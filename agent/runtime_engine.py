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

DEFAULT_EXECUTION_FAILURE_SUGGESTION = "璇锋鏌ユ鍛戒护鎴杙romql"


class PrometheusClient:
    """杞婚噺 Prometheus HTTP API 瀹㈡埛绔紙鏈湴澶囦唤瀹炵幇锛夈€?""

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


def _normalize_exit_codes(value: object) -> set[int]:
    if value is None:
        return set()
    if isinstance(value, (list, tuple, set)):
        items = value
    else:
        items = [value]
    codes: set[int] = set()
    for item in items:
        try:
            codes.add(int(item))
        except (TypeError, ValueError):
            continue
    return codes



def _execute_command_check(
    config: Dict[str, object], context: CheckContext
) -> Tuple[str, str, str]:
    if not isinstance(config, dict):
        return CHECK_STATUS_WARNING, "Command configuration invalid.", "请修正巡检项定义。"
    command = config.get("command")
    if not command:
        return CHECK_STATUS_WARNING, "No command configured.", "请在巡检项里提供命令。"

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
        return CHECK_STATUS_WARNING, "Unsupported command type.", "请使用字符串或列表。"

    timeout = int(config.get("timeout", 30))
    success_codes = config.get("success_exit_codes", [0])
    if not isinstance(success_codes, (list, tuple)):
        success_codes = [success_codes]
    success_codes = {int(code) for code in success_codes}
    warn_exit_codes = _normalize_exit_codes(config.get("warn_exit_codes"))
    critical_exit_codes = _normalize_exit_codes(config.get("critical_exit_codes"))
    force_warning = bool(config.get("force_warning"))
    force_critical = bool(config.get("force_critical"))

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
        return (
            CHECK_STATUS_WARNING,
            f"Command timed out after {timeout}s.",
            config.get("suggestion_on_timeout")
            or config.get("suggestion_on_fail")
            or DEFAULT_EXECUTION_FAILURE_SUGGESTION,
        )
    except FileNotFoundError:
        return (
            CHECK_STATUS_FAILED,
            "Command executable not found.",
            config.get("suggestion_on_fail") or DEFAULT_EXECUTION_FAILURE_SUGGESTION,
        )
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
                config.get("suggestion_on_warn") or "",
            )
        detail = (
            _truncate(stdout)
            or _truncate(stderr)
            or str(config.get("success_message") or "命令执行成功。")
        )
        if force_warning:
            return (
                CHECK_STATUS_WARNING,
                detail,
                config.get("suggestion_on_warn")
                or config.get("suggestion_on_success")
                or "",
            )
        return (
            CHECK_STATUS_PASSED,
            detail,
            config.get("suggestion_on_success") or "",
        )

    detail = config.get("failure_message") or _truncate(
        stderr or stdout or "Command returned non-zero exit code."
    )
    if force_warning:
        return CHECK_STATUS_WARNING, detail, config.get("suggestion_on_warn") or ""
    if force_critical or result.returncode in critical_exit_codes:
        return CHECK_STATUS_CRITICAL, detail, config.get("suggestion_on_critical") or ""
    if result.returncode in warn_exit_codes:
        return CHECK_STATUS_WARNING, detail, config.get("suggestion_on_warn") or ""
    return CHECK_STATUS_CRITICAL, detail, config.get("suggestion_on_critical") or ""

def _require_prom(context: CheckContext) -> Optional[Tuple[str, str, str]]:
    if context.prom is None:
        return (
            CHECK_STATUS_WARNING,
            "Prometheus endpoint is not configured for this cluster.",
            "请在 Agent 或集群配置中补充 Prometheus 地址。",
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
        return CHECK_STATUS_WARNING, "PromQL configuration is invalid.", "淇宸℃椤瑰畾涔夈€?
    missing = _require_prom(context)
    if missing:
        return missing
    expression = str(config.get("expression") or "").strip()
    if not expression:
        return CHECK_STATUS_WARNING, "PromQL expression is not configured.", "琛ュ厖琛ㄨ揪寮忋€?
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
            config.get("suggestion_if_empty") or "纭鎸囨爣姝ｅ湪琚噰闆嗐€?,
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

    max_rows = config.get("result_limit") or config.get("top_n") or 20
    try:
        max_rows = int(max_rows)
        if max_rows <= 0:
            max_rows = 20
    except (TypeError, ValueError):
        max_rows = 20
    reverse = comparison not in {"<", "<="}
    sorted_samples = sorted(
        samples, key=lambda item: item["value"], reverse=reverse  # type: ignore[index]
    )

    def format_entry(entry: Dict[str, object]) -> str:
        metric = entry.get("metric") if isinstance(entry, dict) else {}
        value = entry.get("value", 0.0)
        metric_name = _format_metric(metric)
        return f"{metric_name}：{fmt(float(value))}"

    if status == CHECK_STATUS_PASSED:
        pass_limit = min(3, max_rows) if max_rows else 3
        lines = ["正常"]
        for entry in sorted_samples[:pass_limit]:
            lines.append(format_entry(entry))
        return status, "\n".join(lines), suggestion

    if status == CHECK_STATUS_CRITICAL:
        matches = [
            entry
            for entry in sorted_samples
            if critical_value is not None
            and _compare(float(entry["value"]), critical_value, comparison)  # type: ignore[index]
        ]
        matches_to_show = matches or sorted_samples
    elif status == CHECK_STATUS_WARNING:
        matches = [
            entry
            for entry in sorted_samples
            if warn_value is not None
            and _compare(float(entry["value"]), warn_value, comparison)  # type: ignore[index]
        ]
        matches_to_show = matches or sorted_samples
    else:
        matches_to_show = sorted_samples

    lines = [format_entry(entry) for entry in matches_to_show[:max_rows]]
    detail = "\n".join(lines) if lines else "未提供详情"
    return status, detail, suggestion


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
        return CHECK_STATUS_WARNING, payload, "纭 kubeconfig 鏄惁鍙敤銆?
    line = next(
        (line for line in payload.splitlines() if line.lower().startswith("server version")),
        "",
    )
    if not line:
        return CHECK_STATUS_WARNING, payload, "鏈兘瑙ｆ瀽鍒?Server Version銆?
    return CHECK_STATUS_PASSED, line.strip(), ""




def check_connection_probe(context: CheckContext):
    ok, version_output = _run_kubectl_version_pipeline(context)
    if not ok:
        return (
            CHECK_STATUS_FAILED,
            _truncate(version_output),
            "妫€鏌ubeconfig銆佺綉缁滄垨 API Server 鐘舵€?,
        )
    server_line = version_output.strip() or "Server Version 鏈繑鍥?
    nodes_ok, nodes_output = _run_kubectl(["get", "nodes", "-o", "json"], context)
    detail_suffix = ""
    suggestion = ""
    if nodes_ok:
        try:
            parsed = json.loads(nodes_output)
            node_count = len(parsed.get("items", []))
            detail_suffix = f" 路 鑺傜偣鏁?{node_count}"
        except json.JSONDecodeError:
            nodes_ok = False
            detail_suffix = " 路 鏃犳硶瑙ｆ瀽鑺傜偣淇℃伅"
            suggestion = "纭 kubectl 杈撳嚭鏄惁涓?JSON銆?
    else:
        detail_suffix = f" 路 {_truncate(nodes_output)}"
        suggestion = "妫€鏌ヨ妭鐐瑰彲杈炬€ф垨 kubeconfig 鏉冮檺銆?
    if nodes_ok:
        return CHECK_STATUS_PASSED, f"{server_line}{detail_suffix}", ""
    return CHECK_STATUS_WARNING, f"{server_line}{detail_suffix}", suggestion

def check_nodes_status(context: CheckContext):
    ok, payload = _run_kubectl(["get", "nodes", "-o", "json"], context)
    if not ok:
        return CHECK_STATUS_WARNING, payload, "纭鑺傜偣鍙闂€?
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return CHECK_STATUS_WARNING, payload, "kubectl 杈撳嚭涓嶆槸 JSON銆?
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
        "浣跨敤 kubectl describe node <name> 杩涗竴姝ユ帓鏌ャ€?,
    )


def check_pods_status(context: CheckContext):
    ok, payload = _run_kubectl(["get", "pods", "--all-namespaces", "-o", "json"], context)
    if not ok:
        return CHECK_STATUS_WARNING, payload, "纭闆嗙兢璁块棶鏉冮檺銆?
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        return CHECK_STATUS_WARNING, payload, "kubectl 杈撳嚭涓嶆槸 JSON銆?
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
        "鍙€氳繃 kubectl logs/describe 瀹氫綅鍘熷洜銆?,
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
        return CHECK_STATUS_WARNING, message, "妫€鏌ヨ妭鐐?CPU 鎸囨爣鎶撳彇銆?
    readings = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric", {})
        node = metric.get("instance") or metric.get("node") or "unknown"
        readings.append((node, value))
    if not readings:
        return CHECK_STATUS_PASSED, "鎵€鏈夎妭鐐?CPU 浣跨敤鐜囪緝浣庛€?, ""
    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(f"{node}: {value:.2f}%" for node, value in readings[:5])
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 90:
        status = CHECK_STATUS_CRITICAL
        suggestion = "鑺傜偣 CPU 鎸佺画楂樿礋杞斤紝璇锋帓鏌ョ儹鐐瑰伐浣滆礋杞芥垨鎵╁銆?
    elif worst >= 80:
        status = CHECK_STATUS_WARNING
        suggestion = "閮ㄥ垎鑺傜偣 CPU 鍋忛珮锛屽叧娉ㄨ皟搴︽垨鎵╁銆?
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
        return CHECK_STATUS_WARNING, message, "纭繚 node_exporter 鎶撳彇鍐呭瓨鎸囨爣銆?
    readings = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric", {})
        node = metric.get("instance") or metric.get("node") or "unknown"
        readings.append((node, value))
    if not readings:
        return CHECK_STATUS_PASSED, "鎵€鏈夎妭鐐瑰唴瀛樹娇鐢ㄧ巼姝ｅ父銆?, ""
    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(f"{node}: {value:.2f}%" for node, value in readings[:5])
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 95:
        status = CHECK_STATUS_CRITICAL
        suggestion = "鑺傜偣鍐呭瓨鍑犱箮鑰楀敖锛屽缓璁墿瀹规垨鎺掓煡鍐呭瓨娉勬紡銆?
    elif worst >= 85:
        status = CHECK_STATUS_WARNING
        suggestion = "閮ㄥ垎鑺傜偣鍐呭瓨鍘嬪姏杈冨ぇ锛屽叧娉ㄥ叧閿伐浣滆礋杞姐€?
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
        return CHECK_STATUS_WARNING, message, "纭 Prometheus 姝ｅ湪鎶撳彇鑺傜偣 CPU 鎸囨爣銆?
    if not results:
        return CHECK_STATUS_WARNING, "Prometheus 鏈繑鍥?CPU 鏁版嵁銆?, "妫€鏌?node_exporter銆?
    value = PrometheusClient.extract_value(results[0])
    if value is None:
        return CHECK_STATUS_WARNING, "Prometheus 鏁版嵁鏃犳硶瑙ｆ瀽銆?, "妫€鏌ユ寚鏍囨牸寮忋€?
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if value >= 90:
        status = CHECK_STATUS_CRITICAL
        suggestion = "CPU 鎺ヨ繎婊¤浇锛岄渶鎵╁鎴栭檷杞姐€?
    elif value >= 75:
        status = CHECK_STATUS_WARNING
        suggestion = "CPU 浣跨敤鐜囧亸楂橈紝鍏虫敞鍏抽敭宸ヤ綔璐熻浇銆?
    return status, f"Cluster CPU usage 鈮?{value:.2f}%", suggestion


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
        return CHECK_STATUS_WARNING, message, "纭鍐呭瓨鎸囨爣琚噰闆嗐€?
    if not results:
        return CHECK_STATUS_WARNING, "Prometheus 鏈繑鍥炲唴瀛樻暟鎹€?, "妫€鏌?node_memory_* 鎸囨爣銆?
    value = PrometheusClient.extract_value(results[0])
    if value is None:
        return CHECK_STATUS_WARNING, "Prometheus 鍐呭瓨鏁版嵁鏃犳硶瑙ｆ瀽銆?, "妫€鏌ユ寚鏍囨牸寮忋€?
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if value >= 90:
        status = CHECK_STATUS_CRITICAL
        suggestion = "鍐呭瓨浣跨敤鐜囨瀬楂橈紝闇€鎵╁鎴栨帓鏌ャ€?
    elif value >= 80:
        status = CHECK_STATUS_WARNING
        suggestion = "鍐呭瓨浣跨敤鐜囧亸楂橈紝鍏虫敞鍏抽敭鑺傜偣銆?
    return status, f"Cluster memory usage 鈮?{value:.2f}%", suggestion


def check_cluster_disk_io(context: CheckContext):
    missing = _require_prom(context)
    if missing:
        return missing
    expression = "topk(5, sum by (instance)(rate(node_disk_io_time_seconds_total[5m])))"
    ok, results, message = context.prom.query(expression)
    if not ok:
        return CHECK_STATUS_WARNING, message, "纭繚鎶撳彇 node_disk_io_time_seconds_total 鎸囨爣銆?
    readings = []
    for sample in results or []:
        value = PrometheusClient.extract_value(sample)
        if value is None:
            continue
        metric = sample.get("metric", {})
        node = metric.get("instance") or metric.get("node") or "unknown"
        readings.append((node, value))
    if not readings:
        return CHECK_STATUS_PASSED, "鏈娴嬪埌鏄捐憲鐨勭鐩?IO銆?, ""
    readings.sort(key=lambda item: item[1], reverse=True)
    summary = ", ".join(f"{node}: {value:.4f}s/s" for node, value in readings[:5])
    worst = readings[0][1]
    status = CHECK_STATUS_PASSED
    suggestion = ""
    if worst >= 0.8:
        status = CHECK_STATUS_CRITICAL
        suggestion = "纾佺洏 IO 鏃堕棿鍗犳瘮杩囬珮锛屽彲鑳藉瓨鍦ㄧ摱棰堛€?
    elif worst >= 0.4:
        status = CHECK_STATUS_WARNING
        suggestion = "纾佺洏 IO 鍋忛珮锛屽叧娉ㄧ儹鐐硅妭鐐规垨纾佺洏鍋ュ悍銆?
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
            "鍦ㄥ悗绔疄鐜拌绫诲瀷鎴栨敼鐢?promql/command銆?,
        )
    return handler(context)


__all__ = [
    "PrometheusClient",
    "CheckContext",
    "dispatch_checks",
]





