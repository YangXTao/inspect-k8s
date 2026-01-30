from __future__ import annotations

import json
import math
import logging
import os
import re
import secrets
import shutil
import socket
import ssl
import warnings
from dataclasses import dataclass
import base64
import binascii
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Dict, List, Optional, Any, Generator, Iterable
from uuid import uuid4
import yaml
from urllib.parse import urlparse
import requests
from urllib3.exceptions import InsecureRequestWarning
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    Query,
    Header,
    Request,
    Response,
)
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse, JSONResponse
from sqlalchemy import func
from sqlalchemy.orm import Session
from pydantic import ValidationError

from . import crud, models, schemas
from .audit import AuditActor, set_audit_actor, reset_audit_actor
from .cron import CronValidationError, parse_cron_expression
from .auth import (
    AUTH_COOKIE_NAME,
    COOKIE_SAMESITE,
    COOKIE_SECURE,
    KNOWN_PERMISSIONS,
    PASSWORD_ITERATIONS,
    PASSWORD_SALT_BYTES,
    SESSION_TTL_HOURS,
    build_login_challenge,
    create_session,
    ensure_default_admin,
    ensure_default_roles,
    get_user_from_session,
    get_user_permissions,
    get_user_role_names,
    hash_password,
    normalize_permissions,
    parse_password_hash,
    parse_permissions_json,
    user_has_any_permission,
    user_has_permission,
    verify_login_proof,
    verify_password,
)
from .database import SessionLocal, ensure_runtime_directories, init_db
from .inspections import CheckContext, DEFAULT_CHECKS, dispatch_checks
from .license import LicenseError, license_manager
from .pdf import generate_markdown_report, generate_pdf_report, get_cluster_report_dirs
from .prometheus import PrometheusClient
from .scheduler import InspectionScheduler

logger = logging.getLogger(__name__)

_DEFAULT_INSPECTIONS_SENTINEL = Path("data/state/default_inspections_seeded.flag")
AGENT_HEARTBEAT_TIMEOUT_MINUTES = 1
AGENT_HEARTBEAT_TIMEOUT = timedelta(minutes=AGENT_HEARTBEAT_TIMEOUT_MINUTES)
CONNECTION_TEST_OPERATOR = "__system_connection_test__"
MAX_CLUSTER_NAME_LENGTH = 150
DEFAULT_PROMETHEUS_URL = (
    "http://rancher-monitoring-prometheus.cattle-monitoring-system:9090"
)


def _build_rancher_auth(
    api_key: str,
) -> tuple[Optional[tuple[str, str]], Dict[str, str]]:
    raw = (api_key or "").strip()
    if not raw:
        return None, {}
    if raw.lower().startswith("bearer "):
        return None, {"Authorization": raw}
    if ":" in raw:
        user, password = raw.split(":", 1)
        return (user, password), {}
    return (raw, ""), {}


def _fetch_rancher_version_from_cluster(
    cluster: models.ClusterConfig,
) -> Optional[str]:
    rancher_url = (getattr(cluster, "rancher_url", None) or "").strip()
    rancher_api_key = (getattr(cluster, "rancher_api_key", None) or "").strip()
    if not rancher_url or not rancher_api_key:
        return None
    url = rancher_url.rstrip("/") + "/v3/settings/server-version"
    try:
        auth, headers = _build_rancher_auth(rancher_api_key)
        warnings.filterwarnings("ignore", category=InsecureRequestWarning)
        resp = requests.get(
            url,
            auth=auth,
            headers=headers,
            timeout=10,
            verify=False,
        )
        resp.raise_for_status()
        payload = resp.json()
        version = str(payload.get("value") or "").strip()
        return version or None
    except Exception as exc:
        logger.warning("获取 Rancher 版本失败: %s", exc)
        return None


def _fetch_rancher_cert_expiry(rancher_url: str) -> Optional[str]:
    if not rancher_url:
        return None
    parsed = urlparse(rancher_url)
    if not parsed.hostname:
        return None
    scheme = (parsed.scheme or "https").lower()
    if scheme != "https":
        return None
    port = parsed.port or 443
    try:
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        with socket.create_connection((parsed.hostname, port), timeout=10) as sock:
            with context.wrap_socket(sock, server_hostname=parsed.hostname) as ssock:
                cert = ssock.getpeercert()
        not_after = cert.get("notAfter") if cert else None
        return not_after.strip() if isinstance(not_after, str) and not_after.strip() else None
    except Exception as exc:
        logger.warning("获取 Rancher 证书过期时间失败: %s", exc)
        return None


def _is_k8s_cert_expiry_item(name: str) -> bool:
    if not name:
        return False
    trimmed = name.strip()
    lowered = trimmed.lower()
    if trimmed == "K8s 证书过期时间检查":
        return True
    if "证书过期时间" in trimmed and ("k8s" in lowered or "kubernetes" in lowered):
        return True
    return False


def _append_rancher_cert_detail(
    detail: Optional[str], expiry: str
) -> Optional[str]:
    if not expiry:
        return detail
    line = f"rancher证书 {expiry}"
    if not detail:
        return f"组件 过期时间\n{line}"
    normalized = (
        str(detail)
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .strip()
    )
    if not normalized:
        return f"组件 过期时间\n{line}"
    lines = [item.strip() for item in normalized.split("\n") if item.strip()]
    if any("rancher证书" in item for item in lines):
        return detail
    header = lines[0]
    has_name_column = "证书名称" in header and "过期时间" in header
    has_two_columns = "组件" in header and (
        "过期时间" in header or "证书过期时间" in header
    )
    if has_name_column:
        line = f"rancher证书 Rancher证书 {expiry}"
    elif not has_two_columns:
        line = f"rancher证书 {expiry}"
    return f"{detail.rstrip()}\n{line}"
inspection_scheduler = InspectionScheduler(
    operator_label="定时巡检任务",
    multi_version_label="多版本",
)


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


