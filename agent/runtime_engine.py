from __future__ import annotations

import json
import shutil
import shlex
import subprocess
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Tuple, Optional

import requests

CHECK_STATUS_PASSED = "passed"
CHECK_STATUS_WARNING = "warning"
CHECK_STATUS_CRITICAL = "critical"
CHECK_STATUS_FAILED = "failed"

DEFAULT_EXECUTION_FAILURE_SUGGESTION = "请检查此命令或promql"


class PrometheusClient:
    """轻量 Prometheus HTTP API 客户端（本地备份实现）。"""

    def __init__(self, base_url: str, timeout: float = 5.0, verify_ssl: bool = True):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify_ssl = verify_ssl

    def query(self, expression: str):
        if not self.base_url:
            return False, [], "Prometheus base URL is empty."
        url = f"{self.base_url}/api/v1/query"
        try:
            resp = requests.get(
                url,
                params={"query": expression},
                timeout=self.timeout,
                verify=self.verify_ssl,
            )
        except requests.RequestException as exc:
            return False, [], f"Prometheus request error: {exc}"
        if resp.status_code != 200:
            return (
                False,
                [],
                f"Prometheus returned HTTP {resp.status_code}: {resp.text[:200]}",
            )
        try:
            payload = resp.json()
        except ValueError:
            return False, [], "Prometheus response is not valid JSON."
        if payload.get("status") != "success":
            return (
                False,
                [],
                f"Prometheus query failed: {payload.get('error') or payload!r}",
            )
        data = payload.get("data", {})
        return True, data.get("result", []), ""

    @staticmethod
    def extract_value(sample: dict) -> Optional[float]:
        try:
            value = sample["value"]
            if isinstance(value, (list, tuple)) and len(value) >= 2:
                return float(value[1])
            return float(value)
        except (KeyError, TypeError, ValueError):
            return None


@dataclass
class CheckContext:
    kubeconfig_path: Optional[str] = None
    prom: Optional[PrometheusClient] = None


def _run_kubectl(args: Iterable[str], context: CheckContext) -> Tuple[bool, str]:
    if shutil.which("kubectl") is None:
        return False, "kubectl command not found on agent."
    cmd = ["kubectl"]
    if context.kubeconfig_path:
        cmd.extend(["--kubeconfig", context.kubeconfig_path])
    cmd.extend(args)
    try:
        completed = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception as exc:
        return False, f"kubectl execution error: {exc}"
    if completed.returncode != 0:
        return False, completed.stderr.strip() or "kubectl returned non-zero exit code."
    return True, completed.stdout.strip()


def _run_kubectl_version_pipeline(context: CheckContext) -> Tuple[bool, str]:
    if shutil.which("kubectl") is None:
        return False, "kubectl command not found on agent."
    cmd_parts = ["kubectl"]
    if context.kubeconfig_path:
        cmd_parts.extend(["--kubeconfig", context.kubeconfig_path])
    cmd_parts.append("version")
    pipeline = f"{shlex.join(cmd_parts)} | grep Server | awk '{{print $3}}'"
    try:
        completed = subprocess.run(
            pipeline,
            shell=True,
            check=False,
            capture_output=True,
            text=True,
            timeout=20,
        )
    except Exception as exc:
        return False, f"kubectl pipeline error: {exc}"
    if completed.returncode != 0:
        message = completed.stderr.strip() or completed.stdout.strip()
        return False, message or "kubectl pipeline returned non-zero exit code."
    return True, completed.stdout.strip()


