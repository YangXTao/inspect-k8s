# 升级指南（Agent 模式改造）

适用版本：`v0.5.x` 及以上（包含 Agent 执行模式、Agent 管理模块、巡检状态扩展）。

## 1. 升级前准备

1. **备份数据**
   - 备份数据库：`mysqldump -uroot -p inspect_db > backup-$(date +%F).sql`
   - 备份本地报告及 kubeconfig：`tar czf data-backup-$(date +%F).tgz backend/data`
2. **确认 License**：新特性依赖 `agents` 功能位，请在升级前获取包含该特性的 License。
3. **冻结巡检任务**：在发版窗口暂停新增巡检，避免状态切换期间的任务错乱。
4. **准备镜像**：构建或获取包含 Agent API 的 Server 镜像，以及独立的 Agent 镜像。

## 2. 数据库迁移

后端新增了以下字段/表：

- `cluster_configs.execution_mode`（默认值 `server`）
- `cluster_configs.default_agent_id`（允许为空）
- `inspection_runs.executor / agent_id / agent_status`
- 新表 `inspection_agents`

执行迁移：

```bash
# 进入 backend 目录
cd backend
# 创建虚拟环境或激活现有环境
pip install -r requirements.txt
# 运行 Alembic 迁移
alembic upgrade head
```

> 若使用内置 SQLite，首次启动会自动执行迁移；仍建议手动校验 `backend/app/database.py` 输出日志以确认成功。

迁移完成后，老集群会保持 `execution_mode=server`，无需额外数据清洗。

## 3. 新增 Agent

1. **通过 UI 创建**
   - 打开「设置 → Agent 管理」，填写名称、可选的描述与 Prometheus 覆盖地址。
   - 点击「创建」，将生成唯一 Token，请立即保存。
2. **部署 Agent**
   - 通过容器运行示例：
     ```bash
     docker run -d \
       -e INSPECT_SERVER=http://inspect-server:8080 \
       -e INSPECT_AGENT_TOKEN=<生成的 token> \
       zhisuan/inspection-agent:latest
     ```
   - Agent 启动后会周期性向 `/api/agents/{id}/heartbeat` 上报状态。
3. **绑定集群**
   - 在集群详情页的「执行设置」中，将执行模式切换为 `Agent`，并选择默认 Agent。
   - 保存后，新发起的巡检会排队等待 Agent 领取。

> API 方式参考 `/docs` Swagger：首先调用 `POST /agents` 注册，后续携带返回的 Token 调用其他 Agent 接口。

## 4. 回滚指引

如需临时回滚到不支持 Agent 的旧版本：

1. 将集群执行模式全部切回 `server`：
   ```sql
   UPDATE cluster_configs SET execution_mode = 'server', default_agent_id = NULL;
   ```
2. 停止 Agent 容器，确保无任务等待 Agent 处理。
3. 回滚代码/镜像到旧版本，重新部署。
4. 若回滚后无需保留 Agent 数据，可清空 `inspection_agents` 表；否则保留以便未来重新启用。

## 5. 常见问题

- **Agent 长时间无心跳**：后台会在 5 分钟后将任务回退为 `queued`，可在日志中查看 `_requeue_stale_agent_runs` 输出。
- **License 不包含 agents**：前端会隐藏 Agent 管理入口，同时禁止执行模式切换为 `agent`。
- **切换模式失败**：确认数据库迁移已执行；必要时重新运行 `alembic upgrade head` 并重启后端。

升级完成后建议执行冒烟测试（参考 `docs/test-plan.md`）以校验核心流程是否正常。