def _build_archived_cluster_name(name: str | None, cluster_id: int) -> str:
    base = (name or "cluster").strip() or "cluster"
    suffix = f" (已归档-{cluster_id})"
    max_length = MAX_CLUSTER_NAME_LENGTH
    if len(base) + len(suffix) > max_length:
        base = base[: max_length - len(suffix)].rstrip()
        if not base:
            base = "cluster"
    return f"{base}{suffix}"


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
        critical = status_counter.get("critical", 0)
        failed = status_counter.get("failed", 0)
        if failed > 0:
            overall_status = "finished"
            summary = (
                f"巡检完成，但存在失败：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"严重 {critical} 项，"
                f"失败 {failed} 项。"
            )
        elif critical > 0:
            overall_status = "finished"
            summary = (
                f"巡检完成，但存在严重：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"严重 {critical} 项，"
                f"失败 {failed} 项。"
            )
        elif warnings > 0:
            overall_status = "finished"
            summary = (
                f"巡检完成，但存在告警：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"严重 {critical} 项，"
                f"失败 {failed} 项。"
            )
        else:
            overall_status = "finished"
            summary = (
                f"巡检完成：通过 {passed} 项，"
                f"告警 {warnings} 项，"
                f"严重 {critical} 项，"
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
    run_label = crud.describe_inspection_run(db, run)
    audit_override = crud.get_run_audit_override(run)
    crud.log_action(
        db,
        action="create",
        entity_type="inspection_run",
        entity_id=run.id,
        description=f"生成巡检报告：{run_label}",
        **audit_override,
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


def _has_pending_connection_test(
    db: Session, cluster: models.ClusterConfig, agent_id: Optional[int] = None
) -> bool:
    query = (
        db.query(models.InspectionRun)
        .filter(
            models.InspectionRun.cluster_id == cluster.id,
            models.InspectionRun.operator == CONNECTION_TEST_OPERATOR,
            models.InspectionRun.status.in_(("queued", "running")),
        )
    )
    if agent_id is not None:
        query = query.filter(models.InspectionRun.agent_id == agent_id)
    return query.first() is not None


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
        prometheus_version="3.2",
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
    if _has_pending_connection_test(db, cluster, agent.id):
        return
    _enqueue_connection_test_run(db, cluster, agent)
    crud.update_cluster(
        db,
        cluster,
        connection_status="warning",
        connection_message=message,
        log_audit=False,
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


def _derive_agent_image_from_backend_image(
    backend_image: str | None,
) -> str | None:
    if not backend_image:
        return None
    image = backend_image.strip()
    if not image:
        return None
    name = image
    digest = None
    if "@" in image:
        name, digest = image.split("@", 1)
    tag = None
    last_slash = name.rfind("/")
    last_colon = name.rfind(":")
    if last_colon > last_slash:
        tag = name[last_colon + 1 :]
        name = name[:last_colon]
    if "/" in name:
        repo = name.rsplit("/", 1)[0]
        new_name = f"{repo}/agent"
    else:
        new_name = "agent"
    if tag:
        new_name = f"{new_name}:{tag}"
    if digest:
        new_name = f"{new_name}@{digest}"
    return new_name


def _build_system_agent_install_script() -> str:
    backend_image = os.getenv("INSPECT_BACKEND_IMAGE") or os.getenv("BACKEND_IMAGE") or ""
    agent_image_default = _derive_agent_image_from_backend_image(backend_image) or ""
    lines = [
        "#!/bin/sh",
        "set -eu",
        "",
        "usage() {",
        "  cat <<'USAGE'",
        "Usage:",
        "  system-agent-install.sh --server <url> --token <token> [options]",
        "",
        "Options:",
        "  --cluster-name <name>     Cluster name (default: kubectl context or hostname)",
        "  --prometheus-url <url>    Prometheus URL (optional)",
        "  --kubeconfig <path>       Kubeconfig path (default: current kubectl context)",
        "  --namespace <name>        Namespace for agent resources (default: inspect)",
        "  --agent-image <image>     Agent image (default: derive from backend image)",
        "  --image-pull-secret <name> Image pull secret name (optional)",
        "  --insecure                Skip TLS verification",
        "  -h, --help                Show help",
        "USAGE",
        "}",
        "",
        "SERVER=\"\"",
        "TOKEN=\"\"",
        "CLUSTER_NAME=\"\"",
        "PROM_URL=\"\"",
        "KUBECONFIG_PATH=\"\"",
        "INSECURE=\"false\"",
        "NAMESPACE=\"inspect\"",
        "AGENT_IMAGE=\"\"",
        f"DEFAULT_AGENT_IMAGE=\"{agent_image_default}\"",
        "IMAGE_PULL_SECRET=\"\"",
        "VERIFY_SSL=\"true\"",
        "",
        "while [ \"$#\" -gt 0 ]; do",
        "  case \"$1\" in",
        "    --server) SERVER=\"$2\"; shift 2 ;;",
        "    --token) TOKEN=\"$2\"; shift 2 ;;",
        "    --cluster-name) CLUSTER_NAME=\"$2\"; shift 2 ;;",
        "    --prometheus-url) PROM_URL=\"$2\"; shift 2 ;;",
        "    --kubeconfig) KUBECONFIG_PATH=\"$2\"; shift 2 ;;",
        "    --namespace) NAMESPACE=\"$2\"; shift 2 ;;",
        "    --agent-image) AGENT_IMAGE=\"$2\"; shift 2 ;;",
        "    --image-pull-secret) IMAGE_PULL_SECRET=\"$2\"; shift 2 ;;",
        "    --insecure) INSECURE=\"true\"; shift ;;",
        "    -h|--help) usage; exit 0 ;;",
        "    --) shift; break ;;",
        "    *) echo \"Unknown arg: $1\" >&2; usage; exit 1 ;;",
        "  esac",
        "done",
        "",
        "if [ -z \"$SERVER\" ] || [ -z \"$TOKEN\" ]; then",
        "  echo \"Missing --server or --token.\" >&2",
        "  usage",
        "  exit 1",
        "fi",
        "",
        "if ! command -v kubectl >/dev/null 2>&1; then",
        "  echo \"kubectl not found.\" >&2",
        "  exit 1",
        "fi",
        "",
        "KUBECTL_ARGS=\"\"",
        "if [ -n \"$KUBECONFIG_PATH\" ]; then",
        "  KUBECTL_ARGS=\"--kubeconfig $KUBECONFIG_PATH\"",
        "fi",
        "",
        "if [ -n \"$KUBECONFIG_PATH\" ]; then",
        "  KUBE_DATA=$(cat \"$KUBECONFIG_PATH\")",
        "else",
        "  KUBE_DATA=$(kubectl $KUBECTL_ARGS config view --raw --minify)",
        "fi",
        "",
        "if command -v base64 >/dev/null 2>&1; then",
        "  if printf \"%s\" \"$KUBE_DATA\" | base64 -w 0 >/dev/null 2>&1; then",
        "    KUBE_B64=$(printf \"%s\" \"$KUBE_DATA\" | base64 -w 0)",
        "  elif printf \"%s\" \"$KUBE_DATA\" | base64 -b 0 >/dev/null 2>&1; then",
        "    KUBE_B64=$(printf \"%s\" \"$KUBE_DATA\" | base64 -b 0)",
        "  else",
        "    KUBE_B64=$(printf \"%s\" \"$KUBE_DATA\" | base64 | tr -d '\\\\r\\\\n')",
        "  fi",
        "else",
        "  echo \"base64 not found.\" >&2",
        "  exit 1",
        "fi",
        "",
        "if [ -z \"$CLUSTER_NAME\" ]; then",
        "  CLUSTER_NAME=$(kubectl $KUBECTL_ARGS config current-context 2>/dev/null || true)",
        "fi",
        "if [ -z \"$CLUSTER_NAME\" ]; then",
        "  CLUSTER_NAME=$(hostname)",
        "fi",
        "",
        "json_escape() {",
        "  printf \"%s\" \"$1\" | sed 's/\\\\/\\\\\\\\/g; s/\\\"/\\\\\\\"/g'",
        "}",
        "",
        "TOKEN_ESC=$(json_escape \"$TOKEN\")",
        "CLUSTER_NAME_ESC=$(json_escape \"$CLUSTER_NAME\")",
        "PROM_URL_ESC=$(json_escape \"$PROM_URL\")",
        "",
        "if [ -z \"$AGENT_IMAGE\" ]; then",
        "  if [ -n \"$DEFAULT_AGENT_IMAGE\" ]; then",
        "    AGENT_IMAGE=\"$DEFAULT_AGENT_IMAGE\"",
        "    echo \"Using agent image: $AGENT_IMAGE\"",
        "  else",
        "    AGENT_IMAGE=\"inspect-agent:dev\"",
        "    echo \"Backend image not found, fallback to $AGENT_IMAGE\"",
        "  fi",
        "fi",
        "",
        "if [ -n \"$PROM_URL\" ]; then",
        "  payload=$(printf '{\"registration_token\":\"%s\",\"prometheus_url\":\"%s\",\"cluster\":{\"name\":\"%s\",\"kubeconfig_b64\":\"%s\",\"kubeconfig_name\":\"kubeconfig\"}}' \"$TOKEN_ESC\" \"$PROM_URL_ESC\" \"$CLUSTER_NAME_ESC\" \"$KUBE_B64\")",
        "else",
        "  payload=$(printf '{\"registration_token\":\"%s\",\"cluster\":{\"name\":\"%s\",\"kubeconfig_b64\":\"%s\",\"kubeconfig_name\":\"kubeconfig\"}}' \"$TOKEN_ESC\" \"$CLUSTER_NAME_ESC\" \"$KUBE_B64\")",
        "fi",
        "",
        "curl_flags=\"-fsSL\"",
        "if [ \"$INSECURE\" = \"true\" ]; then",
        "  curl_flags=\"${curl_flags} -k\"",
        "  VERIFY_SSL=\"false\"",
        "fi",
        "",
        "curl $curl_flags \"${SERVER}/agent/bootstrap\" \\",
        "  -H \"Content-Type: application/json\" \\",
        "  -d \"$payload\"",
        "echo \"\"",
        "echo \"Agent bootstrap finished.\"",
        "",
        "kubectl $KUBECTL_ARGS get namespace \"$NAMESPACE\" >/dev/null 2>&1 || \\",
        "  kubectl $KUBECTL_ARGS create namespace \"$NAMESPACE\"",
        "",
        "NAME=\"inspect-agent\"",
        "CONFIG_NAME=\"${NAME}-config\"",
        "SECRET_NAME=\"${NAME}-secret\"",
        "CLUSTER_ROLE_NAME=\"${NAME}-readonly-${NAMESPACE}\"",
        "CLUSTER_ROLE_BINDING_NAME=\"${NAME}-readonly-${NAMESPACE}\"",
        "",
        "if [ -n \"$IMAGE_PULL_SECRET\" ]; then",
        "  cat <<EOF | kubectl $KUBECTL_ARGS apply -f -",
        "apiVersion: v1",
        "kind: ServiceAccount",
        "metadata:",
        "  name: ${NAME}",
        "  namespace: ${NAMESPACE}",
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRole",
        "metadata:",
        "  name: ${CLUSTER_ROLE_NAME}",
        "rules:",
        "  - apiGroups: [\"*\"]",
        "    resources: [\"*\"]",
        "    verbs: [\"get\", \"list\", \"watch\"]",
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRoleBinding",
        "metadata:",
        "  name: ${CLUSTER_ROLE_BINDING_NAME}",
        "subjects:",
        "  - kind: ServiceAccount",
        "    name: ${NAME}",
        "    namespace: ${NAMESPACE}",
        "roleRef:",
        "  apiGroup: rbac.authorization.k8s.io",
        "  kind: ClusterRole",
        "  name: ${CLUSTER_ROLE_NAME}",
        "---",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: ${CONFIG_NAME}",
        "  namespace: ${NAMESPACE}",
        "data:",
        "  config.yaml: |",
        "    server:",
        "      base_url: ${SERVER}",
        "      token_file: /var/lib/inspect-agent/agent.token",
        "    agent:",
        "      poll_interval: 10",
        "      batch_size: 1",
        "      verify_ssl: ${VERIFY_SSL}",
        "      request_timeout: 15",
        "      node_report_interval: 60",
        "      metrics_report_interval: 60",
        "      status_report_interval: 60",
        "    cluster:",
        "      name: ${CLUSTER_NAME}",
        "    prometheus:",
        "      base_url: ${PROM_URL}",
        "---",
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: ${SECRET_NAME}",
        "  namespace: ${NAMESPACE}",
        "type: Opaque",
        "stringData:",
        "  registration_token: ${TOKEN}",
        "---",
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: ${NAME}",
        "  namespace: ${NAMESPACE}",
        "spec:",
        "  replicas: 1",
        "  selector:",
        "    matchLabels:",
        "      app: ${NAME}",
        "  template:",
        "    metadata:",
        "      labels:",
        "        app: ${NAME}",
        "    spec:",
        "      serviceAccountName: ${NAME}",
        "      imagePullSecrets:",
        "        - name: ${IMAGE_PULL_SECRET}",
        "      volumes:",
        "        - name: config",
        "          configMap:",
        "            name: ${CONFIG_NAME}",
        "        - name: state",
        "          emptyDir: {}",
        "      containers:",
        "        - name: ${NAME}",
        "          image: ${AGENT_IMAGE}",
        "          imagePullPolicy: IfNotPresent",
        "          env:",
        "            - name: INSPECT_AGENT_CONFIG",
        "              value: /app/config/config.yaml",
        "            - name: INSPECT_AGENT_REGISTRATION_TOKEN",
        "              valueFrom:",
        "                secretKeyRef:",
        "                  name: ${SECRET_NAME}",
        "                  key: registration_token",
        "                  optional: true",
        "          volumeMounts:",
        "            - name: config",
        "              mountPath: /app/config",
        "            - name: state",
        "              mountPath: /var/lib/inspect-agent",
        "EOF",
        "else",
        "  cat <<EOF | kubectl $KUBECTL_ARGS apply -f -",
        "apiVersion: v1",
        "kind: ServiceAccount",
        "metadata:",
        "  name: ${NAME}",
        "  namespace: ${NAMESPACE}",
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRole",
        "metadata:",
        "  name: ${CLUSTER_ROLE_NAME}",
        "rules:",
        "  - apiGroups: [\"*\"]",
        "    resources: [\"*\"]",
        "    verbs: [\"get\", \"list\", \"watch\"]",
        "---",
        "apiVersion: rbac.authorization.k8s.io/v1",
        "kind: ClusterRoleBinding",
        "metadata:",
        "  name: ${CLUSTER_ROLE_BINDING_NAME}",
        "subjects:",
        "  - kind: ServiceAccount",
        "    name: ${NAME}",
        "    namespace: ${NAMESPACE}",
        "roleRef:",
        "  apiGroup: rbac.authorization.k8s.io",
        "  kind: ClusterRole",
        "  name: ${CLUSTER_ROLE_NAME}",
        "---",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: ${CONFIG_NAME}",
        "  namespace: ${NAMESPACE}",
        "data:",
        "  config.yaml: |",
        "    server:",
        "      base_url: ${SERVER}",
        "      token_file: /var/lib/inspect-agent/agent.token",
        "    agent:",
        "      poll_interval: 10",
        "      batch_size: 1",
        "      verify_ssl: ${VERIFY_SSL}",
        "      request_timeout: 15",
        "      node_report_interval: 60",
        "      metrics_report_interval: 60",
        "      status_report_interval: 60",
        "    cluster:",
        "      name: ${CLUSTER_NAME}",
        "    prometheus:",
        "      base_url: ${PROM_URL}",
        "---",
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: ${SECRET_NAME}",
        "  namespace: ${NAMESPACE}",
        "type: Opaque",
        "stringData:",
        "  registration_token: ${TOKEN}",
        "---",
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: ${NAME}",
        "  namespace: ${NAMESPACE}",
        "spec:",
        "  replicas: 1",
        "  selector:",
        "    matchLabels:",
        "      app: ${NAME}",
        "  template:",
        "    metadata:",
        "      labels:",
        "        app: ${NAME}",
        "    spec:",
        "      serviceAccountName: ${NAME}",
        "      volumes:",
        "        - name: config",
        "          configMap:",
        "            name: ${CONFIG_NAME}",
        "        - name: state",
        "          emptyDir: {}",
        "      containers:",
        "        - name: ${NAME}",
        "          image: ${AGENT_IMAGE}",
        "          imagePullPolicy: IfNotPresent",
        "          env:",
        "            - name: INSPECT_AGENT_CONFIG",
        "              value: /app/config/config.yaml",
        "            - name: INSPECT_AGENT_REGISTRATION_TOKEN",
        "              valueFrom:",
        "                secretKeyRef:",
        "                  name: ${SECRET_NAME}",
        "                  key: registration_token",
        "                  optional: true",
        "          volumeMounts:",
        "            - name: config",
        "              mountPath: /app/config",
        "            - name: state",
        "              mountPath: /var/lib/inspect-agent",
        "EOF",
        "fi",
        "",
        "echo \"Agent resources applied.\"",
    ]
    return "\n".join(lines) + "\n"


app = FastAPI(title="K8s Inspection Service", version="0.3.0")
agent_router = APIRouter(prefix="/agent", tags=["agent"])


@app.exception_handler(HTTPException)
async def handle_http_exception(
    request: Request, exc: HTTPException
) -> PlainTextResponse:
    detail = exc.detail if exc.detail is not None else "请求失败"
    return PlainTextResponse(str(detail), status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def handle_validation_error(
    request: Request, exc: RequestValidationError
) -> PlainTextResponse:
    return PlainTextResponse("请求参数错误", status_code=422)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PUBLIC_AUTH_PATHS = {
    "/auth/login",
    "/auth/login-challenge",
    "/health",
    "/system-agent-install.sh",
    "/openapi.json",
}


def _is_public_path(path: str) -> bool:
    if path in PUBLIC_AUTH_PATHS:
        return True
    if path == "/agent" or path.startswith("/agent/"):
        return True
    if path == "/docs" or path.startswith("/docs/"):
        return True
    if path == "/redoc" or path.startswith("/redoc/"):
        return True
    return False


@app.middleware("http")
async def require_authentication(request: Request, call_next):
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if _is_public_path(path):
        return await call_next(request)
    audit_token = None
    user_id = None
    username = None
    with SessionLocal() as db:
        user = get_user_from_session(db, request.cookies.get(AUTH_COOKIE_NAME))
        if not user:
            return PlainTextResponse("未登录", status_code=401)
        user_id = user.id
        username = user.username
        request.state.user = user
    try:
        audit_token = set_audit_actor(
            AuditActor(
                user_id=user_id,
                username=username,
                ip_address=request.client.host if request.client else None,
                user_agent=request.headers.get("user-agent"),
            )
        )
        return await call_next(request)
    finally:
        if audit_token is not None:
            reset_audit_actor(audit_token)


def get_db() -> Session:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_current_user(
    request: Request, db: Session = Depends(get_db)
) -> models.AuthUser:
    user = get_user_from_session(db, request.cookies.get(AUTH_COOKIE_NAME))
    if not user:
        raise HTTPException(status_code=401, detail="未登录")
    return user


def _require_permission(
    db: Session, user: models.AuthUser, permission: str, label: str
) -> None:
    if not user_has_permission(db, user, permission):
        raise HTTPException(status_code=403, detail=f"无权限执行{label}")


def _require_any_permission(
    db: Session,
    user: models.AuthUser,
    permissions: list[str],
    label: str,
) -> None:
    if not user_has_any_permission(db, user, permissions):
        raise HTTPException(status_code=403, detail=f"无权限执行{label}")


def _seed_defaults(db: Session) -> None:
    if _DEFAULT_INSPECTIONS_SENTINEL.exists():
        return
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


def _is_promql_check_type(check_type: Optional[str]) -> bool:
    return (check_type or "").strip() == "promql"


def _normalize_prometheus_version(value: Optional[str]) -> str:
    if value is None:
        return "3.2"
    trimmed = str(value).strip()
    return trimmed or "3.2"


def _normalize_schedule_name(name: Optional[str]) -> Optional[str]:
    if name is None:
        return None
    trimmed = name.strip()
    return trimmed or None


def _ensure_unique_schedule_name(
    db: Session,
    name: Optional[str],
    schedule_id: Optional[int] = None,
) -> None:
    if not name:
        raise HTTPException(status_code=400, detail="定时巡检名称不能为空。")
    query = (
        db.query(models.InspectionSchedule)
        .filter(models.InspectionSchedule.name.isnot(None))
        .filter(func.lower(models.InspectionSchedule.name) == name.lower())
    )
    if schedule_id is not None:
        query = query.filter(models.InspectionSchedule.id != schedule_id)
    if query.first():
        raise HTTPException(status_code=400, detail="定时巡检名称已存在，请更换名称。")


def _resolve_schedule_last_run_at(
    db: Session,
    schedule: models.InspectionSchedule,
) -> Optional[datetime]:
    name = (schedule.name or "").strip()
    if not name:
        return None
    pattern = f"{name}%"
    return (
        db.query(func.max(models.InspectionRun.created_at))
        .filter(models.InspectionRun.operator.isnot(None))
        .filter(models.InspectionRun.operator.like(pattern))
        .filter(models.InspectionRun.operator != name)
        .scalar()
    )


def _normalize_cron_expression(expression: str) -> str:
    normalized = " ".join((expression or "").strip().split())
    if not normalized:
        raise CronValidationError("Cron expression is empty.")
    parse_cron_expression(normalized)
    return normalized


def _normalize_id_list(values: Iterable[int]) -> list[int]:
    seen: set[int] = set()
    result: list[int] = []
    for value in values:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            continue
        if parsed <= 0 or parsed in seen:
            continue
        seen.add(parsed)
        result.append(parsed)
    return result


def _validate_schedule_clusters(db: Session, cluster_ids: list[int]) -> None:
    if not cluster_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个集群。")
    clusters = (
        db.query(models.ClusterConfig)
        .filter(
            models.ClusterConfig.id.in_(cluster_ids),
            models.ClusterConfig.is_archived.is_(False),
        )
        .all()
    )
    found_ids = {cluster.id for cluster in clusters}
    missing = [cluster_id for cluster_id in cluster_ids if cluster_id not in found_ids]
    if missing:
        missing_text = "、".join(str(value) for value in missing)
        raise HTTPException(
            status_code=400,
            detail=f"包含不存在或已归档的集群：{missing_text}",
        )


def _validate_schedule_items(db: Session, item_ids: list[int]) -> None:
    if not item_ids:
        raise HTTPException(status_code=400, detail="请至少选择一个巡检项。")
    items = (
        db.query(models.InspectionItem)
        .filter(
            models.InspectionItem.id.in_(item_ids),
            models.InspectionItem.is_archived.is_(False),
        )
        .all()
    )
    found_ids = {item.id for item in items}
    missing = [item_id for item_id in item_ids if item_id not in found_ids]
    if missing:
        missing_text = "、".join(str(value) for value in missing)
        raise HTTPException(
            status_code=400,
            detail=f"包含不存在或已归档的巡检项：{missing_text}",
        )

def _inspection_item_name_conflict(
    existing_items: Iterable[models.InspectionItem],
    *,
    name: str,
    check_type: Optional[str],
    prometheus_version: Optional[str],
    exclude_id: Optional[int] = None,
) -> Optional[str]:
    trimmed_name = name.strip()
    new_is_promql = _is_promql_check_type(check_type)
    new_version = (
        _normalize_prometheus_version(prometheus_version) if new_is_promql else None
    )
    for item in existing_items:
        if exclude_id is not None and item.id == exclude_id:
            continue
        if (item.name or "").strip() != trimmed_name:
            continue
        existing_is_promql = _is_promql_check_type(item.check_type)
        if new_is_promql and existing_is_promql:
            existing_version = _normalize_prometheus_version(item.prometheus_version)
            if existing_version == new_version:
                return (
                    f"已存在同名同版本的 PromQL 巡检项（{new_version}）。"
                )
            continue
        return "已存在同名巡检项，非 PromQL 类型不支持重名。"
    return None


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
            crud.update_inspection_agent(
                db,
                agent,
                prometheus_url=prom_url,
                log_audit=False,
            )


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


def _remove_report_dir_safely(path: Path) -> None:
    try:
        if path.exists() and path.is_dir():
            shutil.rmtree(path)
    except Exception:
        pass


def _normalize_nodes_output(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.replace("\r\n", "\n").strip()
    if not normalized:
        return None
    if len(normalized) > 20000:
        normalized = normalized[:20000]
    return normalized


def _normalize_count(value: Optional[int]) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


def _normalize_percentage(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if parsed < 0:
        return None
    return parsed


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
        ensure_default_admin(db)
        ensure_default_roles(db)
    inspection_scheduler.start()


@app.on_event("shutdown")
def on_shutdown() -> None:
    inspection_scheduler.stop()


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}


def _serialize_auth_user(db: Session, user: models.AuthUser) -> schemas.AuthUserOut:
    payload = schemas.AuthUserOut.model_validate(user)
    return payload.model_copy(
        update={
            "permissions": get_user_permissions(db, user),
            "roles": get_user_role_names(user),
        }
    )


@app.post("/auth/login", response_model=schemas.AuthUserOut)
def login(
    payload: schemas.AuthLoginIn,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> schemas.AuthUserOut:
    username = payload.username.strip()
    user = (
        db.query(models.AuthUser)
        .filter(models.AuthUser.username == username)
        .first()
    )
    if payload.proof and payload.nonce:
        if not user or not verify_login_proof(
            username, payload.nonce, payload.proof, user.password_hash
        ):
            return PlainTextResponse("用户名或密码错误", status_code=401)
    elif payload.password:
        if not user or not verify_password(payload.password, user.password_hash):
            return PlainTextResponse("用户名或密码错误", status_code=401)
    else:
        raise HTTPException(status_code=400, detail="缺少登录凭据")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已停用")
    session = create_session(db, user)
    user.last_login_at = datetime.utcnow()
    db.add(user)
    db.add(session)
    db.commit()
    max_age = SESSION_TTL_HOURS * 3600
    cookie_samesite = (
        COOKIE_SAMESITE
        if COOKIE_SAMESITE in {"lax", "strict", "none"}
        else "lax"
    )
    response.set_cookie(
        AUTH_COOKIE_NAME,
        session.id,
        max_age=max_age,
        httponly=True,
        samesite=cookie_samesite,
        secure=COOKIE_SECURE,
    )
    crud.log_action(
        db,
        action="login",
        entity_type="auth_user",
        entity_id=user.id,
        description=f"用户 {user.username} 登录",
        user_id=user.id,
        username=user.username,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
    )
    return _serialize_auth_user(db, user)


@app.post("/auth/login-challenge", response_model=schemas.AuthLoginChallengeOut)
def login_challenge(
    payload: schemas.AuthLoginChallengeIn,
    db: Session = Depends(get_db),
) -> schemas.AuthLoginChallengeOut:
    username = payload.username.strip()
    salt = secrets.token_bytes(PASSWORD_SALT_BYTES).hex()
    iterations = PASSWORD_ITERATIONS
    user = (
        db.query(models.AuthUser)
        .filter(models.AuthUser.username == username)
        .first()
    )
    if user:
        parsed = parse_password_hash(user.password_hash)
        if parsed:
            iterations, salt, _ = parsed
    nonce = build_login_challenge(username)
    return schemas.AuthLoginChallengeOut(
        salt=salt,
        iterations=iterations,
        nonce=nonce,
        scheme="pbkdf2-hmac-sha256",
    )


@app.post("/auth/logout")
def logout(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
) -> dict[str, str]:
    session_id = request.cookies.get(AUTH_COOKIE_NAME)
    if session_id:
        session = (
            db.query(models.AuthSession)
            .filter(models.AuthSession.id == session_id)
            .first()
        )
        if session:
            db.delete(session)
            db.commit()
    response.delete_cookie(AUTH_COOKIE_NAME)
    crud.log_action(
        db,
        action="logout",
        entity_type="auth_user",
        entity_id=current_user.id,
        description=f"用户 {current_user.username} 退出登录",
    )
    return {"status": "ok"}


@app.get("/auth/me", response_model=schemas.AuthUserOut)
def me(
    current_user: models.AuthUser = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.AuthUserOut:
    return _serialize_auth_user(db, current_user)


@app.post("/auth/password")
def change_password(
    payload: schemas.AuthPasswordChangeIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
) -> dict[str, str]:
    if not verify_password(payload.old_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="当前密码不正确")
    if payload.old_password == payload.new_password:
        raise HTTPException(status_code=400, detail="新密码不能与当前密码相同")
    current_user.password_hash = hash_password(payload.new_password)
    current_user.updated_at = datetime.utcnow()
    session_id = request.cookies.get(AUTH_COOKIE_NAME)
    if session_id:
        (
            db.query(models.AuthSession)
            .filter(
                models.AuthSession.user_id == current_user.id,
                models.AuthSession.id != session_id,
            )
            .delete(synchronize_session=False)
        )
    db.add(current_user)
    db.commit()
    return {"status": "ok"}


def _serialize_role(role: models.AuthRole) -> schemas.AuthRoleOut:
    return schemas.AuthRoleOut(
        id=role.id,
        name=role.name,
        display_name=role.display_name or role.name,
        description=role.description,
        permissions=parse_permissions_json(role.permissions_json),
        is_system=role.is_system,
    )


def _serialize_user(user: models.AuthUser) -> schemas.AuthUserListOut:
    payload = schemas.AuthUserListOut.model_validate(user)
    return payload.model_copy(update={"roles": get_user_role_names(user)})


def _normalize_role_permissions(raw_permissions: list[str]) -> list[str]:
    normalized = normalize_permissions(raw_permissions)
    invalid = []
    for value in raw_permissions:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed == "*":
            continue
        if trimmed not in KNOWN_PERMISSIONS:
            invalid.append(trimmed)
    if invalid:
        raise HTTPException(
            status_code=400,
            detail=f"无效的权限标识：{', '.join(sorted(set(invalid)))}",
        )
    return normalized


def _normalize_user_roles(db: Session, raw_roles: list[str]) -> list[str]:
    normalized: list[str] = []
    for value in raw_roles:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed not in normalized:
            normalized.append(trimmed)
    if not normalized:
        raise HTTPException(status_code=400, detail="至少选择一个角色")
    existing_roles = {
        role.name for role in db.query(models.AuthRole.name).all()
    }
    missing = [name for name in normalized if name not in existing_roles]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"包含不存在的角色：{', '.join(missing)}",
        )
    return normalized


@app.get("/roles", response_model=List[schemas.AuthRoleOut])
def list_roles(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "role.read", "角色查看")
    roles = db.query(models.AuthRole).order_by(models.AuthRole.id.asc()).all()
    return [_serialize_role(role) for role in roles]


@app.post("/roles", response_model=schemas.AuthRoleOut, status_code=201)
def create_role(
    payload: schemas.AuthRoleCreateIn,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "role.create", "角色创建")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="角色标识不能为空")
    existing = (
        db.query(models.AuthRole)
        .filter(models.AuthRole.name == name)
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="角色标识已存在")
    permissions = _normalize_role_permissions(payload.permissions)
    role = models.AuthRole(
        name=name,
        display_name=(payload.display_name or name).strip(),
        description=payload.description,
        permissions_json=json.dumps(permissions, ensure_ascii=True),
        is_system=False,
    )
    db.add(role)
    db.commit()
    db.refresh(role)
    return _serialize_role(role)


@app.put("/roles/{role_id}", response_model=schemas.AuthRoleOut)
def update_role(
    role_id: int,
    payload: schemas.AuthRoleUpdateIn,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "role.update", "角色编辑")
    role = db.query(models.AuthRole).filter(models.AuthRole.id == role_id).first()
    if not role:
        raise HTTPException(status_code=404, detail="角色不存在")
    if role.is_system:
        raise HTTPException(status_code=400, detail="系统角色不允许修改")
    update_payload = payload.model_dump(exclude_unset=True)
    if "display_name" in update_payload:
        role.display_name = (update_payload["display_name"] or role.name).strip()
    if "description" in update_payload:
        role.description = update_payload["description"]
    if "permissions" in update_payload:
        role.permissions_json = json.dumps(
            _normalize_role_permissions(update_payload["permissions"] or []),
            ensure_ascii=True,
        )
    db.add(role)
    db.commit()
    db.refresh(role)
    return _serialize_role(role)


@app.delete("/roles/{role_id}", status_code=204)
def delete_role(
    role_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "role.delete", "角色删除")
    role = db.query(models.AuthRole).filter(models.AuthRole.id == role_id).first()
    if not role:
        raise HTTPException(status_code=404, detail="角色不存在")
    if role.is_system:
        raise HTTPException(status_code=400, detail="系统角色不允许删除")
    users = db.query(models.AuthUser).all()
    if any(role.name in get_user_role_names(user) for user in users):
        raise HTTPException(status_code=400, detail="该角色正在被用户使用")
    db.delete(role)
    db.commit()
    return {}


@app.get("/users", response_model=List[schemas.AuthUserListOut])
def list_users(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "user.read", "用户查看")
    users = db.query(models.AuthUser).order_by(models.AuthUser.id.asc()).all()
    return [_serialize_user(user) for user in users]


@app.post("/users", response_model=schemas.AuthUserListOut, status_code=201)
def create_user(
    payload: schemas.AuthUserCreateIn,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "user.create", "用户创建")
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")
    existing = (
        db.query(models.AuthUser)
        .filter(models.AuthUser.username == username)
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="用户名已存在")
    role_names = _normalize_user_roles(db, payload.roles)
    display_name = (payload.display_name or username).strip()
    user = models.AuthUser(
        username=username,
        display_name=display_name,
        password_hash=hash_password(payload.password),
        role=role_names[0],
        roles_json=json.dumps(role_names, ensure_ascii=True),
        is_active=True,
        auth_provider="local",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    crud.log_action(
        db,
        action="create",
        entity_type="auth_user",
        entity_id=user.id,
        description=f"创建用户 {user.username}",
    )
    return _serialize_user(user)


@app.put("/users/{user_id}", response_model=schemas.AuthUserListOut)
def update_user(
    user_id: int,
    payload: schemas.AuthUserUpdateIn,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "user.update", "用户修改")
    user = db.query(models.AuthUser).filter(models.AuthUser.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    update_payload = payload.model_dump(exclude_unset=True)
    is_admin = user.username == "admin"
    if is_admin:
        if "roles" in update_payload or "is_active" in update_payload:
            raise HTTPException(status_code=400, detail="管理员账号不允许修改角色或状态")
    if "display_name" in update_payload:
        user.display_name = (update_payload["display_name"] or user.username).strip()
    if "password" in update_payload and update_payload["password"]:
        user.password_hash = hash_password(update_payload["password"])
    if "roles" in update_payload:
        role_names = _normalize_user_roles(db, update_payload["roles"] or [])
        user.role = role_names[0]
        user.roles_json = json.dumps(role_names, ensure_ascii=True)
    if "is_active" in update_payload:
        if user.id == current_user.id and not update_payload["is_active"]:
            raise HTTPException(status_code=400, detail="不能停用当前登录账号")
        if user.username == "admin" and not update_payload["is_active"]:
            raise HTTPException(status_code=400, detail="管理员账号不能停用")
        user.is_active = bool(update_payload["is_active"])
    db.add(user)
    db.commit()
    db.refresh(user)
    crud.log_action(
        db,
        action="update",
        entity_type="auth_user",
        entity_id=user.id,
        description=f"更新用户 {user.username}",
    )
    return _serialize_user(user)


@app.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "user.delete", "用户删除")
    user = db.query(models.AuthUser).filter(models.AuthUser.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.username == "admin":
        raise HTTPException(status_code=400, detail="管理员账号不能删除")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="不能删除当前登录账号")
    username = user.username
    db.delete(user)
    db.commit()
    crud.log_action(
        db,
        action="delete",
        entity_type="auth_user",
        entity_id=user_id,
        description=f"删除用户 {username}",
    )
    return {}


@app.get("/system-agent-install.sh", response_class=PlainTextResponse)
def system_agent_install_script() -> str:
    return _build_system_agent_install_script()


@app.get("/license/status", response_model=schemas.LicenseStatusOut)
def get_license_status(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
) -> schemas.LicenseStatusOut:
    status = license_manager.status()
    return schemas.LicenseStatusOut(**status)


@app.post("/license/upload", response_model=schemas.LicenseStatusOut)
async def upload_license(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
) -> schemas.LicenseStatusOut:
    _require_permission(db, current_user, "license.upload", "License 上传")
    payload = await file.read()
    if not payload:
        raise HTTPException(status_code=400, detail="上传的 License 文件为空")
    try:
        status = license_manager.import_bytes(payload)
    except LicenseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    licensee = (status.get("licensee") or "").strip()
    description = f"修改 License（{licensee}）" if licensee else "修改 License"
    crud.log_action(
        db,
        action="update",
        entity_type="license",
        entity_id=None,
        description=description,
        user_id=current_user.id,
        username=current_user.username,
    )
    return schemas.LicenseStatusOut(**status)


@app.post("/license/import-text", response_model=schemas.LicenseStatusOut)
def upload_license_text(
    payload: schemas.LicenseImportPayload,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
) -> schemas.LicenseStatusOut:
    _require_permission(db, current_user, "license.upload", "License 上传")
    try:
        status = license_manager.import_bytes(payload.content)
    except LicenseError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    licensee = (status.get("licensee") or "").strip()
    description = f"修改 License（{licensee}）" if licensee else "修改 License"
    crud.log_action(
        db,
        action="update",
        entity_type="license",
        entity_id=None,
        description=description,
        user_id=current_user.id,
        username=current_user.username,
    )
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
    health_message = None
    if (
        cluster.execution_mode == "agent"
        and cluster.connection_status not in {"pending", "deleted"}
    ):
        agent = cluster.default_agent
        last_seen = agent.last_seen_at if agent and agent.is_enabled else None
        if agent and agent.is_enabled:
            deadline = datetime.utcnow() - AGENT_HEARTBEAT_TIMEOUT
            if last_seen and last_seen >= deadline:
                result.connection_status = "connected"
            elif last_seen:
                result.connection_status = "failed"
                health_message = (
                    f"Agent 超过 {AGENT_HEARTBEAT_TIMEOUT_MINUTES} 分钟未上报健康状态。"
                )
            else:
                result.connection_status = "warning"
                health_message = "尚未收到 Agent 心跳。"
        else:
            result.connection_status = "warning"
            health_message = "未绑定可用 Agent。"
    if health_message:
        result.agent_health_message = health_message
    if (
        result.connection_status == "failed"
        and not result.connection_message
        and not result.agent_health_message
    ):
        result.connection_message = "连接异常"
    elif not result.connection_message:
        result.connection_message = "No additional details."
    return result


@app.get("/clusters", response_model=List[schemas.ClusterConfigOut])
def list_clusters(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "clusterAgent.read", "集群查看")
    clusters = crud.list_clusters(db)
    return [_present_cluster(cluster) for cluster in clusters]


@app.post("/clusters", response_model=schemas.ClusterConfigOut, status_code=201)
async def register_cluster(
    file: UploadFile = File(...),
    name: str | None = Form(None),
    prometheus_url: str | None = Form(None),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("clusters")),
):
    _require_permission(db, current_user, "clusterAgent.create", "集群新增")
    raise HTTPException(
        status_code=410,
        detail="Server 端已停用直接上传 kubeconfig，请通过 Agent 完成集群注册。",
    )


@app.post(
    "/clusters/{cluster_id}/test-connection",
    response_model=schemas.ClusterConfigOut,
)
def test_cluster_connection(
    cluster_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("clusters")),
):
    _require_any_permission(
        db,
        current_user,
        ["clusterAgent.test", "clusterAgent.update"],
        "集群连接测试",
    )
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
    if _has_pending_connection_test(db, cluster, agent.id):
        raise HTTPException(
            status_code=409,
            detail="已有连接测试任务执行中，请稍候再试。",
        )
    _enqueue_connection_test_run(db, cluster, agent)
    display_id = crud.get_cluster_display_id(cluster)
    crud.log_action(
        db,
        action="create",
        entity_type="cluster_config",
        entity_id=cluster.id,
        description=f"测试连接集群：{display_id}",
    )
    cluster = crud.update_cluster(
        db,
        cluster,
        connection_status="warning",
        connection_message="已下发连接测试请求，等待 Agent 返回结果。",
        log_audit=False,
    )
    return _present_cluster(cluster)


@app.get(
    "/clusters/{cluster_id}/nodes",
    response_model=schemas.ClusterNodesOut,
)
def get_cluster_nodes(
    cluster_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "clusterAgent.read", "集群节点查看")
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")
    if cluster.execution_mode != "agent":
        raise HTTPException(status_code=400, detail="当前仅支持 Agent 上报的节点信息。")
    candidate = None
    if cluster.default_agent and cluster.default_agent.is_enabled:
        if cluster.default_agent.nodes_output:
            candidate = cluster.default_agent
    if candidate is None:
        candidate = (
            db.query(models.InspectionAgent)
            .filter(
                models.InspectionAgent.cluster_id == cluster.id,
                models.InspectionAgent.is_enabled.is_(True),
                models.InspectionAgent.nodes_output.isnot(None),
            )
            .order_by(models.InspectionAgent.nodes_output_at.desc())
            .first()
        )
    if not candidate or not candidate.nodes_output:
        raise HTTPException(
            status_code=404,
            detail="暂无节点信息，请等待 Agent 上报后重试。",
        )
    output = candidate.nodes_output
    retrieved_at = candidate.nodes_output_at or candidate.last_seen_at or datetime.utcnow()
    return schemas.ClusterNodesOut(
        output=output,
        retrieved_at=retrieved_at,
    )


@app.post(
    "/clusters/{cluster_id}/nodes/refresh",
    response_model=schemas.ClusterNodesRefreshOut,
)
def refresh_cluster_nodes(
    cluster_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("clusters")),
):
    _require_permission(db, current_user, "clusterAgent.update", "集群节点刷新")
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")
    if cluster.execution_mode != "agent":
        raise HTTPException(status_code=400, detail="当前仅支持 Agent 上报的节点信息。")
    agent = _resolve_active_agent(db, cluster)
    if not agent:
        raise HTTPException(
            status_code=409,
            detail="未检测到可用 Agent，请先绑定或启用 Agent。",
        )
    updated = crud.request_agent_nodes_report(db, agent)
    requested_at = updated.nodes_report_requested_at or datetime.utcnow()
    return schemas.ClusterNodesRefreshOut(
        agent_id=updated.id,
        requested_at=requested_at,
    )


@app.put("/clusters/{cluster_id}", response_model=schemas.ClusterConfigOut)
async def update_cluster(
    cluster_id: int,
    db: Session = Depends(get_db),
    name: str | None = Form(None),
    prometheus_url: str | None = Form(None),
    rancher_url: str | None = Form(None, alias="rancherUrl"),
    rancher_api_key: str | None = Form(None, alias="rancherApiKey"),
    default_agent_id: str | None = Form(None),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("clusters")),
):
    _require_permission(db, current_user, "clusterAgent.update", "集群更新")
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

    if rancher_url is not None or rancher_api_key is not None:
        if not getattr(cluster, "is_rancher_local", False):
            raise HTTPException(
                status_code=400,
                detail="当前集群不是 Rancher Local，无法设置 Rancher 信息。",
            )
        trimmed_rancher_url = (rancher_url or "").strip() or None
        if trimmed_rancher_url and not trimmed_rancher_url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400,
                detail="Rancher 地址需以 http:// 或 https:// 开头。",
            )
        trimmed_rancher_key = (rancher_api_key or "").strip() or None
        if trimmed_rancher_key is None:
            raise HTTPException(status_code=400, detail="Rancher API 密钥不能为空。")
        update_kwargs["rancher_url"] = trimmed_rancher_url
        update_kwargs["rancher_api_key"] = trimmed_rancher_key

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
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "clusterAgent.read", "Agent 查看")
    agents = crud.list_inspection_agents(db)
    return [_serialize_agent(agent) for agent in agents]


