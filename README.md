# Kubernetes 巡检中心

一个基于 **FastAPI + React** 的全栈巡检平台，用于批量管理 Kubernetes 集群、执行自动化巡检并生成 PDF 报告，同时整合 Prometheus 指标对资源健康情况进行可视化展示。

## 核心特性

- **多集群管理**：上传 kubeconfig 自动解析上下文，可自定义显示名称与 Prometheus 地址，支持编辑、删除及清理关联巡检记录/报告。
- **连接校验**：上传或替换 kubeconfig 后自动执行连接测试（`kubectl get nodes`），UI 中实时显示状态、失败原因与最近检测时间。
- **巡检项管理**：预置节点健康、Pod 状态、CPU/内存/磁盘 IO 等巡检项，支持前端增删改查并记录审计日志。
- **Prometheus 集成**：只需配置 Prometheus 根地址即可获取节点/集群指标，未配置时相关巡检会返回告警提示。
- **报告留存**：巡检完成后自动生成 PDF，可在历史页面下载或删除，自定义是否连同本地文件一并清理。
- **友好体验**：提供 LOGO 自定义、集群编辑弹窗、巡检历史快捷操作、提示范围控制等实用功能。

## 目录结构

```
inspect-k8s/
├── backend/        # FastAPI 服务端、数据库模型、巡检逻辑
├── frontend/       # Vite + React 前端工程
├── configs/        # 运行时存放上传的 kubeconfig（启动后自动创建）
├── reports/        # 运行时生成的巡检报告 PDF（启动后自动创建）
└── README.md
```

## 本地快速体验

### 1. 启动后端

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
uvicorn app.main:app --reload --app-dir .
```

> 默认使用 SQLite（文件名为 `inspection.db`）。如需连接 MySQL，可在启动前设置：
>
> ```powershell
> $env:MYSQL_HOST = "db.example.com"
> $env:MYSQL_PORT = "3306"
> $env:MYSQL_USER = "demo_user"
> $env:MYSQL_PASSWORD = "demo_pass"
> $env:MYSQL_DATABASE = "demo_db"
> uvicorn app.main:app --reload --app-dir .
> ```
>
> 请确认运行环境已安装 `kubectl` 或具备 `kubernetes` Python SDK，并保证上传的 kubeconfig 拥有相应集群的只读权限。若需执行 PromQL 巡检，请提前准备好可访问的 Prometheus 地址。

### 2. 启动前端

```powershell
cd frontend
npm install
npm run dev
```

默认监听 `http://localhost:5173`，接口代理至 `http://localhost:8000`。

## 基本操作流程

1. **上传集群**：在首页上传 kubeconfig（可选填写显示名称与 Prometheus 地址），系统将自动测试连接并显示结果。
2. **集群维护**：通过“编辑”按钮更新名称、Prometheus 地址或替换 kubeconfig；删除时可选择是否清理本地文件及历史巡检记录。
3. **配置巡检项**：点击右上角设置图标，在“巡检项”页新增或编辑巡检项；支持 command、PromQL 两种类型，可自定义阈值与提示信息。
4. **执行巡检**：回到首页选择目标巡检项，填写巡检人后即可启动；任务完成后会生成 PDF 并可在历史列表中查看或删除。

## 主要 API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | /health                         | 健康检查 |
| GET  | /clusters                       | 集群列表 |
| POST | /clusters                      | 上传 kubeconfig 并注册集群 |
| PUT  | /clusters/{id}                 | 更新集群信息（名称/Prometheus/kubeconfig） |
| DELETE | /clusters/{id}               | 删除集群（可选清理文件 & 巡检记录） |
| GET  | /inspection-items              | 巡检项列表 |
| POST | /inspection-items             | 新建巡检项 |
| PUT  | /inspection-items/{id}         | 更新巡检项 |
| DELETE | /inspection-items/{id}       | 删除巡检项 |
| POST | /inspection-runs               | 执行巡检，生成报告 |
| GET  | /inspection-runs               | 巡检历史列表 |
| GET  | /inspection-runs/{id}          | 巡检详情 |
| DELETE | /inspection-runs/{id}        | 删除巡检记录（可选删除报告） |
| GET  | /inspection-runs/{id}/report   | 下载 PDF 报告 |
| GET  | /audit-logs                    | 审计日志 |

## 预设巡检项

| 名称 | 类型 | 说明 |
| ---- | ---- | ---- |
| Cluster Version        | cluster_version        | `kubectl version --short` |
| Node Health            | nodes_status           | 检查节点 Ready 状态 |
| Pod Status             | pods_status            | 统计异常 Pod |
| Cluster CPU Usage      | cluster_cpu_usage      | Prometheus 聚合 CPU 使用率 |
| Cluster Memory Usage   | cluster_memory_usage   | Prometheus 聚合内存使用率 |
| Node CPU Hotspots      | node_cpu_hotspots      | 节点 CPU 热点排查 |
| Node Memory Pressure   | node_memory_pressure   | 节点内存压力 |
| Cluster Disk IO        | cluster_disk_io        | 节点磁盘 IO 占比 |

> 未配置 Prometheus 时，以上指标类巡检会返回 warning，并提示补充配置。

## 数据与存储

- 默认使用 SQLite；生产建议切换至 MySQL/PostgreSQL，并通过环境变量提供连接信息。
- 关键数据表：`cluster_configs`、`inspection_items`、`inspection_runs`、`inspection_results`、`audit_logs`。
- 上传的 kubeconfig 存放于 `configs/`，巡检报告存放于 `reports/`，删除操作会触发对应文件的清理逻辑。

## 生产部署建议

