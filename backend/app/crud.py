from __future__ import annotations

from datetime import datetime
from typing import Iterable, List, Optional, Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from . import models, schemas
from .audit import get_audit_actor

UNSET = object()
CONNECTION_TEST_OPERATOR = "__system_connection_test__"
SCHEDULED_AUDIT_SUFFIX = "（定时巡检）"


def _hash_string(value: str) -> int:
    hash_value = 0
    for char in value:
        hash_value = (hash_value * 33 + ord(char)) & 0xFFFFFFFF
    if hash_value & 0x80000000:
        hash_value = -((~hash_value + 1) & 0xFFFFFFFF)
    return abs(hash_value)


def _to_base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    parts: list[str] = []
    while value > 0:
        value, remainder = divmod(value, 36)
        parts.append(digits[remainder])
    return "".join(reversed(parts)).upper()


def _build_cluster_display_id(cluster_id: int, cluster_name: Optional[str]) -> str:
    token = f"{cluster_id}:{cluster_name or ''}"
    hashed = _hash_string(token)
    base36 = _to_base36(hashed)
    segment = base36[-4:].rjust(4, "0")
    return f"C-{segment}"


def _normalise_cluster_name(name: Optional[str]) -> str:
    if not name:
        return "cluster"
    import re as _re
    slug = _re.sub(r"\s+", "-", name.strip().lower())
    return slug or "cluster"


def _build_run_display_id(
    db: Session, run: models.InspectionRun, cluster_name: Optional[str]
) -> str:
    slug = _normalise_cluster_name(cluster_name)
    runs = (
        db.query(models.InspectionRun)
        .filter(models.InspectionRun.cluster_id == run.cluster_id)
        .order_by(models.InspectionRun.created_at.asc(), models.InspectionRun.id.asc())
        .all()
    )
    if (run.operator or "") != CONNECTION_TEST_OPERATOR:
        runs = [
            candidate
            for candidate in runs
            if (candidate.operator or "") != CONNECTION_TEST_OPERATOR
        ]
    for index, candidate in enumerate(runs, start=1):
        if candidate.id == run.id:
            return f"{slug}-{index:02d}"
    return f"{slug}-{run.id:02d}"


def describe_inspection_run(
    db: Session,
    run: models.InspectionRun,
    cluster: Optional[models.ClusterConfig] = None,
) -> str:
    cluster_obj = cluster or getattr(run, "cluster", None)
    if cluster_obj is None:
        cluster_obj = get_cluster(db, run.cluster_id)
    cluster_id = cluster_obj.id if cluster_obj else run.cluster_id
    cluster_name = (
        getattr(cluster_obj, "name", None)
        or getattr(run, "cluster_name", None)
        or "cluster"
    )
    cluster_display = _build_cluster_display_id(cluster_id, cluster_name)
    run_display = _build_run_display_id(db, run, cluster_name)
    return f"{cluster_display}集群的{run_display}"


def get_cluster_display_id(cluster: models.ClusterConfig) -> str:
    return _build_cluster_display_id(cluster.id, cluster.name)


def _should_log_run(run: models.InspectionRun) -> bool:
    return (run.operator or "") != CONNECTION_TEST_OPERATOR


def _resolve_run_audit_override(
    run: models.InspectionRun,
) -> dict[str, Optional[object]]:
    if get_audit_actor() is not None:
        return {}
    username = (getattr(run, "created_by_username", None) or "").strip()
    if not username:
        return {}
    operator = (getattr(run, "operator", None) or "").strip()
    if operator.endswith(SCHEDULED_AUDIT_SUFFIX):
        if username.endswith(SCHEDULED_AUDIT_SUFFIX):
            audit_username = username
        else:
            audit_username = f"{username}{SCHEDULED_AUDIT_SUFFIX}"
    else:
        audit_username = username
    return {
        "user_id": getattr(run, "created_by_user_id", None),
        "username": audit_username,
    }


def get_run_audit_override(run: models.InspectionRun) -> dict[str, Optional[object]]:
    return _resolve_run_audit_override(run)


def list_clusters(db: Session) -> List[models.ClusterConfig]:
    return (
        db.query(models.ClusterConfig)
        .options(selectinload(models.ClusterConfig.default_agent))
        .filter(models.ClusterConfig.is_archived.is_(False))
        .order_by(models.ClusterConfig.name)
        .all()
    )


def get_cluster(db: Session, cluster_id: int) -> Optional[models.ClusterConfig]:
    return (
        db.query(models.ClusterConfig)
        .options(selectinload(models.ClusterConfig.default_agent))
        .filter(models.ClusterConfig.id == cluster_id)
        .first()
    )


