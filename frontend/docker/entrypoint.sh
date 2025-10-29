#!/bin/sh
set -e

: "${API_SERVER:=http://inspect-backend:8000}"

envsubst '${API_SERVER}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

exec nginx -g "daemon off;"
