from __future__ import annotations

import argparse
import base64
import logging
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import requests
from requests import exceptions as req_exc
import yaml

# 优先复用后端实现；若缺失则使用本地备份逻辑，确保独立部署时也能运行
REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND_PATH = REPO_ROOT / "backend"
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if BACKEND_PATH.exists() and str(BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(BACKEND_PATH))

try:
    from app.inspections.engine import CheckContext, dispatch_checks
    from app.prometheus import PrometheusClient
    _ENGINE_SOURCE = "backend"
except ImportError:
    from .runtime_engine import CheckContext, dispatch_checks, PrometheusClient
    _ENGINE_SOURCE = "builtin"

LOG = logging.getLogger("inspect-agent")
if _ENGINE_SOURCE == "backend":
    LOG.info("已加载 backend/app 中的巡检引擎。")
else:
    LOG.info("未检测到 backend/app，使用 Agent 内置巡检引擎。")

DEFAULT_POLL_INTERVAL = 10
DEFAULT_BATCH_SIZE = 1
DEFAULT_TIMEOUT = 15
DEFAULT_NODE_REPORT_INTERVAL = 86400


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    value_str = str(value).strip().lower()
    return value_str in {"1", "true", "yes", "y", "on"}


def _as_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _format_request_error(exc: Exception, base_url: str) -> str:
    if isinstance(exc, req_exc.Timeout):
        return (
            f"访问 {base_url} 超时：{exc}。"
            "请检查网络延迟或适当增大 request_timeout。"
        )
    if isinstance(exc, req_exc.ConnectionError):
        return (
            f"无法连接到 {base_url}：{exc}。"
            "请确认 Agent 所在网络可访问该地址，必要时配置公网映射或 VPN。"
        )
    if isinstance(exc, req_exc.HTTPError):
        status = exc.response.status_code if exc.response else "unknown"
        body = ""
        if exc.response is not None:
            try:
                body = (exc.response.text or "").strip()
            except Exception:  # pragma: no cover - 防御
                body = ""
        snippet = f" 响应片段：{body[:200]}" if body else ""
        return f"Server 返回 HTTP {status}{snippet}"
    return str(exc)


def _read_kubeconfig_bytes(path: Path, *, strict: bool) -> Optional[bytes]:
    try:
        return path.read_bytes()
    except FileNotFoundError as exc:
        if strict:
            raise RuntimeError(f"无法读取 kubeconfig 文件：{path}") from exc
        LOG.debug("未找到 kubeconfig 文件 %s", path)
    except OSError as exc:
        if strict:
            raise RuntimeError(f"读取 kubeconfig 文件失败：{path}: {exc}") from exc
        LOG.warning("读取 kubeconfig 文件失败 %s: %s", path, exc)
    return None


def _build_incluster_kubeconfig() -> Optional[Tuple[bytes, str]]:
    host = os.getenv("KUBERNETES_SERVICE_HOST")
    if not host:
        return None
    port = os.getenv("KUBERNETES_SERVICE_PORT_HTTPS") or os.getenv(
        "KUBERNETES_SERVICE_PORT", "443"
    )
    token_path = Path(
        os.getenv(
            "KUBERNETES_TOKEN_FILE",
            "/var/run/secrets/kubernetes.io/serviceaccount/token",
        )
    )
    ca_path = Path(
        os.getenv(
            "KUBERNETES_CA_FILE",
            "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
        )
    )
    namespace_path = Path(
        os.getenv(
            "KUBERNETES_NAMESPACE_FILE",
            "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
        )
    )
    if not token_path.exists() or not ca_path.exists():
        return None
    try:
        token = token_path.read_text(encoding="utf-8").strip()
        if not token:
            return None
        ca_data = base64.b64encode(ca_path.read_bytes()).decode("utf-8")
        namespace = "default"
        if namespace_path.exists():
            ns_value = namespace_path.read_text(encoding="utf-8").strip()
            if ns_value:
                namespace = ns_value
    except OSError as exc:
        LOG.warning("无法读取集群 ServiceAccount 认证文件: %s", exc)
        return None

    server = f"https://{host}:{port}"
    kubeconfig = {
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [
            {
                "name": "in-cluster",
                "cluster": {
                    "certificate-authority-data": ca_data,
                    "server": server,
                },
            }
        ],
        "contexts": [
            {
                "name": "in-cluster",
                "context": {
                    "cluster": "in-cluster",
                    "user": "in-cluster",
                    "namespace": namespace,
                },
            }
        ],
        "current-context": "in-cluster",
        "users": [
            {
                "name": "in-cluster",
                "user": {
                    "token": token,
                },
            }
        ],
    }
    dumped = yaml.safe_dump(kubeconfig, allow_unicode=True).encode("utf-8")
    return dumped, "in-cluster"


