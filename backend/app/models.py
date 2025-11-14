from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, Boolean
from sqlalchemy.orm import relationship

from .database import Base


class ClusterConfig(Base):
    __tablename__ = "cluster_configs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(150), unique=True, nullable=False)
    kubeconfig_path = Column(String(255), nullable=False)
    prometheus_url = Column(String(255), nullable=True)
    contexts_json = Column(Text, nullable=True)
    connection_status = Column(String(20), nullable=False, default="unknown")
    connection_message = Column(Text, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    execution_mode = Column(String(20), nullable=False, default="server")
    default_agent_id = Column(
        Integer,
        ForeignKey("inspection_agents.id", ondelete="SET NULL"),
        nullable=True,
    )

    runs = relationship(
        "InspectionRun",
        back_populates="cluster",
        cascade="all, delete-orphan",
    )
    agents = relationship(
        "InspectionAgent",
        back_populates="cluster",
        cascade="all, delete-orphan",
        primaryjoin="ClusterConfig.id == InspectionAgent.cluster_id",
        foreign_keys="InspectionAgent.cluster_id",
    )
    default_agent = relationship(
        "InspectionAgent",
        foreign_keys=[default_agent_id],
        post_update=True,
    )

    @property
    def contexts(self) -> list[str]:
        if not self.contexts_json:
            return []
        try:
            import json

            return json.loads(self.contexts_json)
        except Exception:
            return []


class InspectionItem(Base):
    __tablename__ = "inspection_items"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text, nullable=True)
    check_type = Column(String(50), nullable=False, default="custom")
    config_json = Column(Text, nullable=True)
    is_archived = Column(Boolean, nullable=False, default=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    @property
    def config(self) -> dict[str, object]:
        if not self.config_json:
            return {}
        try:
            import json
            return json.loads(self.config_json)
        except Exception:
            return {}

    def set_config(self, value: dict[str, object] | None) -> None:
        if not value:
            self.config_json = None
            return
        import json
        self.config_json = json.dumps(value, ensure_ascii=True)
    results = relationship("InspectionResult", back_populates="item")


class InspectionRun(Base):
    __tablename__ = "inspection_runs"

    id = Column(Integer, primary_key=True, index=True)
    operator = Column(String(100), nullable=True)
    cluster_id = Column(
        Integer,
        ForeignKey("cluster_configs.id", ondelete="CASCADE"),
        nullable=False,
    )
    status = Column(String(20), nullable=False, default="queued")
    summary = Column(Text, nullable=True)
    report_path = Column(String(255), nullable=True)
    total_items = Column(Integer, nullable=False, default=0)
    processed_items = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    plan_json = Column(Text, nullable=True)
    executor = Column(String(20), nullable=False, default="server")
    agent_status = Column(String(20), nullable=True)
    agent_id = Column(
        Integer,
        ForeignKey("inspection_agents.id", ondelete="SET NULL"),
        nullable=True,
    )

    results = relationship(
        "InspectionResult", back_populates="run", cascade="all, delete-orphan"
    )
    cluster = relationship("ClusterConfig", back_populates="runs")
    agent = relationship("InspectionAgent", back_populates="runs")


class InspectionResult(Base):
    __tablename__ = "inspection_results"

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, ForeignKey("inspection_runs.id"), nullable=False)
    item_id = Column(Integer, ForeignKey("inspection_items.id", ondelete="SET NULL"), nullable=True)
    status = Column(String(20), nullable=False)
    detail = Column(Text, nullable=True)
    suggestion = Column(Text, nullable=True)
    item_name_cached = Column(String(100), nullable=False, default="")

    run = relationship("InspectionRun", back_populates="results")
    item = relationship("InspectionItem", back_populates="results")


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    action = Column(String(50), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(Integer, nullable=True)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class InspectionAgent(Base):
    __tablename__ = "inspection_agents"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    token = Column(String(64), unique=True, nullable=False)
    cluster_id = Column(
        Integer,
        ForeignKey("cluster_configs.id", ondelete="SET NULL"),
        nullable=True,
    )
    description = Column(Text, nullable=True)
    is_enabled = Column(Boolean, nullable=False, default=True)
    last_seen_at = Column(DateTime, nullable=True)
    prometheus_url = Column(String(255), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    cluster = relationship("ClusterConfig", back_populates="agents", foreign_keys=[cluster_id])
    runs = relationship("InspectionRun", back_populates="agent")
