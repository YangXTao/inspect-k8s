# API + curl Cheatsheet

本文档整理项目当前后端 API 路由及 curl 调用示例，便于成册归档。

## Base Info

- 默认前端会走 `/api` 前缀（Nginx 将 `/api/*` 转发到后端）。
- 直连后端则无需 `/api` 前缀。
- `/agent/*` 需要 `Authorization: Bearer <agent_token>`。
- 部分接口需要 License 功能开通（未开通会 403）。

推荐先设置环境变量：

```bash
# 走前端代理
BASE_URL="http://<host>/api"
# 或直连后端
# BASE_URL="http://<backend-host>:8000"
AGENT_TOKEN="<agent_token>"
```

---

## System & License

### GET /health

健康检查。

```bash
curl -sS "$BASE_URL/health"
```

### GET /system-agent-install.sh

下载 Agent 安装脚本。

```bash
curl -sS "$BASE_URL/system-agent-install.sh" -o system-agent-install.sh
```

### GET /license/status

查询 License 状态。

```bash
curl -sS "$BASE_URL/license/status"
```

### POST /license/upload

上传 License 文件（multipart）。

```bash
curl -sS -F "file=@license.lic" "$BASE_URL/license/upload"
```

### POST /license/import-text

以文本导入 License（JSON）。

```bash
curl -sS -H "Content-Type: application/json" \
  -d "{\"content\":\"<LICENSE_TEXT>\"}" \
  "$BASE_URL/license/import-text"
```

---

## Clusters

### GET /clusters

集群列表。

```bash
curl -sS "$BASE_URL/clusters"
```

### POST /clusters

直接上传 kubeconfig 已停用（返回 410，保留接口但不可用）。

```bash
curl -sS -X POST "$BASE_URL/clusters" \
  -F "file=@kubeconfig" -F "name=cluster-a" -F "prometheus_url=http://prom:9090"
```

### POST /clusters/{cluster_id}/test-connection

触发连接测试。

```bash
curl -sS -X POST "$BASE_URL/clusters/123/test-connection"
```

### GET /clusters/{cluster_id}/nodes

获取节点信息（Agent 上报后可用）。

```bash
curl -sS "$BASE_URL/clusters/123/nodes"
```

### POST /clusters/{cluster_id}/nodes/refresh

请求 Agent 刷新节点信息。

```bash
curl -sS -X POST "$BASE_URL/clusters/123/nodes/refresh"
```

### PUT /clusters/{cluster_id}

更新 Prometheus 或默认 Agent（表单字段）。

```bash
curl -sS -X PUT "$BASE_URL/clusters/123" \
  -F "prometheus_url=http://prom:9090" \
  -F "default_agent_id=1"
```

### DELETE /clusters/{cluster_id}

删除集群（可选删除报告文件）。

```bash
curl -sS -X DELETE "$BASE_URL/clusters/123?delete_files=true"
```

---

## Agents (管理端)

### GET /agents

Agent 列表（需要 License: inspections）。

```bash
curl -sS "$BASE_URL/agents"
```

### POST /agents

创建/注册 Agent（返回 token 给 `/agent/*` 使用）。

```bash
curl -sS -H "Content-Type: application/json" \
  -d "{\"name\":\"cluster-a\",\"cluster_id\":1,\"description\":\"edge agent\",\"prometheus_url\":\"http://prom:9090\"}" \
  "$BASE_URL/agents"
```

---

## Agent (Agent 端)

以下接口均需携带 `Authorization: Bearer <agent_token>`。

### POST /agent/bootstrap

Agent 初次注册并绑定集群（JSON）。

```bash
curl -sS -H "Content-Type: application/json" \
  -d "{\"registration_token\":\"$AGENT_TOKEN\",\"prometheus_url\":\"http://prom:9090\",\"cluster\":{\"name\":\"cluster-a\",\"kubeconfig_b64\":\"<BASE64>\",\"kubeconfig_name\":\"kubeconfig\"}}" \
  "$BASE_URL/agent/bootstrap"
```

### POST /agent/heartbeat

心跳/上报节点信息。

```bash
curl -sS -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d "{\"nodes_output\":\"<kubectl get nodes -o wide>\",\"reported_at\":\"2025-01-01T00:00:00Z\"}" \
  "$BASE_URL/agent/heartbeat"
```

### GET /agent/tasks?limit=5

拉取待执行任务。

```bash
curl -sS -H "Authorization: Bearer $AGENT_TOKEN" "$BASE_URL/agent/tasks?limit=5"
```

### POST /agent/runs/{run_id}/claim

领取任务。