@app.post("/agents", response_model=schemas.AgentRegisterOut, status_code=201)
def register_agent(
    payload: schemas.InspectionAgentCreate,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "clusterAgent.create", "Agent 创建")
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
    if not normalized_prometheus_url:
        normalized_prometheus_url = DEFAULT_PROMETHEUS_URL
    normalized_rancher_url = (payload.rancher_url or "").strip() or None
    normalized_rancher_api_key = (payload.rancher_api_key or "").strip() or None
    wants_rancher_local = bool(payload.is_rancher_local)
    rancher_payload_present = bool(
        wants_rancher_local or normalized_rancher_url or normalized_rancher_api_key
    )
    if rancher_payload_present and not wants_rancher_local:
        raise HTTPException(
            status_code=400,
            detail="请先勾选 Rancher Local 集群后再填写 Rancher 信息。",
        )
    if wants_rancher_local:
        if not normalized_rancher_url:
            raise HTTPException(status_code=400, detail="Rancher 地址不能为空。")
        if not normalized_rancher_url.startswith(("http://", "https://")):
            raise HTTPException(
                status_code=400,
                detail="Rancher 地址需以 http:// 或 https:// 开头。",
            )
        if not normalized_rancher_api_key:
            raise HTTPException(status_code=400, detail="Rancher API 密钥不能为空。")
    rancher_update_kwargs: dict[str, Any] = {}
    if rancher_payload_present:
        rancher_update_kwargs = {
            "is_rancher_local": wants_rancher_local,
            "rancher_url": normalized_rancher_url,
            "rancher_api_key": normalized_rancher_api_key,
        }

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
        if rancher_update_kwargs:
            cluster = crud.update_cluster(db, cluster, **rancher_update_kwargs)
    else:
        cluster = crud.get_cluster_by_name(db, trimmed_name)
        if cluster:
            if getattr(cluster, "is_archived", False):
                archived_name = _build_archived_cluster_name(
                    cluster.name, cluster.id
                )
                if archived_name != cluster.name:
                    cluster = crud.update_cluster(
                        db,
                        cluster,
                        name=archived_name,
                        log_audit=False,
                    )
                placeholder_path = _build_agent_managed_kubeconfig_ref()
                cluster = crud.create_cluster(
                    db,
                    name=trimmed_name,
                    kubeconfig_path=placeholder_path,
                    contexts_json=None,
                    prometheus_url=normalized_prometheus_url,
                    is_rancher_local=wants_rancher_local,
                    rancher_url=normalized_rancher_url,
                    rancher_api_key=normalized_rancher_api_key,
                    connection_status="pending",
                    connection_message="等待 Agent 注册",
                    last_checked_at=None,
                    execution_mode="agent",
                    default_agent_id=None,
                    description=normalized_description,
                )
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
                update_kwargs: dict[str, Any] = {"created_at": datetime.utcnow()}
                if normalized_description is not None:
                    update_kwargs["description"] = normalized_description
                if normalized_prometheus_url is not None:
                    update_kwargs["prometheus_url"] = normalized_prometheus_url
                if rancher_update_kwargs:
                    update_kwargs.update(rancher_update_kwargs)
                cluster = crud.update_cluster(db, cluster, **update_kwargs)
        else:
            placeholder_path = _build_agent_managed_kubeconfig_ref()
            cluster = crud.create_cluster(
                db,
                name=trimmed_name,
                kubeconfig_path=placeholder_path,
                contexts_json=None,
                prometheus_url=normalized_prometheus_url,
                is_rancher_local=wants_rancher_local,
                rancher_url=normalized_rancher_url,
                rancher_api_key=normalized_rancher_api_key,
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
    _license_guard: None = Depends(require_license_dependency("inspections")),
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
        effective_prom_url = (
            agent_prom_url or incoming_prom_url or DEFAULT_PROMETHEUS_URL
        )

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
        existing_message = cluster.connection_message if cluster else None
        existing_version, existing_nodes = schemas._extract_connection_meta(
            existing_message
        )
        has_connection_meta = (
            existing_version is not None or existing_nodes is not None
        )
        connection_message = (
            existing_message
            if has_connection_meta
            else "Agent 已完成注册，Server 端已托管 kubeconfig。"
        )

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
            cluster = crud.update_cluster(
                db,
                cluster,
                log_audit=False,
                **update_kwargs,
            )

        cluster_prom_url = _normalize_prometheus_url(cluster.prometheus_url)
        final_prom_url = cluster_prom_url or effective_prom_url
        if final_prom_url != cluster_prom_url:
            cluster = crud.update_cluster(
                db,
                cluster,
                prometheus_url=final_prom_url,
                log_audit=False,
            )

        agent = crud.update_inspection_agent(
            db,
            agent,
            cluster=cluster,
            is_enabled=True,
            prometheus_url=final_prom_url or agent.prometheus_url,
            log_audit=False,
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
        elif cluster is not None and not has_connection_meta:
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
    nodes_output = _normalize_nodes_output(payload.nodes_output)
    nodes_retrieved_at = payload.nodes_retrieved_at
    node_total = _normalize_count(payload.node_total)
    node_ready = _normalize_count(payload.node_ready)
    if node_total is not None and node_ready is not None and node_ready > node_total:
        node_ready = node_total
    pod_count = _normalize_count(payload.pod_count)
    cpu_usage = _normalize_percentage(payload.cluster_cpu_usage)
    memory_usage = _normalize_percentage(payload.cluster_memory_usage)
    reported_at = payload.reported_at or datetime.utcnow()
    updated = crud.record_agent_heartbeat(
        ctx.db,
        ctx.agent,
        seen_at=reported_at,
        nodes_output=nodes_output,
        nodes_output_at=nodes_retrieved_at,
        node_total=node_total,
        node_ready=node_ready,
        pod_count=pod_count,
    )
    cluster_id = updated.cluster_id
    if cluster_id and (cpu_usage is not None or memory_usage is not None):
        crud.create_cluster_metric_sample(
            ctx.db,
            cluster_id=cluster_id,
            agent_id=updated.id,
            cpu_usage=cpu_usage,
            memory_usage=memory_usage,
            reported_at=reported_at,
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
        cluster = run.cluster or crud.get_cluster(ctx.db, run.cluster_id)
        is_rancher_local = bool(getattr(cluster, "is_rancher_local", False)) if cluster else False
        rancher_url = getattr(cluster, "rancher_url", None) if is_rancher_local else None
        rancher_api_key = getattr(cluster, "rancher_api_key", None) if is_rancher_local else None
        completed_item_ids = {
            result.item_id for result in run.results if result.item_id is not None
        }
        plan_items = _parse_run_plan(run)
        items_out: List[schemas.AgentTaskItemOut] = []
        for item in plan_items:
            try:
                item_id = int(item.get("id"))
            except (TypeError, ValueError):
                continue
            if item_id in completed_item_ids:
                continue
            items_out.append(
                schemas.AgentTaskItemOut(
                    id=item_id,
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
                is_rancher_local=is_rancher_local,
                rancher_url=rancher_url,
                rancher_api_key=rancher_api_key,
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
    return _serialize_run(ctx.db, updated)


@agent_router.get("/runs/{run_id}/status")
def agent_get_run_status(
    run_id: int,
    ctx: AgentRequestContext = Depends(_agent_request_dependency),
):
    run = crud.get_inspection_run(ctx.db, run_id)
    if not run or run.executor != "agent":
        raise HTTPException(status_code=404, detail="巡检任务不存在或非 Agent 类型。")
    if run.agent_id != ctx.agent.id:
        raise HTTPException(status_code=403, detail="巡检任务不属于当前 Agent。")
    return {"status": run.status}




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
    status_map = {"passed": "connected", "warning": "warning", "critical": "failed", "failed": "failed"}
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
    display_id = crud.get_cluster_display_id(cluster)
    is_success = connection_status == "connected"
    actor_entry = (
        db.query(models.AuditLog)
        .filter(
            models.AuditLog.entity_type == "cluster_config",
            models.AuditLog.entity_id == cluster.id,
            models.AuditLog.action == "create",
            models.AuditLog.description.like("测试连接集群：%"),
        )
        .order_by(models.AuditLog.created_at.desc())
        .first()
    )
    is_system_test = (run.operator or "").strip() == CONNECTION_TEST_OPERATOR
    crud.update_cluster(
        db,
        cluster,
        connection_status=connection_status,
        connection_message=message[:500],
        last_checked_at=datetime.utcnow(),
        log_audit=False,
    )
    if not (is_system_test and actor_entry is None):
        crud.log_action(
            db,
            action="update",
            entity_type="cluster_config",
            entity_id=cluster.id,
            description=(
                f"测试连接成功：{display_id}"
                if is_success
                else f"测试连接失败：{display_id}"
            ),
            user_id=actor_entry.user_id if actor_entry else None,
            username=actor_entry.username if actor_entry else None,
            ip_address=actor_entry.ip_address if actor_entry else None,
            user_agent=actor_entry.user_agent if actor_entry else None,
            status="success" if is_success else "failed",
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
    if run.status in {"paused", "cancelled"}:
        refreshed = crud.get_inspection_run(ctx.db, run.id) or run
        return _serialize_run(ctx.db, refreshed)
    is_partial = bool(payload.partial)
    cluster = crud.get_cluster(ctx.db, run.cluster_id)
    is_rancher_local = bool(getattr(cluster, "is_rancher_local", False)) if cluster else False
    rancher_url = (getattr(cluster, "rancher_url", None) or "").strip() if cluster else ""
    rancher_version = _sanitize_optional_text(payload.rancher_version)
    if not rancher_version and (not is_partial) and is_rancher_local and cluster:
        rancher_version = _fetch_rancher_version_from_cluster(cluster)
    if rancher_version and cluster and is_rancher_local:
        crud.update_cluster(ctx.db, cluster, rancher_version=rancher_version)
    item_lookup: dict[int, models.InspectionItem] = {}
    if is_rancher_local:
        item_ids = [result.item_id for result in payload.results if result.item_id]
        if item_ids:
            item_lookup = {item.id: item for item in crud.get_items_by_ids(ctx.db, item_ids)}
    rancher_cert_expiry: Optional[str] = None
    for result in payload.results:
        normalized_status = (result.status or "").strip().lower()
        if normalized_status not in {"passed", "warning", "critical", "failed"}:
            normalized_status = "warning"
        detail = _sanitize_optional_text(result.detail)
        if is_rancher_local and rancher_url and result.item_id:
            item = item_lookup.get(result.item_id)
            if item and _is_k8s_cert_expiry_item(item.name or ""):
                if rancher_cert_expiry is None:
                    rancher_cert_expiry = _fetch_rancher_cert_expiry(rancher_url)
                if rancher_cert_expiry:
                    detail = _append_rancher_cert_detail(detail, rancher_cert_expiry)
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
    if not is_partial:
        pod_count_raw = payload.pod_count
        if pod_count_raw is not None:
            try:
                pod_count_value = int(pod_count_raw)
            except (TypeError, ValueError):
                pod_count_value = None
            if pod_count_value is not None and pod_count_value >= 0:
                run.pod_count = pod_count_value

    def _clamp_processed(value: int, total: int) -> int:
        if total > 0:
            return min(value, total)
        return value

    if is_partial:
        display_total = run.total_items or processed_total
        run = crud.update_inspection_run_agent_state(
            ctx.db,
            run,
            processed_items=_clamp_processed(processed_total, display_total),
        )
        refreshed = crud.get_inspection_run(ctx.db, run.id) or run
        return _serialize_run(ctx.db, refreshed)

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
        return _serialize_run(ctx.db, refreshed)

    try:
        run = _attach_run_report(ctx.db, run)
    except Exception as exc:  # pragma: no cover - avoid failing agent uploads
        logger.exception("生成巡检报告失败(run_id=%s): %s", run.id, exc)
        run.report_path = None
        ctx.db.add(run)
        ctx.db.commit()
        ctx.db.refresh(run)
    return _serialize_run(ctx.db, run)

app.include_router(agent_router)


@app.delete("/clusters/{cluster_id}", status_code=204)
def delete_cluster(
    cluster_id: int,
    delete_files: bool = Query(
        False,
        description="同时删除关联巡检记录及报告文件",
    ),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("clusters")),
):
    _require_permission(db, current_user, "clusterAgent.delete", "集群删除")
    cluster = crud.get_cluster(db, cluster_id)
    if not cluster:
        raise HTTPException(status_code=404, detail="指定的集群不存在。")

    archived_name = None
    if not delete_files:
        archived_name = _build_archived_cluster_name(cluster.name, cluster.id)

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
    if archived_name and cluster.name != archived_name:
        crud.update_cluster(db, cluster, name=archived_name, log_audit=False)

    if delete_files:
        for report_path in report_paths:
            _remove_file_safely(report_path)
        pdf_dir, md_dir = get_cluster_report_dirs(cluster.id, cluster.name)
        _remove_report_dir_safely(pdf_dir)
        _remove_report_dir_safely(md_dir)

    return {}


@app.get("/audit-logs", response_model=schemas.AuditLogListOut)
def list_audit_logs(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    action: Optional[str] = Query(None),
    entity_type: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    start: Optional[datetime] = Query(None),
    end: Optional[datetime] = Query(None),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "audit.read", "审计日志查看")
    if start and end and end < start:
        raise HTTPException(status_code=400, detail="结束时间不能早于开始时间。")
    normalized_action = None if action in (None, "", "all") else action
    normalized_entity = None if entity_type in (None, "", "all") else entity_type
    normalized_keyword = keyword.strip() if keyword else None
    items, total = crud.list_audit_logs(
        db,
        page=page,
        page_size=page_size,
        action=normalized_action,
        entity_type=normalized_entity,
        keyword=normalized_keyword,
        start=start,
        end=end,
    )
    return schemas.AuditLogListOut(
        items=[schemas.AuditLogOut.model_validate(item) for item in items],
        total=total,
        page=page,
        page_size=page_size,
    )


@app.post("/audit-logs/record", response_model=schemas.AuditLogOut)
def record_audit_log(
    payload: schemas.AuditLogCreateIn,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    action = (payload.action or "").strip()
    entity_type = (payload.entity_type or "").strip()
    if not action or not entity_type:
        raise HTTPException(status_code=400, detail="缺少审计日志参数。")
    entry = crud.log_action(
        db,
        action=action,
        entity_type=entity_type,
        entity_id=payload.entity_id,
        description=payload.description,
        status=payload.status or "success",
    )
    return schemas.AuditLogOut.model_validate(entry)


@app.get("/inspection-items", response_model=List[schemas.InspectionItemOut])
def list_inspection_items(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "inspectionItem.read", "巡检项查看")
    return crud.get_inspection_items(db)


@app.get(
    "/inspection-items/export",
    response_model=schemas.InspectionItemsExportOut,
)
def export_inspection_items(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "inspectionItem.read", "巡检项导出")
    items = crud.get_inspection_items(db)
    return {
        "exported_at": datetime.utcnow(),
        "items": items,
    }


@app.get("/inspection-items/export-yaml")
def export_inspection_items_yaml(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "inspectionItem.read", "巡检项导出")
    items = crud.get_inspection_items(db)
    export_payload = schemas.InspectionItemsExportOut(
        exported_at=datetime.utcnow(),
        items=items,
    )
    payload = export_payload.model_dump(mode="json")
    yaml_text = yaml.safe_dump(
        payload,
        allow_unicode=True,
        sort_keys=False,
    )
    return PlainTextResponse(
        yaml_text,
        media_type="text/yaml; charset=utf-8",
    )


@app.post(
    "/inspection-items/import",
    response_model=schemas.InspectionItemsImportResult,
    status_code=201,
)
async def import_inspection_items(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "inspectionItem.create", "巡检项导入")
    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="导入文件为空")
    try:
        text = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="导入文件必须为 UTF-8 编码") from exc

    payload: Any
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        try:
            payload = yaml.safe_load(text)
        except yaml.YAMLError as exc:
            raise HTTPException(
                status_code=400,
                detail="导入文件不是有效的 JSON 或 YAML",
            ) from exc

    if isinstance(payload, dict):
        items_data = payload.get("items")
        if items_data is None:
            raise HTTPException(
                status_code=400,
                detail="导入数据中缺少 items 字段",
            )
    elif isinstance(payload, list):
        items_data = payload
    else:
        raise HTTPException(
            status_code=400,
            detail="导入数据格式不正确，应为巡检项数组或包含 items 字段的对象",
        )

    if not isinstance(items_data, list):
        raise HTTPException(
            status_code=400,
            detail="items 字段必须是数组",
        )
    if not items_data:
        raise HTTPException(status_code=400, detail="导入文件中没有巡检项数据")

    validated_items: List[
        tuple[str, Optional[str], bool, schemas.InspectionItemCreate]
    ] = []
    seen_keys: set[tuple[str, Optional[str], bool]] = set()
    seen_promql_names: set[str] = set()
    seen_non_promql_names: set[str] = set()
    duplicate_keys: set[str] = set()
    mixed_name_conflicts: set[str] = set()

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
        is_promql = _is_promql_check_type(validated.check_type)
        resolved_version = (
            _normalize_prometheus_version(validated.prometheus_version)
            if is_promql
            else None
        )
        if is_promql:
            if trimmed_name in seen_non_promql_names:
                mixed_name_conflicts.add(trimmed_name)
            seen_promql_names.add(trimmed_name)
            key = (trimmed_name, resolved_version, True)
            key_label = f"{trimmed_name}({resolved_version})"
            validated.prometheus_version = resolved_version
        else:
            if trimmed_name in seen_promql_names or trimmed_name in seen_non_promql_names:
                mixed_name_conflicts.add(trimmed_name)
            seen_non_promql_names.add(trimmed_name)
            key = (trimmed_name, None, False)
            key_label = trimmed_name
        if key in seen_keys:
            duplicate_keys.add(key_label)
        seen_keys.add(key)
        validated_items.append((trimmed_name, resolved_version, is_promql, validated))

    if mixed_name_conflicts or duplicate_keys:
        messages: list[str] = []
        if mixed_name_conflicts:
            conflict_list = "、".join(sorted(mixed_name_conflicts))
            messages.append(f"PromQL 与非 PromQL 不能同名：{conflict_list}")
        if duplicate_keys:
            duplicate_list = "、".join(sorted(duplicate_keys))
            messages.append(f"存在同名同版本的重复项：{duplicate_list}")
        raise HTTPException(
            status_code=400,
            detail="；".join(messages),
        )

    lookup_names = [name for name, _, _, _ in validated_items]
    existing_items = (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.name.in_(lookup_names))
        .all()
    )
    existing_by_name: dict[str, list[models.InspectionItem]] = {}
    for item in existing_items:
        key_name = (item.name or "").strip()
        if not key_name:
            continue
        existing_by_name.setdefault(key_name, []).append(item)

    conflict_names: set[str] = set()
    for name, _, is_promql, _ in validated_items:
        candidates = existing_by_name.get(name, [])
        if not candidates:
            continue
        has_non_promql = any(
            not _is_promql_check_type(item.check_type) for item in candidates
        )
        has_promql = any(
            _is_promql_check_type(item.check_type) for item in candidates
        )
        if is_promql and has_non_promql:
            conflict_names.add(name)
        if not is_promql and has_promql:
            conflict_names.add(name)
        if is_promql and has_non_promql and has_promql:
            conflict_names.add(name)
    if conflict_names:
        conflict_list = "、".join(sorted(conflict_names))
        raise HTTPException(
            status_code=400,
            detail=f"已有同名但类型冲突（PromQL 与非 PromQL 不可同名）：{conflict_list}",
        )

    created_items: List[models.InspectionItem] = []
    updated_items: List[models.InspectionItem] = []

    for name, resolved_version, is_promql, payload in validated_items:
        config = payload.config if isinstance(payload.config, dict) else None
        candidates = existing_by_name.get(name, [])
        existing = None
        if is_promql:
            existing = next(
                (
                    item
                    for item in candidates
                    if _is_promql_check_type(item.check_type)
                    and _normalize_prometheus_version(item.prometheus_version)
                    == resolved_version
                ),
                None,
            )
        else:
            existing = next(
                (
                    item
                    for item in candidates
                    if not _is_promql_check_type(item.check_type)
                ),
                None,
            )

        if existing:
            existing.name = name
            existing.description = payload.description
            existing.check_type = payload.check_type
            existing.prometheus_version = payload.prometheus_version
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
                prometheus_version=payload.prometheus_version,
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
    item_in: schemas.InspectionItemCreate,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "inspectionItem.create", "巡检项创建")
    trimmed_name = (item_in.name or "").strip()
    if not trimmed_name:
        raise HTTPException(status_code=400, detail="巡检项名称不能为空。")
    is_promql = _is_promql_check_type(item_in.check_type)
    normalized_version = (
        _normalize_prometheus_version(item_in.prometheus_version)
        if is_promql
        else item_in.prometheus_version
    )
    existing_items = (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.name == trimmed_name)
        .all()
    )
    conflict_message = _inspection_item_name_conflict(
        existing_items,
        name=trimmed_name,
        check_type=item_in.check_type,
        prometheus_version=normalized_version,
    )
    if conflict_message:
        raise HTTPException(status_code=400, detail=conflict_message)
    payload = item_in.model_dump()
    payload["name"] = trimmed_name
    if is_promql:
        payload["prometheus_version"] = normalized_version
    sanitized = schemas.InspectionItemCreate.model_validate(payload)
    return crud.create_inspection_item(db, sanitized)


@app.put("/inspection-items/{item_id}", response_model=schemas.InspectionItemOut)
def update_inspection_item(
    item_id: int,
    item_in: schemas.InspectionItemUpdate,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "inspectionItem.update", "巡检项更新")
    item = crud.get_inspection_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Inspection item not found.")
    next_name = item_in.name if item_in.name is not None else item.name
    next_check_type = (
        item_in.check_type if item_in.check_type is not None else item.check_type
    )
    next_version = (
        item_in.prometheus_version
        if item_in.prometheus_version is not None
        else item.prometheus_version
    )
    trimmed_name = (next_name or "").strip()
    if not trimmed_name:
        raise HTTPException(status_code=400, detail="巡检项名称不能为空。")
    normalized_version = (
        _normalize_prometheus_version(next_version)
        if _is_promql_check_type(next_check_type)
        else None
    )
    existing_items = (
        db.query(models.InspectionItem)
        .filter(models.InspectionItem.name == trimmed_name)
        .all()
    )
    conflict_message = _inspection_item_name_conflict(
        existing_items,
        name=trimmed_name,
        check_type=next_check_type,
        prometheus_version=normalized_version,
        exclude_id=item.id,
    )
    if conflict_message:
        raise HTTPException(status_code=400, detail=conflict_message)
    payload = item_in.model_dump(exclude_unset=True)
    if "name" in payload:
        payload["name"] = trimmed_name
    if _is_promql_check_type(next_check_type):
        payload["prometheus_version"] = normalized_version
    sanitized = schemas.InspectionItemUpdate.model_validate(payload)
    return crud.update_inspection_item(db, item, sanitized)


@app.delete("/inspection-items/{item_id}", status_code=204)
def delete_inspection_item(
    item_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "inspectionItem.delete", "巡检项删除")
    item = crud.get_inspection_item(db, item_id)
    if not item:
        raise HTTPException(status_code=404, detail="Inspection item not found.")
    crud.delete_inspection_item(db, item)
    return {}


@app.get(
    "/inspection-schedules",
    response_model=List[schemas.InspectionScheduleOut],
)
def list_inspection_schedules(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "schedule.read", "定时巡检查看")
    schedules = crud.list_inspection_schedules(db)
    needs_commit = False
    for schedule in schedules:
        latest_run_at = _resolve_schedule_last_run_at(db, schedule)
        if not latest_run_at:
            continue
        if schedule.last_run_at is None or latest_run_at > schedule.last_run_at:
            schedule.last_run_at = latest_run_at
            needs_commit = True
    if needs_commit:
        db.commit()
    return [
        schemas.InspectionScheduleOut.model_validate(schedule)
        for schedule in schedules
    ]


@app.post(
    "/inspection-schedules",
    response_model=schemas.InspectionScheduleOut,
    status_code=201,
)
def create_inspection_schedule(
    payload: schemas.InspectionScheduleCreate,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "schedule.create", "定时巡检创建")
    try:
        cron = _normalize_cron_expression(payload.cron)
    except CronValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Cron 表达式无效：{exc}",
        )
    normalized_name = _normalize_schedule_name(payload.name)
    _ensure_unique_schedule_name(db, normalized_name)
    cluster_ids = _normalize_id_list(payload.cluster_ids)
    item_ids = _normalize_id_list(payload.item_ids)
    _validate_schedule_clusters(db, cluster_ids)
    _validate_schedule_items(db, item_ids)
    sanitized = schemas.InspectionScheduleCreate(
        name=normalized_name,
        cron=cron,
        cluster_ids=cluster_ids,
        item_ids=item_ids,
        is_enabled=payload.is_enabled,
    )
    schedule = crud.create_inspection_schedule(
        db,
        sanitized,
        created_by_user_id=current_user.id,
        created_by_username=current_user.username,
    )
    return schemas.InspectionScheduleOut.model_validate(schedule)


