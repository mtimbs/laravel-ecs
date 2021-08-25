#!/bin/bash
echo "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI=$AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" > /var/www/html/.env
php artisan cache:clear
php artisan config:cache

php artisan queue:work --timeout=300
