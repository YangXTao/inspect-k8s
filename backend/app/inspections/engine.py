from __future__ import annotations

import json
import shutil
import subprocess
import shlex
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, Tuple

from ..prometheus import PrometheusClient

CHECK_STATUS_PASSED = "passed"
CHECK_STATUS_WARNING = "warning"
CHECK_STATUS_FAILED = "failed"


@dataclass
class CheckContext:
    kubeconfig_path: str | None = None
    prom: PrometheusClient | None = None


def _run_kubectl(args: Iterable[str], context: CheckContext) -> Tuple[bool, str]:
    if shutil.which("kubectl") is None:
        return False, "kubectl command not found on server."
    cmd = ["kubectl"]
    if context.kubeconfig_path:
        cmd.extend(["--kubeconfig", context.kubeconfig_path])
    cmd.extend(args)
    try:
        result = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
    except Exception as exc:  # pragma: no cover - defensive path
        return False, f"kubectl execution error: {exc}"

    if result.returncode != 0:
        return False, result.stderr.strip() or "kubectl returned non-zero exit code."
    return True, result.stdout.strip()


DEFAULT_COMMAND_TIMEOUT = 30
MAX_OUTPUT_LENGTH = 2000


def _truncate_output(value: str) -> str:
    value = value.strip()
    if len(value) <= MAX_OUTPUT_LENGTH:
        return value
    return value[: MAX_OUTPUT_LENGTH - 3] + "..."


def _execute_command_check(config: Dict[str, object], context: CheckContext) -> Tuple[str, str, str]:
    if not isinstance(config, dict):
        return (
            CHECK_STATUS_WARNING,
            "Command configuration is invalid.",
            "Update the inspection item definition.",
        )
    command = config.get("command")
    if not command:
        return (
            CHECK_STATUS_WARNING,
            "No command configured.",
            "Provide a command in the inspection item definition.",
        )

    shell = bool(config.get("shell", False))
    placeholder = str(config.get("kubeconfig_placeholder", "{{kubeconfig}}"))
    kubeconfig = context.kubeconfig_path

    def _replace_placeholder(value: str) -> str:
        if placeholder in value:
            return value.replace(placeholder, kubeconfig or "")
        return value

    if isinstance(command, str):
        rendered = _replace_placeholder(command)
        if shell:
            cmd = rendered
        else:
            try:
                cmd = shlex.split(rendered)
            except ValueError as exc:
                return (
                    CHECK_STATUS_WARNING,
                    f"Failed to parse command: {exc}",
                    "Adjust the command definition.",
                )
    elif isinstance(command, (list, tuple)):
        cmd = []
        for part in command:
            part = _replace_placeholder(str(part))
            if not part:
                continue
            cmd.append(part)
    else:
        return (
            CHECK_STATUS_WARNING,
            "Unsupported command data type.",
            "Provide the command as a string or list.",
        )

    timeout = int(config.get("timeout", DEFAULT_COMMAND_TIMEOUT))
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
        suggestion = config.get("suggestion_on_timeout") or config.get("suggestion_on_fail") or "Check command runtime or increase timeout."
        return (
            CHECK_STATUS_WARNING,
            f"Command timed out after {timeout}s.",
            suggestion,
        )
    except FileNotFoundError:
        return (
            CHECK_STATUS_FAILED,
            "Command executable not found.",
            config.get("suggestion_on_fail") or "Ensure the binary is installed on the server.",
        )
    except Exception as exc:  # pragma: no cover - defensive path
        return (
            CHECK_STATUS_FAILED,
            f"Command execution error: {exc}",
            config.get("suggestion_on_fail") or "Review command definition.",
        )

    stdout = result.stdout or ""
    stderr = result.stderr or ""
    exit_code = result.returncode

    if exit_code in success_codes:
        expected = config.get("expect_substrings") or []
        if isinstance(expected, str):
            expected = [expected]
        missing = [pattern for pattern in expected if pattern not in stdout]
        if missing:
            detail = (
                "Output missing expected text: " + ", ".join(missing)
            )
            suggestion = config.get("suggestion_on_fail") or "Verify the command output."
            return CHECK_STATUS_WARNING, detail, suggestion

        success_override = config.get("success_message")
        output_text = stdout.strip() or stderr.strip()
        if success_override:
            detail = _truncate_output(str(success_override))
        elif output_text:
            detail = _truncate_output(output_text)
        else:
            detail = "命令执行成功（无输出）"
        suggestion = config.get("suggestion_on_success") or ""
        return CHECK_STATUS_PASSED, detail, suggestion

    detail = config.get("failure_message") or _truncate_output(stderr or stdout or "Command returned non-zero exit code.")
    suggestion = config.get("suggestion_on_fail") or "Inspect command output for details."
    return CHECK_STATUS_FAILED, detail, suggestion


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