@app.put(
    "/inspection-schedules/{schedule_id}",
    response_model=schemas.InspectionScheduleOut,
)
def update_inspection_schedule(
    schedule_id: int,
    payload: schemas.InspectionScheduleUpdate,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "schedule.update", "定时巡检更新")
    schedule = crud.get_inspection_schedule(db, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="定时巡检不存在。")
    update_payload = payload.model_dump(exclude_unset=True)
    if "name" in update_payload:
        update_payload["name"] = _normalize_schedule_name(update_payload["name"])
        _ensure_unique_schedule_name(
            db,
            update_payload["name"],
            schedule_id=schedule.id,
        )
    if "cron" in update_payload:
        try:
            update_payload["cron"] = _normalize_cron_expression(
                update_payload["cron"]
            )
        except CronValidationError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Cron 表达式无效：{exc}",
            )
    if "cluster_ids" in update_payload:
        cluster_ids = _normalize_id_list(update_payload["cluster_ids"] or [])
        _validate_schedule_clusters(db, cluster_ids)
        update_payload["cluster_ids"] = cluster_ids
    if "item_ids" in update_payload:
        item_ids = _normalize_id_list(update_payload["item_ids"] or [])
        _validate_schedule_items(db, item_ids)
        update_payload["item_ids"] = item_ids
    sanitized = schemas.InspectionScheduleUpdate.model_validate(update_payload)
    updated = crud.update_inspection_schedule(db, schedule, sanitized)
    return schemas.InspectionScheduleOut.model_validate(updated)


