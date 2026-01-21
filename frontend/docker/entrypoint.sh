#!/bin/sh
set -e

: "${API_SERVER:=http://inspect-backend:8000}"
: "${SSL_CERT_PATH:=/etc/nginx/certs/tls.crt}"
: "${SSL_KEY_PATH:=/etc/nginx/certs/tls.key}"
: "${SSL_CN:=inspect.local}"
: "${FRONTEND_ENABLE_HTTPS:=}"

export API_SERVER
export SSL_CERT_PATH
export SSL_KEY_PATH
export SSL_CN
export FRONTEND_ENABLE_HTTPS

enable_https=false
case "$(echo "$FRONTEND_ENABLE_HTTPS" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on) enable_https=true ;;
esac

template_path="/etc/nginx/templates/default.http.conf.template"
if [ "$enable_https" = "true" ]; then
  template_path="/etc/nginx/templates/default.conf.template"
  if [ ! -f "$SSL_CERT_PATH" ] || [ ! -f "$SSL_KEY_PATH" ]; then
    cert_dir="$(dirname "$SSL_CERT_PATH")"
    mkdir -p "$cert_dir"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
      -keyout "$SSL_KEY_PATH" \
      -out "$SSL_CERT_PATH" \
      -subj "/CN=$SSL_CN"
  fi
fi

envsubst '${API_SERVER} ${SSL_CERT_PATH} ${SSL_KEY_PATH}' < "$template_path" > /etc/nginx/conf.d/default.conf

exec nginx -g "daemon off;"
