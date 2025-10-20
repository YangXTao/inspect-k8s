# 升级说明

## v0.3.0 新增功能

- 上传 kubeconfig 后，后端会自动执行 `kubectl get nodes --no-headers` 验证集群连通性，并记录结果。
- 集群卡片展示最新的连接状态、失败原因以及最近验证时间。

## 数据库变更

首次启动会自动为 `cluster_configs` 表补齐以下字段：`connection_status`、`connection_message`、`last_checked_at`。无需手动执行 `ALTER TABLE`。
