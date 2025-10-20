from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from uuid import uuid4

import yaml
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

try:
    from kubernetes import client as k8s_client
    from kubernetes import config as k8s_config
    from kubernetes.client.rest import ApiException
except Exception:  # pragma: no cover - optional dependency
    k8s_client = None
    k8s_config = None
    ApiException = Exception

from . import crud, models, schemas
from .database import SessionLocal, ensure_runtime_directories, init_db
from .inspections import CheckContext, DEFAULT_CHECKS, dispatch_checks
from .pdf import generate_pdf_report
from .prometheus import PrometheusClient

logger = logging.getLogger(__name__)

app = FastAPI(title="K8s Inspection Service", version="0.3.0")

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
    existing_names = {
        name for (name,) in db.query(models.InspectionItem.name).all()
    }
    new_items = [
        models.InspectionItem(**payload)
        for payload in DEFAULT_CHECKS
        if payload["name"] not in existing_names
    ]
    if not new_items:
        return
    for item in new_items:
        db.add(item)
    db.commit()


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


def _normalize_prometheus_url(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    return trimmed.rstrip("/")


def _store_kubeconfig(data: bytes, original_name: str | None = None) -> str:
    suffix = ".yaml"
    if original_name:
        suffix = Path(original_name).suffix or suffix
    filename = f"cluster-{uuid4().hex}{suffix}"
    path = Path("configs") / filename
    path.write_bytes(data)
    return str(path)


def _remove_file_safely(path: str | Path | None) -> None:
    if not path:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except Exception:
        pass


def _sanitize_message(message: str | None) -> str | None:
    if not message:
        return "No additional details."
    collapsed = re.sub(r"\s+", " ", message).strip()
    try:
        sanitized = collapsed.encode("ascii", errors="ignore").decode("ascii").strip()
    except Exception:
        sanitized = ""
    if not sanitized:
        return "No additional details."
    return sanitized[:500]


def _sanitize_optional_text(value: str | None) -> str | None:
    if not value:
        return None
    collapsed = re.sub(r"\s+", " ", value).strip()
    try:
        sanitized = collapsed.encode("ascii", errors="ignore").decode("ascii").strip()
    except Exception:
        sanitized = ""
    if not sanitized:
        return None
    return sanitized[:2000]


def _test_cluster_connection(kubeconfig_path: str) -> tuple[str, str]:
    if not k8s_config or not k8s_client:
        return (
            "warning",
            "后端未安装 kubernetes Python 客户端，跳过连通性校验。",
        )

    try:
        api_client = k8s_config.new_client_from_config(config_file=kubeconfig_path)
        version_api = k8s_client.VersionApi(api_client)
        version_info = version_api.get_code()
        git_version = (version_info.git_version or "").strip()
        if not git_version:
            git_version = f"{version_info.major}.{version_info.minor}".strip()

        core_api = k8s_client.CoreV1Api(api_client)
        nodes = core_api.list_node(_request_timeout=5)
        node_count = len(nodes.items)
        detail = f"Server version {git_version}; nodes {node_count}."
        return "connected", detail
    except ApiException as exc:
        reason = exc.reason or exc.body or str(exc)
        return "failed", f"Kubernetes API error: {reason}"
    except Exception as exc:  # pragma: no cover
        return "failed", f"Cluster validation error: {exc}"


def _log_connection_status(cluster_name: str, status: str, message: Optional[str]) -> None:
    if status == "connected":
        logger.info("Cluster %s connectivity check succeeded.", cluster_name)
    elif status == "warning":
        logger.warning(
            "Cluster %s connectivity check warning: %s",
            cluster_name,
            message or "no details",
        )
    else:
        logger.error(
            "Cluster %s connectivity check failed: %s",
            cluster_name,
            message or "no details",
        )


@app.on_event("startup")
def on_startup() -> None:
    ensure_runtime_directories()
    init_db()
    with SessionLocal() as db:
        _seed_defaults(db)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/clusters", response_model=List[schemas.ClusterConfigOut])
def list_clusters(db: Session = Depends(get_db)):
    return crud.list_clusters(db)


@app.post("/clusters", response_model=schemas.ClusterConfigOut, status_code=201)
async def register_cluster(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    prometheus_url: str | None = Form(None),
    db: Session = Depends(get_db),
):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="上传的 kubeconfig 文件为空。")
    try:
        text = data.decode()
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="无法解析 kubeconfig 文件内容。")

    contexts = _extract_contexts(text)
    default_name = (
        contexts[0]
        if contexts
        else Path(file.filename or "kubeconfig").stem or f"cluster-{uuid4().hex[:6]}"
    )
    cluster_name = name.strip() if name else default_name

    existing = crud.get_cluster_by_name(db, cluster_name)
    if existing:
        raise HTTPException(
            status_code=400, detail=f"名称为 '{cluster_name}' 的集群已存在。"
        )

    normalized_prom_url = _normalize_prometheus_url(prometheus_url)
    if normalized_prom_url and not normalized_prom_url.startswith(("http://", "https://")):
        raise HTTPException(
            status_code=400,
            detail="Prometheus 地址需要以 http:// 或 https:// 开头。",
        )

    kubeconfig_path = _store_kubeconfig(data, file.filename)
    cluster = crud.create_cluster(
        db,
        name=cluster_name,
        kubeconfig_path=kubeconfig_path,
        contexts_json=json.dumps(contexts, ensure_ascii=False),
        prometheus_url=normalized_prom_url,
    )

    status, message = _test_cluster_connection(cluster.kubeconfig_path)
    sanitized_message = _sanitize_message(message)
    _log_connection_status(cluster.name, status, message)
    cluster = crud.update_cluster(
        db,
        cluster,
        connection_status=status,
        connection_message=sanitized_message,
        last_checked_at=datetime.utcnow(),
    )

    return cluster