def _aggregate_values(values: list[float], mode: str) -> float:
    if not values:
        return 0.0
    mode = mode.lower()
    if mode == "min":
        return min(values)
    if mode == "avg" or mode == "mean":
        return sum(values) / len(values)
    if mode == "sum":
        return sum(values)
    return max(values)


def _execute_promql_check(config: Dict[str, object], context: CheckContext) -> Tuple[str, str, str]:
    if not isinstance(config, dict):
        return (
            CHECK_STATUS_WARNING,
            "PromQL configuration is invalid.",
            "Update the inspection item definition.",
        )
    missing = _require_prom(context)
    if missing:
        return missing
    expression = config.get("expression")
    if not expression:
        return (
            CHECK_STATUS_WARNING,
            "PromQL expression is not configured.",
            "Provide an expression in the inspection item definition.",
        )
    prom = context.prom
    ok, results, message = prom.query(str(expression))
    if not ok:
        suggestion = config.get("suggestion_on_error") or "Check Prometheus endpoint availability."
        return CHECK_STATUS_WARNING, message, suggestion

    values = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is not None:
            values.append(value)

    if not values:
        empty_status = config.get("status_if_empty", CHECK_STATUS_WARNING)
        empty_message = config.get("empty_message") or "Prometheus returned no samples."
        suggestion = config.get("suggestion_if_empty") or "Ensure the metric is being scraped."
        return empty_status, empty_message, suggestion

    aggregate_mode = str(config.get("aggregate", "max"))
    aggregate_value = _aggregate_values(values, aggregate_mode)

    comparison = str(config.get("comparison", ">=")).strip()
    fail_threshold = config.get("fail_threshold")
    warn_threshold = config.get("warn_threshold")

    status = CHECK_STATUS_PASSED
    suggestion = config.get("suggestion_on_success") or ""

    if fail_threshold is not None and _compare(float(aggregate_value), float(fail_threshold), comparison):
        status = CHECK_STATUS_FAILED
        suggestion = config.get("suggestion_on_fail") or suggestion
    elif warn_threshold is not None and _compare(float(aggregate_value), float(warn_threshold), comparison):
        status = CHECK_STATUS_WARNING
        suggestion = config.get("suggestion_on_warn") or suggestion

    detail_template = config.get("detail_template")
    if isinstance(detail_template, str):
        try:
            detail = detail_template.format(value=aggregate_value, values=values, expression=expression)
        except Exception:
            detail = f"{aggregate_mode} value from {expression}: {aggregate_value}"
    else:
        sample_count = len(values)
        detail = f"{aggregate_mode} value from {expression}: {aggregate_value} (samples={sample_count})"

    return status, detail, suggestion


def _require_prom(context: CheckContext) -> Tuple[str, str, str] | None:
    if context.prom is None:
        return (
            CHECK_STATUS_WARNING,
            "Prometheus endpoint is not configured for this cluster.",
            "Edit the cluster and填写 Prometheus 地址以启用该巡检项。",
        )
    return None


def _format_percentage(value: float) -> str:
    return f"{value:.2f}%"


def check_cluster_version(context: CheckContext) -> Tuple[str, str, str]:
    ok, payload = _run_kubectl(["version"], context)
    if not ok:
        return CHECK_STATUS_WARNING, payload, "Verify kubectl connectivity to the cluster."
    server_line = next(
        (line for line in payload.splitlines() if line.lower().startswith("server version")),
        "",
    )
    if not server_line:
        return CHECK_STATUS_WARNING, payload, "未能从输出中解析到 Server Version。"
    return CHECK_STATUS_PASSED, server_line.strip(), ""


