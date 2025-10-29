from __future__ import annotations

from datetime import datetime
from typing import Iterable, List, Optional

from sqlalchemy.orm import Session, selectinload

from . import models, schemas


def list_clusters(db: Session) -> List[models.ClusterConfig]:
    return db.query(models.ClusterConfig).order_by(models.ClusterConfig.name).all()


def get_cluster(db: Session, cluster_id: int) -> Optional[models.ClusterConfig]:
    return (
        db.query(models.ClusterConfig)
        .filter(models.ClusterConfig.id == cluster_id)
        .first()
    )


def get_cluster_by_name(db: Session, name: str) -> Optional[models.ClusterConfig]:
    return (
        db.query(models.ClusterConfig)
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
) -> models.ClusterConfig:
    cluster = models.ClusterConfig(
        name=name,
        kubeconfig_path=kubeconfig_path,
        contexts_json=contexts_json,
        prometheus_url=prometheus_url,
        connection_status=connection_status,
        connection_message=connection_message,
        last_checked_at=last_checked_at,
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
    return (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.id.in_(list(item_ids)))
        .all()
    )


def create_inspection_run(
    db: Session,
    *,
    operator: Optional[str],
    cluster: models.ClusterConfig,
    status: str = "pending",
) -> models.InspectionRun:
    run = models.InspectionRun(
        operator=operator,
        cluster_id=cluster.id,
        status=status,
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
) -> models.InspectionRun:
    run.status = status
    run.summary = summary
    run.report_path = report_path
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
    item: models.InspectionItem,
    status: str,
    detail: Optional[str],
    suggestion: Optional[str],
) -> models.InspectionResult:
    result = models.InspectionResult(
        run_id=run.id,
        item_id=item.id,
        status=status,
        detail=detail,
        suggestion=suggestion,
        item_name_cached=item.name or f"巡检项({item.id})",
    )
    db.add(result)
    db.commit()
    db.refresh(result)
    log_action(
        db,
        action="create",
        entity_type="inspection_result",
        entity_id=result.id,
        description=f"Recorded result for item '{item.name}' with status={status}",
    )
    return result


def list_inspection_runs(db: Session) -> List[models.InspectionRun]:
    return (
        db.query(models.InspectionRun)
        .options(selectinload(models.InspectionRun.cluster))
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