```bash
curl -sS -X POST -H "Authorization: Bearer $AGENT_TOKEN" \
  "$BASE_URL/agent/runs/123/claim"
```

### POST /agent/runs/{run_id}/results

上报任务结果。

```bash
curl -sS -X POST -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" \
  -d "{\"results\":[{\"item_id\":1,\"status\":\"passed\",\"detail\":\"ok\",\"suggestion\":\"\"}],\"partial\":false}" \
  "$BASE_URL/agent/runs/123/results"
```

---

## Audit Logs

### GET /audit-logs?limit=100

审计日志。

```bash
curl -sS "$BASE_URL/audit-logs?limit=100"
```

---

## Inspection Items

### GET /inspection-items

巡检项列表。

```bash
curl -sS "$BASE_URL/inspection-items"
```

### GET /inspection-items/export

导出 JSON。

```bash
curl -sS "$BASE_URL/inspection-items/export"
```

### GET /inspection-items/export-yaml

导出 YAML。

```bash
curl -sS "$BASE_URL/inspection-items/export-yaml"
```

### POST /inspection-items/import

导入（JSON/YAML 文件）。

```bash
curl -sS -F "file=@inspection-items.json" "$BASE_URL/inspection-items/import"
```

### POST /inspection-items

新建巡检项（JSON）。

```bash
curl -sS -H "Content-Type: application/json" \
  -d "{\"name\":\"Node Disk\",\"description\":\"check disk\",\"check_type\":\"promql\",\"prometheus_version\":\"3.2\",\"config\":{}}" \
  "$BASE_URL/inspection-items"
```

### PUT /inspection-items/{item_id}

更新巡检项（JSON）。

```bash
curl -sS -X PUT -H "Content-Type: application/json" \
  -d "{\"description\":\"updated\"}" \
  "$BASE_URL/inspection-items/123"
```

### DELETE /inspection-items/{item_id}

删除巡检项。

```bash
curl -sS -X DELETE "$BASE_URL/inspection-items/123"
```

---

## Inspection Schedules

### GET /inspection-schedules

定时巡检列表。

```bash
curl -sS "$BASE_URL/inspection-schedules"
```

### POST /inspection-schedules

创建定时巡检（需要 License: inspections）。

```bash
curl -sS -H "Content-Type: application/json" \
  -d "{\"name\":\"每日健康巡检\",\"cron\":\"0 2 * * *\",\"cluster_ids\":[1,2],\"item_ids\":[3,4,5],\"is_enabled\":true}" \
  "$BASE_URL/inspection-schedules"
```

### PUT /inspection-schedules/{schedule_id}

更新定时巡检（需要 License: inspections）。

```bash
curl -sS -X PUT -H "Content-Type: application/json" \
  -d "{\"name\":\"周例行巡检\",\"cron\":\"0 3 * * 1\",\"cluster_ids\":[1],\"item_ids\":[3,4],\"is_enabled\":false}" \
  "$BASE_URL/inspection-schedules/123"
```

### DELETE /inspection-schedules/{schedule_id}

删除定时巡检（需要 License: inspections）。

```bash
curl -sS -X DELETE "$BASE_URL/inspection-schedules/123"
```

---

## Inspection Runs

### POST /inspection-runs

触发巡检任务。

```bash
curl -sS -H "Content-Type: application/json" \
  -d "{\"cluster_id\":1,\"item_ids\":[1,2,3],\"operator\":\"alice\",\"prometheus_version\":\"3.2\"}" \
  "$BASE_URL/inspection-runs"
```

### GET /inspection-runs

任务列表。

```bash
curl -sS "$BASE_URL/inspection-runs"
```

### GET /inspection-runs/{run_id}

任务详情。

```bash
curl -sS "$BASE_URL/inspection-runs/123"
```

### POST /inspection-runs/{run_id}/pause

暂停任务。

```bash
curl -sS -X POST "$BASE_URL/inspection-runs/123/pause"
```

### POST /inspection-runs/{run_id}/resume

继续任务。

```bash
curl -sS -X POST "$BASE_URL/inspection-runs/123/resume"
```

### POST /inspection-runs/{run_id}/cancel

取消任务。

```bash
curl -sS -X POST "$BASE_URL/inspection-runs/123/cancel"
```

### DELETE /inspection-runs/{run_id}?delete_files=true

删除任务（可选删除报告）。

```bash
curl -sS -X DELETE "$BASE_URL/inspection-runs/123?delete_files=true"
```

### GET /inspection-runs/{run_id}/report?format=pdf|md

下载报告。

```bash
curl -sS "$BASE_URL/inspection-runs/123/report?format=pdf" -o report.pdf
```
