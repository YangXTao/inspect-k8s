from __future__ import annotations

from datetime import datetime
import json
import re
from typing import Any, Dict, List, Optional, Tuple

from pydantic import BaseModel, Field, ConfigDict, computed_field


def _extract_connection_meta(
    message: Optional[str],
) -> Tuple[Optional[str], Optional[int]]:
    if not message:
        return None, None

    # 尝试解析 JSON 格式: {"version": "...", "node_count": 8}
    try:
        payload = json.loads(message)
        if isinstance(payload, dict):
            version = payload.get("version") or payload.get("kubernetes_version")
            if version:
                version = str(version).strip() or None
            node_value = payload.get("node_count") or payload.get("nodes")
            if isinstance(node_value, str):
                node_value = node_value.strip()
                node_value = int(node_value) if node_value.isdigit() else None
            elif isinstance(node_value, (int, float)):
                node_value = int(node_value)
            else:
                node_value = None
            return version, node_value
    except Exception:
        pass

    # 匹配 "Server version v1.30.14; nodes 8." 类型字符串
    version_match = re.search(
        r"Server\s+version\s+([^\s;]+)", message, flags=re.IGNORECASE
    )
    nodes_match = re.search(r"nodes?\s+(\d+)", message, flags=re.IGNORECASE)
    version = version_match.group(1).strip() if version_match else None
    node_count = int(nodes_match.group(1)) if nodes_match else None

    if version is None:
        localized = re.search(
            r"(?:版本|version)[:：]?\s*([vV]?\d+(?:\.\d+){1,2}(?:[^\s·]+)?)", message
        )
        if localized:
            version = localized.group(1).strip()
    if version is None:
        leading_segment = message.strip().split("·", 1)[0].strip()
        if leading_segment and any(ch.isdigit() for ch in leading_segment):
            version = leading_segment

    if node_count is None:
        localized_nodes = re.search(r"(?:节点数|节点)[:：]?\s*(\d+)", message)
        if localized_nodes:
            node_count = int(localized_nodes.group(1))

    return version, node_count


class ClusterConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    prometheus_url: Optional[str]
    contexts: List[str]
    description: Optional[str]
    connection_status: str
    connection_message: Optional[str]
    agent_health_message: Optional[str] = None
    last_checked_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime
    execution_mode: str
    default_agent_id: Optional[int]

    @computed_field(return_type=Optional[str])
    @property
    def kubernetes_version(self) -> Optional[str]:
        version, _ = _extract_connection_meta(self.connection_message)
        return version

    @computed_field(return_type=Optional[int])
    @property
    def node_count(self) -> Optional[int]:
        _, node_count = _extract_connection_meta(self.connection_message)
        return node_count

    @computed_field(return_type=Optional[str])
    @property
    def default_agent_name(self) -> Optional[str]:
        agent = getattr(self, "default_agent", None)
        if agent and getattr(agent, "name", None):
            return agent.name
        return None

    @computed_field(return_type=Optional[str])
    @property
    def default_agent_description(self) -> Optional[str]:
        agent = getattr(self, "default_agent", None)
        if not agent:
            return None
        description = getattr(agent, "description", None)
        if description:
            return description
        return None


class ClusterNodesOut(BaseModel):
    output: str
    retrieved_at: datetime


class ClusterNodesRefreshOut(BaseModel):
    agent_id: int
    requested_at: datetime


class ClusterUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=150)
    prometheus_url: Optional[str] = Field(
        None, max_length=255, description="Prometheus 根地址，形如 http(s)://host:port"
    )
    default_agent_id: Optional[int] = Field(
        None, description="默认执行巡检的 Agent ID"
    )


class AuditLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    action: str
    entity_type: str
    entity_id: Optional[int]
    description: Optional[str]
    created_at: datetime


class InspectionItemBase(BaseModel):
    name: str = Field(..., max_length=100)
    description: Optional[str] = None
    check_type: str = Field(..., max_length=50)
    prometheus_version: str = Field("3.2", max_length=20)
    config: Optional[Dict[str, Any]] = None


class InspectionItemCreate(InspectionItemBase):
    pass


class InspectionItemUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    check_type: Optional[str] = Field(None, max_length=50)
    prometheus_version: Optional[str] = Field(None, max_length=20)
    config: Optional[Dict[str, Any]] = None


