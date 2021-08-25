import { Construct, Duration, RemovalPolicy, Stack, StackProps } from '@aws-cdk/core';
import { Effect, Policy, PolicyStatement, Role, ServicePrincipal, User } from '@aws-cdk/aws-iam';
import { AuthorizationToken } from '@aws-cdk/aws-ecr';
import { DockerImageAsset } from '@aws-cdk/aws-ecr-assets';
import {
  GatewayVpcEndpointAwsService, InstanceClass, InstanceSize,
  InstanceType,
  InterfaceVpcEndpointAwsService,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc
} from '@aws-cdk/aws-ec2';
import { LogGroup } from '@aws-cdk/aws-logs';
import {
  Cluster,
  Compatibility,
  ContainerImage,
  DeploymentControllerType,
  FargatePlatformVersion,
  FargateService,
  Secret,
  TaskDefinition,
  Protocol as EcsProtocol,
  LogDriver
} from '@aws-cdk/aws-ecs';
import { ApplicationLoadBalancer, ApplicationProtocol, ApplicationTargetGroup, Protocol, TargetType } from '@aws-cdk/aws-elasticloadbalancingv2';
import { ParameterTier, StringParameter } from '@aws-cdk/aws-ssm';
import { Secret as SecretManager } from '@aws-cdk/aws-secretsmanager';
import { DatabaseInstance, DatabaseInstanceEngine, MysqlEngineVersion } from '@aws-cdk/aws-rds';
import { Queue } from '@aws-cdk/aws-sqs';
import { QueueProcessingFargateService } from '@aws-cdk/aws-ecs-patterns';
import { CfnCacheCluster, CfnSubnetGroup } from '@aws-cdk/aws-elasticache';
import { Accelerator } from '@aws-cdk/aws-globalaccelerator';
import { ApplicationLoadBalancerEndpoint } from '@aws-cdk/aws-globalaccelerator-endpoints';

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const user = new User(this, 'deployment-user', {});
    AuthorizationToken.grantRead(user);

    const applicationImage = new DockerImageAsset(this, 'applicationImage', {
      directory: '..',
      file: './docker/apache/Dockerfile'
    });

    const schedulerImage = new DockerImageAsset(this, 'schedulerImage', {
      directory: '..',
      file: './docker/scheduler/Dockerfile'
    });

    const queueWorkerImage = new DockerImageAsset(this, 'queueWorkerImage', {
      directory: '..',
      file: './docker/queue_worker/Dockerfile'
    });

    // VPC
    const SUBNET_APPLICATION = {
      name: 'Application',
      subnetType: SubnetType.PUBLIC
    };

    const SUBNET_BACKGROUND_TASKS = {
      name: 'Background',
      subnetType: SubnetType.PUBLIC
    };

    const SUBNET_ISOLATED = {
      name: 'RDS-Redis',
      subnetType: SubnetType.ISOLATED
    };

    const vpc = new Vpc(this, 'my-vpc', {
      natGateways: 0,
      subnetConfiguration: [
        SUBNET_APPLICATION,
        SUBNET_BACKGROUND_TASKS,
        SUBNET_ISOLATED,
      ],
      gatewayEndpoints: {
        S3: {
          service: GatewayVpcEndpointAwsService.S3,
        },
      },
    });

    // VPC - Private Links
    const ecr = vpc.addInterfaceEndpoint('ecr-gateway', {
      service: InterfaceVpcEndpointAwsService.ECR,
    });

    vpc.addInterfaceEndpoint('ecr-docker-gateway', {
      service: InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    const ecs = vpc.addInterfaceEndpoint('ecs-gateway', {
      service: InterfaceVpcEndpointAwsService.ECS,
    });

    const ecsAgent = vpc.addInterfaceEndpoint('ecs-agent-gateway', {
      service: InterfaceVpcEndpointAwsService.ECS_AGENT,
    });

    const ecsTelemetry = vpc.addInterfaceEndpoint('ecs-telemetry-gateway', {
      service: InterfaceVpcEndpointAwsService.ECS_TELEMETRY,
    });

    const sqsEndpoint = vpc.addInterfaceEndpoint('sqs-gateway', {
      service: InterfaceVpcEndpointAwsService.SQS,
    });

    // need to add private link for secrets manager
    const sm = vpc.addInterfaceEndpoint('secrets-manager', {
      service: InterfaceVpcEndpointAwsService.SECRETS_MANAGER
    });

    // need to add private link for cloudwatch
    const cw = vpc.addInterfaceEndpoint('cloudwatch', {
      service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS
    });

    // LOAD BALANCER
    const alb = new ApplicationLoadBalancer(this, 'application-ALB', {
      http2Enabled: false,
      internetFacing: true,
      loadBalancerName: 'application',
      vpc,
      vpcSubnets: {
        subnetGroupName: SUBNET_APPLICATION.name
      }
    });

    const loadBalancerSecurityGroup = new SecurityGroup(this, 'load-balancer-SG', {
      vpc,
      allowAllOutbound: true,
    });

    alb.addSecurityGroup(loadBalancerSecurityGroup);

    // For HTTPS you need to set up an ACM and reference it here
    const listener = alb.addListener('alb-target-group', {
      open: true,
      port: 80
    });

    // Target group to make resources containers discoverable by the application load balancer
    const targetGroupHttp = new ApplicationTargetGroup(this, 'alb-target-group', {
      port: 80,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      vpc,
    });
    // Health check for containers to check they were deployed correctly
    targetGroupHttp.configureHealthCheck({
      path: '/api/health-check',
      protocol: Protocol.HTTP,
    });
    // Add target group to listener
    listener.addTargetGroups('alb-listener-target-group', {
      targetGroups: [targetGroupHttp],
    });

    // Fargate Service Things
    const cluster = new Cluster(this, 'application-cluster', {
      clusterName: 'application',
      containerInsights: true,
      vpc,
    });

    const backgroundCluster = new Cluster(this, 'scheduler-cluster', {
      clusterName: 'background-tasks',
      containerInsights: true,
      vpc,
    });

    // LOG GROUPS
    const applicationLogGroup = new LogGroup(this, 'application-log-group', {
      logGroupName: 'application',
      removalPolicy: RemovalPolicy.DESTROY,
      retention: 30
    });
    const schedulerLogGroup = new LogGroup(this, 'scheduler-log-group', {
      logGroupName: 'scheduler',
      removalPolicy: RemovalPolicy.DESTROY,
      retention: 30
    });
    const queueWorkerLogGroup = new LogGroup(this, 'queue-worker-log-group', {
      logGroupName: 'queue-worker',
      removalPolicy: RemovalPolicy.DESTROY,
      retention: 7
    });

    applicationLogGroup.grant(user, 'logs:CreateLogGroup');
    schedulerLogGroup.grant(user, 'logs:CreateLogGroup');
    queueWorkerLogGroup.grant(user, 'logs:CreateLogGroup');

    const taskRole = new Role(this, 'fargate-task-role', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: 'application-fargate-task-role',
      description: 'Role that the api task definitions use to run the api code',
    });

    const applicationServiceDefinition = new TaskDefinition(this, 'application-fargate-service-definition', {
      compatibility: Compatibility.EC2_AND_FARGATE,
      cpu: '256',
      family: 'api-task-family',
      memoryMiB: '512',
      taskRole
    });

    const applicationSecurityGroup = new SecurityGroup(this, 'application-SG', {
      vpc,
      description: 'SecurityGroup into which application ECS tasks will be deployed',
      allowAllOutbound: true
    });
    applicationSecurityGroup.connections.allowFrom(loadBalancerSecurityGroup, Port.allTcp(), 'Load Balancer ingress All TCP');
    ecr.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));
    ecs.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));
    ecsAgent.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));
    ecsTelemetry.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));
    sm.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));
    cw.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));

    const backgroundTasksSecurityGroup = new SecurityGroup(this, 'background-task-SG', {
      vpc,
      description: 'SecurityGroup into which scheduler ECS tasks will be deployed',
      allowAllOutbound: true
    });
    ecr.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));
    ecs.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));
    ecsAgent.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));
    ecsTelemetry.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));
    sm.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));
    cw.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));

    const redisSecurityGroup = new SecurityGroup(this, 'redis-SG', {
      vpc,
      description: 'SecurityGroup associated with the ElastiCache Redis Cluster',
      allowAllOutbound: false
    });
    redisSecurityGroup.connections.allowFrom(applicationSecurityGroup, Port.tcp(6379), 'Application ingress 6379');
    redisSecurityGroup.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(6379), 'Scheduler ingress 6379');

    // Parameters
    const LOG_LEVEL = new StringParameter(this, 'Parameter', {
      allowedPattern: '.*',
      description: 'Application log level',
      parameterName: 'LOG_LEVEL',
      stringValue: 'debug',
      tier: ParameterTier.STANDARD,
    }).stringValue;

    const APP_URL = StringParameter.fromStringParameterName(this, 'APP_URL', 'APP_URL').stringValue;

    // RDS
    const databaseSecurityGroup = new SecurityGroup(this, 'database-SG', {
      vpc,
      description: 'SecurityGroup associated with the MySQL RDS Instance',
      allowAllOutbound: false
    });
    databaseSecurityGroup.connections.allowFrom(applicationSecurityGroup, Port.tcp(3306));
    databaseSecurityGroup.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(3306));

    const db = new DatabaseInstance(this, 'primary-db', {
      allocatedStorage: 20,
      autoMinorVersionUpgrade: true,
      allowMajorVersionUpgrade: false,
      databaseName: 'example',
      engine: DatabaseInstanceEngine.mysql({
        version: MysqlEngineVersion.VER_8_0_21
      }),
      iamAuthentication: true,
      instanceType: InstanceType.of(InstanceClass.BURSTABLE3, InstanceSize.SMALL),
      maxAllocatedStorage: 250,
      multiAz: false,
      securityGroups: [databaseSecurityGroup],
      vpc,
      vpcSubnets: {
        subnetGroupName: SUBNET_ISOLATED.name
      }
    });

    // ELASTICACHE
    const redisSubnetGroup = new CfnSubnetGroup(this, 'redis-subnet-group', {
      description: 'Redis Subnet Group',
      subnetIds: vpc.isolatedSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: 'RedisSubnetGroup'
    });

    const redis = new CfnCacheCluster(this, 'redis-cluster', {
      cacheNodeType: 'cache.t3.small',
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      clusterName: 'redis-cluster',
      engine: 'redis',
      engineVersion: '6.x',
      numCacheNodes: 1,
      port: 6379,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId]
    });

    redis.node.addDependency(redisSubnetGroup);

    // SECRETS
    const stripe = SecretManager.fromSecretNameV2(this, 'stripe_keys', 'STRIPE'); // Don't forget to create this manually

    const secrets = {
      DB_DATABASE: Secret.fromSecretsManager(db.secret!, 'dbname'),
      DB_USERNAME: Secret.fromSecretsManager(db.secret!, 'username'),
      DB_PASSWORD: Secret.fromSecretsManager(db.secret!, 'password'),
      STRIPE_KEY: Secret.fromSecretsManager(stripe, 'STRIPE_KEY'),
      STRIPE_SECRET: Secret.fromSecretsManager(stripe, 'STRIPE_SECRET'),
    };

    // This is specific for laravel application used in examples
    const environment = {
      APP_URL,
      LOG_CHANNEL: 'stdout',
      LOG_LEVEL,
      DB_CONNECTION: 'mysql',
      DB_HOST: db.dbInstanceEndpointAddress,
      DB_PORT: db.dbInstanceEndpointPort,
      CACHE_DRIVER: 'redis',
      REDIS_HOST: redis.attrRedisEndpointAddress,
      REDIS_PASSWORD: 'null',
      REDIS_PORT: '6379',
    };

    const applicationContainer = applicationServiceDefinition.addContainer('app-container', {
      cpu: 256,
      environment,
      essential: true,
      image: ContainerImage.fromDockerImageAsset(applicationImage),
      logging: LogDriver.awsLogs({
        logGroup: applicationLogGroup,
        streamPrefix: new Date().toLocaleDateString('en-ZA')
      }),
      memoryLimitMiB: 512,
      secrets,
    });

    applicationContainer.addPortMappings({
      containerPort: 80,
      hostPort: 80,
      protocol: EcsProtocol.TCP
    });

    const applicationService = new FargateService(this, 'application-fargate-service', {
      assignPublicIp: true,
      circuitBreaker: {
        rollback: true
      },
      deploymentController: {
        type: DeploymentControllerType.ECS
      },
      desiredCount: 1,
      cluster,
      platformVersion: FargatePlatformVersion.LATEST,
      securityGroups: [applicationSecurityGroup],
      taskDefinition: applicationServiceDefinition,
      vpcSubnets: {
        subnetGroupName: SUBNET_APPLICATION.name
      }
    });

    applicationService.attachToApplicationTargetGroup(targetGroupHttp);

    const scaleTarget = applicationService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 10,
    });

    scaleTarget.scaleOnMemoryUtilization('scale-out-memory-threshold', {
      targetUtilizationPercent: 75
    });
    scaleTarget.scaleOnCpuUtilization('scale-out-cpu-threshold', {
      targetUtilizationPercent: 75
    });

    // Scheduled Tasks
    const scheduledServiceRole = new Role(this, 'scheduled-fargate-task-role', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: 'scheduled-fargate-task-role',
      description: 'Role that the scheduled task definitions use to run scheduled jobs',
    });

    const scheduledServiceDefinition = new TaskDefinition(this, 'background-fargate-service-definition', {
      compatibility: Compatibility.EC2_AND_FARGATE,
      cpu: '256',
      family: 'background-task-family',
      memoryMiB: '512',
      taskRole: scheduledServiceRole
    });

    // We don't want to autoscale scheduled tasks. Otherwise each container will run each job independently
    // If scheduled jobs are slow running you are better off pushing the work to the queue
    const scheduledService = new FargateService(this, 'scheduled-fargate-service', {
      assignPublicIp: true,
      circuitBreaker: {
        rollback: true
      },
      deploymentController: {
        type: DeploymentControllerType.ECS
      },
      desiredCount: 1,
      cluster: backgroundCluster,
      platformVersion: FargatePlatformVersion.LATEST,
      securityGroups: [backgroundTasksSecurityGroup],
      taskDefinition: scheduledServiceDefinition,
      vpcSubnets: {
        subnetGroupName: SUBNET_BACKGROUND_TASKS.name
      }
    });

    scheduledService.taskDefinition.addContainer('background-container', {
      cpu: 256,
      environment,
      essential: true,
      image: ContainerImage.fromDockerImageAsset(schedulerImage),
      logging: LogDriver.awsLogs({
        logGroup: schedulerLogGroup,
        streamPrefix: new Date().toLocaleDateString('en-ZA'),
      }),
      memoryLimitMiB: 512,
      secrets,
    });

    // SQS and QueueProcessingService
    const schedulerJobQueue = new Queue(this, 'job-queue', {
      queueName: 'scheduler-job-queue'
    });

    const sqsPolicy = new Policy(this, 'fargate-task-sqs-policy', {
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['sqs:*'],
          resources: [schedulerJobQueue.queueArn],
        }),
      ],
    });

    const queueWorkerService = new QueueProcessingFargateService(this, 'queued-jobs', {
      assignPublicIp: false,
      circuitBreaker: {
        rollback: true
      },
      cluster: backgroundCluster,
      cpu: 256,
      deploymentController: {
        type: DeploymentControllerType.ECS
      },
      enableLogging: true,
      environment,
      image: ContainerImage.fromDockerImageAsset(queueWorkerImage),
      logDriver: LogDriver.awsLogs({
        logGroup: queueWorkerLogGroup,
        streamPrefix: new Date().toLocaleDateString('en-ZA')
      }),
      maxScalingCapacity: 2,
      memoryLimitMiB: 512,
      queue: schedulerJobQueue,
      secrets,
      platformVersion: FargatePlatformVersion.LATEST,
      securityGroups: [backgroundTasksSecurityGroup],
      taskSubnets: {
        subnetGroupName: SUBNET_BACKGROUND_TASKS.name
      }
    });

    // Allow ECS to grab the images to spin up new containers
    applicationImage.repository.grantPull(applicationService.taskDefinition.obtainExecutionRole());
    schedulerImage.repository.grantPull(scheduledService.taskDefinition.obtainExecutionRole());
    queueWorkerImage.repository.grantPull(queueWorkerService.taskDefinition.obtainExecutionRole());

    // SQS Permissions
    sqsEndpoint.connections.allowFrom(backgroundTasksSecurityGroup, Port.tcp(443));
    sqsEndpoint.connections.allowFrom(applicationSecurityGroup, Port.tcp(443));

    // Application Permissions grants
    taskRole.attachInlinePolicy(sqsPolicy);
    scheduledServiceRole.attachInlinePolicy(sqsPolicy);
    queueWorkerService.taskDefinition.taskRole.attachInlinePolicy(sqsPolicy);

    schedulerJobQueue.grantSendMessages(applicationService.taskDefinition.obtainExecutionRole());
    schedulerJobQueue.grantSendMessages(scheduledService.taskDefinition.obtainExecutionRole());

    schedulerJobQueue.grantSendMessages(queueWorkerService.taskDefinition.obtainExecutionRole());
    schedulerJobQueue.grantPurge(queueWorkerService.taskDefinition.obtainExecutionRole());
    schedulerJobQueue.grantConsumeMessages(queueWorkerService.taskDefinition.obtainExecutionRole());

    // SECRETS PERMISSIONS
    Object.values(secrets).forEach(secret => {
      secret.grantRead(applicationService.taskDefinition.obtainExecutionRole());
      secret.grantRead(scheduledService.taskDefinition.obtainExecutionRole());
      secret.grantRead(queueWorkerService.taskDefinition.obtainExecutionRole());
    });

    // Log Permissions
    applicationLogGroup.grant(applicationService.taskDefinition.obtainExecutionRole(), 'logs:CreateLogStream');
    applicationLogGroup.grant(applicationService.taskDefinition.obtainExecutionRole(), 'logs:PutLogEvents');
    schedulerLogGroup.grant(scheduledService.taskDefinition.obtainExecutionRole(), 'logs:CreateLogStream');
    schedulerLogGroup.grant(scheduledService.taskDefinition.obtainExecutionRole(), 'logs:PutLogEvents');
    queueWorkerLogGroup.grant(queueWorkerService.taskDefinition.obtainExecutionRole(), 'logs:CreateLogStream');
    queueWorkerLogGroup.grant(queueWorkerService.taskDefinition.obtainExecutionRole(), 'logs:PutLogEvents');

    // DB permissions
    db.grantConnect(applicationService.taskDefinition.taskRole);
    db.grantConnect(scheduledService.taskDefinition.taskRole);
    db.grantConnect(queueWorkerService.taskDefinition.taskRole);

    // Create an Accelerator
    const accelerator = new Accelerator(this, 'global-accelerator');

    // Create a Listener
    const acceleratorListener = accelerator.addListener('global-accelerator-listener', {
      portRanges: [
        { fromPort: 80 },
        { fromPort: 443 },
      ],
    });

    const endpointGroup = acceleratorListener.addEndpointGroup('global-accelerator-listener-alb-group', {
      endpoints: [
        new ApplicationLoadBalancerEndpoint(alb, {
          preserveClientIp: true,
        })
      ],
      healthCheckInterval: Duration.seconds(30),
      healthCheckPath: '/api/health-check'
    });

    // Remember that there is only one AGA security group per VPC.
    const acceleratorSecurityGroup = endpointGroup.connectionsPeer('GlobalAcceleratorSG', vpc);

    // Allow connections from the AGA to the ALB
    alb.connections.allowFrom(acceleratorSecurityGroup, Port.tcp(443));
  }
}