def get_cluster_by_name(db: Session, name: str) -> Optional[models.ClusterConfig]:
    return (
        db.query(models.ClusterConfig)
        .options(selectinload(models.ClusterConfig.default_agent))
        .filter(models.ClusterConfig.name == name)
        .first()
    )


def create_cluster(
    db: Session,
    *,
    name: str,
    kubeconfig_path: str,
    contexts_json: Optional[str],
    prometheus_url: Optional[str],
    is_rancher_local: bool = False,
    rancher_url: Optional[str] = None,
    rancher_api_key: Optional[str] = None,
    rancher_version: Optional[str] = None,
    rancher_cluster_count: Optional[int] = None,
    connection_status: str = "unknown",
    connection_message: Optional[str] = None,
    last_checked_at: Optional[datetime] = None,
    execution_mode: str = "agent",
    default_agent_id: Optional[int] = None,
    description: Optional[str] = None,
) -> models.ClusterConfig:
    cluster = models.ClusterConfig(
        name=name,
        kubeconfig_path=kubeconfig_path,
        contexts_json=contexts_json,
        prometheus_url=prometheus_url,
        is_rancher_local=is_rancher_local,
        rancher_url=rancher_url,
        rancher_api_key=rancher_api_key,
        rancher_version=rancher_version,
        rancher_cluster_count=rancher_cluster_count,
        connection_status=connection_status,
        connection_message=connection_message,
        last_checked_at=last_checked_at,
        execution_mode=execution_mode,
        default_agent_id=default_agent_id,
        description=description,
    )
    db.add(cluster)
    db.commit()
    db.refresh(cluster)
    log_action(
        db,
        action="create",
        entity_type="cluster_config",
        entity_id=cluster.id,
        description=f"Registered cluster '{name}'.",
    )
    return cluster


def update_cluster(
    db: Session,
    cluster: models.ClusterConfig,
    *,
    name: Optional[str] = None,
    created_at: Optional[datetime] = None,
    kubeconfig_path: Optional[str] = None,
    contexts_json: Optional[str] = None,
    prometheus_url: Optional[str] = None,
    is_rancher_local: Optional[bool] = None,
    rancher_url: Optional[str] = None,
    rancher_api_key: Optional[str] = None,
    rancher_version: Optional[str] = None,
    rancher_cluster_count: Optional[int] = None,
    connection_status: Optional[str] = None,
    connection_message: Optional[str] = None,
    last_checked_at: Optional[datetime] = None,
    execution_mode: Optional[str] = None,
    default_agent_id: Any = UNSET,
    is_archived: Any = UNSET,
    description: Optional[str] = None,
    log_audit: bool = True,
) -> models.ClusterConfig:
    if name is not None:
        cluster.name = name
    if created_at is not None:
        cluster.created_at = created_at
    if kubeconfig_path is not None:
        cluster.kubeconfig_path = kubeconfig_path
    if contexts_json is not None:
        cluster.contexts_json = contexts_json
    if prometheus_url is not None:
        cluster.prometheus_url = prometheus_url
    if is_rancher_local is not None:
        cluster.is_rancher_local = bool(is_rancher_local)
    if rancher_url is not None:
        cluster.rancher_url = rancher_url
    if rancher_api_key is not None:
        cluster.rancher_api_key = rancher_api_key
    if rancher_version is not None:
        cluster.rancher_version = rancher_version
    if rancher_cluster_count is not None:
        cluster.rancher_cluster_count = rancher_cluster_count
    if connection_status is not None:
        cluster.connection_status = connection_status
    if connection_message is not None:
        cluster.connection_message = connection_message
    if last_checked_at is not None:
        cluster.last_checked_at = last_checked_at
    if execution_mode is not None:
        cluster.execution_mode = execution_mode
    if description is not None:
        cluster.description = description
    if default_agent_id is not UNSET:
        cluster.default_agent_id = default_agent_id
    if is_archived is not UNSET:
        cluster.is_archived = bool(is_archived)
    cluster.updated_at = datetime.utcnow()
    db.add(cluster)
    db.commit()
    db.refresh(cluster)
    if log_audit:
        log_action(
            db,
            action="update",
            entity_type="cluster_config",
            entity_id=cluster.id,
            description=f"Updated cluster '{cluster.name}'.",
        )
    return cluster


