# Kubernetes 巡检中心

面向多集群环境的巡检与报告平台：后端基于 FastAPI，前端基于 React/Vite，可对 Kubernetes 集群进行连接校验、巡检项执行以及报告生成，并支持以 Markdown/PDF 导出结果。

## 功能速览

- **多集群管理**：上传 kubeconfig 即可注册集群，自动校验连接并展示版本、节点信息。
- **巡检任务**：支持自定义巡检项（命令或 PromQL），运行结果会生成 Markdown/PDF 报告。
- **License 管控**：通过加密 License 启用集群管理、巡检执行与报告下载等能力。
- **Helm 支持**：仓库内提供 Helm Chart，可一键部署前后端组件。

## Docker 镜像

示例命令（根据实际仓库调整镜像地址/Tag）：

```bash
# 构建基础镜像
docker build -t your-registry/inspection-backend:latest -f backend/Dockerfile .
docker build -t your-registry/inspection-frontend:latest -f frontend/Dockerfile .

# 推送到镜像仓库
docker push your-registry/inspection-backend:latest
docker push your-registry/inspection-frontend:latest
```

> 后端镜像默认在 `/app/data` 下保存数据库、kubeconfig 与报告文件；记得在运行容器时挂载或持久化该目录。

## Helm 部署

Charts 目录内已准备 `inspection-center` Chart，可直接安装：

```bash
# 可选：自定义配置
cat > my-values.yaml <<'EOF'
image:
  backend:
    repository: your-registry/inspection-backend
    tag: v1.0.0
  frontend:
    repository: your-registry/inspection-frontend
    tag: v1.0.0
backend:
  database:
    env:
      MYSQL_HOST: mysql.example.com
      MYSQL_USER: demo
      MYSQL_PASSWORD: s3cret
      MYSQL_DATABASE: inspection
frontend:
  service:
    nodePort: 32080  # 如果想固定 NodePort，可以覆盖默认值
licenseSecret:
  create: true
  value: demo-secret
EOF

# 安装
helm install inspection charts/inspection-center -f my-values.yaml \
  --set backend.persistence.storageClassName=fast-ssd \
  --set backend.persistence.size=20Gi
```

- 后端默认会创建名为 `backend-data` 的 PVC，并挂载到 `/app/data`。
- 前端 Service 为 NodePort，默认分配端口 `30080`，可通过 `--set frontend.service.nodePort=<port>` 调整。
- License 可以通过预先创建的 Secret 注入：`--set licenseSecret.create=false --set licenseSecret.name=my-license-secret`。

安装完成后，可结合 Ingress/LoadBalancer 暴露前端服务，也可使用 `kubectl port-forward svc/inspection-inspection-center-frontend 8080:80` 临时访问。祝巡检顺利！
