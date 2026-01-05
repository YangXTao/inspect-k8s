from __future__ import annotations

import json
import logging
import re
import secrets
from dataclasses import dataclass
import base64
import binascii
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional, Any, Generator, Iterable
from uuid import uuid4
import yaml
from fastapi import APIRouter, Depends, FastAPI, File, Form, HTTPException, UploadFile, Query, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from pydantic import ValidationError

from . import crud, models, schemas
from .database import SessionLocal, ensure_runtime_directories, init_db
from .inspections import CheckContext, DEFAULT_CHECKS, dispatch_checks
from .license import LicenseError, license_manager
from .pdf import generate_markdown_report, generate_pdf_report
from .prometheus import PrometheusClient

logger = logging.getLogger(__name__)

_DEFAULT_INSPECTIONS_SENTINEL = Path("data/state/default_inspections_seeded.flag")
AGENT_HEARTBEAT_TIMEOUT_MINUTES = 5
AGENT_HEARTBEAT_TIMEOUT = timedelta(minutes=AGENT_HEARTBEAT_TIMEOUT_MINUTES)
CONNECTION_TEST_OPERATOR = "__system_connection_test__"


@dataclass
class AgentRequestContext:
    db: Session
    agent: models.InspectionAgent


def _requeue_stale_agent_runs(db: Session) -> int:
    deadline = datetime.utcnow() - AGENT_HEARTBEAT_TIMEOUT
    candidates = (
        db.query(models.InspectionRun)
        .filter(
            models.InspectionRun.executor == "agent",
            models.InspectionRun.status == "running",
            models.InspectionRun.agent_status == "running",
        )
        .all()
    )
    recovered = 0
    for run in candidates:
        agent = run.agent
        if not agent:
            continue
        last_seen = agent.last_seen_at
        if last_seen and last_seen >= deadline:
            continue
        note = (
            f"Agent {agent.name or agent.id} 超过 {AGENT_HEARTBEAT_TIMEOUT_MINUTES} 分钟未上报，任务已重新排队。"
        )
        run.status = "queued"
        run.agent_status = "queued"
        run.completed_at = None
        run.report_path = None
        if run.summary:
            run.summary = f"{run.summary}\n{note}"
        else:
            run.summary = note
        db.add(run)
        recovered += 1
    if recovered:
        db.commit()
        logger.warning("已回滚 %s 个超时的 Agent 巡检任务。", recovered)
    return recovered


def _normalise_cluster_name(name: str | None) -> str:
    if not name:
        return "cluster"
    import re as _re
    slug = _re.sub(r"\s+", "-", name.strip().lower())
    return slug or "cluster"


def _build_run_display_id(db: Session, run: models.InspectionRun) -> str:
    cluster_name = getattr(run.cluster, "name", None) or getattr(run, "cluster_name", None) or "cluster"
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


def _calculate_run_progress(run: models.InspectionRun) -> tuple[int, int, int]:
    total_items = run.total_items or 0
    processed_items = run.processed_items or 0
    status = (run.status or "").lower()
    if total_items > 0:
        processed_items = max(0, min(processed_items, total_items))
        if status in {"finished", "failed"}:
            processed_items = max(processed_items, total_items)
        elif status in {"queued"}:
            processed_items = 0
        progress = int((processed_items / total_items) * 100)
    else:
        progress = 0 if status in {"queued", "running"} else 100
    progress = max(0, min(progress, 100))
    return total_items, processed_items, progress


def _summarize_run_outcome(
    *,
    total_items: int,
    processed_total: int,
    status_counter: dict[str, int],
    current_processed: int,
) -> tuple[str, str, int]:
    if total_items <= 0:
        overall_status = "finished"
        summary = "巡检完成：未配置任何检查项。"
    elif processed_total < total_items:
        overall_status = "failed"
        summary = (
            f"巡检失败：仅处理 {processed_total}/{total_items} 项，"
            "请核查巡检项配置与执行日志。"
        )
    else:
        passed = status_counter.get("passed", 0)
        warnings = status_counter.get("warning", 0)
        failed = status_counter.get("failed", 0)
        if failed > 0:
            overall_status = "failed"
            summary = (
                f"巡检失败：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"失败 {failed} 项。"
            )
        elif warnings > 0:
            overall_status = "finished"
            summary = (
                f"巡检完成，但存在告警：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"失败 {failed} 项。"
            )
        else:
            overall_status = "finished"
            summary = (
                f"巡检完成：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"失败 {failed} 项。"
            )

    final_processed = processed_total
    if total_items > 0:
        final_processed = min(processed_total, total_items)
    if overall_status == "finished" and total_items > 0:
        final_processed = total_items
    final_processed = max(final_processed, current_processed or 0)
    return overall_status, summary, final_processed


def _attach_run_report(db: Session, run: models.InspectionRun) -> models.InspectionRun:
    run = crud.get_inspection_run(db, run.id) or run
    if not run.results:
        return run
    display_id = _build_run_display_id(db, run)
    report_path = generate_pdf_report(
        run=run, results=run.results, display_id=display_id
    )
    run.report_path = report_path
    db.add(run)
    db.commit()
    db.refresh(run)
    crud.log_action(
        db,
        action="update",
        entity_type="inspection_run",
        entity_id=run.id,
        description="生成巡检报告。",
    )
    return run


def _generate_agent_token() -> str:
    return secrets.token_urlsafe(32)


def _build_connection_test_plan(cluster: models.ClusterConfig) -> str:
    plan = [
        {
            "id": -int(cluster.id),
            "name": "连接连通性测试",
            "check_type": "connection_probe",
            "config": {},
        }
    ]
    return json.dumps(plan, ensure_ascii=False)


def _resolve_active_agent(db: Session, cluster: models.ClusterConfig) -> Optional[models.InspectionAgent]:
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


def _has_pending_connection_test(db: Session, cluster: models.ClusterConfig) -> bool:
    existing = (
        db.query(models.InspectionRun)
        .filter(
            models.InspectionRun.cluster_id == cluster.id,
            models.InspectionRun.operator == CONNECTION_TEST_OPERATOR,
            models.InspectionRun.status.in_(("queued", "running")),
        )
        .first()
    )
    return existing is not None