def delete_cluster(db: Session, cluster: models.ClusterConfig) -> None:
    cluster_id = cluster.id
    cluster_name = cluster.name
    schedules = db.query(models.InspectionSchedule).all()
    for schedule in schedules:
        if cluster_id not in schedule.cluster_ids:
            continue
        name_map = schedule.cluster_name_map
        if cluster_id not in name_map:
            name_map[cluster_id] = cluster_name
            schedule.set_cluster_name_map(name_map)
            schedule.updated_at = datetime.utcnow()
            db.add(schedule)
    related_agents = (
        db.query(models.InspectionAgent)
        .filter(
            (models.InspectionAgent.cluster_id == cluster_id)
            | (models.InspectionAgent.name == cluster_name)
        )
        .all()
    )
    removed_agent_ids = [agent.id for agent in related_agents]
    for agent in related_agents:
        db.delete(agent)
    db.delete(cluster)
    db.commit()
    log_action(
        db,
        action="delete",
        entity_type="cluster_config",
        entity_id=cluster_id,
        description=f"Deleted cluster '{cluster_name}'.",
    )
    if removed_agent_ids:
        log_action(
            db,
            action="delete",
            entity_type="inspection_agent",
            entity_id=None,
            description=(
                f"Removed {len(removed_agent_ids)} agent(s) bound to cluster '{cluster_name}'."
            ),
        )


def archive_cluster(db: Session, cluster: models.ClusterConfig) -> None:
    cluster_id = cluster.id
    cluster_name = cluster.name
    related_agents = (
        db.query(models.InspectionAgent)
        .filter(
            (models.InspectionAgent.cluster_id == cluster_id)
            | (models.InspectionAgent.name == cluster_name)
        )
        .all()
    )
    removed_agent_ids = [agent.id for agent in related_agents]
    for agent in related_agents:
        db.delete(agent)

    cluster.is_archived = True
    cluster.default_agent_id = None
    cluster.connection_status = "deleted"
    cluster.connection_message = "集群已删除"
    cluster.updated_at = datetime.utcnow()
    db.add(cluster)
    db.commit()

    log_action(
        db,
        action="delete",
        entity_type="cluster_config",
        entity_id=cluster_id,
        description=f"Deleted cluster '{cluster_name}'.",
    )
    if removed_agent_ids:
        log_action(
            db,
            action="delete",
            entity_type="inspection_agent",
            entity_id=None,
            description=(
                f"Removed {len(removed_agent_ids)} agent(s) bound to cluster '{cluster_name}'."
            ),
        )


def log_action(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: Optional[int],
    description: Optional[str] = None,
    user_id: Optional[int] = None,
    username: Optional[str] = None,
    ip_address: Optional[str] = None,
    user_agent: Optional[str] = None,
    status: str = "success",
) -> models.AuditLog:
    actor = get_audit_actor()
    if actor:
        if user_id is None:
            user_id = actor.user_id
        if username is None:
            username = actor.username
        if ip_address is None:
            ip_address = actor.ip_address
        if user_agent is None:
            user_agent = actor.user_agent
    entry = models.AuditLog(
        user_id=user_id,
        username=username,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        description=description,
        ip_address=ip_address,
        user_agent=user_agent,
        status=status or "success",
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return entry


def get_inspection_items(db: Session) -> List[models.InspectionItem]:
    return (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.is_archived.is_(False))
        .order_by(models.InspectionItem.id)
        .all()
    )


def get_inspection_item(db: Session, item_id: int) -> Optional[models.InspectionItem]:
    return (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.id == item_id)
        .first()
    )


def create_inspection_item(
    db: Session, item_in: schemas.InspectionItemCreate
) -> models.InspectionItem:
    data = item_in.model_dump()
    config = data.pop("config", None)
    item = models.InspectionItem(**data)
    item.set_config(config if isinstance(config, dict) else None)
    db.add(item)
    db.commit()
    db.refresh(item)
    log_action(
        db,
        action="create",
        entity_type="inspection_item",
        entity_id=item.id,
        description=f"Created inspection item '{item.name}'",
    )
    return item


def update_inspection_item(
    db: Session, item: models.InspectionItem, item_in: schemas.InspectionItemUpdate
) -> models.InspectionItem:
    data = item_in.model_dump(exclude_unset=True)
    config = data.pop("config", None)

    for key, value in data.items():
        setattr(item, key, value)

    if config is not None:
        item.set_config(config if isinstance(config, dict) else None)

    item.updated_at = datetime.utcnow()
    db.add(item)
    db.commit()
    db.refresh(item)
    log_action(
        db,
        action="update",
        entity_type="inspection_item",
        entity_id=item.id,
        description=f"Updated inspection item '{item.name}'",
    )
    return item