def _capture_kubeconfig_from_kubectl() -> Optional[Tuple[bytes, str]]:
    kube_binary = os.getenv("KUBECTL_BINARY", "kubectl")
    if shutil.which(kube_binary) is None:
        return None
    command = [kube_binary, "config", "view", "--raw"]
    try:
        result = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        LOG.debug("执行 kubectl config view 失败: %s", exc)
        return None
    if result.returncode != 0:
        LOG.warning(
            "kubectl config view 返回异常(%s): %s",
            result.returncode,
            result.stderr.strip(),
        )
        return None
    stdout = result.stdout.strip()
    if not stdout:
        LOG.warning("kubectl config view 未返回任何 kubeconfig 内容。")
        return None
    return stdout.encode("utf-8"), "kubectl-export"


def _resolve_kubeconfig_bytes(
    config: "AgentConfig",
) -> Tuple[Optional[bytes], Optional[str]]:
    if config.kubeconfig_path:
        data = _read_kubeconfig_bytes(config.kubeconfig_path, strict=True)
        if data:
            LOG.info("使用显式指定的 kubeconfig: %s", config.kubeconfig_path)
            return data, config.kubeconfig_path.name
        return None, None

    candidates: List[Path] = []
    kubeconfig_env = os.getenv("KUBECONFIG")
    if kubeconfig_env:
        for chunk in kubeconfig_env.split(os.pathsep):
            cleaned = chunk.strip()
            if not cleaned:
                continue
            candidates.append(Path(cleaned).expanduser())
    candidates.append(Path.home() / ".kube" / "config")
    candidates.extend(
        [
            Path("/etc/rancher/k3s/k3s.yaml"),
            Path("/etc/rancher/rke2/rke2.yaml"),
            Path("/etc/kubernetes/admin.conf"),
        ]
    )
    fallback_env = os.getenv("INSPECT_AGENT_KUBECONFIG_FALLBACKS")
    if fallback_env:
        for raw in fallback_env.split(os.pathsep):
            cleaned = raw.strip()
            if cleaned:
                candidates.append(Path(cleaned).expanduser())

    seen: Set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        data = _read_kubeconfig_bytes(candidate, strict=False)
        if data:
            LOG.info("自动使用 kubeconfig: %s", candidate)
            return data, candidate.name or "kubeconfig"

    incluster = _build_incluster_kubeconfig()
    if incluster:
        LOG.info("已根据 ServiceAccount 自动生成 kubeconfig。")
        return incluster

    kubectl_config = _capture_kubeconfig_from_kubectl()
    if kubectl_config:
        LOG.info("已通过 kubectl config view 捕获 kubeconfig。")
        return kubectl_config

    LOG.warning("未能自动发现 kubeconfig，后端可能无法完成连通性校验。")
    return None, None


@dataclass
class AgentConfig:
    server_base: str
    token: Optional[str] = None
    registration_token: Optional[str] = None
    token_file: Optional[Path] = None
    agent_name: Optional[str] = None
    cluster_id: Optional[int] = None
    cluster_name: Optional[str] = None
    kubeconfig_path: Optional[Path] = None
    prometheus_url: Optional[str] = None
    poll_interval: int = DEFAULT_POLL_INTERVAL
    batch_size: int = DEFAULT_BATCH_SIZE
    verify_ssl: bool = True
    request_timeout: int = DEFAULT_TIMEOUT
    node_report_interval: int = DEFAULT_NODE_REPORT_INTERVAL

    def load_token(self) -> Optional[str]:
        if self.token:
            return self.token
        if self.token_file and self.token_file.exists():
            return self.token_file.read_text(encoding='utf-8').strip() or None
        return None

    def save_token(self, token: str) -> None:
        if not self.token_file:
            return
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text(token, encoding='utf-8')
        LOG.info("Agent Token saved to %s", self.token_file)


