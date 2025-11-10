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
    return version, node_count


class ClusterConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    prometheus_url: Optional[str]
    contexts: List[str]
    connection_status: str
    connection_message: Optional[str]
    last_checked_at: Optional[datetime]
    created_at: datetime
    updated_at: datetime

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


class ClusterUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=150)
    prometheus_url: Optional[str] = Field(
        None, max_length=255, description="Prometheus 根地址，形如 http(s)://host:port"
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
    config: Optional[Dict[str, Any]] = None


class InspectionItemCreate(InspectionItemBase):
    pass


class InspectionItemUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    check_type: Optional[str] = Field(None, max_length=50)
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
    results: List[InspectionResultOut]


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


class InspectionItemsExportOut(BaseModel):
    exported_at: datetime
    items: List[InspectionItemOut]


class InspectionItemsImportPayload(BaseModel):
    items: List[InspectionItemCreate] = Field(..., min_length=1)


class InspectionItemsImportResult(BaseModel):
    created: int = Field(..., ge=0)
    updated: int = Field(..., ge=0)
    total: int = Field(..., ge=0)


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