def delete_inspection_item(db: Session, item: models.InspectionItem) -> None:
    results = (
        db.query(models.InspectionResult)
        .filter(models.InspectionResult.item_id == item.id)
        .all()
    )
    for result in results:
        if not result.item_name_cached:
            result.item_name_cached = item.name or f"巡检项({item.id})"
        result.item_id = None
        db.add(result)

    item_id = item.id
    item_name = item.name
    db.delete(item)
    db.commit()
    log_action(
        db,
        action="delete",
        entity_type="inspection_item",
        entity_id=item_id,
        description=f"Deleted inspection item '{item_name}'",
    )


def get_items_by_ids(
    db: Session, item_ids: Iterable[int]
) -> List[models.InspectionItem]:
    ids = list(dict.fromkeys(item_ids))
    if not ids:
        return []
    items = (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.id.in_(ids))
        .all()
    )
    item_map = {item.id: item for item in items}
    return [item_map[item_id] for item_id in ids if item_id in item_map]


def filter_items_for_cluster(
    cluster: models.ClusterConfig,
    items: Iterable[models.InspectionItem],
) -> List[models.InspectionItem]:
    if getattr(cluster, "is_rancher_local", False):
        return list(items)
    return [
        item
        for item in items
        if (item.check_type or "").strip() != "rancher_local"
    ]