def _truncate(text: str, limit: int = 2000) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _execute_command_check(
    config: Dict[str, object], context: CheckContext
) -> Tuple[str, str, str]:
    if not isinstance(config, dict):
        return CHECK_STATUS_WARNING, "Command configuration invalid.", "修正巡检项定义。"
    command = config.get("command")
    if not command:
        return CHECK_STATUS_WARNING, "No command configured.", "在巡检项里提供命令。"

    placeholder = str(config.get("kubeconfig_placeholder", "{{kubeconfig}}"))

    def replace(value: str) -> str:
        if placeholder in value:
            return value.replace(placeholder, context.kubeconfig_path or "")
        return value

    shell = bool(config.get("shell", False))
    if isinstance(command, str):
        rendered = replace(command)
        cmd = rendered if shell else shlex.split(rendered)
    elif isinstance(command, (list, tuple)):
        cmd = [replace(str(part)) for part in command if str(part)]
    else:
        return CHECK_STATUS_WARNING, "Unsupported command type.", "使用字符串或列表。"

    timeout = int(config.get("timeout", 30))
    success_codes = config.get("success_exit_codes", [0])
    if not isinstance(success_codes, (list, tuple)):
        success_codes = [success_codes]
    success_codes = {int(code) for code in success_codes}

    try:
        result = subprocess.run(
            cmd,
            shell=shell,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return CHECK_STATUS_WARNING, f"Command timed out after {timeout}s.", config.get(
            "suggestion_on_timeout"
        ) or config.get("suggestion_on_fail") or DEFAULT_EXECUTION_FAILURE_SUGGESTION
    except FileNotFoundError:
        return CHECK_STATUS_FAILED, "Command executable not found.", config.get(
            "suggestion_on_fail"
        ) or DEFAULT_EXECUTION_FAILURE_SUGGESTION
    except Exception as exc:
        return (
            CHECK_STATUS_FAILED,
            f"Command execution error: {exc}",
            config.get("suggestion_on_fail") or DEFAULT_EXECUTION_FAILURE_SUGGESTION,
        )

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if result.returncode in success_codes:
        expect = config.get("expect_substrings") or []
        if isinstance(expect, str):
            expect = [expect]
        missing = [pattern for pattern in expect if pattern not in stdout]
        if missing:
            return (
                CHECK_STATUS_WARNING,
                "Output missing expected text: " + ", ".join(missing),
                config.get("suggestion_on_fail") or DEFAULT_EXECUTION_FAILURE_SUGGESTION,
            )
        detail = (
            _truncate(stdout)
            or _truncate(stderr)
            or str(config.get("success_message") or "命令执行成功。")
        )
        status = CHECK_STATUS_WARNING if config.get("force_warning") else CHECK_STATUS_PASSED
        return (
            status,
            detail,
            config.get("suggestion_on_success") or "",
        )
    detail = config.get("failure_message") or _truncate(
        stderr or stdout or "Command returned non-zero exit code."
    )
    return CHECK_STATUS_FAILED, detail, config.get("suggestion_on_fail") or DEFAULT_EXECUTION_FAILURE_SUGGESTION


def _require_prom(context: CheckContext) -> Optional[Tuple[str, str, str]]:
    if context.prom is None:
        return (
            CHECK_STATUS_WARNING,
            "Prometheus endpoint is not configured for this cluster.",
            "在 Agent 或集群设置中补充 Prometheus 地址。",
        )
    return None


def _compare(value: float, threshold: float, operator: str) -> bool:
    if operator == ">=":
        return value >= threshold
    if operator == ">":
        return value > threshold
    if operator == "<=":
        return value <= threshold
    if operator == "<":
        return value < threshold
    if operator == "==":
        return value == threshold
    if operator == "!=":
        return value != threshold
    return value >= threshold


def _aggregate(values: List[float], mode: str) -> float:
    if not values:
        return 0.0
    mode = mode.lower()
    if mode == "min":
        return min(values)
    if mode in {"avg", "mean"}:
        return sum(values) / len(values)
    if mode == "sum":
        return sum(values)
    return max(values)


def _execute_promql_check(config: Dict[str, object], context: CheckContext):
    if not isinstance(config, dict):
        return CHECK_STATUS_WARNING, "PromQL configuration is invalid.", "修正巡检项定义。"
    missing = _require_prom(context)
    if missing:
        return missing
    expression = str(config.get("expression") or "").strip()
    if not expression:
        return CHECK_STATUS_WARNING, "PromQL expression is not configured.", "补充表达式。"
    prom = context.prom
    ok, results, message = prom.query(expression)
    if not ok:
        return (
            CHECK_STATUS_WARNING,
            message,
            config.get("suggestion_on_error")
            or config.get("suggestion_on_fail")
            or DEFAULT_EXECUTION_FAILURE_SUGGESTION,
        )
    values: List[float] = []
    samples: List[Dict[str, object]] = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric") if isinstance(sample, dict) else {}
        samples.append({"metric": metric, "value": value})
        values.append(value)
    if not values:
        return (
            config.get("status_if_empty", CHECK_STATUS_WARNING),
            config.get("empty_message") or "Prometheus returned no samples.",
            config.get("suggestion_if_empty") or "确认指标正在被采集。",
        )
    aggregate_mode = str(config.get("aggregate", "max"))
    aggregate_value = _aggregate(values, aggregate_mode)
    comparison = str(config.get("comparison", ">=")).strip()
    critical_threshold = config.get("critical_threshold")
    fail_threshold = config.get("fail_threshold")
    warn_threshold = config.get("warn_threshold")

    def to_float(raw):
        try:
            return float(raw)
        except (TypeError, ValueError):
            return None

    critical_value = to_float(critical_threshold)
    if critical_value is None and critical_threshold is None:
        critical_value = to_float(fail_threshold)
    warn_value = to_float(warn_threshold)
    status = CHECK_STATUS_PASSED
    suggestion = config.get("suggestion_on_success") or ""
    if critical_value is not None and _compare(aggregate_value, critical_value, comparison):
        status = CHECK_STATUS_CRITICAL
        suggestion = config.get("suggestion_on_critical") or suggestion
    elif warn_value is not None and _compare(aggregate_value, warn_value, comparison):
        status = CHECK_STATUS_WARNING
        suggestion = config.get("suggestion_on_warn") or suggestion

    def fmt(value: float) -> str:
        fmt_tpl = config.get("value_format")
        if isinstance(fmt_tpl, str) and fmt_tpl:
            try:
                return fmt_tpl.format(value=value)
            except Exception:
                pass
        return f"{value:.4f}".rstrip("0").rstrip(".") or "0"

    prefix = config.get("detail_template")
    detail_prefix = ""
    if isinstance(prefix, str) and prefix.strip():
        try:
            detail_prefix = prefix.format(
                expression=expression, value=aggregate_value, values=values
            )
        except Exception:
            detail_prefix = ""
    if not detail_prefix:
        detail_prefix = (
            f"{aggregate_mode} value from {expression}: {fmt(aggregate_value)} "
            f"(samples={len(values)})"
        )
    max_rows = config.get("result_limit") or config.get("top_n") or 5
    try:
        max_rows = int(max_rows)
        if max_rows <= 0:
            max_rows = 5
    except (TypeError, ValueError):
        max_rows = 5
    reverse = comparison not in {"<", "<="}
    sorted_samples = sorted(
        samples, key=lambda item: item["value"], reverse=reverse  # type: ignore[index]
    )
    lines = [detail_prefix.strip()]
    for entry in sorted_samples[:max_rows]:
        metric = entry.get("metric") if isinstance(entry, dict) else {}
        value = entry.get("value", 0.0)
        metric_name = _format_metric(metric)
        lines.append(f"- {metric_name}: {fmt(float(value))}")
    return status, "\n".join(lines), suggestion


def _format_metric(metric: Dict[str, object] | None) -> str:
    if not metric:
        return "sample"
    namespace = str(metric.get("namespace") or "").strip()
    pod = str(metric.get("pod") or "").strip()
    instance = str(metric.get("instance") or metric.get("node") or "").strip()
    if namespace and pod:
        base = f"{namespace}/{pod}"
    elif pod:
        base = pod
    elif instance:
        base = instance
    else:
        base = str(metric.get("__name__") or "sample")
    container = str(metric.get("container") or "").strip()
    if container:
        base = f"{base}:{container}"
    extras: List[str] = []
    for key in sorted(metric):
        if key in {
            "__name__",
            "namespace",
            "pod",
            "container",
            "instance",
            "node",
            "job",
        }:
            continue
        value = metric.get(key)
        if value in (None, "", "-"):
            continue
        extras.append(f"{key}={value}")
    if extras:
        return f"{base} ({', '.join(extras)})"
    return base


def check_cluster_version(context: CheckContext):
    ok, payload = _run_kubectl(["version"], context)
    if not ok:
        return CHECK_STATUS_WARNING, payload, "确认 kubeconfig 是否可用。"
    line = next(
        (line for line in payload.splitlines() if line.lower().startswith("server version")),
        "",
    )
    if not line:
        return CHECK_STATUS_WARNING, payload, "未能解析到 Server Version。"
    return CHECK_STATUS_PASSED, line.strip(), ""




def check_connection_probe(context: CheckContext):
    ok, version_output = _run_kubectl_version_pipeline(context)
    if not ok:
        return (
            CHECK_STATUS_FAILED,
            _truncate(version_output),
            "检查kubeconfig、网络或 API Server 状态",
        )
    server_line = version_output.strip() or "Server Version 未返回"
    nodes_ok, nodes_output = _run_kubectl(["get", "nodes", "-o", "json"], context)
    detail_suffix = ""
    suggestion = ""
    if nodes_ok:
        try:
            parsed = json.loads(nodes_output)
            node_count = len(parsed.get("items", []))
            detail_suffix = f" · 节点数 {node_count}"
        except json.JSONDecodeError:
            nodes_ok = False
            detail_suffix = " · 无法解析节点信息"
            suggestion = "确认 kubectl 输出是否为 JSON。"
    else:
        detail_suffix = f" · {_truncate(nodes_output)}"
        suggestion = "检查节点可达性或 kubeconfig 权限。"
    if nodes_ok:
        return CHECK_STATUS_PASSED, f"{server_line}{detail_suffix}", ""
    return CHECK_STATUS_WARNING, f"{server_line}{detail_suffix}", suggestion

def check_nodes_status(context: CheckContext):
    ok, payload = _run_kubectl(["get", "nodes", "-o", "json"], context)
    if not ok:
        return CHECK_STATUS_WARNING, payload, "确认节点可访问。"
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return CHECK_STATUS_WARNING, payload, "kubectl 输出不是 JSON。"
    not_ready = []
    for item in parsed.get("items", []):
        conditions = item.get("status", {}).get("conditions", [])
        ready = next((c for c in conditions if c.get("type") == "Ready"), None)
        if ready and ready.get("status") != "True":
            not_ready.append(item.get("metadata", {}).get("name"))
    if not not_ready:
        return CHECK_STATUS_PASSED, f"{len(parsed.get('items', []))} nodes ready.", ""
    return (
        CHECK_STATUS_CRITICAL,
        "Nodes not ready: " + ", ".join(filter(None, not_ready)),
        "使用 kubectl describe node <name> 进一步排查。",
    )


def check_pods_status(context: CheckContext):
    ok, payload = _run_kubectl(["get", "pods", "--all-namespaces", "-o", "json"], context)
    if not ok:
        return CHECK_STATUS_WARNING, payload, "确认集群访问权限。"
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return CHECK_STATUS_WARNING, payload, "kubectl 输出不是 JSON。"
    failing = []
    for item in parsed.get("items", []):
        status = item.get("status", {})
        phase = status.get("phase")
        if phase not in {"Running", "Succeeded"}:
            ns = item.get("metadata", {}).get("namespace", "default")
            name = item.get("metadata", {}).get("name")
            failing.append(f"{ns}/{name} ({phase})")
    if not failing:
        return CHECK_STATUS_PASSED, "All pods running or completed.", ""
    return (
        CHECK_STATUS_WARNING,
        "Problem pods: " + ", ".join(failing[:10]),
        "可通过 kubectl logs/describe 定位原因。",
    )


def check_node_cpu_hotspots(context: CheckContext):
    missing = _require_prom(context)
    if missing:
        return missing
    expression = (
        "topk(5, (1 - avg by (instance)(rate(node_cpu_seconds_total{mode='idle'}[5m]))) * 100)"
    )
    ok, results, message = context.prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "检查节点 CPU 指标抓取。"
    readings = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric", {})
        node = metric.get("instance") or metric.get("node") or "unknown"
        readings.append((node, value))
    if not readings:
        return CHECK_STATUS_PASSED, "所有节点 CPU 使用率较低。", ""
    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(f"{node}: {value:.2f}%" for node, value in readings[:5])
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 90:
        status = CHECK_STATUS_CRITICAL
        suggestion = "节点 CPU 持续高负载，请排查热点工作负载或扩容。"
    elif worst >= 80:
        status = CHECK_STATUS_WARNING
        suggestion = "部分节点 CPU 偏高，关注调度或扩容。"
    return status, f"Top node CPU usage: {summary}", suggestion


def check_node_memory_pressure(context: CheckContext):
    missing = _require_prom(context)
    if missing:
        return missing
    expression = (
        "topk(5, ((node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)"
        " / node_memory_MemTotal_bytes) * 100)"
    )
    ok, results, message = context.prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确保 node_exporter 抓取内存指标。"
    readings = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric", {})
        node = metric.get("instance") or metric.get("node") or "unknown"
        readings.append((node, value))
    if not readings:
        return CHECK_STATUS_PASSED, "所有节点内存使用率正常。", ""
    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(f"{node}: {value:.2f}%" for node, value in readings[:5])
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 95:
        status = CHECK_STATUS_CRITICAL
        suggestion = "节点内存几乎耗尽，建议扩容或排查内存泄漏。"
    elif worst >= 85:
        status = CHECK_STATUS_WARNING
        suggestion = "部分节点内存压力较大，关注关键工作负载。"
    return status, f"Top node memory usage: {summary}", suggestion


def check_cluster_cpu_usage(context: CheckContext):
    missing = _require_prom(context)
    if missing:
        return missing
    expression = (
        "sum(rate(node_cpu_seconds_total{mode!='idle'}[5m])) "
        "/ sum(rate(node_cpu_seconds_total[5m])) * 100"
    )
    ok, results, message = context.prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确认 Prometheus 正在抓取节点 CPU 指标。"
    if not results:
        return CHECK_STATUS_WARNING, "Prometheus 未返回 CPU 数据。", "检查 node_exporter。"
    value = PrometheusClient.extract_value(results[0])
    if value is None:
        return CHECK_STATUS_WARNING, "Prometheus 数据无法解析。", "检查指标格式。"
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if value >= 90:
        status = CHECK_STATUS_CRITICAL
        suggestion = "CPU 接近满载，需扩容或降载。"
    elif value >= 75:
        status = CHECK_STATUS_WARNING
        suggestion = "CPU 使用率偏高，关注关键工作负载。"
    return status, f"Cluster CPU usage ≈ {value:.2f}%", suggestion


def check_cluster_memory_usage(context: CheckContext):
    missing = _require_prom(context)
    if missing:
        return missing
    expression = (
        "(sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)"
        "/ sum(node_memory_MemTotal_bytes)) * 100"
    )
    ok, results, message = context.prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确认内存指标被采集。"
    if not results:
        return CHECK_STATUS_WARNING, "Prometheus 未返回内存数据。", "检查 node_memory_* 指标。"
    value = PrometheusClient.extract_value(results[0])
    if value is None:
        return CHECK_STATUS_WARNING, "Prometheus 内存数据无法解析。", "检查指标格式。"
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if value >= 90:
        status = CHECK_STATUS_CRITICAL
        suggestion = "内存使用率极高，需扩容或排查。"
    elif value >= 80:
        status = CHECK_STATUS_WARNING
        suggestion = "内存使用率偏高，关注关键节点。"
    return status, f"Cluster memory usage ≈ {value:.2f}%", suggestion


def check_cluster_disk_io(context: CheckContext):
    missing = _require_prom(context)
    if missing:
        return missing
    expression = "topk(5, sum by (instance)(rate(node_disk_io_time_seconds_total[5m])))"
    ok, results, message = context.prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确保抓取 node_disk_io_time_seconds_total 指标。"
    readings = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric", {})
        node = metric.get("instance") or metric.get("node") or "unknown"
        readings.append((node, value))
    if not readings:
        return CHECK_STATUS_PASSED, "未检测到显著的磁盘 IO。", ""
    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(f"{node}: {value:.4f}s/s" for node, value in readings[:5])
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 0.8:
        status = CHECK_STATUS_CRITICAL
        suggestion = "磁盘 IO 时间占比过高，可能存在瓶颈。"
    elif worst >= 0.4:
        status = CHECK_STATUS_WARNING
        suggestion = "磁盘 IO 偏高，关注热点节点或磁盘健康。"
    return status, f"Top node disk IO (s/s): {summary}", suggestion


HANDLERS: Dict[str, Callable[[CheckContext], Tuple[str, str, str]]] = {
    "cluster_version": check_cluster_version,
    "connection_probe": check_connection_probe,
    "nodes_status": check_nodes_status,
    "pods_status": check_pods_status,
    "cluster_cpu_usage": check_cluster_cpu_usage,
    "cluster_memory_usage": check_cluster_memory_usage,
    "node_cpu_hotspots": check_node_cpu_hotspots,
    "node_memory_pressure": check_node_memory_pressure,
    "cluster_disk_io": check_cluster_disk_io,
}


def dispatch_checks(
    check_type: str,
    context: CheckContext,
    config: Optional[Dict[str, object]] = None,
) -> Tuple[str, str, str]:
    if check_type == "command":
        return _execute_command_check(config or {}, context)
    if check_type == "promql":
        return _execute_promql_check(config or {}, context)
    handler = HANDLERS.get(check_type)
    if handler is None:
        return (
            CHECK_STATUS_WARNING,
            f"No handler implemented for check type '{check_type}'.",
            "在后端实现该类型或改用 promql/command。",
        )
    return handler(context)


__all__ = [
    "PrometheusClient",
    "CheckContext",
    "dispatch_checks",
]