def _enqueue_connection_test_run(
    db: Session, cluster: models.ClusterConfig, agent: models.InspectionAgent
) -> models.InspectionRun:
    plan_json = _build_connection_test_plan(cluster)
    return crud.create_inspection_run(
        db,
        operator=CONNECTION_TEST_OPERATOR,
        cluster=cluster,
        status="queued",
        total_items=1,
        processed_items=0,
        plan_json=plan_json,
        executor="agent",
        agent_status="queued",
        agent_id=agent.id,
    )


def _trigger_auto_connection_test(
    db: Session,
    cluster: models.ClusterConfig,
    agent: models.InspectionAgent,
    message: str = "已自动触发连接测试，稍后更新结果。",
) -> None:
    if _has_pending_connection_test(db, cluster):
        return
    _enqueue_connection_test_run(db, cluster, agent)
    crud.update_cluster(
        db,
        cluster,
        connection_status="warning",
        connection_message=message,
    )


def _parse_run_plan(run: models.InspectionRun) -> List[Dict[str, Any]]:
    if not run.plan_json:
        return []
    try:
        payload = json.loads(run.plan_json)
        if isinstance(payload, list):
            return payload
    except Exception:
        logger.warning("Failed to parse run %s plan_json.", run.id, exc_info=True)
    return []


def _serialize_agent(agent: models.InspectionAgent) -> schemas.InspectionAgentOut:
    return schemas.InspectionAgentOut.model_validate(agent)


def _resolve_agent_from_header(
    db: Session,
    authorization: str | None,
) -> models.InspectionAgent:
    if not authorization:
        raise HTTPException(status_code=401, detail="Agent token 缺失。")
    prefix = "bearer "
    if not authorization.lower().startswith(prefix):
        raise HTTPException(status_code=401, detail="Agent token 格式无效。")
    token = authorization[len(prefix) :].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Agent token 为空。")
    agent = crud.get_inspection_agent_by_token(db, token)
    if not agent:
        raise HTTPException(status_code=401, detail="Agent token 无效。")
    if not agent.is_enabled:
        raise HTTPException(status_code=403, detail="Agent 已被禁用。")
    return agent


def _agent_request_dependency(
    authorization: str = Header(None),
) -> Generator[AgentRequestContext, None, None]:
    db = SessionLocal()
    try:
        agent = _resolve_agent_from_header(db, authorization)
        _requeue_stale_agent_runs(db)
        yield AgentRequestContext(db=db, agent=agent)
    finally:
        db.close()