def create_inspection_run(
    db: Session,
    *,
    operator: Optional[str],
    cluster: models.ClusterConfig,
    status: str = "queued",
    total_items: int = 0,
    processed_items: int = 0,
    plan_json: Optional[str] = None,
    prometheus_version: str = "3.2",
    executor: str = "server",
    agent_status: Optional[str] = None,
    agent_id: Optional[int] = None,
    log_audit: bool = True,
    created_by_user_id: Optional[int] = None,
    created_by_username: Optional[str] = None,
) -> models.InspectionRun:
    run = models.InspectionRun(
        operator=operator,
        created_by_user_id=created_by_user_id,
        created_by_username=created_by_username,
        cluster_id=cluster.id,
        status=status,
        total_items=max(0, total_items),
        processed_items=max(0, processed_items),
        plan_json=plan_json,
        prometheus_version=prometheus_version,
        executor=executor,
        agent_status=agent_status,
        agent_id=agent_id,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    if log_audit and (operator or "") != CONNECTION_TEST_OPERATOR:
        run_label = describe_inspection_run(db, run, cluster)
        audit_override = _resolve_run_audit_override(run)
        log_action(
            db,
            action="create",
            entity_type="inspection_run",
            entity_id=run.id,
            description=f"创建巡检记录：{run_label}",
            **audit_override,
        )
    return run


def finalize_inspection_run(
    db: Session,
    *,
    run: models.InspectionRun,
    status: str,
    summary: str,
    report_path: Optional[str],
    processed_items: Optional[int] = None,
) -> models.InspectionRun:
    run.status = status
    run.summary = summary
    run.report_path = report_path
    if processed_items is None:
        processed = run.total_items if run.total_items else run.processed_items
    else:
        processed = processed_items
    if run.total_items:
        processed = min(max(processed, run.total_items), run.total_items)
    run.processed_items = max(processed, run.processed_items or 0)
    run.completed_at = datetime.utcnow()
    db.add(run)
    db.commit()
    db.refresh(run)
    if _should_log_run(run):
        run_label = describe_inspection_run(db, run)
        audit_override = _resolve_run_audit_override(run)
        log_action(
            db,
            action="update",
            entity_type="inspection_run",
            entity_id=run.id,
            description=f"更新巡检记录（状态 {status}）：{run_label}",
            **audit_override,
        )
    return run


def add_inspection_result(
    db: Session,
    *,
    run: models.InspectionRun,
    item: Optional[models.InspectionItem],
    status: str,
    detail: Optional[str],
    suggestion: Optional[str],
) -> models.InspectionResult:
    item_id = item.id if item else None
    item_name = ""
    if item:
        item_name = item.name or f"巡检项({item.id})"
    else:
        item_name = "巡检项"
    result = models.InspectionResult(
        run_id=run.id,
        item_id=item_id,
        status=status,
        detail=detail,
        suggestion=suggestion,
        item_name_cached=item_name,
    )
    db.add(result)
    db.commit()
    db.refresh(result)
    return result


def update_inspection_run_progress(
    db: Session,
    *,
    run: models.InspectionRun,
    processed_items: int,
) -> models.InspectionRun:
    run.processed_items = max(0, min(processed_items, run.total_items or processed_items))
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def list_inspection_agents(db: Session) -> List[models.InspectionAgent]:
    return (
        db.query(models.InspectionAgent)
        .options(selectinload(models.InspectionAgent.cluster))
        .order_by(models.InspectionAgent.created_at.desc())
        .all()
    )


def get_inspection_agent(db: Session, agent_id: int) -> Optional[models.InspectionAgent]:
    return (
        db.query(models.InspectionAgent)
        .filter(models.InspectionAgent.id == agent_id)
        .first()
    )


def get_inspection_agent_by_token(db: Session, token: str) -> Optional[models.InspectionAgent]:
    return (
        db.query(models.InspectionAgent)
        .filter(models.InspectionAgent.token == token)
        .first()
    )


def get_inspection_agent_by_name(
    db: Session, name: str
) -> Optional[models.InspectionAgent]:
    trimmed = name.strip()
    if not trimmed:
        return None
    return (
        db.query(models.InspectionAgent)
        .filter(models.InspectionAgent.name == trimmed)
        .first()
    )


def create_inspection_agent(
    db: Session,
    *,
    name: str,
    token: str,
    cluster: Optional[models.ClusterConfig] = None,
    description: Optional[str] = None,
    is_enabled: bool = True,
    prometheus_url: Optional[str] = None,
) -> models.InspectionAgent:
    agent = models.InspectionAgent(
        name=name,
        token=token,
        cluster_id=cluster.id if cluster else None,
        description=description,
        is_enabled=is_enabled,
        prometheus_url=prometheus_url,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    log_action(
        db,
        action="create",
        entity_type="inspection_agent",
        entity_id=agent.id,
        description=f"创建巡检 Agent '{agent.name}'",
    )
    return agent


def update_inspection_agent(
    db: Session,
    agent: models.InspectionAgent,
    *,
    name: Optional[str] = None,
    description: Optional[str] = None,
    is_enabled: Optional[bool] = None,
    cluster: Any = UNSET,
    prometheus_url: Any = UNSET,
    log_audit: bool = True,
) -> models.InspectionAgent:
    if name is not None:
        agent.name = name
    if description is not None:
        agent.description = description
    if is_enabled is not None:
        agent.is_enabled = is_enabled
    if cluster is not UNSET:
        agent.cluster_id = cluster.id if isinstance(cluster, models.ClusterConfig) else None
    if prometheus_url is not UNSET:
        agent.prometheus_url = prometheus_url
    agent.updated_at = datetime.utcnow()
    db.add(agent)
    db.commit()
    db.refresh(agent)
    if log_audit:
        log_action(
            db,
            action="update",
            entity_type="inspection_agent",
            entity_id=agent.id,
            description=f"更新巡检 Agent '{agent.name}'",
        )
    return agent


def delete_inspection_agent(
    db: Session,
    agent: models.InspectionAgent,
    *,
    reason: Optional[str] = None,
) -> None:
    agent_id = agent.id
    agent_name = agent.name
    db.delete(agent)
    db.commit()
    log_action(
        db,
        action="delete",
        entity_type="inspection_agent",
        entity_id=agent_id,
        description=reason or f"Deleted inspection agent '{agent_name}'.",
    )


def record_agent_heartbeat(
    db: Session,
    agent: models.InspectionAgent,
    *,
    seen_at: Optional[datetime] = None,
    nodes_output: Optional[str] = None,
    nodes_output_at: Optional[datetime] = None,
    node_total: Optional[int] = None,
    node_ready: Optional[int] = None,
    pod_count: Optional[int] = None,
) -> models.InspectionAgent:
    agent.last_seen_at = seen_at or datetime.utcnow()
    if nodes_output is not None:
        agent.nodes_output = nodes_output
        agent.nodes_output_at = nodes_output_at or agent.last_seen_at
        agent.nodes_report_requested_at = None
    if node_total is not None:
        agent.node_total = node_total
    if node_ready is not None:
        agent.node_ready = node_ready
    if pod_count is not None:
        agent.pod_count = pod_count
    if any(value is not None for value in (node_total, node_ready, pod_count)):
        agent.metrics_reported_at = agent.last_seen_at
    agent.updated_at = datetime.utcnow()
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


def create_cluster_metric_sample(
    db: Session,
    *,
    cluster_id: int,
    agent_id: Optional[int],
    cpu_usage: Optional[float],
    memory_usage: Optional[float],
    reported_at: datetime,
) -> models.ClusterMetricSample:
    sample = models.ClusterMetricSample(
        cluster_id=cluster_id,
        agent_id=agent_id,
        cpu_usage=cpu_usage,
        memory_usage=memory_usage,
        reported_at=reported_at,
    )
    db.add(sample)
    db.commit()
    db.refresh(sample)
    return sample


def delete_metric_samples_before(
    db: Session,
    *,
    cutoff: datetime,
) -> int:
    if not cutoff:
        return 0
    deleted = (
        db.query(models.ClusterMetricSample)
        .filter(models.ClusterMetricSample.reported_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return int(deleted or 0)


def request_agent_nodes_report(
    db: Session,
    agent: models.InspectionAgent,
    *,
    requested_at: Optional[datetime] = None,
) -> models.InspectionAgent:
    agent.nodes_report_requested_at = requested_at or datetime.utcnow()
    agent.updated_at = datetime.utcnow()
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


def list_agent_runs(
    db: Session,
    *,
    agent: models.InspectionAgent,
    statuses: Iterable[str] = ("queued", "running"),
    limit: int = 10,
) -> List[models.InspectionRun]:
    return (
        db.query(models.InspectionRun)
        .options(
            selectinload(models.InspectionRun.cluster),
            selectinload(models.InspectionRun.results),
            selectinload(models.InspectionRun.agent),
        )
        .filter(
            models.InspectionRun.agent_id == agent.id,
            models.InspectionRun.executor == "agent",
            models.InspectionRun.agent_status.in_(tuple(statuses)),
        )
        .order_by(models.InspectionRun.created_at.asc())
        .limit(limit)
        .all()
    )


def update_inspection_run_agent_state(
    db: Session,
    run: models.InspectionRun,
    *,
    agent_status: Optional[str] = None,
    status: Optional[str] = None,
    processed_items: Optional[int] = None,
) -> models.InspectionRun:
    if agent_status is not None:
        run.agent_status = agent_status
    if status is not None:
        run.status = status
    if processed_items is not None:
        run.processed_items = processed_items
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def delete_run_results(db: Session, run: models.InspectionRun) -> None:
    db.query(models.InspectionResult).filter(
        models.InspectionResult.run_id == run.id
    ).delete()
    db.commit()


def delete_inspection_runs_bulk(
    db: Session,
    run_ids: Iterable[int],
    *,
    log_description: Optional[str] = None,
) -> int:
    """
    批量删除巡检记录及其结果，减少逐条提交带来的性能开销。
    """
    ids = [int(run_id) for run_id in dict.fromkeys(run_ids) if run_id is not None]
    if not ids:
        return 0

    runs = (
        db.query(models.InspectionRun)
        .filter(models.InspectionRun.id.in_(ids))
        .all()
    )
    if not runs:
        return 0

    should_log = any(_should_log_run(run) for run in runs)

    # 先删除结果，再删除巡检记录，统一提交一次
    db.query(models.InspectionResult).filter(
        models.InspectionResult.run_id.in_(ids)
    ).delete(synchronize_session=False)
    db.query(models.InspectionRun).filter(
        models.InspectionRun.id.in_(ids)
    ).delete(synchronize_session=False)
    db.commit()

    if should_log:
        description = log_description or f"批量删除 {len(ids)} 条巡检记录"
        log_action(
            db,
            action="delete",
            entity_type="inspection_run",
            entity_id=None,
            description=description,
        )
    return len(runs)


def add_run_result_by_item_id(
    db: Session,
    run: models.InspectionRun,
    item_id: Optional[int],
    status: str,
    detail: Optional[str],
    suggestion: Optional[str],
    *,
    replace_existing: bool = False,
) -> models.InspectionResult:
    item = None
    if item_id is not None:
        item = (
            db.query(models.InspectionItem)
            .filter(models.InspectionItem.id == item_id)
            .first()
        )

    existing: Optional[models.InspectionResult] = None
    if replace_existing:
        query = db.query(models.InspectionResult).filter(
            models.InspectionResult.run_id == run.id,
        )
        if item_id is not None:
            query = query.filter(models.InspectionResult.item_id == item_id)
        else:
            query = query.filter(models.InspectionResult.item_id.is_(None))
        existing = query.order_by(models.InspectionResult.id.desc()).first()
        if existing:
            existing.status = status
            existing.detail = detail
            existing.suggestion = suggestion
            if item and item.name:
                existing.item_name_cached = item.name
            db.add(existing)
            db.commit()
            db.refresh(existing)
            return existing

    return add_inspection_result(
        db,
        run=run,
        item=item,
        status=status,
        detail=detail,
        suggestion=suggestion,
    )


def count_run_results(db: Session, run: models.InspectionRun) -> int:
    return (
        db.query(func.count(models.InspectionResult.id))
        .filter(models.InspectionResult.run_id == run.id)
        .scalar()
        or 0
    )


def get_run_result_status_counts(
    db: Session, run: models.InspectionRun
) -> dict[str, int]:
    rows = (
        db.query(models.InspectionResult.status, func.count(models.InspectionResult.id))
        .filter(models.InspectionResult.run_id == run.id)
        .group_by(models.InspectionResult.status)
        .all()
    )
    return {str(status): int(count) for status, count in rows}


def pause_inspection_run(
    db: Session,
    run: models.InspectionRun,
) -> models.InspectionRun:
    run.status = "paused"
    if run.executor == "agent":
        run.agent_status = "paused"
    db.add(run)
    db.commit()
    db.refresh(run)
    if _should_log_run(run):
        run_label = describe_inspection_run(db, run)
        audit_override = _resolve_run_audit_override(run)
        log_action(
            db,
            action="update",
            entity_type="inspection_run",
            entity_id=run.id,
            description=f"暂停巡检记录：{run_label}",
            **audit_override,
        )
    return run


def resume_inspection_run(
    db: Session,
    run: models.InspectionRun,
) -> models.InspectionRun:
    run.status = "running"
    if run.executor == "agent":
        run.agent_status = "queued"
    run.completed_at = None
    db.add(run)
    db.commit()
    db.refresh(run)
    if _should_log_run(run):
        run_label = describe_inspection_run(db, run)
        audit_override = _resolve_run_audit_override(run)
        log_action(
            db,
            action="update",
            entity_type="inspection_run",
            entity_id=run.id,
            description=f"恢复巡检记录：{run_label}",
            **audit_override,
        )
    return run


def cancel_inspection_run(
    db: Session,
    run: models.InspectionRun,
    reason: Optional[str] = None,
) -> models.InspectionRun:
    run.status = "cancelled"
    run.report_path = None
    if run.executor == "agent":
        run.agent_status = "failed"
    run.completed_at = datetime.utcnow()
    if reason:
        run.summary = reason[:500]
    elif not run.summary:
        run.summary = "巡检已取消"
    db.add(run)
    db.commit()
    db.refresh(run)
    if _should_log_run(run):
        run_label = describe_inspection_run(db, run)
        audit_override = _resolve_run_audit_override(run)
        log_action(
            db,
            action="update",
            entity_type="inspection_run",
            entity_id=run.id,
            description=f"取消巡检记录：{run_label}",
            **audit_override,
        )
    return run


def list_inspection_runs(db: Session) -> List[models.InspectionRun]:
    return (
        db.query(models.InspectionRun)
        .options(
            selectinload(models.InspectionRun.cluster),
            selectinload(models.InspectionRun.agent),
        )
        .order_by(models.InspectionRun.created_at.desc())
        .all()
    )


def get_inspection_run(db: Session, run_id: int) -> Optional[models.InspectionRun]:
    return (
        db.query(models.InspectionRun)
        .options(
            selectinload(models.InspectionRun.results).selectinload(
                models.InspectionResult.item
            ),
            selectinload(models.InspectionRun.cluster),
            selectinload(models.InspectionRun.agent),
        )
        .filter(models.InspectionRun.id == run_id)
        .first()
    )


def delete_inspection_run(db: Session, run: models.InspectionRun) -> None:
    run_id = run.id
    run_label = describe_inspection_run(db, run)
    db.delete(run)
    db.commit()
    if _should_log_run(run):
        audit_override = _resolve_run_audit_override(run)
        log_action(
            db,
            action="delete",
            entity_type="inspection_run",
            entity_id=run_id,
            description=f"删除巡检记录：{run_label}",
            **audit_override,
        )


def list_inspection_schedules(db: Session) -> List[models.InspectionSchedule]:
    return (
        db.query(models.InspectionSchedule)
        .order_by(models.InspectionSchedule.created_at.desc())
        .all()
    )


def get_inspection_schedule(
    db: Session, schedule_id: int
) -> Optional[models.InspectionSchedule]:
    return (
        db.query(models.InspectionSchedule)
        .filter(models.InspectionSchedule.id == schedule_id)
        .first()
    )


def create_inspection_schedule(
    db: Session,
    schedule_in: schemas.InspectionScheduleCreate,
    *,
    created_by_user_id: Optional[int] = None,
    created_by_username: Optional[str] = None,
) -> models.InspectionSchedule:
    payload = schedule_in.model_dump()
    cluster_ids = payload.pop("cluster_ids", [])
    item_ids = payload.pop("item_ids", [])
    cluster_name_map = {
        cluster.id: cluster.name
        for cluster in db.query(models.ClusterConfig)
        .filter(models.ClusterConfig.id.in_(cluster_ids))
        .all()
    }
    schedule = models.InspectionSchedule(**payload)
    schedule.created_by_user_id = created_by_user_id
    schedule.created_by_username = created_by_username
    schedule.set_cluster_ids(cluster_ids)
    schedule.set_cluster_name_map(cluster_name_map)
    schedule.set_item_ids(item_ids)
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    log_action(
        db,
        action="create",
        entity_type="inspection_schedule",
        entity_id=schedule.id,
        description=f"Created inspection schedule '{schedule.name or schedule.id}'.",
    )
    return schedule


def update_inspection_schedule(
    db: Session,
    schedule: models.InspectionSchedule,
    schedule_in: schemas.InspectionScheduleUpdate,
) -> models.InspectionSchedule:
    previous_name_map = schedule.cluster_name_map
    payload = schedule_in.model_dump(exclude_unset=True)
    if "cluster_ids" in payload:
        cluster_ids = payload.pop("cluster_ids") or []
        schedule.set_cluster_ids(cluster_ids)
        current_name_map = {
            cluster.id: cluster.name
            for cluster in db.query(models.ClusterConfig)
            .filter(models.ClusterConfig.id.in_(cluster_ids))
            .all()
        }
        for cluster_id in cluster_ids:
            if cluster_id not in current_name_map and cluster_id in previous_name_map:
                current_name_map[cluster_id] = previous_name_map[cluster_id]
        schedule.set_cluster_name_map(current_name_map)
    if "item_ids" in payload:
        schedule.set_item_ids(payload.pop("item_ids") or [])
    for key, value in payload.items():
        setattr(schedule, key, value)
    schedule.updated_at = datetime.utcnow()
    db.add(schedule)
    db.commit()
    db.refresh(schedule)
    log_action(
        db,
        action="update",
        entity_type="inspection_schedule",
        entity_id=schedule.id,
        description=f"Updated inspection schedule '{schedule.name or schedule.id}'.",
    )
    return schedule


def delete_inspection_schedule(
    db: Session, schedule: models.InspectionSchedule
) -> None:
    schedule_id = schedule.id
    schedule_name = schedule.name
    db.delete(schedule)
    db.commit()
    log_action(
        db,
        action="delete",
        entity_type="inspection_schedule",
        entity_id=schedule_id,
        description=f"Deleted inspection schedule '{schedule_name or schedule_id}'.",
    )


def list_audit_logs(
    db: Session,
    *,
    page: int = 1,
    page_size: int = 20,
    action: Optional[str] = None,
    entity_type: Optional[str] = None,
    keyword: Optional[str] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> tuple[List[models.AuditLog], int]:
    query = db.query(models.AuditLog)

    known_entity_types = {
        "auth_user",
        "auth_role",
        "cluster_config",
        "inspection_agent",
        "inspection_schedule",
        "inspection_run",
        "inspection_item",
        "inspection_result",
        "prometheus_version",
    }

    if entity_type:
        if entity_type == "cluster":
            query = query.filter(
                models.AuditLog.entity_type.in_(
                    ["cluster_config", "inspection_agent"]
                )
            )
        elif entity_type == "other":
            query = query.filter(
                models.AuditLog.entity_type.notin_(sorted(known_entity_types))
            )
        else:
            query = query.filter(models.AuditLog.entity_type == entity_type)

    if entity_type == "inspection_run":
        allowed_actions = {"create", "update", "delete", "download", "query"}
        if action:
            if action not in allowed_actions:
                return [], 0
            query = query.filter(models.AuditLog.action == action)
        else:
            query = query.filter(models.AuditLog.action.in_(allowed_actions))
    elif action:
        query = query.filter(models.AuditLog.action == action)
    if start:
        query = query.filter(models.AuditLog.created_at >= start)
    if end:
        query = query.filter(models.AuditLog.created_at <= end)
    if keyword:
        normalized = f"%{keyword.strip().lower()}%"
        query = query.filter(
            or_(
                func.lower(models.AuditLog.username).like(normalized),
                func.lower(models.AuditLog.action).like(normalized),
                func.lower(models.AuditLog.entity_type).like(normalized),
                func.lower(models.AuditLog.description).like(normalized),
            )
        )

    total = query.count()
    offset = max(page - 1, 0) * max(page_size, 1)
    items = (
        query.order_by(models.AuditLog.created_at.desc())
        .offset(offset)
        .limit(page_size)
        .all()
    )
    return items, total

