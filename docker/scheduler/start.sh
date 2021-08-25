#!/bin/bash
echo "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" >> /etc/environment
php artisan cache:clear
php artisan config:cache
cron -f