app = FastAPI(title="K8s Inspection Service", version="0.3.0")
agent_router = APIRouter(prefix="/agent", tags=["agent"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _seed_defaults(db: Session) -> None:
    if _DEFAULT_INSPECTIONS_SENTINEL.exists():
        return

    has_any = db.query(models.InspectionItem.id).limit(1).first()
    if has_any:
        try:
            _DEFAULT_INSPECTIONS_SENTINEL.parent.mkdir(parents=True, exist_ok=True)
            _DEFAULT_INSPECTIONS_SENTINEL.write_text(
                datetime.utcnow().isoformat(), encoding="utf-8"
            )
        except Exception:
            logger.debug("无法写入默认巡检项标记文件，继续运行。", exc_info=True)
        return

    existing_names = {
        name for (name,) in db.query(models.InspectionItem.name).all()
    }
    new_items = []
    for payload in DEFAULT_CHECKS:
        if payload["name"] in existing_names:
            continue
        data = payload.copy()
        config = data.pop("config", None)
        item = models.InspectionItem(**data)
        if config is not None:
            item.set_config(config if isinstance(config, dict) else None)
        new_items.append(item)

    if not new_items:
        return
    for item in new_items:
        db.add(item)
    db.commit()

    try:
        _DEFAULT_INSPECTIONS_SENTINEL.parent.mkdir(parents=True, exist_ok=True)
        _DEFAULT_INSPECTIONS_SENTINEL.write_text(
            datetime.utcnow().isoformat(), encoding="utf-8"
        )
    except Exception:
        logger.debug("写入默认巡检项标记文件失败。", exc_info=True)

    # deprecated_names = {"Recent Events"}
    # if deprecated_names:
    #     existing = (
    #         db.query(models.InspectionItem)
    #         .filter(models.InspectionItem.name.in_(deprecated_names))
    #         .all()
    #     )
    #     for item in existing:
    #         db.delete(item)
    #     if existing:
    #         db.commit()


def _extract_contexts(kubeconfig_text: str) -> List[str]:
    try:
        payload = yaml.safe_load(kubeconfig_text) or {}
    except yaml.YAMLError:
        return []
    contexts = payload.get("contexts", []) or []
    names: List[str] = []
    for entry in contexts:
        if isinstance(entry, dict):
            name = entry.get("name")
        if name:
            names.append(name)
    return names


AGENT_MANAGED_KUBECONFIG_PREFIX = "agent-managed://"


def _build_agent_managed_kubeconfig_ref() -> str:
    return f"{AGENT_MANAGED_KUBECONFIG_PREFIX}{uuid4().hex}"


def _is_agent_managed_kubeconfig(path: str | None) -> bool:
    if not path:
        return False
    return str(path).startswith(AGENT_MANAGED_KUBECONFIG_PREFIX)


def _normalize_prometheus_url(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed.rstrip("/")


def _sync_cluster_prometheus_to_agents(
    db: Session, cluster: models.ClusterConfig
) -> None:
    """
    将集群 Prometheus 地址同步到所有挂载该集群的 Agent。
    以集群侧配置为最终值，Agent 上的 Prometheus 地址保持一致。
    """
    prom_url = cluster.prometheus_url
    agents = (
        db.query(models.InspectionAgent)
        .filter(models.InspectionAgent.cluster_id == cluster.id)
        .all()
    )
    for agent in agents:
        if agent.prometheus_url != prom_url:
            crud.update_inspection_agent(db, agent, prometheus_url=prom_url)


def _remove_file_safely(path: str | Path | None) -> None:
    if not path:
        return
    if _is_agent_managed_kubeconfig(str(path)):
        return
    candidate = Path(path)
    try:
        candidate.unlink(missing_ok=True)
    except Exception:
        pass

    counterpart_paths: list[Path] = []
    suffix = candidate.suffix.lower()
    stem = candidate.stem
    if suffix == ".pdf":
        counterpart_paths.append(candidate.with_suffix(".md"))
        if candidate.parent.name == "pdf":
            counterpart_paths.append(candidate.parent.parent / "md" / f"{stem}.md")
    elif suffix == ".md":
        counterpart_paths.append(candidate.with_suffix(".pdf"))
        if candidate.parent.name == "md":
            counterpart_paths.append(candidate.parent.parent / "pdf" / f"{stem}.pdf")

    for counterpart in counterpart_paths:
        try:
            counterpart.unlink(missing_ok=True)
        except Exception:
            continue


def _sanitize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.replace("\r\n", "\n")
    normalized = re.sub(r"[^\S\n]+", " ", normalized)
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    normalized = normalized.strip()
    if not normalized:
        return None
    if len(normalized) > 2000:
        normalized = normalized[:2000]
    return normalized


@app.on_event("startup")
def on_startup() -> None:
    ensure_runtime_directories()
    license_manager.reload()
    init_db()
    with SessionLocal() as db:
        _seed_defaults(db)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/license/status", response_model=schemas.LicenseStatusOut)
def get_license_status() -> schemas.LicenseStatusOut:
    status = license_manager.status()
    return schemas.LicenseStatusOut(**status)


@app.post("/license/upload", response_model=schemas.LicenseStatusOut)
async def upload_license(file: UploadFile = File(...)) -> schemas.LicenseStatusOut:
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="上传的 License 文件为空")
    try:
        status = license_manager.import_bytes(payload)
    except LicenseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return schemas.LicenseStatusOut(**status)


@app.post("/license/import-text", response_model=schemas.LicenseStatusOut)
def upload_license_text(payload: schemas.LicenseImportPayload) -> schemas.LicenseStatusOut:
    try:
        status = license_manager.import_bytes(payload.content)
    except LicenseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return schemas.LicenseStatusOut(**status)


def require_license_dependency(*features: str) -> Callable[[], None]:
    def _dependency() -> None:
        try:
            license_manager.require(features)
        except LicenseError as exc:
            raise HTTPException(status_code=403, detail=str(exc))
    return _dependency


def _present_cluster(
    cluster: models.ClusterConfig,
) -> schemas.ClusterConfigOut:
    result = schemas.ClusterConfigOut.model_validate(cluster)
    if result.connection_status == "failed":
        result.connection_message = "连接异常"
    elif not result.connection_message:
        result.connection_message = "No additional details."
    return result


@app.get("/clusters", response_model=List[schemas.ClusterConfigOut])
def list_clusters(db: Session = Depends(get_db)):
    clusters = crud.list_clusters(db)
    return [_present_cluster(cluster) for cluster in clusters]


@app.post("/clusters", response_model=schemas.ClusterConfigOut, status_code=201)
async def register_cluster(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    prometheus_url: str | None = Form(None),
    db: Session = Depends(get_db),
    _license_guard: None = Depends(require_license_dependency("clusters")),
):
    raise HTTPException(
        status_code=410,
        detail="Server 端已停用直接上传 kubeconfig，请通过 Agent 完成集群注册。",
    )


@app.post(
    "/clusters/{cluster_id}/test-connection",
    response_model=schemas.ClusterConfigOut,
)
def test_cluster_connection(cluster_id: int, db: Session = Depends(get_db)):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")
    if cluster.execution_mode != "agent":
        raise HTTPException(
            status_code=400,
            detail="当前仅支持由 Agent 执行的集群发起连接测试。",
        )
    if cluster.connection_status == "pending":
        raise HTTPException(
            status_code=400,
            detail="集群尚未完成注册，请先完成注册后再进行连接测试。",
        )
    agent = _resolve_active_agent(db, cluster)
    if not agent:
        raise HTTPException(
            status_code=409,
            detail="未检测到可用 Agent，请先绑定或启用 Agent。",
        )
    if _has_pending_connection_test(db, cluster):
        raise HTTPException(
            status_code=409,
            detail="已有连接测试任务执行中，请稍候再试。",
        )
    _enqueue_connection_test_run(db, cluster, agent)
    cluster = crud.update_cluster(
        db,
        cluster,
        connection_status="warning",
        connection_message="已下发连接测试请求，等待 Agent 返回结果。",
    )
    return _present_cluster(cluster)


@app.put("/clusters/{cluster_id}", response_model=schemas.ClusterConfigOut)
async def update_cluster(
    cluster_id: int,
    db: Session = Depends(get_db),
    name: str | None = Form(None),
    prometheus_url: str | None = Form(None),
    default_agent_id: str | None = Form(None),
):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    update_kwargs: dict[str, Any] = {}

    if name is not None:
        new_name = name.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="集群名称不能为空。")
        if new_name != cluster.name:
            raise HTTPException(
                status_code=400, detail="集群名称创建后不可修改，如需变更请重新注册。"
            )

    if prometheus_url is not None:
        normalized_prom_url = _normalize_prometheus_url(prometheus_url)
        if normalized_prom_url and not normalized_prom_url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400,
                detail="Prometheus 地址需以 http:// 或 https:// 开头。",
            )
        update_kwargs["prometheus_url"] = normalized_prom_url

    default_agent_obj = None
    default_agent_specified = False
    if default_agent_id is not None:
        default_agent_specified = True
        cleaned = default_agent_id.strip() if default_agent_id else ""
        if cleaned:
            try:
                agent_id = int(cleaned)
            except ValueError:
                raise HTTPException(status_code=400, detail="默认 Agent ID 无效。")
            default_agent_obj = crud.get_inspection_agent(db, agent_id)
            if not default_agent_obj:
                raise HTTPException(status_code=404, detail="指定的 Agent 不存在。")
            if not default_agent_obj.is_enabled:
                raise HTTPException(status_code=400, detail="指定的 Agent 已被禁用。")
            update_kwargs["default_agent_id"] = default_agent_obj.id
        else:
            update_kwargs["default_agent_id"] = None

    if update_kwargs:
        cluster = crud.update_cluster(db, cluster, **update_kwargs)

    if default_agent_specified:
        if update_kwargs.get("default_agent_id") is None and cluster.default_agent is not None:
            crud.update_inspection_agent(db, cluster.default_agent, cluster=None)
        elif default_agent_obj and default_agent_obj.cluster_id != cluster.id:
            crud.update_inspection_agent(db, default_agent_obj, cluster=cluster)

    cluster = crud.get_cluster(db, cluster.id)
    _sync_cluster_prometheus_to_agents(db, cluster)
    return _present_cluster(cluster)