@app.put("/clusters/{cluster_id}", response_model=schemas.ClusterConfigOut)
async def update_cluster(
    cluster_id: int,
    db: Session = Depends(get_db),
    name: str | None = Form(None),
    prometheus_url: str | None = Form(None),
    file: UploadFile | None = File(None),
):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    update_kwargs: dict[str, Optional[str]] = {}
    connection_status: Optional[str] = None
    connection_message: Optional[str] = None
    connection_checked_at: Optional[datetime] = None
    original_kubeconfig_path = cluster.kubeconfig_path

    if name is not None:
        new_name = name.strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="集群名称不能为空。")
        if new_name != cluster.name:
            existing = crud.get_cluster_by_name(db, new_name)
            if existing and existing.id != cluster.id:
                raise HTTPException(
                    status_code=400, detail=f"名称为 '{new_name}' 的集群已存在。"
                )
        update_kwargs["name"] = new_name

    if prometheus_url is not None:
        normalized_prom_url = _normalize_prometheus_url(prometheus_url)
        if normalized_prom_url and not normalized_prom_url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400,
                detail="Prometheus 地址需要以 http:// 或 https:// 开头。",
            )
        update_kwargs["prometheus_url"] = normalized_prom_url

    new_kubeconfig_path: Optional[str] = None
    if file is not None:
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="上传的 kubeconfig 文件为空。")
        try:
            text = data.decode()
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="无法解析 kubeconfig 文件内容。")
        contexts = _extract_contexts(text)
        new_kubeconfig_path = _store_kubeconfig(data, file.filename)
        update_kwargs["kubeconfig_path"] = new_kubeconfig_path
        update_kwargs["contexts_json"] = json.dumps(contexts, ensure_ascii=False)
        status, message = _test_cluster_connection(new_kubeconfig_path)
        connection_status = status
        connection_message = _sanitize_message(message)
        connection_checked_at = datetime.utcnow()

    if update_kwargs:
        cluster = crud.update_cluster(db, cluster, **update_kwargs)

    if connection_status is not None:
        _log_connection_status(cluster.name, connection_status, message)
        cluster = crud.update_cluster(
            db,
            cluster,
            connection_status=connection_status,
            connection_message=connection_message,
            last_checked_at=connection_checked_at,
        )

    if new_kubeconfig_path:
        _remove_file_safely(original_kubeconfig_path)

    return cluster


@app.delete("/clusters/{cluster_id}", status_code=204)
def delete_cluster(cluster_id: int, db: Session = Depends(get_db)):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    runs = (
        db.query(models.InspectionRun)
        .filter(models.InspectionRun.cluster_id == cluster_id)
        .all()
    )
    report_paths = [run.report_path for run in runs if run.report_path]
    kubeconfig_path = cluster.kubeconfig_path

    crud.delete_cluster(db, cluster)

    _remove_file_safely(kubeconfig_path)
    for report_path in report_paths:
        _remove_file_safely(report_path)

    return {}


@app.get("/audit-logs", response_model=List[schemas.AuditLogOut])
def list_audit_logs(limit: int = 100, db: Session = Depends(get_db)):
    return crud.list_audit_logs(db, limit=limit)


@app.get("/inspection-items", response_model=List[schemas.InspectionItemOut])
def list_inspection_items(db: Session = Depends(get_db)):
    return crud.get_inspection_items(db)


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
        item_name=result.item.name,
    )