class InspectionItemOut(InspectionItemBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime


class InspectionResultOut(BaseModel):
    id: int
    item_id: Optional[int]
    status: str
    detail: Optional[str]
    suggestion: Optional[str]
    item_name: str


class InspectionRunBase(BaseModel):
    operator: Optional[str] = None


class InspectionRunCreate(InspectionRunBase):
    item_ids: List[int]
    cluster_id: int
    prometheus_version: Optional[str] = Field("3.2", max_length=20)


class InspectionRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    operator: Optional[str]
    cluster_id: int
    cluster_name: str
    status: str
    summary: Optional[str]
    report_path: Optional[str]
    total_items: int
    processed_items: int
    progress: int
    created_at: datetime
    completed_at: Optional[datetime]
    prometheus_version: Optional[str] = None
    executor: str
    agent_status: Optional[str]
    agent_id: Optional[int]
    results: List[InspectionResultOut]

    @computed_field(return_type=Optional[str])
    @property
    def agent_name(self) -> Optional[str]:
        agent = getattr(self, "agent", None)
        if agent and getattr(agent, "name", None):
            return agent.name
        return None

    @computed_field(return_type=str)
    @property
    def status_label(self) -> str:
        mapping = {
            "queued": "排队中",
            "running": "执行中",
            "paused": "暂停中",
            "finished": "已完成",
            "failed": "执行失败",
            "cancelled": "已取消",
        }
        status = getattr(self, "status", None) or ""
        return mapping.get(status, "未知状态")

    @computed_field(return_type=Optional[str])
    @property
    def agent_status_label(self) -> Optional[str]:
        if getattr(self, "agent_status", None) is None:
            return None
        mapping = {
            "queued": "待领取",
            "running": "Agent 执行中",
            "paused": "Agent 已暂停",
            "finished": "Agent 已完成",
            "failed": "Agent 执行失败",
        }
        status = getattr(self, "agent_status", None) or ""
        return mapping.get(status, "未知状态")


class InspectionRunListOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    operator: Optional[str]
    cluster_id: int
    cluster_name: str
    status: str
    summary: Optional[str]
    report_path: Optional[str]
    total_items: int
    processed_items: int
    progress: int
    created_at: datetime
    completed_at: Optional[datetime]
    prometheus_version: Optional[str] = None
    executor: str
    agent_status: Optional[str]
    agent_id: Optional[int]

    @computed_field(return_type=Optional[str])
    @property
    def agent_name(self) -> Optional[str]:
        agent = getattr(self, "agent", None)
        if agent and getattr(agent, "name", None):
            return agent.name
        return None

    @computed_field(return_type=str)
    @property
    def status_label(self) -> str:
        mapping = {
            "queued": "排队中",
            "running": "执行中",
            "paused": "暂停中",
            "finished": "已完成",
            "failed": "执行失败",
            "cancelled": "已取消",
        }
        status = getattr(self, "status", None) or ""
        return mapping.get(status, "未知状态")

    @computed_field(return_type=Optional[str])
    @property
    def agent_status_label(self) -> Optional[str]:
        if getattr(self, "agent_status", None) is None:
            return None
        mapping = {
            "queued": "待领取",
            "running": "Agent 执行中",
            "paused": "Agent 已暂停",
            "finished": "Agent 已完成",
            "failed": "Agent 执行失败",
        }
        status = getattr(self, "agent_status", None) or ""
        return mapping.get(status, "未知状态")


class InspectionScheduleBase(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    cron: str = Field(..., max_length=50)
    cluster_ids: List[int] = Field(..., min_length=1)
    item_ids: List[int] = Field(..., min_length=1)
    is_enabled: bool = True


class InspectionScheduleCreate(InspectionScheduleBase):
    pass


class InspectionScheduleUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    cron: Optional[str] = Field(None, max_length=50)
    cluster_ids: Optional[List[int]] = Field(None, min_length=1)
    item_ids: Optional[List[int]] = Field(None, min_length=1)
    is_enabled: Optional[bool] = None


class InspectionScheduleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: Optional[str]
    cron: str
    cluster_ids: List[int]
    cluster_name_map: Dict[int, str] = Field(default_factory=dict)
    item_ids: List[int]
    is_enabled: bool
    last_run_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime


class InspectionAgentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    cluster_id: Optional[int]
    description: Optional[str]
    is_enabled: bool
    last_seen_at: Optional[datetime]
    nodes_report_requested_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime
    prometheus_url: Optional[str]

    @computed_field(return_type=Optional[str])
    @property
    def cluster_name(self) -> Optional[str]:
        cluster = getattr(self, "cluster", None)
        if cluster and getattr(cluster, "name", None):
            return cluster.name
        return None


class InspectionAgentCreate(BaseModel):
    name: str = Field(..., max_length=100)
    cluster_id: Optional[int] = Field(
        None, description="关联的集群 ID（可选）"
    )
    description: Optional[str] = Field(
        None, max_length=500, description="Agent 描述"
    )
    prometheus_url: Optional[str] = Field(
        None, max_length=255, description="Agent Prometheus URL"
    )


class InspectionAgentUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    cluster_id: Optional[int] = Field(None, description="关联的集群 ID（可选）")
    description: Optional[str] = Field(None, max_length=500)
    is_enabled: Optional[bool] = Field(None, description="是否启用 Agent")
    prometheus_url: Optional[str] = Field(None, max_length=255, description="Agent Prometheus URL")


class AgentHeartbeatIn(BaseModel):
    reported_at: Optional[datetime] = Field(
        None, description="Agent 上报时间（可选），默认使用服务器时间"
    )
    nodes_output: Optional[str] = Field(
        None, description="kubectl get nodes -o wide 输出"
    )
    nodes_retrieved_at: Optional[datetime] = Field(
        None, description="节点信息获取时间（可选）"
    )


class AgentRegisterOut(BaseModel):
    id: int
    name: str
    token: str
    cluster_id: Optional[int]


class AgentTaskItemOut(BaseModel):
    id: int
    name: str
    description: Optional[str]
    check_type: str
    config: Dict[str, Any]


class AgentTaskOut(BaseModel):
    run_id: int
    cluster_id: int
    operator: Optional[str]
    total_items: int
    items: List[AgentTaskItemOut]


class AgentRunResultItemIn(BaseModel):
    item_id: Optional[int]
    status: str
    detail: Optional[str] = None
    suggestion: Optional[str] = None


class AgentRunResultIn(BaseModel):
    results: List[AgentRunResultItemIn] = Field(..., min_length=1)
    partial: bool = Field(
        False,
        description="是否为增量上报；True 表示仅追加/更新已有结果，不会结束巡检",
    )


class AgentBootstrapCluster(BaseModel):
    name: str = Field(
        ...,
        max_length=150,
        description="Agent 侧上报的集群名称",
    )
    kubeconfig_b64: Optional[str] = Field(
        None,
        description="Base64 编码的 kubeconfig 内容",
    )

    kubeconfig_name: Optional[str] = Field(
        None,
        description="kubeconfig 文件名（可选）",
    )


class AgentBootstrapIn(BaseModel):
    registration_token: str = Field(
        ...,
        min_length=16,
        max_length=128,
        description="Server 端分发给 Agent 的注册 Token",
    )
    prometheus_url: Optional[str] = Field(
        None,
        max_length=255,
        description="Agent 采集侧上报的 Prometheus 地址（可选）",
    )
    cluster: AgentBootstrapCluster

class InspectionItemsImportPayload(BaseModel):
    items: List[InspectionItemCreate] = Field(..., min_length=1)


class InspectionItemsImportResult(BaseModel):
    created: int = Field(..., ge=0)
    updated: int = Field(..., ge=0)
    total: int = Field(..., ge=0)


class InspectionItemsExportOut(BaseModel):
    exported_at: datetime
    items: List[InspectionItemOut]


class LicenseStatusOut(BaseModel):
    valid: bool
    reason: Optional[str] = None
    product: Optional[str] = None
    licensee: Optional[str] = None
    issued_at: Optional[datetime] = None
    not_before: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    features: List[str] = Field(default_factory=list)


class LicenseImportPayload(BaseModel):
    content: str = Field(..., min_length=1, description="加密或明文 License 内容")


class AuthLoginIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: Optional[str] = Field(default=None, min_length=1, max_length=128)
    nonce: Optional[str] = Field(default=None, min_length=1, max_length=256)
    proof: Optional[str] = Field(default=None, min_length=1, max_length=512)
    scheme: Optional[str] = Field(default=None, min_length=1, max_length=50)


class AuthLoginChallengeIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)


class AuthLoginChallengeOut(BaseModel):
    salt: str
    iterations: int
    nonce: str
    scheme: str


class AuthUserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    display_name: Optional[str] = None
    role: str
    permissions: List[str] = Field(default_factory=list)


class AuthPasswordChangeIn(BaseModel):
    old_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=6, max_length=128)


class AuthRoleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    display_name: str
    description: Optional[str] = None
    permissions: List[str] = Field(default_factory=list)
    is_system: bool


class AuthRoleCreateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    display_name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = Field(default=None, max_length=255)
    permissions: List[str] = Field(default_factory=list)


class AuthRoleUpdateIn(BaseModel):
    display_name: Optional[str] = Field(default=None, max_length=100)
    description: Optional[str] = Field(default=None, max_length=255)
    permissions: Optional[List[str]] = None
