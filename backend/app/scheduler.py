from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from typing import Iterable, Optional

from sqlalchemy.orm import Session

from . import crud, models
from .cron import CronValidationError, cron_matches
from .database import SessionLocal
from .license import LicenseError, license_manager

logger = logging.getLogger(__name__)

DEFAULT_PROMETHEUS_VERSION = "3.2"
MULTI_PROMETHEUS_VERSION_LABEL = "multi"
DEFAULT_OPERATOR = "定时巡检任务"
SCHEDULE_OPERATOR_SUFFIX = "（定时巡检）"


def _normalize_prometheus_version(value: Optional[str]) -> str:
    if value is None:
        return DEFAULT_PROMETHEUS_VERSION
    trimmed = str(value).strip()
    return trimmed or DEFAULT_PROMETHEUS_VERSION


def _resolve_active_agent(
    db: Session, cluster: models.ClusterConfig
) -> Optional[models.InspectionAgent]:
    agent = cluster.default_agent
    if agent and agent.is_enabled:
        return agent
    fallback = (
        db.query(models.InspectionAgent)
        .filter(
            models.InspectionAgent.cluster_id == cluster.id,
            models.InspectionAgent.is_enabled.is_(True),
        )
        .order_by(models.InspectionAgent.updated_at.desc())
        .first()
    )
    return fallback


def _build_run_plan(items: Iterable[models.InspectionItem]) -> str:
    plan = []
    for item in items:
        plan.append(
            {
                "id": item.id,
                "name": item.name,
                "description": item.description,
                "check_type": item.check_type,
                "config": item.config,
            }
        )
    return json.dumps(plan, ensure_ascii=False)


def _derive_prometheus_version(
    items: Iterable[models.InspectionItem],
    multi_label: str,
) -> str:
    versions = {
        _normalize_prometheus_version(item.prometheus_version)
        for item in items
        if (item.check_type or "").strip() == "promql"
    }
    if not versions:
        return DEFAULT_PROMETHEUS_VERSION
    if len(versions) == 1:
        return next(iter(versions))
    return multi_label


def _normalize_operator(name: Optional[str], fallback: str) -> str:
    if not name:
        return fallback
    trimmed = name.strip()
    return trimmed or fallback


def _format_schedule_operator(
    name: Optional[str], fallback: str
) -> str:
    base = _normalize_operator(name, fallback)
    if base.endswith(SCHEDULE_OPERATOR_SUFFIX):
        return base
    return f"{base}{SCHEDULE_OPERATOR_SUFFIX}"


def _resolve_schedule_creator(
    db: Session,
    schedule: models.InspectionSchedule,
) -> tuple[Optional[int], Optional[str]]:
    if schedule.created_by_user_id or schedule.created_by_username:
        return schedule.created_by_user_id, schedule.created_by_username
    entry = (
        db.query(models.AuditLog)
        .filter(
            models.AuditLog.entity_type == "inspection_schedule",
            models.AuditLog.entity_id == schedule.id,
            models.AuditLog.action == "create",
        )
        .order_by(models.AuditLog.created_at.desc())
        .first()
    )
    if not entry or not entry.username:
        return None, None
    schedule.created_by_user_id = entry.user_id
    schedule.created_by_username = entry.username
    schedule.updated_at = datetime.utcnow()
    db.add(schedule)
    db.commit()
    return entry.user_id, entry.username


def _should_skip_by_minute(schedule: models.InspectionSchedule, now: datetime) -> bool:
    if not schedule.last_run_at:
        return False
    previous = schedule.last_run_at.replace(second=0, microsecond=0)
    current = now.replace(second=0, microsecond=0)
    return previous == current


def _dispatch_schedule_runs(
    db: Session,
    schedule: models.InspectionSchedule,
    *,
    operator_label: str,
    multi_version_label: str,
) -> int:
    item_ids = schedule.item_ids
    cluster_ids = schedule.cluster_ids
    if not item_ids or not cluster_ids:
        return 0

    items = [
        item
        for item in crud.get_items_by_ids(db, item_ids)
        if not item.is_archived
    ]
    if not items:
        return 0

    plan_json = _build_run_plan(items)
    prometheus_version = _derive_prometheus_version(items, multi_version_label)
    operator = _format_schedule_operator(schedule.name, operator_label)
    created_by_user_id, created_by_username = _resolve_schedule_creator(db, schedule)

    created = 0
    for cluster_id in cluster_ids:
        cluster = crud.get_cluster(db, cluster_id)
        if not cluster or cluster.is_archived:
            continue
        agent = _resolve_active_agent(db, cluster)
        if not agent:
            continue
        crud.create_inspection_run(
            db,
            operator=operator,
            cluster=cluster,
            status="queued",
            total_items=len(items),
            processed_items=0,
            plan_json=plan_json,
            prometheus_version=prometheus_version,
            executor="agent",
            agent_status="queued",
            agent_id=agent.id,
            created_by_user_id=created_by_user_id,
            created_by_username=created_by_username,
        )
        created += 1
    return created


class InspectionScheduler:
    def __init__(
        self,
        interval_seconds: int = 30,
        *,
        operator_label: str = DEFAULT_OPERATOR,
        multi_version_label: str = MULTI_PROMETHEUS_VERSION_LABEL,
    ) -> None:
        self._interval_seconds = max(5, int(interval_seconds))
        self._operator_label = operator_label
        self._multi_version_label = multi_version_label
        self._stop_event = threading.Event()
        self._thread = threading.Thread(
            target=self._run_loop,
            name="inspection-scheduler",
            daemon=True,
        )

    def start(self) -> None:
        if self._thread.is_alive():
            return
        self._thread.start()

    def stop(self, timeout_seconds: int = 5) -> None:
        self._stop_event.set()
        if self._thread.is_alive():
            self._thread.join(timeout=timeout_seconds)

    def _run_loop(self) -> None:
        logger.info("Inspection scheduler started.")
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception:
                logger.exception("Inspection scheduler tick failed.")
            self._stop_event.wait(self._interval_seconds)
        logger.info("Inspection scheduler stopped.")

    def _tick(self) -> None:
        now = datetime.now()
        try:
            license_manager.require(["inspections"])
        except LicenseError as exc:
            logger.info("Skip inspection schedules due to license: %s", exc)
            return
        with SessionLocal() as db:
            schedules = crud.list_inspection_schedules(db)
            for schedule in schedules:
                if not schedule.is_enabled:
                    continue
                if _should_skip_by_minute(schedule, now):
                    continue
                try:
                    if not cron_matches(schedule.cron, now):
                        continue
                except CronValidationError:
                    logger.warning(
                        "Skip schedule %s due to invalid cron: %s",
                        schedule.id,
                        schedule.cron,
                    )
                    continue
                created = _dispatch_schedule_runs(
                    db,
                    schedule,
                    operator_label=self._operator_label,
                    multi_version_label=self._multi_version_label,
                )
                if created > 0:
                    schedule.last_run_at = now
                    schedule.updated_at = now
                    db.add(schedule)
                    db.commit()