def _serialize_run(run: models.InspectionRun) -> schemas.InspectionRunOut:
    cluster = run.cluster
    if cluster is None:
        raise HTTPException(status_code=500, detail="Cluster information missing.")
    return schemas.InspectionRunOut(
        id=run.id,
        operator=run.operator,
        cluster_id=cluster.id,
        cluster_name=cluster.name,
        status=run.status,
        summary=run.summary,
        report_path=run.report_path,
        created_at=run.created_at,
        completed_at=run.completed_at,
        results=[_serialize_result(result) for result in run.results],
    )


def _serialize_run_list(run: models.InspectionRun) -> schemas.InspectionRunListOut:
    cluster = run.cluster
    if cluster is None:
        raise HTTPException(status_code=500, detail="Cluster information missing.")
    return schemas.InspectionRunListOut(
        id=run.id,
        operator=run.operator,
        cluster_id=cluster.id,
        cluster_name=cluster.name,
        status=run.status,
        summary=run.summary,
        report_path=run.report_path,
        created_at=run.created_at,
        completed_at=run.completed_at,
    )


@app.post("/inspection-runs", response_model=schemas.InspectionRunOut, status_code=201)
def trigger_inspection(
    run_in: schemas.InspectionRunCreate, db: Session = Depends(get_db)
):
    if not run_in.item_ids:
        raise HTTPException(status_code=400, detail="No inspection items selected.")

    cluster = crud.get_cluster(db, run_in.cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")
    kubeconfig_path = Path(cluster.kubeconfig_path)
    if not kubeconfig_path.exists():
        raise HTTPException(status_code=500, detail="集群 kubeconfig 文件不存在。")

    items = crud.get_items_by_ids(db, run_in.item_ids)
    if len(items) != len(set(run_in.item_ids)):
        raise HTTPException(
            status_code=400, detail="One or more inspection items do not exist."
        )

    run = crud.create_inspection_run(
        db, operator=run_in.operator, cluster=cluster, status="running"
    )

    prom_client: Optional[PrometheusClient] = None
    if cluster.prometheus_url:
        prom_client = PrometheusClient(cluster.prometheus_url)

    context = CheckContext(
        kubeconfig_path=str(kubeconfig_path),
        prom=prom_client,
    )

    status_counter = {"passed": 0, "warning": 0, "failed": 0}
    for item in items:
        status, detail, suggestion = dispatch_checks(item.check_type, context)
        sanitized_detail = _sanitize_optional_text(detail)
        sanitized_suggestion = _sanitize_optional_text(suggestion)
        crud.add_inspection_result(
            db,
            run=run,
            item=item,
            status=status,
            detail=sanitized_detail,
            suggestion=sanitized_suggestion,
        )
        status_counter[status] = status_counter.get(status, 0) + 1

    overall_status = "passed"
    if status_counter.get("failed", 0) > 0:
        overall_status = "failed"
    elif status_counter.get("warning", 0) > 0:
        overall_status = "warning"

    summary = (
        f"Cluster {cluster.name} -> passed: {status_counter['passed']}, "
        f"warning: {status_counter['warning']}, failed: {status_counter['failed']}."
    )

    run = crud.finalize_inspection_run(
        db,
        run=run,
        status=overall_status,
        summary=summary,
        report_path=None,
    )

    run = crud.get_inspection_run(db, run.id)
    if not run:
        raise HTTPException(status_code=500, detail="无法加载巡检结果。")

    report_path = generate_pdf_report(run=run, results=run.results)
    run.report_path = report_path
    db.add(run)
    db.commit()
    db.refresh(run)
    crud.log_action(
        db,
        action="update",
        entity_type="inspection_run",
        entity_id=run.id,
        description="Attached PDF report to inspection run.",
    )

    run = crud.get_inspection_run(db, run.id)
    if not run:
        raise HTTPException(status_code=500, detail="Unable to refresh run details.")
    return _serialize_run(run)


@app.get("/inspection-runs", response_model=List[schemas.InspectionRunListOut])
def list_inspection_runs(db: Session = Depends(get_db)):
    runs = crud.list_inspection_runs(db)
    return [_serialize_run_list(run) for run in runs]


@app.get("/inspection-runs/{run_id}", response_model=schemas.InspectionRunOut)
def get_inspection_run(run_id: int, db: Session = Depends(get_db)):
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    return _serialize_run(run)


@app.delete("/inspection-runs/{run_id}", status_code=204)
def delete_inspection_run(run_id: int, db: Session = Depends(get_db)):
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    report_path = run.report_path
    crud.delete_inspection_run(db, run)
    _remove_file_safely(report_path)
    return {}


@app.get("/inspection-runs/{run_id}/report")
def download_report(run_id: int, db: Session = Depends(get_db)):
    run = crud.get_inspection_run(db, run_id)
    if not run or not run.report_path:
        raise HTTPException(status_code=404, detail="Report not found.")
    path = Path(run.report_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Report file missing on server.")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=path.name,
    )