def check_nodes_status(context: CheckContext) -> Tuple[str, str, str]:
    ok, payload = _run_kubectl(["get", "nodes", "-o", "json"], context)
    if not ok:
        return (
            CHECK_STATUS_WARNING,
            payload,
            "Ensure nodes are reachable and kubeconfig is configured.",
        )
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return CHECK_STATUS_WARNING, payload, "kubectl output not in JSON format."

    not_ready = []
    for item in parsed.get("items", []):
        conditions = item.get("status", {}).get("conditions", [])
        ready_state = next(
            (cond for cond in conditions if cond.get("type") == "Ready"), None
        )
        if ready_state and ready_state.get("status") != "True":
            not_ready.append(item["metadata"]["name"])

    if not not_ready:
        return CHECK_STATUS_PASSED, f"{len(parsed.get('items', []))} nodes ready.", ""
    detail = "Nodes not ready: " + ", ".join(not_ready)
    suggestion = "Investigate node conditions via 'kubectl describe node <name>'."
    return CHECK_STATUS_FAILED, detail, suggestion


def check_pods_status(context: CheckContext) -> Tuple[str, str, str]:
    ok, payload = _run_kubectl(["get", "pods", "--all-namespaces", "-o", "json"], context)
    if not ok:
        return (
            CHECK_STATUS_WARNING,
            payload,
            "Verify cluster access or specify kubeconfig.",
        )
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return CHECK_STATUS_WARNING, payload, "kubectl output not in JSON format."

    failing = []
    for item in parsed.get("items", []):
        status = item.get("status", {})
        phase = status.get("phase")
        if phase not in {"Running", "Succeeded"}:
            namespace = item.get("metadata", {}).get("namespace", "default")
            name = item.get("metadata", {}).get("name")
            failing.append(f"{namespace}/{name} ({phase})")

    if not failing:
        return CHECK_STATUS_PASSED, "All pods running or completed.", ""

    detail = "Problem pods: " + ", ".join(failing[:8])
    suggestion = "Check pod logs or describe pods for details."
    return CHECK_STATUS_WARNING, detail, suggestion


# def check_events_recent(context: CheckContext) -> Tuple[str, str, str]:
#     ok, payload = _run_kubectl(
#         [
#             "get",
#             "events",
#             "--all-namespaces",
#             "--sort-by=.metadata.creationTimestamp",
#             "-o",
#             "wide",
#         ],
#         context,
#     )
#     if not ok:
#         return (
#             CHECK_STATUS_WARNING,
#             payload,
#             "Confirm cluster permissions for events.",
#         )
#     return CHECK_STATUS_PASSED, payload[:2000], "Use kubectl get events for full details."


def check_cluster_cpu_usage(context: CheckContext) -> Tuple[str, str, str]:
    missing = _require_prom(context)
    if missing:
        return missing
    prom = context.prom
    expression = (
        "sum(rate(node_cpu_seconds_total{mode!='idle'}[5m])) "
        "/ sum(rate(node_cpu_seconds_total[5m])) * 100"
    )
    ok, results, message = prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确认 Prometheus 服务可访问，且节点指标已采集。"
    if not results:
        return CHECK_STATUS_WARNING, "Prometheus 未返回 CPU 数据。", "检查 Prometheus 抓取的节点 CPU 指标。"
    value = PrometheusClient.extract_value(results[0])
    if value is None:
        return CHECK_STATUS_WARNING, "Prometheus 数据无法解析。", "检查指标格式。"

    status = CHECK_STATUS_PASSED
    suggestion = ""
    if value >= 90:
        status = CHECK_STATUS_FAILED
        suggestion = "CPU 接近满载，请检查集群负载并考虑扩容。"
    elif value >= 75:
        status = CHECK_STATUS_WARNING
        suggestion = "CPU 使用率偏高，关注关键工作负载或扩容。"
    detail = f"Cluster CPU usage ≈ {_format_percentage(value)}."
    return status, detail, suggestion