@app.get("/agents", response_model=List[schemas.InspectionAgentOut])
def list_agents(
    db: Session = Depends(get_db),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    agents = crud.list_inspection_agents(db)
    return [_serialize_agent(agent) for agent in agents]


@app.post("/agents", response_model=schemas.AgentRegisterOut, status_code=201)
def register_agent(
    payload: schemas.InspectionAgentCreate,
    db: Session = Depends(get_db),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    trimmed_name = (payload.name or "").strip()
    if not trimmed_name:
        raise HTTPException(status_code=400, detail="Agent 名称不能为空。")

    existing_agent = crud.get_inspection_agent_by_name(db, trimmed_name)
    if existing_agent:
        cluster = (
            crud.get_cluster(db, existing_agent.cluster_id)
            if existing_agent.cluster_id
            else crud.get_cluster_by_name(db, trimmed_name)
        )
        if cluster is None:
            crud.delete_inspection_agent(
                db,
                existing_agent,
                reason=f"清理无关联集群的 Agent '{trimmed_name}'。",
            )
        else:
            raise HTTPException(status_code=400, detail="Agent 名称已存在，请更换名称。")

    normalized_description = (payload.description or "").strip() or None
    normalized_prometheus_url = _normalize_prometheus_url(payload.prometheus_url)

    cluster: Optional[models.ClusterConfig] = None
    if payload.cluster_id is not None:
        cluster = crud.get_cluster(db, payload.cluster_id)
        if not cluster:
            raise HTTPException(status_code=404, detail="指定的集群不存在。")
        if cluster.name != trimmed_name:
            raise HTTPException(
                status_code=400,
                detail="Agent 名称必须与目标集群名称保持一致。",
            )
        if normalized_description:
            cluster = crud.update_cluster(db, cluster, description=normalized_description)
        if normalized_prometheus_url:
            cluster = crud.update_cluster(
                db,
                cluster,
                prometheus_url=normalized_prometheus_url,
            )
    else:
        cluster = crud.get_cluster_by_name(db, trimmed_name)
        if cluster:
            if getattr(cluster, "is_archived", False):
                placeholder_path = _build_agent_managed_kubeconfig_ref()
                update_kwargs: dict[str, Any] = {
                    "kubeconfig_path": placeholder_path,
                    "connection_status": "pending",
                    "connection_message": "等待 Agent 注册",
                    "last_checked_at": None,
                    "execution_mode": "agent",
                    "default_agent_id": None,
                    "is_archived": False,
                }
                if normalized_description is not None:
                    update_kwargs["description"] = normalized_description
                if normalized_prometheus_url is not None:
                    update_kwargs["prometheus_url"] = normalized_prometheus_url
                cluster = crud.update_cluster(db, cluster, **update_kwargs)
            else:
                if cluster.connection_status != "pending":
                    raise HTTPException(
                        status_code=400,
                        detail="同名集群已存在，请更换 Agent 名称或删除旧集群。",
                    )
                linked_agents = (
                    db.query(models.InspectionAgent)
                    .filter(models.InspectionAgent.cluster_id == cluster.id)
                    .count()
                )
                if linked_agents > 0:
                    raise HTTPException(
                        status_code=400,
                        detail="该 Agent 名称已保留 Token，如需重新创建请先删除旧 Token。",
                    )
                update_kwargs: dict[str, Any] = {}
                if normalized_description is not None:
                    update_kwargs["description"] = normalized_description
                if normalized_prometheus_url is not None:
                    update_kwargs["prometheus_url"] = normalized_prometheus_url
                if update_kwargs:
                    cluster = crud.update_cluster(db, cluster, **update_kwargs)
        else:
            placeholder_path = _build_agent_managed_kubeconfig_ref()
            cluster = crud.create_cluster(
                db,
                name=trimmed_name,
                kubeconfig_path=placeholder_path,
                contexts_json=None,
                prometheus_url=normalized_prometheus_url,
                connection_status="pending",
                connection_message="等待 Agent 注册",
                last_checked_at=None,
                execution_mode="agent",
                default_agent_id=None,
                description=normalized_description,
            )

    token = _generate_agent_token()
    while crud.get_inspection_agent_by_token(db, token) is not None:
        token = _generate_agent_token()

    agent = crud.create_inspection_agent(
        db,
        name=trimmed_name,
        token=token,
        cluster=cluster,
        description=normalized_description,
        is_enabled=True,
        prometheus_url=normalized_prometheus_url,
    )
    return schemas.AgentRegisterOut(
        id=agent.id,
        name=agent.name,
        token=token,
        cluster_id=agent.cluster_id,
    )


@agent_router.post("/bootstrap", response_model=schemas.InspectionAgentOut)
def agent_bootstrap(
    payload: schemas.AgentBootstrapIn,
):
    token_value = (payload.registration_token or "").strip()
    if not token_value:
        raise HTTPException(status_code=400, detail="Agent Token 不能为空")

    db = SessionLocal()
    try:
        agent = crud.get_inspection_agent_by_token(db, token_value)
        if not agent:
            raise HTTPException(status_code=401, detail="Agent Token 无效或已过期")

        cluster_payload = payload.cluster
        cluster_name_reported = (cluster_payload.name or "").strip()
        agent_name = (agent.name or "").strip()
        if not agent_name:
            raise HTTPException(
                status_code=400,
                detail="Agent 名称缺失，无法匹配对应的集群。",
            )
        if not cluster_name_reported:
            raise HTTPException(status_code=400, detail="集群名称不能为空")
        if cluster_name_reported and cluster_name_reported != agent_name:
            logger.warning(
                "Agent 上报的集群名称(%s)与平台注册名称(%s)不一致，已使用平台注册名称。",
                cluster_name_reported,
                agent_name,
            )

        cluster_name = agent_name
        cluster = agent.cluster or crud.get_cluster_by_name(db, cluster_name)
        cluster_was_pending = False
        if cluster is None:
            cluster_was_pending = True
        else:
            cluster_was_pending = cluster.connection_status == "pending"
        if cluster and cluster.name != cluster_name:
            raise HTTPException(
                status_code=400,
                detail="集群名称已存在但与当前 Agent 不匹配，请重新注册。",
            )
        agent_prom_url = _normalize_prometheus_url(agent.prometheus_url)
        incoming_prom_url = _normalize_prometheus_url(payload.prometheus_url)
        effective_prom_url = agent_prom_url or incoming_prom_url

        contexts_json: Optional[str] = None
        if cluster_payload.kubeconfig_b64:
            raw_kubeconfig = cluster_payload.kubeconfig_b64
            kubeconfig_text = raw_kubeconfig
            decoded_bytes: Optional[bytes] = None
            try:
                decoded_bytes = base64.b64decode(
                    raw_kubeconfig, validate=True
                )
            except (binascii.Error, ValueError):
                decoded_bytes = None
            if decoded_bytes:
                try:
                    decoded_text = decoded_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    decoded_text = None
                if decoded_text:
                    kubeconfig_text = decoded_text
            contexts: List[str] = []
            try:
                contexts = _extract_contexts(kubeconfig_text)
            except yaml.YAMLError:
                contexts = []
            if contexts:
                contexts_json = json.dumps(contexts, ensure_ascii=False)

        if cluster and _is_agent_managed_kubeconfig(cluster.kubeconfig_path):
            kubeconfig_path = cluster.kubeconfig_path
        else:
            if cluster and cluster.kubeconfig_path:
                _remove_file_safely(cluster.kubeconfig_path)
            kubeconfig_path = _build_agent_managed_kubeconfig_ref()

        now = datetime.utcnow()
        connection_status = "connected"
        connection_message = "Agent 已完成注册，Server 端已托管 kubeconfig。"

        agent_description = (agent.description or "").strip() or None

        if cluster is None:
            cluster = crud.create_cluster(
                db,
                name=cluster_name,
                kubeconfig_path=kubeconfig_path,
                contexts_json=contexts_json,
                prometheus_url=effective_prom_url,
                connection_status=connection_status,
                connection_message=connection_message,
                last_checked_at=now,
                execution_mode="agent",
                default_agent_id=agent.id,
                description=agent_description,
            )
        else:
            update_kwargs: dict[str, Any] = {
                "execution_mode": "agent",
                "default_agent_id": agent.id,
                "kubeconfig_path": kubeconfig_path,
                "connection_status": connection_status,
                "connection_message": connection_message,
                "last_checked_at": now,
            }
            if contexts_json is not None:
                update_kwargs["contexts_json"] = contexts_json
            if agent_description is not None:
                update_kwargs["description"] = agent_description
            cluster = crud.update_cluster(db, cluster, **update_kwargs)

        cluster_prom_url = _normalize_prometheus_url(cluster.prometheus_url)
        final_prom_url = cluster_prom_url or effective_prom_url
        if final_prom_url != cluster_prom_url:
            cluster = crud.update_cluster(
                db,
                cluster,
                prometheus_url=final_prom_url,
            )

        agent = crud.update_inspection_agent(
            db,
            agent,
            cluster=cluster,
            is_enabled=True,
            prometheus_url=final_prom_url or agent.prometheus_url,
        )
        if cluster_was_pending and cluster is not None:
            try:
                _trigger_auto_connection_test(
                    db,
                    cluster,
                    agent,
                    message="已自动触发连接测试，等待结果更新。",
                )
            except Exception:
                logger.warning("自动触发连接测试失败。", exc_info=True)
        _sync_cluster_prometheus_to_agents(db, cluster)
        crud.record_agent_heartbeat(db, agent, seen_at=datetime.utcnow())
        refreshed = crud.get_inspection_agent(db, agent.id)
        if not refreshed:
            raise HTTPException(status_code=500, detail="Agent 信息刷新失败")
        return _serialize_agent(refreshed)
    finally:
        db.close()


@agent_router.post("/heartbeat", response_model=schemas.InspectionAgentOut)
def agent_heartbeat(
    payload: schemas.AgentHeartbeatIn,
    ctx: AgentRequestContext = Depends(_agent_request_dependency),
):
    updated = crud.record_agent_heartbeat(
        ctx.db, ctx.agent, seen_at=payload.reported_at or datetime.utcnow()
    )
    refreshed = crud.get_inspection_agent(ctx.db, updated.id) or updated
    return _serialize_agent(refreshed)


@agent_router.get("/tasks", response_model=List[schemas.AgentTaskOut])
def agent_pull_tasks(
    limit: int = Query(5, ge=1, le=50, description="每次获取的任务数量"),
    ctx: AgentRequestContext = Depends(_agent_request_dependency),
):
    crud.record_agent_heartbeat(ctx.db, ctx.agent)
    runs = crud.list_agent_runs(
        ctx.db, agent=ctx.agent, statuses=("queued",), limit=limit
    )
    tasks: List[schemas.AgentTaskOut] = []
    for run in runs:
        plan_items = _parse_run_plan(run)
        items_out: List[schemas.AgentTaskItemOut] = []
        for item in plan_items:
            items_out.append(
                schemas.AgentTaskItemOut(
                    id=int(item.get("id")),
                    name=str(item.get("name") or ""),
                    description=item.get("description"),
                    check_type=str(item.get("check_type") or ""),
                    config=item.get("config") or {},
                )
            )
        tasks.append(
            schemas.AgentTaskOut(
                run_id=run.id,
                cluster_id=run.cluster_id,
                operator=run.operator,
                total_items=run.total_items,
                items=items_out,
            )
        )
    return tasks


@agent_router.post("/runs/{run_id}/claim", response_model=schemas.InspectionRunOut)
def agent_claim_run(
    run_id: int,
    ctx: AgentRequestContext = Depends(_agent_request_dependency),
):
    run = crud.get_inspection_run(ctx.db, run_id)
    if not run or run.executor != "agent":
        raise HTTPException(status_code=404, detail="巡检任务不存在或非 Agent 类型。")
    if run.agent_id != ctx.agent.id:
        raise HTTPException(status_code=403, detail="巡检任务不属于当前 Agent。")
    if run.agent_status not in {None, "queued", "running"} or run.status not in {
        "queued",
        "running",
    }:
        raise HTTPException(status_code=400, detail="巡检任务当前状态不允许领取。")
    run = crud.update_inspection_run_agent_state(
        ctx.db,
        run,
        agent_status="running",
        status="running",
    )
    crud.record_agent_heartbeat(ctx.db, ctx.agent)
    updated = crud.get_inspection_run(ctx.db, run_id)
    if not updated:
        raise HTTPException(status_code=404, detail="巡检任务不存在。")
    return _serialize_run(updated)




def _apply_connection_test_result(
    db: Session,
    run: models.InspectionRun,
    results: Iterable[Any],
) -> None:
    cluster = crud.get_cluster(db, run.cluster_id)
    if not cluster:
        return
    result_payload: Optional[dict[str, Any]] = None
    for entry in results:
        if hasattr(entry, "model_dump"):
            result_payload = entry.model_dump()
        elif isinstance(entry, dict):
            result_payload = dict(entry)
        else:
            continue
        break
    status_map = {"passed": "connected", "warning": "warning", "failed": "failed"}
    connection_status = "failed"
    message = ""
    if result_payload:
        normalized = str(result_payload.get("status") or "").strip().lower()
        connection_status = status_map.get(normalized, "failed")
        message = (result_payload.get("detail") or "").strip()
    else:
        normalized_run = (run.status or "").strip().lower()
        if normalized_run == "finished":
            connection_status = "connected"
        elif normalized_run == "warning":
            connection_status = "warning"
        message = (run.summary or "").strip()
    if not message:
        message = "Agent 未返回详细信息。"
    crud.update_cluster(
        db,
        cluster,
        connection_status=connection_status,
        connection_message=message[:500],
        last_checked_at=datetime.utcnow(),
    )
@agent_router.post("/runs/{run_id}/results", response_model=schemas.InspectionRunOut)
def agent_submit_results(
    run_id: int,
    payload: schemas.AgentRunResultIn,
    ctx: AgentRequestContext = Depends(_agent_request_dependency),
):
    run = crud.get_inspection_run(ctx.db, run_id)
    if not run or run.executor != "agent":
        raise HTTPException(status_code=404, detail="巡检任务不存在或非 Agent 类型。")
    if run.agent_id != ctx.agent.id:
        raise HTTPException(status_code=403, detail="巡检任务不属于当前 Agent。")
    crud.record_agent_heartbeat(ctx.db, ctx.agent)
    is_partial = bool(payload.partial)
    for result in payload.results:
        normalized_status = (result.status or "").strip().lower()
        if normalized_status not in {"passed", "warning", "failed"}:
            normalized_status = "warning"
        detail = _sanitize_optional_text(result.detail)
        suggestion = _sanitize_optional_text(result.suggestion)
        crud.add_run_result_by_item_id(
            ctx.db,
            run,
            result.item_id,
            normalized_status,
            detail,
            suggestion,
            replace_existing=True,
        )
    run = crud.get_inspection_run(ctx.db, run.id) or run
    processed_total = crud.count_run_results(ctx.db, run)

    def _clamp_processed(value: int, total: int) -> int:
        if total > 0:
            return min(value, total)
        return value

    if is_partial:
        display_total = run.total_items or processed_total
        run = crud.update_inspection_run_agent_state(
            ctx.db,
            run,
            status="running",
            processed_items=_clamp_processed(processed_total, display_total),
        )
        refreshed = crud.get_inspection_run(ctx.db, run.id) or run
        return _serialize_run(refreshed)

    if run.total_items == 0 and processed_total > 0:
        run.total_items = processed_total
        ctx.db.add(run)
        ctx.db.commit()
        ctx.db.refresh(run)

    status_counter = crud.get_run_result_status_counts(ctx.db, run)
    overall_status, summary, final_processed = _summarize_run_outcome(
        total_items=run.total_items or processed_total,
        processed_total=processed_total,
        status_counter=status_counter,
        current_processed=run.processed_items or 0,
    )

    run = crud.finalize_inspection_run(
        ctx.db,
        run=run,
        status=overall_status,
        summary=summary,
        report_path=None,
        processed_items=final_processed,
    )
    agent_state = "finished" if overall_status == "finished" else "failed"
    run = crud.update_inspection_run_agent_state(
        ctx.db,
        run,
        agent_status=agent_state,
    )
    if run.operator == CONNECTION_TEST_OPERATOR:
        _apply_connection_test_result(ctx.db, run, payload.results)
        refreshed = crud.get_inspection_run(ctx.db, run.id) or run
        return _serialize_run(refreshed)

    run = _attach_run_report(ctx.db, run)
    return _serialize_run(run)

app.include_router(agent_router)


@app.delete("/clusters/{cluster_id}", status_code=204)
def delete_cluster(
    cluster_id: int,
    delete_files: bool = Query(
        False,
        description="同时删除关联巡检记录及报告文件",
    ),
    db: Session = Depends(get_db),
):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    report_paths: list[str] = []
    if delete_files:
        runs = (
            db.query(models.InspectionRun)
            .filter(models.InspectionRun.cluster_id == cluster_id)
            .all()
        )
        report_paths = [run.report_path for run in runs if run.report_path]
        for run in runs:
            crud.delete_inspection_run(db, run)

    crud.archive_cluster(db, cluster)

    if delete_files:
        for report_path in report_paths:
            _remove_file_safely(report_path)

    return {}


@app.get("/audit-logs", response_model=List[schemas.AuditLogOut])
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db)):
    return crud.list_audit_logs(db, limit=limit)


