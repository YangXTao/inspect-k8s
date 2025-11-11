# Kubernetes 巡检中心

面向多集群环境的巡检与报告平台，采用 **FastAPI**（后端）与 **React/Vite**（前端）双模块架构，底层数据持久化与报告文件统一存放在 `/app/data`。系统主要功能包括：

- **集群管理**：上传 kubeconfig 即可注册集群，自动检测版本、节点数量与连接状态。
- **巡检执行**：支持命令类与 PromQL 类巡检项，任务完成后生成 Markdown/PDF 报告。
- **报告归档**：自动保存巡检报告，可下载 PDF/Markdown，也可联动删除。
- **License 控制**：通过加密 License 启用集群管理、巡检执行与报告下载三大能力。

> 默认镜像统一为 `zhisuan/k8s-inspection:v0.1.0`，镜像内部已包含前后端组件与静态资源。

## 使用 Docker 运行

```bash
# 1. 启动容器（建议映射数据目录）
docker run -d --name k8s-inspection \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e LICENSE_SECRET=demo-secret \
  -e MYSQL_HOST=192.168.10.184 \
  -e MYSQL_PORT=3306 \
  -e MYSQL_USER=root \
  -e MYSQL_PASSWORD=root \
  -e MYSQL_DATABASE=demo \
  zhisuan/k8s-inspection:v0.1.0

# 2. 浏览器访问
http://localhost:8080
```

说明：
- `/app/data` 挂载目录用于保存数据库、上传的 kubeconfig、巡检报告等运行时数据。
- 如需使用外部数据库，请配置 `MYSQL_*` 环境变量；若不配置，应用将默认使用 SQLite。
- License 可通过 UI 上传或在环境变量中直接注入 `LICENSE_SECRET`。

## 使用 Helm 部署

官方 Chart 仓库：`https://helm.com/zs-k8s-inspection`

```bash
# 添加仓库并更新索引
helm repo add zs-k8s-inspection https://helm.com/zs-k8s-inspection
helm repo update

# 自定义配置（可选）
cat > my-values.yaml <<'EOF'
backend:
  image:
    repository: zhisuan/k8s-inspection
    tag: v0.1.0
    pullPolicy: Always
  env:
    - name: MYSQL_HOST
      value: 192.168.10.184
    - name: MYSQL_PORT
      value: "3306"
    - name: MYSQL_USER
      value: root
    - name: MYSQL_PASSWORD
      value: root
    - name: MYSQL_DATABASE
      value: demo
    - name: LICENSE_SECRET
      value: demo-secret
  persistence:
    storageClassName: local-path
    size: 10Gi
frontend:
  service:
    nodePort: 30001
EOF

# 安装到目标命名空间
helm install inspection zs-k8s-inspection/inspection-center \
  -n inspect --create-namespace \
  -f my-values.yaml
```

部署完成后：
- 后端 Pod 挂载 PVC `backend-data` 到 `/app/data`，确保报告、数据库与上传文件持久化。
- 前端 Service 默认以 NodePort 方式暴露（`30001`），可按需结合 Ingress/LoadBalancer 对外提供访问。
- 通过 `kubectl port-forward -n inspect svc/inspection-inspection-center-frontend 8080:80` 可快速调试。

至此，即可通过浏览器访问集群巡检中心，上传 License 后即可开始注册集群、执行巡检并生成报告。祝巡检顺利！