def _ensure_incluster_kubeconfig_file(config: AgentConfig) -> None:
    if config.kubeconfig_path and config.kubeconfig_path.exists():
        return
    if config.kubeconfig_path and not config.kubeconfig_path.exists():
        LOG.warning(
            "未找到 kubeconfig 文件 %s，将尝试使用 ServiceAccount 自动生成。",
            config.kubeconfig_path,
        )
        config.kubeconfig_path = None

    incluster = _build_incluster_kubeconfig()
    if not incluster:
        return
    data, _name = incluster
    base_dir = (
        config.token_file.parent
        if config.token_file
        else Path("/var/lib/inspect-agent")
    )
    try:
        base_dir.mkdir(parents=True, exist_ok=True)
        kubeconfig_path = base_dir / "incluster.kubeconfig"
        kubeconfig_path.write_bytes(data)
    except OSError as exc:
        LOG.warning("写入 ServiceAccount kubeconfig 失败: %s", exc)
        return
    config.kubeconfig_path = kubeconfig_path
    LOG.info("已生成 ServiceAccount kubeconfig: %s", kubeconfig_path)


def _load_yaml_config(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return {}
    file_path = Path(path)
    if not file_path.exists():
        raise FileNotFoundError(f"找不到配置文件：{file_path}")
    with file_path.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    if not isinstance(data, dict):
        raise ValueError("配置文件需为 YAML 对象。")
    return data


def load_config(config_path: Optional[str]) -> AgentConfig:
    raw = _load_yaml_config(config_path)
    server_cfg = raw.get('server', {})
    agent_cfg = raw.get('agent', {})
    cluster_cfg = raw.get('cluster', {})
    prom_cfg = raw.get('prometheus', {})
    register_cfg = server_cfg.get('register', {})

    server_base = os.getenv('INSPECT_AGENT_SERVER', server_cfg.get('base_url'))
    if not server_base:
        raise ValueError('server.base_url is required (or set INSPECT_AGENT_SERVER).')

    token_file_value = os.getenv(
        'INSPECT_AGENT_TOKEN_FILE',
        agent_cfg.get('token_file') or server_cfg.get('token_file') or 'agent_token.txt',
    )
    token_file = Path(token_file_value).expanduser() if token_file_value else None

    cluster_id_value = os.getenv(
        'INSPECT_AGENT_CLUSTER_ID',
        agent_cfg.get('cluster_id') or register_cfg.get('cluster_id'),
    )
    cluster_id = None
    if cluster_id_value not in (None, '' ):
        try:
            cluster_id = int(cluster_id_value)
        except ValueError as exc:
            raise ValueError('cluster_id must be an integer') from exc

    raw_cluster_name = os.getenv(
        'INSPECT_AGENT_CLUSTER_NAME',
        cluster_cfg.get('name') or agent_cfg.get('cluster_name') or register_cfg.get('cluster_name'),
    )
    kubeconfig_path_value = os.getenv(
        'INSPECT_AGENT_KUBECONFIG',
        cluster_cfg.get('kubeconfig_path') or agent_cfg.get('kubeconfig_path'),
    )
    kubeconfig_path = (
        Path(kubeconfig_path_value).expanduser() if kubeconfig_path_value else None
    )

    registration_token = os.getenv(
        'INSPECT_AGENT_REGISTRATION_TOKEN',
        server_cfg.get('registration_token')
        or agent_cfg.get('registration_token')
        or register_cfg.get('token'),
    )

    raw_agent_name = os.getenv(
        'INSPECT_AGENT_NAME',
        agent_cfg.get('name') or register_cfg.get('name'),
    )
    agent_name = raw_agent_name.strip() if raw_agent_name else None
    cluster_name = raw_cluster_name.strip() if raw_cluster_name else None
    if not cluster_name and agent_name:
        cluster_name = agent_name
        LOG.info(
            "未显式配置 cluster.name，已自动使用 agent.name='%s' 作为集群名称。",
            agent_name,
        )
    if not cluster_name:
        raise ValueError(
            "cluster.name 未配置，且无法从 agent.name 推导，请在配置或环境变量中指定。"
        )

    config = AgentConfig(
        server_base=server_base.rstrip('/'),
        token=os.getenv('INSPECT_AGENT_TOKEN', server_cfg.get('token')),
        registration_token=registration_token,
        token_file=token_file,
        agent_name=agent_name,
        cluster_id=cluster_id,
        cluster_name=cluster_name,
        kubeconfig_path=kubeconfig_path,
        prometheus_url=os.getenv(
            'INSPECT_AGENT_PROM_URL',
            prom_cfg.get('base_url'),
        ),
        poll_interval=_as_int(
            os.getenv('INSPECT_AGENT_POLL_INTERVAL', agent_cfg.get('poll_interval')),
            DEFAULT_POLL_INTERVAL,
        ),
        batch_size=_as_int(
            os.getenv('INSPECT_AGENT_BATCH_SIZE', agent_cfg.get('batch_size')),
            DEFAULT_BATCH_SIZE,
        ),
        verify_ssl=not _as_bool(
            os.getenv(
                'INSPECT_AGENT_INSECURE',
                False if agent_cfg.get('verify_ssl', True) else True,
            )
        ),
        request_timeout=_as_int(
            os.getenv('INSPECT_AGENT_TIMEOUT', agent_cfg.get('request_timeout')),
            DEFAULT_TIMEOUT,
        ),
        node_report_interval=_as_int(
            os.getenv(
                'INSPECT_AGENT_NODE_REPORT_INTERVAL',
                agent_cfg.get('node_report_interval'),
            ),
            DEFAULT_NODE_REPORT_INTERVAL,
        ),
    )
    return config
class AgentClient:
    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.session = requests.Session()
        self.session.verify = config.verify_ssl
        self.token: Optional[str] = config.token
        if not self.session.verify:
            requests.packages.urllib3.disable_warnings(  # type: ignore[attr-defined]
                category=requests.packages.urllib3.exceptions.InsecureRequestWarning  # type: ignore[attr-defined]
            )

    def load_token_from_disk(self) -> None:
        cached = self.config.load_token()
        if cached:
            self.token = cached
            self.config.token = cached
            LOG.info("已从本地缓存加载 Agent Token。")

    def _headers(self) -> Dict[str, str]:
        if not self.token:
            raise RuntimeError("缺少 Agent Token。")
        return {"Authorization": f"Bearer {self.token}"}

    def register_if_needed(self, cluster_payload: Optional[Dict[str, Any]]) -> None:
        if self.token:
            return
        registration_token = self.config.registration_token
        if not registration_token:
            raise RuntimeError("缺少注册 Token，无法完成引导流程。")
        if not cluster_payload:
            raise RuntimeError("缺少集群信息，无法完成 Agent 注册。")
        payload: Dict[str, Any] = {
            "registration_token": registration_token,
            "prometheus_url": self.config.prometheus_url,
            "cluster": cluster_payload,
        }
        LOG.info(
            "正在使用注册 Token 引导 Agent（cluster=%s）。",
            cluster_payload.get("name"),
        )
        resp = self.session.post(
            f"{self.config.server_base}/agent/bootstrap",
            json=payload,
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()
        agent_data = resp.json()
        if isinstance(agent_data, dict):
            server_prom_url = (agent_data.get("prometheus_url") or "").strip()
            if server_prom_url:
                self.config.prometheus_url = server_prom_url
                LOG.info("Server returned Prometheus URL: %s", server_prom_url)
        self.token = registration_token
        self.config.token = registration_token
        if self.config.token_file:
            self.config.save_token(self.token)

    def send_heartbeat(
        self,
        *,
        nodes_output: Optional[str] = None,
        nodes_retrieved_at: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        payload: Dict[str, Any] = {
            "reported_at": datetime.now(timezone.utc).isoformat()
        }
        if nodes_output:
            payload["nodes_output"] = nodes_output
        if nodes_retrieved_at:
            payload["nodes_retrieved_at"] = nodes_retrieved_at
        resp = self.session.post(
            f"{self.config.server_base}/agent/heartbeat",
            json=payload,
            headers=self._headers(),
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()
        try:
            return resp.json()
        except ValueError:
            return None

    def fetch_tasks(self, limit: int) -> List[Dict[str, Any]]:
        resp = self.session.get(
            f"{self.config.server_base}/agent/tasks",
            params={"limit": limit},
            headers=self._headers(),
            timeout=self.config.request_timeout + self.config.poll_interval,
        )
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            raise RuntimeError("服务端返回的任务列表格式异常。")
        return data

    def claim_run(self, run_id: int) -> Dict[str, Any]:
        resp = self.session.post(
            f"{self.config.server_base}/agent/runs/{run_id}/claim",
            headers=self._headers(),
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def submit_results(
        self,
        run_id: int,
        results: Iterable[Dict[str, Any]],
        *,
        partial: bool = False,
    ) -> Dict[str, Any]:
        payload = {"results": list(results), "partial": partial}
        resp = self.session.post(
            f"{self.config.server_base}/agent/runs/{run_id}/results",
            json=payload,
            headers=self._headers(),
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def get_run_status(self, run_id: int) -> Optional[str]:
        resp = self.session.get(
            f"{self.config.server_base}/inspection-runs/{run_id}",
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, dict):
            status = (data.get("status") or "").strip().lower()
            return status or None
        return None


class AgentRunner:
    def __init__(self, config: AgentConfig, client: AgentClient) -> None:
        self.config = config
        self.client = client
        self.prom_client: Optional[PrometheusClient] = None
        self._active_prom_url: Optional[str] = None
        self._last_nodes_report_at: Optional[datetime] = None
        self._last_nodes_report_request: Optional[str] = None
        self._apply_prometheus_url(config.prometheus_url)

    def _await_run_active(self, run_id: int) -> bool:
        while True:
            try:
                status = self.client.get_run_status(run_id)
            except Exception as exc:
                LOG.warning("Failed to sync run status: %s", exc)
                return True
            if not status:
                return True
            if status in {"cancelled", "finished", "failed"}:
                LOG.info("Run %s stopped by server status=%s", run_id, status)
                return False
            if status == "paused":
                LOG.info("Run %s is paused, releasing agent.", run_id)
                return False
            return True

    def _apply_prometheus_url(self, url: Optional[str]) -> None:
        normalized = (url or "").strip()
        if not normalized:
            if self._active_prom_url:
                LOG.info("Prometheus URL cleared,后续巡检将跳过需要 Prometheus 的检查。")
            self._active_prom_url = None
            self.prom_client = None
            self.config.prometheus_url = None
            return
        if normalized == self._active_prom_url:
            return
        self._active_prom_url = normalized
        self.config.prometheus_url = normalized
        self.prom_client = PrometheusClient(
            normalized,
            timeout=float(self.config.request_timeout),
            verify_ssl=self.config.verify_ssl,
        )
        LOG.info("Prometheus URL 已同步为 %s", normalized)

    def _should_report_nodes(self, now: datetime) -> bool:
        interval = max(0, self.config.node_report_interval)
        if interval == 0:
            return False
        if not self._last_nodes_report_at:
            return True
        elapsed = (now - self._last_nodes_report_at).total_seconds()
        return elapsed >= interval

    def _collect_nodes_output(self) -> Optional[str]:
        kubeconfig_path = self.config.kubeconfig_path
        if not kubeconfig_path or not kubeconfig_path.exists():
            LOG.warning("节点信息上报跳过：未找到 kubeconfig。")
            return None
        kube_binary = os.getenv("KUBECTL_BINARY", "kubectl")
        if shutil.which(kube_binary) is None:
            LOG.warning("节点信息上报跳过：未找到 kubectl。")
            return None
        cmd = [
            kube_binary,
            "--kubeconfig",
            str(kubeconfig_path),
            "get",
            "nodes",
            "-o",
            "wide",
        ]
        try:
            completed = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                timeout=max(10, int(self.config.request_timeout)),
            )
        except subprocess.TimeoutExpired:
            LOG.warning("节点信息上报超时。")
            return None
        except Exception as exc:
            LOG.warning("节点信息上报失败: %s", exc)
            return None
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "").strip()
            LOG.warning("kubectl get nodes 失败: %s", detail)
            return None
        output = (completed.stdout or "").strip()
        if not output:
            LOG.warning("kubectl 未返回节点信息。")
            return None
        return output

    def _refresh_nodes_on_demand(self, heartbeat_data: Optional[Dict[str, Any]]) -> None:
        if not heartbeat_data:
            return
        raw_requested_at = heartbeat_data.get("nodes_report_requested_at")
        requested_at = str(raw_requested_at).strip() if raw_requested_at else ""
        if not requested_at:
            return
        if requested_at == self._last_nodes_report_request:
            return
        self._last_nodes_report_request = requested_at
        now = datetime.now(timezone.utc)
        nodes_output = self._collect_nodes_output()
        if not nodes_output:
            LOG.warning("节点信息刷新请求失败：未获取到节点输出。")
            return
        try:
            self.client.send_heartbeat(
                nodes_output=nodes_output,
                nodes_retrieved_at=now.isoformat(),
            )
            self._last_nodes_report_at = now
            LOG.info("已按需上报节点信息。")
        except Exception as exc:
            LOG.warning("按需上报节点信息失败：%s", exc)

    def sync_prometheus_from_config(self) -> None:
        self._apply_prometheus_url(self.config.prometheus_url)

    def build_bootstrap_payload(self) -> Optional[Dict[str, Any]]:
        if self.config.cluster_name is None:
            return None
        payload: Dict[str, Any] = {"name": self.config.cluster_name}
        kubeconfig_data, kubeconfig_name = _resolve_kubeconfig_bytes(self.config)
        if kubeconfig_data:
            payload["kubeconfig_b64"] = base64.b64encode(kubeconfig_data).decode(
                "utf-8"
            )
            if kubeconfig_name:
                payload["kubeconfig_name"] = kubeconfig_name
        else:
            LOG.warning(
                "未找到可用的 kubeconfig，首次注册可能无法通过连接校验。"
            )
        return payload

    def run_forever(self, once: bool = False) -> None:
        LOG.info("Agent 已启动，轮询间隔 %s 秒。", self.config.poll_interval)
        while True:
            has_task = False
            try:
                has_task = self.run_once()
            except KeyboardInterrupt:
                LOG.info("收到中断信号，准备退出。")
                raise
            except Exception as exc:
                LOG.exception("执行周期失败：%s", exc)
            if once:
                break
            sleep_seconds = 1 if has_task else max(1, self.config.poll_interval)
            time.sleep(sleep_seconds)

    def run_once(self) -> bool:
        heartbeat_blocked = False
        try:
            nodes_output = None
            nodes_retrieved_at = None
            now = datetime.now(timezone.utc)
            if self._should_report_nodes(now):
                self._last_nodes_report_at = now
                nodes_output = self._collect_nodes_output()
                if nodes_output:
                    nodes_retrieved_at = now.isoformat()
            heartbeat_data = self.client.send_heartbeat(
                nodes_output=nodes_output,
                nodes_retrieved_at=nodes_retrieved_at,
            )
            if isinstance(heartbeat_data, dict):
                server_prom = (heartbeat_data.get("prometheus_url") or "").strip()
                if server_prom and server_prom != (self._active_prom_url or ""):
                    self._apply_prometheus_url(server_prom)
            self._refresh_nodes_on_demand(
                heartbeat_data if isinstance(heartbeat_data, dict) else None
            )
        except req_exc.RequestException as exc:
            heartbeat_blocked = True
            LOG.warning(
                "心跳上报失败：%s",
                _format_request_error(exc, self.config.server_base),
            )
        except Exception as exc:
            LOG.warning("心跳上报失败：%s", exc)
        if heartbeat_blocked:
            return False
        try:
            tasks = self.client.fetch_tasks(limit=max(1, self.config.batch_size))
        except req_exc.RequestException as exc:
            LOG.error(
                "拉取任务失败：%s",
                _format_request_error(exc, self.config.server_base),
            )
            return False
        except Exception as exc:
            LOG.error("拉取任务失败：%s", exc)
            return False
        if not tasks:
            LOG.debug("暂无待执行任务。")
            return False
        for task in tasks:
            run_id = task.get("run_id")
            if run_id is None:
                LOG.warning("收到异常任务：%s", task)
                continue
            try:
                self.client.claim_run(run_id)
            except requests.HTTPError as exc:
                LOG.warning("领取巡检 %s 失败：%s", run_id, exc.response.text if exc.response else exc)
                continue
            except Exception as exc:
                LOG.warning("领取巡检 %s 失败：%s", run_id, exc)
                continue
            results = self._execute_items(run_id, task)
            if results is None:
                LOG.info("Run %s aborted before completion.", run_id)
                continue
            try:
                self.client.submit_results(run_id, results)
                LOG.info("巡检 %s 已回传结果。", run_id)
            except Exception as exc:
                LOG.error("上报巡检 %s 结果失败：%s", run_id, exc)
        return True

    def _execute_items(
        self, run_id: int, task: Dict[str, Any]
    ) -> Optional[List[Dict[str, Any]]]:
        items = task.get("items") or []
        results: List[Dict[str, Any]] = []
        cluster_id = task.get("cluster_id")
        context = CheckContext(
            kubeconfig_path=str(self.config.kubeconfig_path)
            if self.config.kubeconfig_path
            else None,
            prom=self.prom_client,
        )
        for item in items:
            if not self._await_run_active(run_id):
                return None
            item_id = item.get("id")
            name = item.get("name") or f"item-{item_id}"
            check_type = (item.get("check_type") or "").strip()
            config = item.get("config") or {}
            LOG.info(
                "开始执行巡检项 %s (type=%s, cluster_id=%s)",
                name,
                check_type or "unknown",
                cluster_id,
            )
            try:
                status, detail, suggestion = dispatch_checks(
                    check_type or "custom", context, config
                )
            except Exception as exc:  # pragma: no cover - 防御
                LOG.exception("巡检项 %s 执行异常: %s", name, exc)
                status = "failed"
                detail = f"Agent 执行 {name} 失败：{exc}"
                suggestion = "查看 Agent 日志或检查巡检配置。"
            LOG.info(
                "巡检项 %s 完成，状态=%s，摘要=%s",
                name,
                status,
                (detail or "")[:120],
            )
            results.append(
                {
                    "item_id": item_id,
                    "status": status,
                    "detail": detail,
                    "suggestion": suggestion,
                }
            )
            self._upload_partial_result(run_id, results[-1])
        return results

    def _upload_partial_result(self, run_id: int, result: Dict[str, Any]) -> None:
        try:
            self.client.submit_results(run_id, [result], partial=True)
        except Exception as exc:
            LOG.warning(
                "巡检 %s 局部结果上报失败，将在最终汇总时重试：%s",
                run_id,
                exc,
            )


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Inspection Agent 原型客户端")
    parser.add_argument(
        "-c",
        "--config",
        dest="config",
        help="YAML 配置文件路径（默认读取 INSPECT_AGENT_CONFIG）",
        default=os.getenv("INSPECT_AGENT_CONFIG"),
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="仅执行一次任务轮询并退出。",
    )
    parser.add_argument(
        "--log-level",
        dest="log_level",
        default=os.getenv("INSPECT_AGENT_LOG_LEVEL", "INFO"),
        help="日志级别，默认 INFO。",
    )
    return parser


def _configure_logging(level_name: str) -> None:
    level = getattr(logging, level_name.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    )


def main(argv: Optional[List[str]] = None) -> None:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    _configure_logging(args.log_level)

    try:
        config = load_config(args.config)
    except Exception as exc:
        LOG.error('加载配置失败：%s', exc)
        sys.exit(1)

    _ensure_incluster_kubeconfig_file(config)

    client = AgentClient(config)
    runner = AgentRunner(config, client)
    try:
        client.load_token_from_disk()
        cluster_payload = runner.build_bootstrap_payload() if not client.token else None
        client.register_if_needed(cluster_payload)
    except Exception as exc:
        LOG.error('初始化 Agent 失败：%s', exc)
        sys.exit(1)

    try:
        runner.run_forever(once=args.once)
    except KeyboardInterrupt:
        LOG.info('Agent 已终止。')
    except Exception as exc:
        LOG.exception('Agent 运行失败：%s', exc)
        sys.exit(2)
if __name__ == "__main__":
    main()
