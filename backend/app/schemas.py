from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, ConfigDict


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


class InspectionItemCreate(InspectionItemBase):
    pass


class InspectionItemUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=100)
    description: Optional[str] = None
    check_type: Optional[str] = Field(None, max_length=50)


class InspectionItemOut(InspectionItemBase):
    model_config = ConfigDict(from_attributes=True)

    id: int
    created_at: datetime
    updated_at: datetime


class InspectionResultOut(BaseModel):
    id: int
    item_id: int
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
    created_at: datetime
    completed_at: Optional[datetime]
