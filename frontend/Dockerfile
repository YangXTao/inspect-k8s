FROM hub.zscr.io/node:20-alpine AS build
WORKDIR /frontend
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM hub.zscr.io/nginx:1.27-alpine
WORKDIR /etc/nginx
ENV API_SERVER=http://inspect-backend:8000
COPY docker/default.conf.template ./templates/default.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY --from=build /frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["/entrypoint.sh"]
