FROM 192.168.10.51/base/node:20-alpine AS build
WORKDIR /frontend
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm install react-helmet@6.1.0 && npm run build

FROM 192.168.10.51/base/nginx:1.27-alpine
WORKDIR /etc/nginx
ENV API_SERVER=http://inspect-backend:8000
COPY docker/default.conf.template ./templates/default.conf.template
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY --from=build /frontend/dist /usr/share/nginx/html
EXPOSE 80
CMD ["/entrypoint.sh"]
