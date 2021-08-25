## Laravel App Configured to Deploy to ECS Fargate - Managed with AWS CDK

This repo contains all the code necessary to configure AWS infrastructure to run autoscaling containerised applications using [AWS ECS](https://aws.amazon.com/ecs/). Specifically it leverages the [Fargate Service](https://aws.amazon.com/fargate/) for pay as you go autoscaling. Everything related to configuring infrastructure via [AWS CDK](https://docs.aws.amazon.com/cdk/latest/guide/home.html) can be found in `cdk/lib/cdk-stack.ts`
 
![Architecture Overview](https://public-files.gumroad.com/bp0sr18p0bg9dw8nws9ussmb4m83)

For the sake of example, a Laravel application is what has been packaged up for deployment on our infrastructure. This uses a black Laravel 8.4 installation. The only change made is in `routes/api` where I have added a health-check route for the load balancer

```php
Route::get('/health-check', function () {
    return response('OK', 200);
});
```

## Deployments with CDK
You'll need to install the CDK CLI
    
    npm install -g aws-cdk

Then you'll need to make sure you have AWS Credentials configured on the host machine.


### Useful commands
To be run from the `/cdk` directory

* `cdk bootstrap`   you will need to bootstrap some CDK assets the first time you deploy
* `cdk deploy`      deploy this stack to your default AWS account/region
* `cdk diff`        compare deployed stack with current state
* `cdk synth`       emits the synthesized CloudFormation template

**Note:** Deploying this infrastructure WILL incur charges in your AWS account. The following infrastructure costs roughly $100-150 USD/month to maintain on AWS.

## Code Use
This code is provided as is without warranty. Feel free to use any of the Docker config, or CDK code for your own projects.

## Learn More
If you want to learn more about how this works, you can check out my short course on [Gumroad](https://michaeltimbs.gumroad.com/l/BZPcgS). It will cover everything referenced in the CDK stack in under 90 minutes.




