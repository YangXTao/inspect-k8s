from __future__ import annotations

import argparse
import base64
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import requests
import yaml

LOG = logging.getLogger("inspect-agent")

DEFAULT_POLL_INTERVAL = 10
DEFAULT_BATCH_SIZE = 1
DEFAULT_TIMEOUT = 15


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

    def load_token(self) -> Optional[str]:
        if self.token:
            return self.token
        if self.token_file and self.token_file.exists():
            return self.token_file.read_text(encoding="utf-8").strip() or None
        return None

    def save_token(self, token: str) -> None:
        if not self.token_file:
            return
        self.token_file.parent.mkdir(parents=True, exist_ok=True)
        self.token_file.write_text(token, encoding="utf-8")
        LOG.info("已将 Agent Token 写入 %s", self.token_file)


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

    cluster_name = os.getenv(
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

    config = AgentConfig(
        server_base=server_base.rstrip('/'),
        token=os.getenv('INSPECT_AGENT_TOKEN', server_cfg.get('token')),
        registration_token=registration_token,
        token_file=token_file,
        agent_name=os.getenv(
            'INSPECT_AGENT_NAME',
            agent_cfg.get('name') or register_cfg.get('name'),
        ),
        cluster_id=cluster_id,
        cluster_name=cluster_name.strip() if cluster_name else None,
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
        self.token = registration_token
        self.config.token = registration_token
        if self.config.token_file:
            self.config.save_token(self.token)

    def send_heartbeat(self) -> None:
        payload = {"reported_at": datetime.now(timezone.utc).isoformat()}
        resp = self.session.post(
            f"{self.config.server_base}/agent/heartbeat",
            json=payload,
            headers=self._headers(),
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()

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
    ) -> Dict[str, Any]:
        payload = {"results": list(results)}
        resp = self.session.post(
            f"{self.config.server_base}/agent/runs/{run_id}/results",
            json=payload,
            headers=self._headers(),
            timeout=self.config.request_timeout,
        )
        resp.raise_for_status()
        return resp.json()


class PrometheusExecutor:
    def __init__(self, base_url: Optional[str], session: requests.Session, timeout: int) -> None:
        self.base_url = base_url.rstrip("/") if base_url else None
        self.session = session
        self.timeout = timeout

    def available(self) -> bool:
        return bool(self.base_url)

    def query(self, promql: str) -> Dict[str, Any]:
        if not self.base_url:
            raise RuntimeError("未配置 Prometheus 地址。")
        resp = self.session.get(
            f"{self.base_url}/api/v1/query",
            params={"query": promql},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("status") != "success":
            raise RuntimeError(data.get("error", "Prometheus 查询失败"))
        return data.get("data", {})


class AgentRunner:
    def __init__(self, config: AgentConfig, client: AgentClient) -> None:
        self.config = config
        self.client = client
        self.prom = PrometheusExecutor(
            config.prometheus_url,
            client.session,
            timeout=config.request_timeout,
        )

    def build_bootstrap_payload(self) -> Optional[Dict[str, Any]]:
        if self.config.cluster_name is None:
            return None
        payload: Dict[str, Any] = {"name": self.config.cluster_name}
        path = self.config.kubeconfig_path
        if path:
            try:
                data = path.read_bytes()
            except FileNotFoundError as exc:
                raise RuntimeError(f"无法读取 kubeconfig 文件：{path}") from exc
            payload["kubeconfig_b64"] = base64.b64encode(data).decode("utf-8")
            payload["kubeconfig_name"] = path.name
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
        try:
            self.client.send_heartbeat()
        except Exception as exc:
            LOG.warning("心跳上报失败：%s", exc)
        try:
            tasks = self.client.fetch_tasks(limit=max(1, self.config.batch_size))
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
            results = self._execute_items(task)
            try:
                self.client.submit_results(run_id, results)
                LOG.info("巡检 %s 已回传结果。", run_id)
            except Exception as exc:
                LOG.error("上报巡检 %s 结果失败：%s", run_id, exc)
        return True

    def _execute_items(self, task: Dict[str, Any]) -> List[Dict[str, Any]]:
        items = task.get("items") or []
        results: List[Dict[str, Any]] = []
        cluster_id = task.get("cluster_id")
        for item in items:
            item_id = item.get("id")
            name = item.get("name") or f"item-{item_id}"
            config = item.get("config") or {}
            promql = config.get("promql")
            if promql:
                status, detail, suggestion = self._run_promql(name, promql, cluster_id)
            else:
                status = "warning"
                detail = "未提供 PromQL 配置，任务已跳过。"
                suggestion = "补充 promql 字段或在服务器端调整巡检逻辑。"
            results.append(
                {
                    "item_id": item_id,
                    "status": status,
                    "detail": detail,
                    "suggestion": suggestion,
                }
            )
        return results

    def _run_promql(
        self,
        item_name: str,
        promql: str,
        cluster_id: Optional[int],
    ) -> tuple[str, str, Optional[str]]:
        if not self.prom.available():
            return (
                "warning",
                f"未配置 Prometheus 地址，无法执行 {item_name} 的 PromQL。",
                "配置 prometheus.base_url 或在环境变量 INSPECT_AGENT_PROM_URL 中提供地址。",
            )
        try:
            data = self.prom.query(promql)
        except Exception as exc:
            return (
                "failed",
                f"PromQL 查询失败：{exc}",
                "检查 Prometheus 网络连通性与认证配置。",
            )
        result = data.get("result") or []
        if result:
            detail = (
                f"PromQL 返回 {len(result)} 条结果。"
                f"{' (cluster %s)' % cluster_id if cluster_id is not None else ''}"
            )
            return "passed", detail, None
        return (
            "warning",
            "PromQL 查询成功但结果为空，可能无匹配样本。",
            "确认 PromQL 是否正确，或调整时间窗口。",
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