@app.get("/inspection-items", response_model=List[schemas.InspectionItemOut])
def list_inspection_items(db: Session = Depends(get_db)):
    return crud.get_inspection_items(db)


@app.get(
    "/inspection-items/export",
    response_model=schemas.InspectionItemsExportOut,
)
def export_inspection_items(db: Session = Depends(get_db)):
    items = crud.get_inspection_items(db)
    return {
        "exported_at": datetime.utcnow(),
        "items": items,
    }


@app.post(
    "/inspection-items/import",
    response_model=schemas.InspectionItemsImportResult,
    status_code=201,
)
async def import_inspection_items(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="导入文件为空")
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="导入文件必须为 UTF-8 编码") from exc

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"导入文件不是有效的 JSON：{exc.msg}",
        ) from exc

    if isinstance(payload, dict):
        items_data = payload.get("items")
        if items_data is None:
            raise HTTPException(
                status_code=400,
                detail="JSON 中缺少 items 字段",
            )
    elif isinstance(payload, list):
        items_data = payload
    else:
        raise HTTPException(
            status_code=400,
            detail="JSON 格式不正确，应为巡检项数组或包含 items 字段的对象",
        )

    if not isinstance(items_data, list):
        raise HTTPException(
            status_code=400,
            detail="items 字段必须是数组",
        )
    if not items_data:
        raise HTTPException(status_code=400, detail="导入文件中没有巡检项数据")

    validated_items: List[tuple[str, schemas.InspectionItemCreate]] = []
    seen_names: set[str] = set()
    duplicates: set[str] = set()

    for index, item in enumerate(items_data, start=1):
        if not isinstance(item, dict):
            raise HTTPException(
                status_code=400,
                detail=f"第 {index} 个巡检项不是对象",
            )
        try:
            validated = schemas.InspectionItemCreate.model_validate(item)
        except ValidationError as exc:
            messages: list[str] = []
            for error in exc.errors():
                location = ".".join(str(part) for part in error.get("loc", ()))
                field_label = location or "字段"
                messages.append(f"{field_label}: {error.get('msg')}")
            detail_message = "；".join(messages) or "数据校验失败"
            raise HTTPException(
                status_code=400,
                detail=f"第 {index} 个巡检项数据不合法：{detail_message}",
            ) from exc

        trimmed_name = validated.name.strip()
        if not trimmed_name:
            raise HTTPException(
                status_code=400,
                detail=f"第 {index} 个巡检项名称不能为空",
            )
        if trimmed_name in seen_names:
            duplicates.add(trimmed_name)
        seen_names.add(trimmed_name)
        validated_items.append((trimmed_name, validated))

    if duplicates:
        duplicate_list = "、".join(sorted(duplicates))
        raise HTTPException(
            status_code=400,
            detail=f"导入文件中存在重复的巡检项名称：{duplicate_list}",
        )

    lookup_names = [name for name, _ in validated_items]
    existing_items = (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.name.in_(lookup_names))
        .all()
    )
    existing_map = {item.name.strip(): item for item in existing_items}

    created_items: List[models.InspectionItem] = []
    updated_items: List[models.InspectionItem] = []

    for name, payload in validated_items:
        config = payload.config if isinstance(payload.config, dict) else None
        existing = existing_map.get(name)
        if existing:
            existing.name = name
            existing.description = payload.description
            existing.check_type = payload.check_type
            existing.is_archived = False
            existing.set_config(config)
            existing.updated_at = datetime.utcnow()
            db.add(existing)
            updated_items.append(existing)
        else:
            item = models.InspectionItem(
                name=name,
                description=payload.description,
                check_type=payload.check_type,
                is_archived=False,
            )
            item.set_config(config)
            db.add(item)
            created_items.append(item)

    db.commit()

    for item in created_items:
        db.refresh(item)
        crud.log_action(
            db,
            action="create",
            entity_type="inspection_item",
            entity_id=item.id,
            description=f"导入巡检项 '{item.name}'",
        )

    for item in updated_items:
        db.refresh(item)
        crud.log_action(
            db,
            action="update",
            entity_type="inspection_item",
            entity_id=item.id,
            description=f"更新巡检项 '{item.name}'（导入）",
        )

    return schemas.InspectionItemsImportResult(
        created=len(created_items),
        updated=len(updated_items),
        total=len(validated_items),
    )


@app.post("/inspection-items", response_model=schemas.InspectionItemOut, status_code=201)
def create_inspection_item(
    item_in: schemas.InspectionItemCreate, db: Session = Depends(get_db)
):
    existing = (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.name == item_in.name)
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Inspection item with name '{item_in.name}' already exists.",
        )
    return crud.create_inspection_item(db, item_in)


@app.put("/inspection-items/{item_id}", response_model=schemas.InspectionItemOut)
def update_inspection_item(
    item_id: int,
    item_in: schemas.InspectionItemUpdate,
    db: Session = Depends(get_db),
):
    item = crud.get_inspection_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Inspection item not found.")
    return crud.update_inspection_item(db, item, item_in)


@app.delete("/inspection-items/{item_id}", status_code=204)
def delete_inspection_item(item_id: int, db: Session = Depends(get_db)):
    item = crud.get_inspection_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Inspection item not found.")
    crud.delete_inspection_item(db, item)
    return {}


def _serialize_result(result: models.InspectionResult) -> schemas.InspectionResultOut:
    return schemas.InspectionResultOut(
        id=result.id,
        item_id=result.item_id,
        status=result.status,
        detail=result.detail,
        suggestion=result.suggestion,
        item_name=result.item.name if result.item else (result.item_name_cached or "已删除巡检项"),
    )


def _serialize_run(run: models.InspectionRun) -> schemas.InspectionRunOut:
    cluster = run.cluster
    if cluster is None:
        raise HTTPException(status_code=500, detail="Cluster information missing.")
    total_items, processed_items, progress = _calculate_run_progress(run)
    return schemas.InspectionRunOut(
        id=run.id,
        operator=run.operator,
        cluster_id=cluster.id,
        cluster_name=cluster.name,
        status=run.status,
        summary=run.summary,
        report_path=run.report_path,
        total_items=total_items,
        processed_items=processed_items,
        progress=progress,
        created_at=run.created_at,
        completed_at=run.completed_at,
        executor=run.executor,
        agent_status=run.agent_status,
        agent_id=run.agent_id,
        results=[_serialize_result(result) for result in run.results],
    )


def _serialize_run_list(run: models.InspectionRun) -> schemas.InspectionRunListOut:
    cluster = run.cluster
    if cluster is None:
        raise HTTPException(status_code=500, detail="Cluster information missing.")
    total_items, processed_items, progress = _calculate_run_progress(run)
    return schemas.InspectionRunListOut(
        id=run.id,
        operator=run.operator,
        cluster_id=cluster.id,
        cluster_name=cluster.name,
        status=run.status,
        summary=run.summary,
        report_path=run.report_path,
        total_items=total_items,
        processed_items=processed_items,
        progress=progress,
        created_at=run.created_at,
        completed_at=run.completed_at,
        executor=run.executor,
        agent_status=run.agent_status,
        agent_id=run.agent_id,
    )


@app.post("/inspection-runs", response_model=schemas.InspectionRunOut, status_code=201)
def trigger_inspection(
    run_in: schemas.InspectionRunCreate,
    db: Session = Depends(get_db),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    if not run_in.item_ids:
        raise HTTPException(status_code=400, detail="No inspection items selected.")

    cluster = crud.get_cluster(db, run_in.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    items = crud.get_items_by_ids(db, run_in.item_ids)
    if len(items) != len(set(run_in.item_ids)):
        raise HTTPException(
            status_code=400, detail="One or more inspection items do not exist."
        )

    plan_items: List[Dict[str, Any]] = []
    for item in items:
        plan_items.append(
            {
                "id": item.id,
                "name": item.name,
                "description": item.description,
                "check_type": item.check_type,
                "config": item.config,
            }
        )
    plan_json = json.dumps(plan_items, ensure_ascii=False)

    agent = cluster.default_agent
    if not agent or not agent.is_enabled:
        raise HTTPException(status_code=400, detail="该集群未配置可用的 Agent。")
    executor = "agent"
    agent_id = agent.id
    agent_status: Optional[str] = "queued"

    run = crud.create_inspection_run(
        db,
        operator=run_in.operator,
        cluster=cluster,
        status="queued",
        total_items=len(items),
        processed_items=0,
        plan_json=plan_json,
        executor=executor,
        agent_status=agent_status,
        agent_id=agent_id,
    )

    run = crud.get_inspection_run(db, run.id)
    if not run:
        raise HTTPException(status_code=500, detail="无法加载巡检任务。")
    return _serialize_run(run)


@app.get("/inspection-runs", response_model=List[schemas.InspectionRunListOut])
def list_inspection_runs(db: Session = Depends(get_db)):
    _requeue_stale_agent_runs(db)
    runs = [
        run
        for run in crud.list_inspection_runs(db)
        if run.operator != CONNECTION_TEST_OPERATOR
    ]
    return [_serialize_run_list(run) for run in runs]


@app.get("/inspection-runs/{run_id}", response_model=schemas.InspectionRunOut)
def get_inspection_run(run_id: int, db: Session = Depends(get_db)):
    _requeue_stale_agent_runs(db)
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    return _serialize_run(run)


@app.post(
    "/inspection-runs/{run_id}/pause",
    response_model=schemas.InspectionRunOut,
)
def pause_inspection_run(run_id: int, db: Session = Depends(get_db)):
    raise HTTPException(status_code=410, detail="暂停功能已停用。")


@app.post(
    "/inspection-runs/{run_id}/resume",
    response_model=schemas.InspectionRunOut,
)
def resume_inspection_run(run_id: int, db: Session = Depends(get_db)):
    raise HTTPException(status_code=410, detail="继续功能已停用。")


@app.post(
    "/inspection-runs/{run_id}/cancel",
    response_model=schemas.InspectionRunOut,
)
def cancel_inspection_run(run_id: int, db: Session = Depends(get_db)):
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    if run.status not in {"queued", "running"}:
        raise HTTPException(status_code=400, detail="仅可取消排队或进行中的巡检。")
    crud.cancel_inspection_run(db, run)
    refreshed = crud.get_inspection_run(db, run_id)
    if not refreshed:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    return _serialize_run(refreshed)


@app.delete("/inspection-runs/{run_id}", status_code=204)
def delete_inspection_run(
    run_id: int,
    delete_files: bool = Query(
        False,
        description="同时删除本地巡检报告文件",
    ),
    db: Session = Depends(get_db),
):
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    report_path = run.report_path if delete_files else None
    crud.delete_inspection_run(db, run)
    if delete_files:
        _remove_file_safely(report_path)
    return {}


@app.get("/inspection-runs/{run_id}/report")
def download_report(
    run_id: int,
    format: str = Query(
        "pdf",
        description="下载格式，支持 pdf 或 md",
    ),
    db: Session = Depends(get_db),
    _license_guard: None = Depends(require_license_dependency("reports")),
):
    run = crud.get_inspection_run(db, run_id)
    if not run or not run.report_path:
        raise HTTPException(status_code=404, detail="Report not found.")
    requested_format = (format or "pdf").lower()
    if requested_format not in {"pdf", "md"}:
        raise HTTPException(status_code=400, detail="Unsupported report format.")

    pdf_path = Path(run.report_path)
    if not pdf_path.is_absolute():
        pdf_path = Path.cwd() / pdf_path

    if requested_format == "md":
        display_id = _build_run_display_id(db, run)
        markdown_path = Path(
            generate_markdown_report(
                run=run,
                results=run.results,
                display_id=display_id,
            )
        )
        if not markdown_path.is_absolute():
            markdown_path = Path.cwd() / markdown_path
        if not markdown_path.exists():
            raise HTTPException(status_code=500, detail="Report file missing on server.")
        return FileResponse(
            markdown_path,
            media_type="text/markdown; charset=utf-8",
            filename=markdown_path.name,
        )

    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="Report file missing on server.")
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=pdf_path.name,
    )
