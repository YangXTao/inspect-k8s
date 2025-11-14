from __future__ import annotations

from datetime import datetime
from typing import Iterable, List, Optional, Any

from sqlalchemy.orm import Session, selectinload

from . import models, schemas

UNSET = object()


def list_clusters(db: Session) -> List[models.ClusterConfig]:
    return (
        db.query(models.ClusterConfig)
        .options(selectinload(models.ClusterConfig.default_agent))
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
    execution_mode: str = "server",
    default_agent_id: Optional[int] = None,
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
    kubeconfig_path: Optional[str] = None,
    contexts_json: Optional[str] = None,
    prometheus_url: Optional[str] = None,
    connection_status: Optional[str] = None,
    connection_message: Optional[str] = None,
    last_checked_at: Optional[datetime] = None,
    execution_mode: Optional[str] = None,
    default_agent_id: Any = UNSET,
) -> models.ClusterConfig:
    if name is not None:
        cluster.name = name
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
    if default_agent_id is not UNSET:
        cluster.default_agent_id = default_agent_id
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
    db.delete(cluster)
    db.commit()
    log_action(
        db,
        action="delete",
        entity_type="cluster_config",
        entity_id=cluster_id,
        description=f"Deleted cluster '{cluster_name}'.",
    )


def log_action(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: Optional[int],
    description: Optional[str] = None,
) -> models.AuditLog:
    entry = models.AuditLog(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        description=description,
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
    log_action(
        db,
        action="create",
        entity_type="inspection_result",
        entity_id=result.id,
        description=f"Recorded result for item '{item_name}' with status={status}",
    )
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


def record_agent_heartbeat(
    db: Session,
    agent: models.InspectionAgent,
    *,
    seen_at: Optional[datetime] = None,
) -> models.InspectionAgent:
    agent.last_seen_at = seen_at or datetime.utcnow()
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
) -> models.InspectionResult:
    item = None
    if item_id is not None:
        item = (
            db.query(models.InspectionItem)
            .filter(models.InspectionItem.id == item_id)
            .first()
        )
    return add_inspection_result(
        db,
        run=run,
        item=item,
        status=status,
        detail=detail,
        suggestion=suggestion,
    )


def pause_inspection_run(
    db: Session,
    run: models.InspectionRun,
) -> models.InspectionRun:
    run.status = "paused"
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


def list_audit_logs(db: Session, limit: int = 100) -> List[models.AuditLog]:
    return (
        db.query(models.AuditLog)
        .order_by(models.AuditLog.created_at.desc())
        .limit(limit)
        .all()
    )

