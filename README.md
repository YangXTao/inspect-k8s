# Kubernetes 巡检中心

一个基于 **FastAPI + React** 的全栈巡检平台，可批量管理多集群、执行自动化巡检、生成 PDF 报告，并整合 Prometheus 指标完成资源健康监控。

## 核心能力

- **多集群管理**：上传 kubeconfig 自动解析上下文，可编辑名称 / Prometheus 地址，支持删除并清理关联巡检记录与报告。
- **连接校验**：每次上传或替换 kubeconfig 后，系统自动执行 `kubectl get nodes` 验证连通性，并在 UI 中展示状态、失败原因与最近验证时间。
- **巡检项管理**：预置节点健康、Pod 状态、事件、CPU/内存/磁盘 IO 等巡检项，支持自定义增删改查，所有操作写入审计日志。
- **Prometheus 集成**：配置 Prometheus 后即可采集集群/节点资源指标；未配置时相关巡检会返回告警提示。
- **报告留存**：巡检完成后自动生成 PDF，可下载或在历史记录中删除。
- **友好 UI**：支持自定义 LOGO、集群编辑弹窗、巡检历史过滤、报告快捷操作等。

## 目录结构

```
backend/   # FastAPI 服务端、数据库与巡检逻辑
frontend/  # Vite + React 前端
reports/   # 巡检生成的 PDF 报告（运行时创建）
configs/   # 已上传的 kubeconfig 文件（运行时创建）
```

## 快速启动

### 后端

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
uvicorn app.main:app --reload --app-dir .
```

> 默认使用 SQLite（`inspection.db`）。若需连接 MySQL，请在启动前设置：
> ```powershell
> $env:MYSQL_HOST = "db.example.com"
> $env:MYSQL_PORT = "3306"            # 可选，默认 3306
> $env:MYSQL_USER = "demo_user"
> $env:MYSQL_PASSWORD = "demo_pass"
> $env:MYSQL_DATABASE = "demo_db"
> uvicorn app.main:app --reload --app-dir .
> ```
> 服务器需安装 `kubectl` 或安装 `kubernetes` Python 客户端（已包含在 requirements）。上传的 kubeconfig 需具备访问权限。若需 Prometheus 巡检项，请在集群设置中填写 Prometheus 根地址（例如 `https://prometheus.example.com`）。

### 前端

```powershell
cd frontend
npm install
npm run dev
```

访问 http://localhost:5173 ，所有请求会代理到 `http://localhost:8000`。

## 操作流程

1. 在首页上传 kubeconfig（可选填写集群名称 & Prometheus 地址）。上传后自动验证连通性，并在集群卡片显示结果。  
2. 需要修改名称 / 地址或替换 kubeconfig 时点击“编辑”；集群删除支持级联清理巡检结果与报告。  
3. 在巡检面板勾选巡检项，填写巡检人后点击“开始巡检”。Prometheus 相关检查未配置地址时会返回告警。  
4. 巡检完成后生成 PDF，可在历史面板中下载或删除记录。

## 主要 API

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| GET  | /health | 健康检查 |
| GET  | /clusters | 集群列表 |
| POST | /clusters | 上传 kubeconfig 并注册集群 |
| PUT  | /clusters/{id} | 更新集群（名称 / Prometheus / kubeconfig） |
| DELETE | /clusters/{id} | 删除集群及关联巡检记录 |
| GET  | /inspection-items | 巡检项列表 |
| POST | /inspection-items | 新建巡检项 |
| PUT  | /inspection-items/{id} | 更新巡检项 |
| DELETE | /inspection-items/{id} | 删除巡检项 |
| POST | /inspection-runs | 执行巡检并生成报告 |
| GET  | /inspection-runs | 巡检历史列表 |
| GET  | /inspection-runs/{id} | 巡检详情 |
| DELETE | /inspection-runs/{id} | 删除巡检记录及 PDF |
| GET  | /inspection-runs/{id}/report | 下载 PDF 报告 |
| GET  | /audit-logs | 操作审计日志 |

## 预置巡检项

| 巡检项 | 类型 | 说明 |
| ------ | ---- | ---- |
| Cluster Version | cluster_version | `kubectl version --short` |
| Node Health | nodes_status | 节点 Ready 状态 |
| Pod Status | pods_status | 非 Running/Succeeded Pod |
| Recent Events | events_recent | 最近事件列表 |
| Cluster CPU Usage | cluster_cpu_usage | Prometheus 统计集群 CPU 使用率 |
| Cluster Memory Usage | cluster_memory_usage | Prometheus 统计内存使用率 |
| Node CPU Hotspots | node_cpu_hotspots | 节点 CPU 热点 |
| Node Memory Pressure | node_memory_pressure | 节点内存热点 |
| Cluster Disk IO | cluster_disk_io | 节点磁盘 IO 占比 |

> 未配置 Prometheus 时，上述指标类巡检将返回 warning 提示完善配置。

## 数据与存储

- 默认 SQLite；生产环境推荐配置 `MYSQL_*` 环境变量指向 MySQL 等数据库。  
- 核心表：`cluster_configs`、`inspection_items`、`inspection_runs`、`inspection_results`、`audit_logs`。  
- 上传的 kubeconfig 存于 `configs/`，巡检报告存于 `reports/`，删除集群或巡检记录时自动清理。

数据库会在启动时自动补齐缺失的 `connection_status / connection_message / last_checked_at` 字段，无需手动迁移。

## 生产部署建议

- 使用环境变量管理数据库、Prometheus 等敏感信息，或将 kubeconfig/报告存入对象存储（MinIO/S3）。  
- 接入认证与权限控制，限制巡检与删除操作。  
- 确保 Prometheus 已部署 node_exporter、kube-state-metrics 等组件。  
- 若需扩展巡检逻辑，可在 `backend/app/inspections/engine.py` 新增 Handler，并在前端或数据库新增对应 `check_type`。
