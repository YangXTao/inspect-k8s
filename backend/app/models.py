from __future__ import annotations

from datetime import datetime
from typing import Iterable

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, Text, Boolean, Float
from sqlalchemy.orm import relationship

from .database import Base


class ClusterConfig(Base):
    __tablename__ = "cluster_configs"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(150), unique=True, nullable=False)
    kubeconfig_path = Column(String(255), nullable=False)
    prometheus_url = Column(String(255), nullable=True)
    is_rancher_local = Column(Boolean, nullable=False, default=False)
    rancher_url = Column(String(255), nullable=True)
    rancher_api_key = Column(Text, nullable=True)
    rancher_version = Column(String(50), nullable=True)
    rancher_cluster_count = Column(Integer, nullable=True)
    contexts_json = Column(Text, nullable=True)
    description = Column(Text, nullable=True)
    connection_status = Column(String(20), nullable=False, default="unknown")
    connection_message = Column(Text, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)
    is_archived = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    execution_mode = Column(String(20), nullable=False, default="agent")
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
    name = Column(String(100), nullable=False)
    description = Column(Text, nullable=True)
    check_type = Column(String(50), nullable=False, default="custom")
    prometheus_version = Column(String(20), nullable=False, default="3.2")
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
    created_by_user_id = Column(Integer, nullable=True)
    created_by_username = Column(String(100), nullable=True)
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
    pod_count = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    last_progress_at = Column(DateTime, nullable=True)
    plan_json = Column(Text, nullable=True)
    prometheus_version = Column(String(20), nullable=False, default="3.2")
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


class InspectionSchedule(Base):
    __tablename__ = "inspection_schedules"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=True)
    cron = Column(String(50), nullable=False)
    cluster_ids_json = Column(Text, nullable=False)
    cluster_names_json = Column(Text, nullable=True)
    item_ids_json = Column(Text, nullable=False)
    is_enabled = Column(Boolean, nullable=False, default=True)
    last_run_at = Column(DateTime, nullable=True)
    created_by_user_id = Column(Integer, nullable=True)
    created_by_username = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    @property
    def cluster_ids(self) -> list[int]:
        return self._load_ids(self.cluster_ids_json)

    @property
    def item_ids(self) -> list[int]:
        return self._load_ids(self.item_ids_json)

    @property
    def cluster_name_map(self) -> dict[int, str]:
        if not self.cluster_names_json:
            return {}
        try:
            import json

            raw = json.loads(self.cluster_names_json)
        except Exception:
            return {}
        if not isinstance(raw, dict):
            return {}
        result: dict[int, str] = {}
        for key, value in raw.items():
            try:
                cluster_id = int(key)
            except Exception:
                continue
            if isinstance(value, str) and value.strip():
                result[cluster_id] = value
        return result

    def set_cluster_ids(self, value: Iterable[int]) -> None:
        self.cluster_ids_json = self._dump_ids(value)

    def set_cluster_name_map(self, value: dict[int, str]) -> None:
        import json

        normalized = {
            str(cluster_id): name
            for cluster_id, name in value.items()
            if isinstance(name, str) and name.strip()
        }
        self.cluster_names_json = json.dumps(normalized, ensure_ascii=False)

    def set_item_ids(self, value: Iterable[int]) -> None:
        self.item_ids_json = self._dump_ids(value)

    @staticmethod
    def _normalize_ids(values: Iterable[int]) -> list[int]:
        seen: set[int] = set()
        results: list[int] = []
        for value in values:
            try:
                parsed = int(value)
            except (TypeError, ValueError):
                continue
            if parsed <= 0 or parsed in seen:
                continue
            seen.add(parsed)
            results.append(parsed)
        return results

    @classmethod
    def _dump_ids(cls, values: Iterable[int]) -> str:
        import json

        normalized = cls._normalize_ids(values)
        return json.dumps(normalized, ensure_ascii=True)

    @classmethod
    def _load_ids(cls, raw: str | None) -> list[int]:
        if not raw:
            return []
        try:
            import json

            payload = json.loads(raw)
        except Exception:
            return []
        if not isinstance(payload, list):
            return []
        return cls._normalize_ids(payload)


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
    user_id = Column(Integer, nullable=True)
    username = Column(String(100), nullable=True)
    action = Column(String(50), nullable=False)
    entity_type = Column(String(50), nullable=False)
    entity_id = Column(Integer, nullable=True)
    description = Column(Text, nullable=True)
    ip_address = Column(String(64), nullable=True)
    user_agent = Column(String(255), nullable=True)
    status = Column(String(20), nullable=False, default="success")
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
    nodes_output = Column(Text, nullable=True)
    nodes_output_at = Column(DateTime, nullable=True)
    nodes_report_requested_at = Column(DateTime, nullable=True)
    node_total = Column(Integer, nullable=True)
    node_ready = Column(Integer, nullable=True)
    pod_count = Column(Integer, nullable=True)
    metrics_reported_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    cluster = relationship("ClusterConfig", back_populates="agents", foreign_keys=[cluster_id])
    runs = relationship("InspectionRun", back_populates="agent")


class ClusterMetricSample(Base):
    __tablename__ = "cluster_metric_samples"

    id = Column(Integer, primary_key=True, index=True)
    cluster_id = Column(
        Integer,
        ForeignKey("cluster_configs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_id = Column(
        Integer,
        ForeignKey("inspection_agents.id", ondelete="SET NULL"),
        nullable=True,
    )
    cpu_usage = Column(Float, nullable=True)
    memory_usage = Column(Float, nullable=True)
    reported_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class AuthRole(Base):
    __tablename__ = "auth_roles"
    __table_args__ = {
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_unicode_ci",
    }

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, nullable=False)
    display_name = Column(String(100), nullable=False, default="")
    description = Column(Text, nullable=True)
    permissions_json = Column(Text, nullable=False)
    is_system = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class AuthUser(Base):
    __tablename__ = "auth_users"
    __table_args__ = {
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_unicode_ci",
    }

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(100), unique=True, nullable=False)
    display_name = Column(String(100), nullable=False, default="")
    password_hash = Column(String(255), nullable=False)
    role = Column(String(50), nullable=False, default="admin")
    roles_json = Column(Text, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)
    auth_provider = Column(String(20), nullable=False, default="local")
    external_id = Column(String(150), nullable=True)
    last_login_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )

    sessions = relationship(
        "AuthSession",
        back_populates="user",
        cascade="all, delete-orphan",
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    __table_args__ = {
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_unicode_ci",
    }

    id = Column(String(64), primary_key=True)
    user_id = Column(
        Integer,
        ForeignKey("auth_users.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=False)

    user = relationship("AuthUser", back_populates="sessions")


class SystemSettings(Base):
    __tablename__ = "system_settings"
    __table_args__ = {
        "mysql_charset": "utf8mb4",
        "mysql_collate": "utf8mb4_unicode_ci",
    }

    id = Column(Integer, primary_key=True, index=True)
    base_url = Column(String(255), nullable=True)
    report_retention_days = Column(Integer, nullable=False, default=30)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )
