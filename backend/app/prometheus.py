from __future__ import annotations

from typing import List, Tuple

import requests


class PrometheusClient:
    """Minimal Prometheus HTTP API client for instant queries."""

    def __init__(self, base_url: str, timeout: float = 5.0, verify_ssl: bool = True):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.verify_ssl = verify_ssl

    def query(self, expression: str) -> Tuple[bool, List[dict], str]:
        """Execute an instant query. Returns (success, results, message)."""
        if not self.base_url:
            return False, [], "Prometheus base URL is empty."

        url = f"{self.base_url}/api/v1/query"
        try:
            response = requests.get(
                url,
                params={"query": expression},
                timeout=self.timeout,
                verify=self.verify_ssl,
            )
        except requests.RequestException as exc:
            return False, [], f"Prometheus request error: {exc}"

        if response.status_code != 200:
            snippet = response.text[:200]
            return (
                False,
                [],
                f"Prometheus returned HTTP {response.status_code}: {snippet}",
            )

        try:
            payload = response.json()
        except ValueError:
            return False, [], "Prometheus response is not valid JSON."

        if payload.get("status") != "success":
            error_type = payload.get("errorType")
            error_message = payload.get("error")
            return (
                False,
                [],
                f"Prometheus query failed: {error_type or ''} {error_message or ''}".strip(),
            )

        data = payload.get("data", {})
        results = data.get("result", [])
        return True, results, ""

    @staticmethod
    def extract_value(sample: dict) -> float | None:
        try:
            value = sample["value"]
            if isinstance(value, (list, tuple)) and len(value) >= 2:
                return float(value[1])
            return float(value)
        except (KeyError, TypeError, ValueError):
            return None