def check_cluster_memory_usage(context: CheckContext) -> Tuple[str, str, str]:
    missing = _require_prom(context)
    if missing:
        return missing
    prom = context.prom
    expression = (
        "(sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) "
        "/ sum(node_memory_MemTotal_bytes)) * 100"
    )
    ok, results, message = prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确认 Prometheus 正在采集 node_exporter 内存指标。"
    if not results:
        return CHECK_STATUS_WARNING, "Prometheus 未返回内存数据。", "检查 node_memory_* 指标是否存在。"
    value = PrometheusClient.extract_value(results[0])
    if value is None:
        return CHECK_STATUS_WARNING, "Prometheus 内存数据无法解析。", "检查指标格式。"

    status = CHECK_STATUS_PASSED
    suggestion = ""
    if value >= 90:
        status = CHECK_STATUS_FAILED
        suggestion = "内存使用率已非常高，建议扩容或排查内存泄漏。"
    elif value >= 80:
        status = CHECK_STATUS_WARNING
        suggestion = "内存使用率偏高，请关注关键节点和工作负载。"
    detail = f"Cluster memory usage ≈ {_format_percentage(value)}."
    return status, detail, suggestion


def check_node_cpu_hotspots(context: CheckContext) -> Tuple[str, str, str]:
    missing = _require_prom(context)
    if missing:
        return missing
    prom = context.prom
    expression = (
        "topk(5, (1 - avg by (instance)("
        "rate(node_cpu_seconds_total{mode='idle'}[5m])"
        ")) * 100)"
    )
    ok, results, message = prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "检查 Prometheus 节点 CPU 指标抓取是否正常。"
    if not results:
        return CHECK_STATUS_PASSED, "所有节点 CPU 使用率较低。", ""

    readings = []
    for sample in results:
        metric = sample.get("metric", {})
        node_name = metric.get("instance") or metric.get("node") or "unknown"
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        readings.append((node_name, value))
    if not readings:
        return CHECK_STATUS_WARNING, "无法解析节点 CPU 指标。", "确认节点标签（instance/node）是否存在。"

    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(
        f"{name}: {_format_percentage(value)}" for name, value in readings[:5]
    )
    worst = readings[0][1]
    if worst >= 90:
        status = CHECK_STATUS_FAILED
        suggestion = "部分节点 CPU 使用率极高，请排查热点工作负载或考虑调度优化。"
    elif worst >= 80:
        status = CHECK_STATUS_WARNING
        suggestion = "部分节点 CPU 使用率偏高，可结合调度策略或扩容处理。"
    else:
        status = CHECK_STATUS_PASSED
        suggestion = ""
    return status, f"Top node CPU usage: {summary}", suggestion


def check_node_memory_pressure(context: CheckContext) -> Tuple[str, str, str]:
    missing = _require_prom(context)
    if missing:
        return missing
    prom = context.prom
    expression = (
        "topk(5, (("
        "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes"
        ") / node_memory_MemTotal_bytes) * 100)"
    )
    ok, results, message = prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确保 node_exporter 正在采集内存指标。"
    if not results:
        return CHECK_STATUS_PASSED, "所有节点内存使用率正常。", ""

    readings = []
    for sample in results:
        metric = sample.get("metric", {})
        node_name = metric.get("instance") or metric.get("node") or "unknown"
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        readings.append((node_name, value))
    if not readings:
        return CHECK_STATUS_WARNING, "Prometheus 返回的内存数据无法解析。", "检查指标标签。"

    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(
        f"{name}: {_format_percentage(value)}" for name, value in readings[:5]
    )
    worst = readings[0][1]
    if worst >= 95:
        status = CHECK_STATUS_FAILED
        suggestion = "节点内存几乎耗尽，建议排查内存泄漏或扩容。"
    elif worst >= 85:
        status = CHECK_STATUS_WARNING
        suggestion = "部分节点内存压力较大，关注关键工作负载。"
    else:
        status = CHECK_STATUS_PASSED
        suggestion = ""
    return status, f"Top node memory usage: {summary}", suggestion


