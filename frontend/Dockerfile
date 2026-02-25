FROM 192.168.10.51/base/node:20-alpine AS build
WORKDIR /frontend
ARG VITE_API_BASE_URL=auto
ARG VITE_BUILD_OPTS="--sourcemap"
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
COPY package*.json ./
RUN npm ci
COPY . .
# 说明：默认开启 --sourcemap，便于排查报错（可用 VITE_BUILD_OPTS 覆盖/置空）
RUN npm install react-helmet@6.1.0 && npm run build -- ${VITE_BUILD_OPTS}

FROM 192.168.10.51/base/nginx:1.27-alpine
WORKDIR /etc/nginx
ENV API_SERVER=http://inspect-backend:8000
RUN apk add --no-cache openssl
COPY docker/default.conf.template ./templates/default.conf.template
COPY docker/default.http.conf.template ./templates/default.http.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY --from=build /frontend/dist /usr/share/nginx/html
EXPOSE 80 443
CMD ["/entrypoint.sh"]