- 使用环境变量或 Secret 管理数据库、Prometheus、认证等敏感信息。
- 若需长期保留报告，可将 `reports/` 迁移到对象存储（S3/MinIO）或挂载专用存储卷。
- 引入认证授权、审计、操作审批等机制，限制高危操作（删除巡检、清理文件等）。
- 监控后端日志与运行状况，结合 Prometheus + Loki/ELK 建立统一观测体系。
- 扩展巡检项时可在 `backend/app/inspections/engine.py` 中新增自定义 Handler，并在前端开放对应的 `check_type`。

## 在 Kubernetes 中部署

以下步骤展示如何将巡检中心运行在 Kubernetes 集群中，涵盖镜像构建、资源对象与运维要点。请根据实际环境扩展 TLS、认证或 Helm Chart 等能力。

### 1. 构建镜像

```bash
docker build -t your-registry/inspect-backend:latest -f backend/Dockerfile .
docker build -t your-registry/inspect-frontend:latest -f frontend/Dockerfile .
docker push your-registry/inspect-backend:latest
docker push your-registry/inspect-frontend:latest
```

若尚未编写 Dockerfile，可直接使用以下模板：

`backend/Dockerfile`
```dockerfile
FROM python:3.11-slim
WORKDIR /app

# 安装依赖
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝源码
COPY backend /app

ENV PYTHONUNBUFFERED=1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`frontend/Dockerfile`
```dockerfile
FROM node:20-alpine AS build
WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm install
COPY frontend /frontend
RUN npm run build

FROM nginx:1.27-alpine
# 如果需要自定义代理，可在 frontend/nginx.conf 中编写并复制进来
COPY --from=build /frontend/dist /usr/share/nginx/html
```

> 如需在前端容器内配置 `/api` → `inspect-backend:8000` 的反向代理，可在仓库根目录创建 `frontend/nginx.conf`，示例：
> ```nginx
> server {
>     listen 80;
>     server_name _;
> 
>     location /api/ {
>         proxy_pass http://inspect-backend:8000/;
>         proxy_set_header Host $host;
>         proxy_set_header X-Real-IP $remote_addr;
>     }
> 
>     location / {
>         try_files $uri $uri/ /index.html;
>     }
> }
> ```
> 并在 Dockerfile 中添加 `COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf`。

### 2. 准备集群资源

```bash
kubectl create namespace inspect

# 持久化 SQLite、kubeconfig 与 PDF 报告
kubectl apply -n inspect -f - <<'YAML'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: inspect-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 10Gi
YAML

# 应用配置（Prometheus、数据库等）
kubectl apply -n inspect -f - <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: inspect-config
data:
  PROMETHEUS_URL: "http://prometheus.monitoring.svc.cluster.local:9090"
  MYSQL_HOST: ""
  MYSQL_PORT: "3306"
  MYSQL_USER: ""
  MYSQL_PASSWORD: ""
  MYSQL_DATABASE: ""
YAML
```

若切换到 MySQL，可将配置写入 Secret，并在 Deployment 中引用。

### 3. 部署后端

```bash
kubectl apply -n inspect -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inspect-backend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: inspect-backend
  template:
    metadata:
      labels:
        app: inspect-backend
    spec:
      containers:
        - name: backend
          image: your-registry/inspect-backend:latest
          imagePullPolicy: Always
          envFrom:
            - configMapRef:
                name: inspect-config
          ports:
            - containerPort: 8000
          volumeMounts:
            - name: data
              mountPath: /app/data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: inspect-data
---
apiVersion: v1
kind: Service
metadata:
  name: inspect-backend
spec:
  selector:
    app: inspect-backend
  ports:
    - port: 8000
      targetPort: 8000
YAML
```

如使用外部数据库，可移除 PVC，并通过环境变量 `MYSQL_*` 指向外部实例。

### 4. 部署前端

```bash
kubectl apply -n inspect -f - <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: inspect-frontend
spec:
  replicas: 1
  selector:
    matchLabels:
      app: inspect-frontend
  template:
    metadata:
      labels:
        app: inspect-frontend
    spec:
      containers:
        - name: frontend
          image: your-registry/inspect-frontend:latest
          imagePullPolicy: Always
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: inspect-frontend
spec:
  selector:
    app: inspect-frontend
  ports:
    - port: 80
      targetPort: 80
YAML
```

若使用 Nginx 作为前端运行时，请确保 `/api` 反向代理到 `http://inspect-backend:8000/`。

### 5. 暴露入口

```bash
# 临时调试
kubectl port-forward -n inspect svc/inspect-frontend 8080:80
```

生产环境可借助 Ingress：

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: inspect
  namespace: inspect
spec:
  rules:
    - host: inspect.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: inspect-frontend
                port:
                  number: 80
```

结合 cert-manager/self-signed 证书即可启用 HTTPS。

### 6. 日常运维建议

- **存储**：默认将 SQLite、kubeconfig、PDF 报告保存在 PVC 中；如需长期归档可接入对象存储或文件服务器。
- **巡检项批量导入**：可在集群内执行 `kubectl exec` + `curl` 调用后端 API 批量写入 JSON 配置。
- **日志与监控**：后端日志输出到 STDOUT，可配合 Loki/ELK 收集；PromQL 巡检依赖外部 Prometheus，请确保网络可达。
- **升级发布**：推送新镜像后执行 `kubectl rollout restart deployment/inspect-backend` 与 `deployment/inspect-frontend` 即可滚动升级。
- **权限控制**：上传的 kubeconfig 应具备最低所需权限；如需执行 `kubectl` 命令，请预装二进制并配置 ServiceAccount/RBAC。

完成上述步骤后，巡检中心即可在 Kubernetes 中稳定运行，并具备持久化、横向扩展与统一运维能力。
