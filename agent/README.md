# 巡检 Agent 原型使用说明

本目录提供一个基于 Python 的最小可运行 Agent，能够完成以下能力：

- 向 Server 注册并获取 Token（可选）；
- 定时上报心跳、拉取待执行巡检任务；
- 执行巡检项中的 PromQL 查询；
- 回传巡检结果，具备幂等处理。

## 快速开始

1. **安装依赖**

   ```bash
   cd agent
   python -m venv .venv
   source .venv/bin/activate  # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```

2. **准备配置**

   复制 `config.sample.yaml` 并填入实际的 Server 与 Prometheus 地址：

   ```bash
   cp config.sample.yaml config.yaml
   ```

3. **启动 Agent**

   ```bash
   python -m agent -c config.yaml
   ```

   如需仅执行一次巡检并退出，可追加 `--once`。

## 配置说明

`config.yaml` 主要包含三个部分：

```yaml
server:
  base_url: http://backend:8000     # Server API 地址
  register:
    name: demo-agent                # 首次注册使用的 Agent 名称
    cluster_id: 1                   # 绑定的集群 ID（可选）
  token_file: ./state/agent.token   # 缓存 Token 的路径，可选
agent:
  poll_interval: 10                 # 无任务时的轮询间隔（秒）
  batch_size: 1                     # 每次拉取的任务数
  verify_ssl: true                  # 是否校验 Server 证书
  request_timeout: 15               # HTTP 请求超时（秒）
prometheus:
  base_url: http://prometheus:9090  # Prometheus 查询入口
```

- 若已手动在 Server 侧创建 Agent 并获取 Token，可直接通过环境变量或 `server.token` 字段传入；
- 若未提供 Token，Agent 会使用 `register` 块中的信息尝试注册，并将新 Token 写入 `token_file`；
- 支持以下环境变量覆盖配置：
  - `INSPECT_AGENT_SERVER`、`INSPECT_AGENT_TOKEN`、`INSPECT_AGENT_TOKEN_FILE`
  - `INSPECT_AGENT_NAME`、`INSPECT_AGENT_CLUSTER_ID`
  - `INSPECT_AGENT_PROM_URL`
  - `INSPECT_AGENT_POLL_INTERVAL`、`INSPECT_AGENT_BATCH_SIZE`
  - `INSPECT_AGENT_INSECURE`（为 `true` 时跳过 SSL 校验）

## 容器镜像

已提供 `Dockerfile`，可直接构建：

```bash
docker build -t inspect-agent:dev agent
```

使用示例（通过环境变量提供配置）：

```bash
docker run --rm \
  -e INSPECT_AGENT_SERVER=http://backend:8000 \
  -e INSPECT_AGENT_PROM_URL=http://prometheus:9090 \
  -e INSPECT_AGENT_TOKEN=<your-token> \
  inspect-agent:dev
```

如果需要挂载配置文件与状态目录：

```bash
docker run --rm \
  -v $(pwd)/config.yaml:/app/config.yaml \
  -v $(pwd)/state:/app/state \
  inspect-agent:dev
```

## Kubernetes 部署示例

`kubernetes/deployment.yaml` 给出了在集群中运行 Agent 的基础模板，包含：

- 使用 `ConfigMap` 传递配置；
- 通过 `Secret` 持有 Token（也可以在 Pod 内注册）；
- 为容器挂载持久化卷保存 Token。

部署步骤：

```bash
kubectl apply -f kubernetes/deployment.yaml
```

请根据实际环境修改镜像地址、配置文件内容以及安全策略。

## PromQL 执行策略

- 巡检项 `config.promql` 存在时，Agent 调用 Prometheus 的 `/api/v1/query` 接口执行；
- 查询成功且返回结果不为空视为 `passed`；结果为空时记为 `warning`；发生异常时记为 `failed`；
- 未配置 PromQL 或未提供 Prometheus 地址时，默认返回 `warning` 并提示补充配置。

## 日志与排错

- 默认日志级别为 `INFO`，可通过 `--log-level` 或环境变量 `INSPECT_AGENT_LOG_LEVEL` 调整；
- 出现 HTTP 错误时会打印响应内容，方便定位；
- 若 Agent 长时间未心跳，Server 会自动将任务回滚为 `queued`，需要重新领取后再执行。