@app.delete("/inspection-schedules/{schedule_id}", status_code=204)
def delete_inspection_schedule(
    schedule_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "schedule.delete", "定时巡检删除")
    schedule = crud.get_inspection_schedule(db, schedule_id)
    if not schedule:
        raise HTTPException(status_code=404, detail="定时巡检不存在。")
    crud.delete_inspection_schedule(db, schedule)
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


def _resolve_prometheus_versions(
    db: Session, run: models.InspectionRun
) -> Optional[List[str]]:
    plan = _parse_run_plan(run)
    if not plan:
        return None
    item_ids = [
        int(entry.get("id"))
        for entry in plan
        if isinstance(entry, dict) and entry.get("id") is not None
    ]
    if not item_ids:
        return None
    items = crud.get_items_by_ids(db, item_ids)
    versions = {
        _normalize_prometheus_version(item.prometheus_version)
        for item in items
        if (item.check_type or "").strip() == "promql"
    }
    if not versions:
        return None
    return sorted(versions)


def _serialize_run(db: Session, run: models.InspectionRun) -> schemas.InspectionRunOut:
    cluster = run.cluster
    if cluster is None:
        raise HTTPException(status_code=500, detail="Cluster information missing.")
    total_items, processed_items, progress = _calculate_run_progress(run)
    prometheus_versions = _resolve_prometheus_versions(db, run)
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
        pod_count=run.pod_count,
        created_at=run.created_at,
        completed_at=run.completed_at,
        prometheus_version=run.prometheus_version,
        prometheus_versions=prometheus_versions,
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
        pod_count=run.pod_count,
        created_at=run.created_at,
        completed_at=run.completed_at,
        prometheus_version=run.prometheus_version,
        executor=run.executor,
        agent_status=run.agent_status,
        agent_id=run.agent_id,
    )


