from __future__ import annotations

from datetime import datetime
from typing import Iterable, List, Optional, Any

from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from . import models, schemas
from .audit import get_audit_actor

UNSET = object()


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
    connection_status: Optional[str] = None,
    connection_message: Optional[str] = None,
    last_checked_at: Optional[datetime] = None,
    execution_mode: Optional[str] = None,
    default_agent_id: Any = UNSET,
    is_archived: Any = UNSET,
    description: Optional[str] = None,
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
) -> models.InspectionRun:
    run = models.InspectionRun(
        operator=operator,
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
    log_action(
        db,
        action="create",
        entity_type="inspection_run",
        entity_id=run.id,
        description=f"Created inspection run (status={status})",
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
    log_action(
        db,
        action="update",
        entity_type="inspection_run",
        entity_id=run.id,
        description=f"Run finalized with status={status}",
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
) -> models.InspectionAgent:
    agent.last_seen_at = seen_at or datetime.utcnow()
    if nodes_output is not None:
        agent.nodes_output = nodes_output
        agent.nodes_output_at = nodes_output_at or agent.last_seen_at
        agent.nodes_report_requested_at = None
    agent.updated_at = datetime.utcnow()
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return agent


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
    log_action(
        db,
        action="update",
        entity_type="inspection_run",
        entity_id=run.id,
        description="Paused inspection run.",
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
    log_action(
        db,
        action="update",
        entity_type="inspection_run",
        entity_id=run.id,
        description="Resumed inspection run.",
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
    log_action(
        db,
        action="update",
        entity_type="inspection_run",
        entity_id=run.id,
        description="Cancelled inspection run.",
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
    db.delete(run)
    db.commit()
    log_action(
        db,
        action="delete",
        entity_type="inspection_run",
        entity_id=run_id,
        description=f"Deleted inspection run {run_id}.",
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
    db: Session, schedule_in: schemas.InspectionScheduleCreate
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

    if entity_type:
        if entity_type == "cluster":
            query = query.filter(
                models.AuditLog.entity_type.in_(
                    ["cluster_config", "inspection_agent"]
                )
            )
        else:
            query = query.filter(models.AuditLog.entity_type == entity_type)

    if entity_type == "inspection_run":
        allowed_actions = {"create", "delete", "download"}
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

