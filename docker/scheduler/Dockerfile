# Create base image
FROM php:8.0-apache as base

RUN apt-get update \
    && apt-get install -y libicu-dev default-mysql-client cron \
    && docker-php-ext-configure intl \
    && docker-php-ext-install pdo pdo_mysql intl pcntl opcache

RUN pecl install redis \
    && docker-php-ext-enable redis


# Install composer dependencies
FROM composer as deps
ARG APP_HOME=/var/www/html
RUN rm -rf $APP_HOME && mkdir $APP_HOME
WORKDIR $APP_HOME
COPY . $APP_HOME

RUN composer install --prefer-dist --no-scripts --no-progress --no-interaction --optimize-autoloader --no-dev $ARGS
RUN composer dump-autoload --classmap-authoritative

# Application Image
FROM base
ARG APP_HOME=/var/www/html
ENV APP_HOME=$APP_HOME
ENV APP_ENV=prod
RUN rm -rf $APP_HOME && mkdir $APP_HOME
WORKDIR $APP_HOME

# change uid and gid of apache to docker user uid/gid
RUN usermod -u 1000 www-data && groupmod -g 1000 www-data
RUN chown -R www-data:www-data $APP_HOME
USER www-data

# Copy source files
COPY --from=deps --chown=www-data:www-data $APP_HOME $APP_HOME
# Add start script
ADD ./docker/scheduler/start.sh /

USER root
# Copy cron file to the cron.d directory
ADD ./docker/scheduler/crontab /etc/cron.d/scheduler-cron
# Give execution rights on the cron job
RUN chmod 0644 /etc/cron.d/scheduler-cron
# Apply cron job
RUN crontab /etc/cron.d/scheduler-cron
# Add start script
RUN chmod +x /start.sh

CMD ["/start.sh"]