def _resolve_latest_runs_by_cluster(
    db: Session, cluster_ids: List[int]
) -> dict[int, models.InspectionRun]:
    if not cluster_ids:
        return {}
    runs = (
        db.query(models.InspectionRun)
        .filter(models.InspectionRun.cluster_id.in_(cluster_ids))
        .order_by(
            func.coalesce(
                models.InspectionRun.completed_at,
                models.InspectionRun.created_at,
            ).desc(),
            models.InspectionRun.id.desc(),
        )
        .all()
    )
    latest: dict[int, models.InspectionRun] = {}
    for run in runs:
        if run.cluster_id not in latest:
            latest[run.cluster_id] = run
    return latest


def _floor_time_to_interval_seconds(moment: datetime, interval_seconds: int) -> datetime:
    seconds = max(1, int(interval_seconds))
    epoch_seconds = int(moment.timestamp())
    bucket_seconds = (epoch_seconds // seconds) * seconds
    return datetime.utcfromtimestamp(bucket_seconds)


@app.get("/overview/summary", response_model=schemas.OverviewSummaryOut)
def get_overview_summary(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "clusterAgent.read", "集群查看")
    clusters = crud.list_clusters(db)
    cluster_total = len(clusters)
    cluster_online = 0
    node_ready_total = 0
    node_total_total = 0
    pod_total = 0
    matched_nodes = False
    matched_pods = False
    deadline = datetime.utcnow() - AGENT_HEARTBEAT_TIMEOUT
    for cluster in clusters:
        if cluster.execution_mode != "agent":
            continue
        agent = _resolve_active_agent(db, cluster)
        if not agent or not agent.is_enabled:
            continue
        last_seen = agent.last_seen_at
        if last_seen and last_seen >= deadline:
            cluster_online += 1
            if agent.node_total is not None and agent.node_ready is not None:
                node_total_total += agent.node_total
                node_ready_total += agent.node_ready
                matched_nodes = True
            if agent.pod_count is not None and agent.pod_count >= 0:
                pod_total += agent.pod_count
                matched_pods = True
    return schemas.OverviewSummaryOut(
        cluster_total=cluster_total,
        cluster_online=cluster_online,
        node_ready=node_ready_total if matched_nodes else None,
        node_total=node_total_total if matched_nodes else None,
        pod_total=pod_total if matched_pods else None,
    )


@app.get("/overview/metrics", response_model=schemas.OverviewMetricsOut)
def get_overview_metrics(
    minutes: int = Query(180, ge=20, le=24 * 60, description="时间窗口（分钟）"),
    interval: int = Query(20, ge=5, le=120, description="采样间隔（分钟）"),
    interval_seconds: Optional[int] = Query(
        None, ge=5, le=3600, description="采样间隔（秒）"
    ),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_permission(db, current_user, "clusterAgent.read", "集群查看")
    now = datetime.utcnow()
    start = now - timedelta(minutes=minutes)
    resolved_interval_seconds = (
        max(1, int(interval_seconds))
        if interval_seconds is not None
        else max(1, int(interval)) * 60
    )
    interval_minutes = max(1, int(math.ceil(resolved_interval_seconds / 60)))
    start_bucket = _floor_time_to_interval_seconds(start, resolved_interval_seconds)
    end_bucket = _floor_time_to_interval_seconds(now, resolved_interval_seconds)

    clusters = crud.list_clusters(db)
    cluster_map = {cluster.id: cluster.name for cluster in clusters}
    if not cluster_map:
        return schemas.OverviewMetricsOut(
            start=start_bucket,
            end=end_bucket,
            interval_seconds=resolved_interval_seconds,
            interval_minutes=interval_minutes,
            series=[],
        )

    samples = (
        db.query(models.ClusterMetricSample)
        .filter(
            models.ClusterMetricSample.cluster_id.in_(list(cluster_map.keys())),
            models.ClusterMetricSample.reported_at >= start_bucket,
            models.ClusterMetricSample.reported_at <= now,
        )
        .order_by(
            models.ClusterMetricSample.cluster_id.asc(),
            models.ClusterMetricSample.reported_at.asc(),
        )
        .all()
    )

    buckets: dict[int, dict[datetime, dict[str, float]]] = {}
    counts: dict[int, dict[datetime, dict[str, int]]] = {}

    for sample in samples:
        cluster_id = sample.cluster_id
        bucket_time = _floor_time_to_interval_seconds(
            sample.reported_at, resolved_interval_seconds
        )
        bucket_map = buckets.setdefault(cluster_id, {})
        count_map = counts.setdefault(cluster_id, {})
        bucket = bucket_map.setdefault(bucket_time, {"cpu_sum": 0.0, "mem_sum": 0.0})
        count = count_map.setdefault(bucket_time, {"cpu_count": 0, "mem_count": 0})
        if sample.cpu_usage is not None:
            bucket["cpu_sum"] += float(sample.cpu_usage)
            count["cpu_count"] += 1
        if sample.memory_usage is not None:
            bucket["mem_sum"] += float(sample.memory_usage)
            count["mem_count"] += 1

    series: list[schemas.OverviewMetricsSeriesOut] = []
    for cluster in clusters:
        bucket_map = buckets.get(cluster.id, {})
        count_map = counts.get(cluster.id, {})
        points: list[schemas.OverviewMetricPointOut] = []
        for bucket_time in sorted(bucket_map.keys()):
            sums = bucket_map[bucket_time]
            cnt = count_map.get(bucket_time, {})
            cpu_value = (
                sums["cpu_sum"] / cnt["cpu_count"]
                if cnt.get("cpu_count")
                else None
            )
            mem_value = (
                sums["mem_sum"] / cnt["mem_count"]
                if cnt.get("mem_count")
                else None
            )
            if cpu_value is None and mem_value is None:
                continue
            points.append(
                schemas.OverviewMetricPointOut(
                    reported_at=bucket_time,
                    cpu_usage=cpu_value,
                    memory_usage=mem_value,
                )
            )
        series.append(
            schemas.OverviewMetricsSeriesOut(
                cluster_id=cluster.id,
                cluster_name=cluster.name,
                points=points,
            )
        )
    return schemas.OverviewMetricsOut(
        start=start_bucket,
        end=end_bucket,
        interval_seconds=resolved_interval_seconds,
        interval_minutes=interval_minutes,
        series=series,
    )


@app.post("/inspection-runs", response_model=schemas.InspectionRunOut, status_code=201)
def trigger_inspection(
    run_in: schemas.InspectionRunCreate,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "history.create", "历史巡检创建")
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
    items = crud.filter_items_for_cluster(cluster, items)
    if not items:
        raise HTTPException(
            status_code=400, detail="No applicable inspection items for this cluster."
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

    prometheus_version = run_in.prometheus_version or "3.2"
    run = crud.create_inspection_run(
        db,
        operator=run_in.operator,
        cluster=cluster,
        status="queued",
        total_items=len(items),
        processed_items=0,
        plan_json=plan_json,
        prometheus_version=prometheus_version,
        executor=executor,
        agent_status=agent_status,
        agent_id=agent_id,
        created_by_user_id=current_user.id,
        created_by_username=current_user.username,
    )

    run = crud.get_inspection_run(db, run.id)
    if not run:
        raise HTTPException(status_code=500, detail="无法加载巡检任务。")
    return _serialize_run(db, run)


@app.get("/inspection-runs", response_model=List[schemas.InspectionRunListOut])
def list_inspection_runs(
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_any_permission(
        db,
        current_user,
        ["history.read", "runRecord.read"],
        "巡检记录查看",
    )
    _requeue_stale_agent_runs(db)
    runs = [
        run
        for run in crud.list_inspection_runs(db)
        if run.operator != CONNECTION_TEST_OPERATOR
    ]
    return [_serialize_run_list(run) for run in runs]


@app.get("/inspection-runs/{run_id}", response_model=schemas.InspectionRunOut)
def get_inspection_run(
    run_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
):
    _require_any_permission(
        db,
        current_user,
        ["history.read", "runRecord.read", "result.read"],
        "巡检结果查看",
    )
    _requeue_stale_agent_runs(db)
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    run_label = crud.describe_inspection_run(db, run)
    crud.log_action(
        db,
        action="query",
        entity_type="inspection_run",
        entity_id=run.id,
        description=f"查看巡检记录：{run_label}",
    )
    return _serialize_run(db, run)


@app.post(
    "/inspection-runs/{run_id}/pause",
    response_model=schemas.InspectionRunOut,
)
def pause_inspection_run(
    run_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "history.update", "历史巡检更新")
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    if run.status == "paused":
        return _serialize_run(db, run)
    if run.status != "running":
        raise HTTPException(status_code=400, detail="仅可暂停进行中的巡检。")
    crud.pause_inspection_run(db, run)
    refreshed = crud.get_inspection_run(db, run_id)
    if not refreshed:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    return _serialize_run(db, refreshed)


@app.post(
    "/inspection-runs/{run_id}/resume",
    response_model=schemas.InspectionRunOut,
)
def resume_inspection_run(
    run_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "history.update", "历史巡检更新")
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    if run.status == "running":
        return _serialize_run(db, run)
    if run.status != "paused":
        raise HTTPException(status_code=400, detail="仅可继续已暂停的巡检。")
    crud.resume_inspection_run(db, run)
    refreshed = crud.get_inspection_run(db, run_id)
    if not refreshed:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    return _serialize_run(db, refreshed)


@app.post(
    "/inspection-runs/{run_id}/cancel",
    response_model=schemas.InspectionRunOut,
)
def cancel_inspection_run(
    run_id: int,
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_permission(db, current_user, "history.update", "历史巡检更新")
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    if run.status not in {"queued", "running", "paused"}:
        raise HTTPException(status_code=400, detail="仅可取消排队、进行中或暂停的巡检。")
    crud.cancel_inspection_run(db, run)
    refreshed = crud.get_inspection_run(db, run_id)
    if not refreshed:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    return _serialize_run(db, refreshed)


@app.delete("/inspection-runs/{run_id}", status_code=204)
def delete_inspection_run(
    run_id: int,
    delete_files: bool = Query(
        False,
        description="同时删除本地巡检报告文件",
    ),
    db: Session = Depends(get_db),
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("inspections")),
):
    _require_any_permission(
        db,
        current_user,
        ["history.delete", "runRecord.delete", "result.delete", "report.delete"],
        "巡检记录删除",
    )
    run = crud.get_inspection_run(db, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Inspection run not found.")
    if run.status == "running":
        raise HTTPException(status_code=400, detail="进行中的巡检任务不可删除，请先取消。")
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
    current_user: models.AuthUser = Depends(get_current_user),
    _license_guard: None = Depends(require_license_dependency("reports")),
):
    _require_permission(db, current_user, "report.read", "巡检报告查看")
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
        run_label = crud.describe_inspection_run(db, run)
        crud.log_action(
            db,
            action="download",
            entity_type="inspection_run",
            entity_id=run.id,
            description=f"下载巡检报告（{requested_format}）：{run_label}",
        )
        return FileResponse(
            markdown_path,
            media_type="text/markdown; charset=utf-8",
            filename=markdown_path.name,
        )

    if not pdf_path.exists():
        raise HTTPException(status_code=404, detail="Report file missing on server.")
    run_label = crud.describe_inspection_run(db, run)
    crud.log_action(
        db,
        action="download",
        entity_type="inspection_run",
        entity_id=run.id,
        description=f"下载巡检报告（{requested_format}）：{run_label}",
    )
    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=pdf_path.name,
    )