def check_cluster_disk_io(context: CheckContext) -> Tuple[str, str, str]:
    missing = _require_prom(context)
    if missing:
        return missing
    prom = context.prom
    expression = "topk(5, sum by (instance)(rate(node_disk_io_time_seconds_total[5m])))"
    ok, results, message = prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "确保 Prometheus 抓取到 node_disk_io_time_seconds_total 指标。"
    if not results:
        return CHECK_STATUS_PASSED, "Prometheus 未检测到显著的磁盘 IO。", ""

    readings = []
    for sample in results:
        metric = sample.get("metric", {})
        node_name = metric.get("instance") or metric.get("node") or "unknown"
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        readings.append((node_name, value))

    if not readings:
        return CHECK_STATUS_WARNING, "磁盘 IO 指标无法解析。", "确认节点导出器是否暴露磁盘 IO 指标。"

    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(
        f"{name}: {value:.4f}s/s" for name, value in readings[:5]
    )
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 0.8:
        status = CHECK_STATUS_FAILED
        suggestion = "磁盘 IO 时间占比过高，可能存在 IO 瓶颈。"
    elif worst >= 0.4:
        status = CHECK_STATUS_WARNING
        suggestion = "磁盘 IO 占比偏高，关注热点节点或磁盘健康状态。"
    return status, f"Top node disk IO (s/s): {summary}", suggestion


HANDLERS: Dict[str, Callable[[CheckContext], Tuple[str, str, str]]] = {
    "cluster_version": check_cluster_version,
    "nodes_status": check_nodes_status,
    "pods_status": check_pods_status,
    # "events_recent": check_events_recent,
    "cluster_cpu_usage": check_cluster_cpu_usage,
    "cluster_memory_usage": check_cluster_memory_usage,
    "node_cpu_hotspots": check_node_cpu_hotspots,
    "node_memory_pressure": check_node_memory_pressure,
    "cluster_disk_io": check_cluster_disk_io,
}

DEFAULT_CHECKS = [
    {
        "name": "Cluster Version",
        "description": "Collects Kubernetes API server and kubectl client version.",
        "check_type": "cluster_version",
    },
    {
        "name": "Node Health",
        "description": "Verifies all nodes are Ready.",
        "check_type": "nodes_status",
    },
    {
        "name": "Pod Status",
        "description": "Checks for non-running pods cluster-wide.",
        "check_type": "pods_status",
    },
    {
        "name": "Cluster CPU Usage",
        "description": "Aggregated CPU utilisation via Prometheus metrics.",
        "check_type": "cluster_cpu_usage",
    },
    {
        "name": "Cluster Memory Usage",
        "description": "Overall memory utilisation from Prometheus.",
        "check_type": "cluster_memory_usage",
    },
    {
        "name": "Node CPU Hotspots",
        "description": "Highlights nodes with highest CPU usage.",
        "check_type": "node_cpu_hotspots",
    },
    {
        "name": "Node Memory Pressure",
        "description": "Highlights nodes with highest memory usage.",
        "check_type": "node_memory_pressure",
    },
    {
        "name": "Cluster Disk IO",
        "description": "Monitors node disk IO time ratio.",
        "check_type": "cluster_disk_io",
    },
    {
        "name": "kubectl cluster-info",
        "description": "Runs 'kubectl cluster-info' using the cluster kubeconfig to verify connectivity.",
        "check_type": "command",
        "config": {
            "command": ["kubectl", "--kubeconfig", "{{kubeconfig}}", "cluster-info"],
            "timeout": 20,
            "success_message": "kubectl cluster-info succeeded.",
            "failure_message": "kubectl cluster-info reported an error.",
            "suggestion_on_fail": "检查 kubeconfig 是否有效且 apiserver 可访问。"
        },
    },
    {
        "name": "API Server Availability",
        "description": "Checks the apiserver 'up' metric via Prometheus.",
        "check_type": "promql",
        "config": {
            "expression": "max(up{job='apiserver'})",
            "comparison": "<=",
            "fail_threshold": 0,
            "empty_message": "Prometheus 未返回 apiserver up 指标。",
            "suggestion_on_fail": "确认 Prometheus 中 apiserver target 状态正常。",
            "suggestion_if_empty": "检查 Prometheus 抓取配置是否包含 apiserver target。"
        },
    },
]


def dispatch_checks(
    check_type: str,
    context: CheckContext,
    config: Dict[str, object] | None = None,
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
            "Create a handler in inspections.engine.HANDLERS or use a command/promql definition.",
        )
    return handler(context)
