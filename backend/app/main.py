from __future__ import annotations

import json
import logging
import re
import threading
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable, Dict, List, Optional
from uuid import uuid4
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

import os
import shutil
import subprocess
import yaml
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
import urllib3
from pydantic import ValidationError

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
from .license import LicenseError, license_manager
from .pdf import generate_markdown_report, generate_pdf_report
from .prometheus import PrometheusClient

logger = logging.getLogger(__name__)

_INSPECTION_EXECUTOR = ThreadPoolExecutor(max_workers=4)


@dataclass
class RunExecutionControl:
    pause_event: threading.Event = field(default_factory=threading.Event)
    cancel_event: threading.Event = field(default_factory=threading.Event)

    def __post_init__(self) -> None:
        self.pause_event.set()


_RUN_EXECUTION_LOCK = threading.Lock()
_ACTIVE_RUN_CONTROLS: Dict[int, RunExecutionControl] = {}
_ACTIVE_RUN_FUTURES: Dict[int, Future] = {}
_RUN_ITEM_CACHE: Dict[int, List[int]] = {}


def _register_run_execution(
    run_id: int,
    item_ids: List[int],
    control: RunExecutionControl,
    future: Future,
) -> None:
    snapshot = list(item_ids)
    with _RUN_EXECUTION_LOCK:
        _RUN_ITEM_CACHE[run_id] = snapshot
        _ACTIVE_RUN_CONTROLS[run_id] = control
        _ACTIVE_RUN_FUTURES[run_id] = future

    def _cleanup(fut: Future) -> None:
        with _RUN_EXECUTION_LOCK:
            stored = _ACTIVE_RUN_FUTURES.get(run_id)
            if stored is not fut:
                return
            _ACTIVE_RUN_FUTURES.pop(run_id, None)
            _ACTIVE_RUN_CONTROLS.pop(run_id, None)
        logger.info("Inspection run %s worker completed.", run_id)
        db = SessionLocal()
        try:
            run = crud.get_inspection_run(db, run_id)
            if run and run.status not in {"running", "paused"}:
                with _RUN_EXECUTION_LOCK:
                    _RUN_ITEM_CACHE.pop(run_id, None)
                    logger.debug(
                        "Inspection run %s cache cleared after completion.",
                        run_id,
                    )
        finally:
            db.close()

    future.add_done_callback(_cleanup)


def _get_run_control(run_id: int) -> Optional[RunExecutionControl]:
    with _RUN_EXECUTION_LOCK:
        return _ACTIVE_RUN_CONTROLS.get(run_id)


def _get_run_future(run_id: int) -> Optional[Future]:
    with _RUN_EXECUTION_LOCK:
        return _ACTIVE_RUN_FUTURES.get(run_id)


def _get_run_item_ids(run_id: int) -> Optional[List[int]]:
    with _RUN_EXECUTION_LOCK:
        snapshot = _RUN_ITEM_CACHE.get(run_id)
        return list(snapshot) if snapshot is not None else None


def _submit_run_execution(run_id: int, item_ids: List[int]) -> None:
    control = RunExecutionControl()
    future = _INSPECTION_EXECUTOR.submit(
        _execute_inspection_run_async,
        run_id,
        list(item_ids),
        control,
    )
    logger.info(
        "Inspection run %s scheduled with %d items.",
        run_id,
        len(item_ids),
    )
    _register_run_execution(run_id, list(item_ids), control, future)


def _pause_run_execution(run_id: int) -> None:
    control = _get_run_control(run_id)
    if control:
        control.pause_event.clear()
        logger.info("Inspection run %s paused (worker waiting).", run_id)


def _resume_run_execution(run_id: int) -> bool:
    control = _get_run_control(run_id)
    future = _get_run_future(run_id)
    if not control or not future:
        logger.warning(
            "Inspection run %s resume requested without active worker.",
            run_id,
        )
        return False
    if future.done():
        logger.info(
            "Inspection run %s worker already finished before resume.",
            run_id,
        )
        return False
    control.pause_event.set()
    logger.info("Inspection run %s resumed on existing worker.", run_id)
    return True


def _cancel_run_execution(run_id: int) -> None:
    control = _get_run_control(run_id)
    if control:
        control.cancel_event.set()
        control.pause_event.set()
        logger.info("Inspection run %s received cancellation request.", run_id)


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
    for index, candidate in enumerate(runs, start=1):
        if candidate.id == run.id:
            return f"{slug}-{index:02d}"
    return f"{slug}-{run.id:02d}"


def _calculate_run_progress(run: models.InspectionRun) -> tuple[int, int, int]:
    total_items = run.total_items or 0
    processed_items = run.processed_items or 0
    active_statuses = {"running", "paused", "cancelled"}
    if total_items > 0:
        processed_items = max(0, min(processed_items, total_items))
        if run.status not in active_statuses:
            processed_items = max(processed_items, total_items)
        progress = int((processed_items / total_items) * 100)
    else:
        progress = 0 if run.status in active_statuses else 100
    progress = max(0, min(progress, 100))
    return total_items, processed_items, progress

app = FastAPI(title="K8s Inspection Service", version="0.3.0")

CONNECTION_TEST_TIMEOUT_SECONDS = 8.0
CONNECTION_TEST_CONNECT_TIMEOUT = 3.0
CONNECTION_TEST_READ_TIMEOUT = 5.0

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


def _execute_inspection_run_async(
    run_id: int,
    item_ids: List[int],
    control: RunExecutionControl,
) -> None:
    db = SessionLocal()
    try:
        run = crud.get_inspection_run(db, run_id)
        if not run:
            logger.error("Inspection run %s not found for async execution.", run_id)
            return

        cluster = crud.get_cluster(db, run.cluster_id)
        if not cluster:
            raise RuntimeError("指定的集群不存在。")

        kubeconfig_path = Path(cluster.kubeconfig_path)
        if not kubeconfig_path.exists():
            raise RuntimeError("集群 kubeconfig 文件不存在。")

        items = crud.get_items_by_ids(db, item_ids)
        if len(items) != len(set(item_ids)):
            raise RuntimeError("部分巡检项不存在或已删除。")

        total_items = len(items)
        if run.total_items != total_items:
            run.total_items = total_items
            db.add(run)
            db.commit()
            db.refresh(run)

        processed_count = int(run.processed_items or 0)
        if processed_count < 0:
            processed_count = 0
        if processed_count > total_items:
            processed_count = total_items
        remaining_items = items[processed_count:]
        logger.info(
            "Inspection run %s worker active: %d/%d items already processed.",
            run_id,
            processed_count,
            total_items,
        )

        prom_client: Optional[PrometheusClient] = None
        if cluster.prometheus_url:
            prom_client = PrometheusClient(cluster.prometheus_url)

        context = CheckContext(
            kubeconfig_path=str(kubeconfig_path),
            prom=prom_client,
        )

        status_counter = {"passed": 0, "warning": 0, "failed": 0}
        for existing in run.results or []:
            key = (existing.status or "passed").lower()
            if key not in {"passed", "warning", "failed"}:
                key = "warning"
            status_counter[key] = status_counter.get(key, 0) + 1

        for offset, item in enumerate(remaining_items, start=1):
            target_index = processed_count + offset
            while True:
                if control.cancel_event.is_set():
                    logger.info("Inspection run %s interrupted via cancel event.", run_id)
                    return
                control.pause_event.wait()
                if control.cancel_event.is_set():
                    logger.info("Inspection run %s interrupted via cancel event.", run_id)
                    return
                try:
                    db.refresh(run)
                except Exception:
                    refreshed = crud.get_inspection_run(db, run_id)
                    if not refreshed:
                        logger.info("Inspection run %s no longer exists, aborting execution.", run_id)
                        return
                    run = refreshed
                if run.status == "paused":
                    control.pause_event.clear()
                    continue
                if run.status != "running":
                    logger.info(
                        "Inspection run %s interrupted with status %s.",
                        run_id,
                        run.status,
                    )
                    return
                break
            status, detail, suggestion = dispatch_checks(
                item.check_type, context, item.config
            )
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
            run = crud.update_inspection_run_progress(
                db, run=run, processed_items=target_index
            )
            normalized_status = (status or "warning").lower()
            if normalized_status not in {"passed", "warning", "failed"}:
                normalized_status = "warning"
            status_counter[normalized_status] = status_counter.get(normalized_status, 0) + 1

        if control.cancel_event.is_set():
            logger.info(
                "Inspection run %s cancellation detected before finalization.",
                run_id,
            )
            return
        try:
            db.refresh(run)
        except Exception:
            refreshed = crud.get_inspection_run(db, run_id)
            if not refreshed:
                logger.info(
                    "Inspection run %s missing during finalization, aborting.",
                    run_id,
                )
                return
            run = refreshed
        if run.status == "cancelled":
            logger.info("Inspection run %s has been cancelled before finalization.", run_id)
            return

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
            processed_items=run.total_items or len(items),
        )

        run = crud.get_inspection_run(db, run.id)
        if not run:
            raise RuntimeError("无法加载巡检结果。")

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
            description="Attached PDF report to inspection run.",
        )
        logger.info("Inspection run %s completed with status %s.", run_id, overall_status)
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Inspection run %s failed during execution.", run_id)
        db.rollback()
        run = crud.get_inspection_run(db, run_id)
        if run:
            message = _sanitize_optional_text(str(exc)) or "巡检执行过程中出现未知错误。"
            summary = f"巡检执行失败：{message}"
            crud.finalize_inspection_run(
                db,
                run=run,
                status="failed",
                summary=summary[:500],
                report_path=None,
                processed_items=run.total_items or len(item_ids),
            )
    finally:
        db.close()


def _seed_defaults(db: Session) -> None:
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
    path = Path("backend/data/configs") / filename
    path.write_bytes(data)
    return str(path)


def _remove_file_safely(path: str | Path | None) -> None:
    if not path:
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


def _fetch_server_version_with_kubectl(kubeconfig_path: str) -> Optional[str]:
    if shutil.which("kubectl") is None:
        return None
    env = os.environ.copy()
    env["KUBECONFIG"] = kubeconfig_path
    command = "kubectl version | grep Server | awk '{print $3}'"
    try:
        result = subprocess.run(
            command,
            shell=True,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            timeout=CONNECTION_TEST_READ_TIMEOUT,
        )
    except (subprocess.SubprocessError, OSError) as exc:
        logger.warning("执行 kubectl version 命令失败: %s", exc)
        return None
    if result.returncode != 0:
        logger.warning(
            "kubectl version 命令返回非零退出码(%s): %s",
            result.returncode,
            result.stderr.strip(),
        )
        return None
    output = result.stdout.strip()
    return output or None


def _test_cluster_connection(kubeconfig_path: str) -> tuple[str, str]:
    if not k8s_config or not k8s_client:
        return (
            "warning",
            "\u540e\u7aef\u672a\u5b89\u88c5 kubernetes Python \u5ba2\u6237\u7aef\uff0c\u8df3\u8f6c\u8fde\u901a\u6027\u6821\u9a8c\u3002",
        )

    def _perform_check() -> tuple[str, str]:
        api_client = k8s_config.new_client_from_config(config_file=kubeconfig_path)
        rest_client = getattr(api_client, "rest_client", None)
        pool_manager = getattr(rest_client, "pool_manager", None)
        if pool_manager and hasattr(pool_manager, "connection_pool_kw"):
            pool_manager.connection_pool_kw["timeout"] = urllib3.Timeout(
                connect=CONNECTION_TEST_CONNECT_TIMEOUT,
                read=CONNECTION_TEST_READ_TIMEOUT,
            )

        git_version = _fetch_server_version_with_kubectl(kubeconfig_path) or ""
        if not git_version:
            version_api = k8s_client.VersionApi(api_client)
            version_info = version_api.get_code(
                _request_timeout=CONNECTION_TEST_READ_TIMEOUT
            )
            git_version = (version_info.git_version or "").strip()
            if not git_version:
                git_version = f"{version_info.major}.{version_info.minor}".strip()

        core_api = k8s_client.CoreV1Api(api_client)
        nodes = core_api.list_node(
            _request_timeout=CONNECTION_TEST_READ_TIMEOUT,
            _preload_content=True,
        )
        node_count = len(nodes.items)
        if not git_version:
            git_version = "unknown"
        detail = f"Server version {git_version}; nodes {node_count}."
        return "connected", detail

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(_perform_check)
        try:
            return future.result(timeout=CONNECTION_TEST_TIMEOUT_SECONDS)
        except FuturesTimeoutError:
            return (
                "failed",
                f"\u8fde\u63a5\u6821\u9a8c\u8d85\u65f6(>{CONNECTION_TEST_TIMEOUT_SECONDS}\u79d2)\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u8fde\u901a\u6027\u6216\u76ee\u6807\u5730\u5740\u3002",
            )
        except ApiException as exc:
            reason = exc.reason or exc.body or str(exc)
            return "failed", f"Kubernetes API error: {reason}"
        except Exception as exc:  # pragma: no cover
            return "failed", f"Cluster validation error: {exc}"

    try:
        return _perform_check()
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
    stored_message = sanitized_message or "No additional details."
    _log_connection_status(cluster.name, status, message)
    cluster = crud.update_cluster(
        db,
        cluster,
        connection_status=status,
        connection_message=stored_message,
        last_checked_at=datetime.utcnow(),
    )

    return _present_cluster(cluster)



@app.post(
    "/clusters/{cluster_id}/test-connection",
    response_model=schemas.ClusterConfigOut,
)
def test_cluster_connection(cluster_id: int, db: Session = Depends(get_db)):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    kubeconfig_path = Path(cluster.kubeconfig_path)
    if not kubeconfig_path.exists():
        raise HTTPException(status_code=500, detail="集群 kubeconfig 文件不存在。")

    status, message = _test_cluster_connection(cluster.kubeconfig_path)
    sanitized_message = _sanitize_message(message)
    stored_message = sanitized_message or "No additional details."
    _log_connection_status(cluster.name, status, message)
    cluster = crud.update_cluster(
        db,
        cluster,
        connection_status=status,
        connection_message=stored_message,
        last_checked_at=datetime.utcnow(),
    )
    return _present_cluster(cluster)


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
        sanitized_message = _sanitize_message(message)
        stored_message = sanitized_message or "No additional details."
        connection_message = stored_message
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

    return _present_cluster(cluster)


@app.delete("/clusters/{cluster_id}", status_code=204)
def delete_cluster(
    cluster_id: int,
    delete_files: bool = Query(
        False,
        description="同时删除本地 kubeconfig 及关联巡检报告文件",
    ),
    db: Session = Depends(get_db),
):
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    report_paths: list[str] = []
    kubeconfig_path: str | None = None
    if delete_files:
        runs = (
            db.query(models.InspectionRun)
            .filter(models.InspectionRun.cluster_id == cluster_id)
            .all()
        )
        report_paths = [run.report_path for run in runs if run.report_path]
        kubeconfig_path = cluster.kubeconfig_path

    crud.delete_cluster(db, cluster)

    if delete_files:
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
    kubeconfig_path = Path(cluster.kubeconfig_path)
    if not kubeconfig_path.exists():
        raise HTTPException(status_code=500, detail="集群 kubeconfig 文件不存在。")

    items = crud.get_items_by_ids(db, run_in.item_ids)
    if len(items) != len(set(run_in.item_ids)):
        raise HTTPException(
            status_code=400, detail="One or more inspection items do not exist."
        )

    run = crud.create_inspection_run(
        db,
        operator=run_in.operator,
        cluster=cluster,
        status="running",
        total_items=len(items),
        processed_items=0,
    )

    _submit_run_execution(run.id, list(run_in.item_ids))

    run = crud.get_inspection_run(db, run.id)
    if not run:
        raise HTTPException(status_code=500, detail="无法加载巡检任务。")
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
    if run.status not in {"running", "paused"}:
        raise HTTPException(status_code=400, detail="仅可取消进行中或已暂停的巡检。")
    crud.cancel_inspection_run(db, run)
    _cancel_run_execution(run.id)
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
