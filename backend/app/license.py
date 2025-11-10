from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Set


class LicenseError(Exception):
    """Raised when license validation fails."""


def _normalize_datetime(value: Any, *, field: str) -> datetime:
    if value is None:
        raise LicenseError(f"License 缺少 {field}")
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise LicenseError(f"License 缺少 {field}")
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(text)
        except ValueError as exc:  # pragma: no cover - defensive
            raise LicenseError(f"License 字段 {field} 解析失败") from exc
    else:  # pragma: no cover - defensive
        raise LicenseError(f"License 字段 {field} 类型无效")

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def _optional_datetime(value: Any, *, field: str) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return _normalize_datetime(value, field=field)


def _canonical_features(features: Iterable[str]) -> Set[str]:
    result: Set[str] = set()
    for item in features:
        text = str(item).strip()
        if text:
            result.add(text.lower())
    return result


def _signature_payload(data: Dict[str, Any]) -> str:
    licensee = str(data.get("licensee") or "").strip()
    product = str(data.get("product") or "").strip()
    issued_at = str(data.get("issued_at") or "").strip()
    not_before = str(data.get("not_before") or "").strip()
    expires_at = str(data.get("expires_at") or "").strip()
    features = ",".join(sorted(str(item).strip() for item in data.get("features", []) if str(item).strip()))
    return "|".join([product, licensee, issued_at, not_before, expires_at, features])


def _expected_signature(data: Dict[str, Any], secret: str) -> str:
    payload = _signature_payload(data)
    return hmac.new(secret.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


@dataclass(frozen=True)
class LicenseData:
    licensee: str
    product: str
    issued_at: Optional[datetime]
    not_before: Optional[datetime]
    expires_at: datetime
    features: Set[str]
    raw: Dict[str, Any]


class LicenseManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._data: Optional[LicenseData] = None
        self._error: Optional[str] = "未安装 License"
        license_path = os.getenv("LICENSE_FILE_PATH")
        self.license_path = Path(license_path) if license_path else Path("license/license.json")

    def reload(self) -> None:
        try:
            payload = self.license_path.read_bytes()
        except FileNotFoundError:
            with self._lock:
                self._data = None
                self._error = "未安装 License"
            return
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self._data = None
                self._error = f"读取 License 文件失败: {exc}"
            return

        try:
            data = self._parse_bytes(payload)
        except LicenseError as exc:
            with self._lock:
                self._data = None
                self._error = str(exc)
            return

        with self._lock:
            self._data = data
            self._error = None

    def status(self) -> Dict[str, Any]:
        with self._lock:
            data = self._data
            error = self._error

        if data is None:
            return {
                "valid": False,
                "reason": error or "未安装 License",
                "product": None,
                "licensee": None,
                "issued_at": None,
                "not_before": None,
                "expires_at": None,
                "features": [],
            }

        now = datetime.now(timezone.utc)
        if data.not_before and now < data.not_before:
            return {
                "valid": False,
                "reason": f"License 尚未生效，将于 {data.not_before.isoformat()} 生效",
                "product": data.product or None,
                "licensee": data.licensee or None,
                "issued_at": data.issued_at,
                "not_before": data.not_before,
                "expires_at": data.expires_at,
                "features": sorted(data.features),
            }
        if now > data.expires_at:
            return {
                "valid": False,
                "reason": f"License 已于 {data.expires_at.isoformat()} 过期",
                "product": data.product or None,
                "licensee": data.licensee or None,
                "issued_at": data.issued_at,
                "not_before": data.not_before,
                "expires_at": data.expires_at,
                "features": sorted(data.features),
            }

        return {
            "valid": True,
            "reason": None,
            "product": data.product or None,
            "licensee": data.licensee or None,
            "issued_at": data.issued_at,
            "not_before": data.not_before,
            "expires_at": data.expires_at,
            "features": sorted(data.features),
        }

    def require(self, features: Iterable[str]) -> None:
        status = self.status()
        if not status["valid"]:
            raise LicenseError(status.get("reason") or "License 未生效")

        available = set(status.get("features") or [])
        missing = sorted({feature for feature in features if feature and feature not in available})
        if missing:
            raise LicenseError(f"当前 License 不包含功能: {', '.join(missing)}")

    def import_bytes(self, payload: bytes) -> Dict[str, Any]:
        data = self._parse_bytes(payload)
        self.license_path.parent.mkdir(parents=True, exist_ok=True)
        self.license_path.write_bytes(payload)
        with self._lock:
            self._data = data
            self._error = None
        return self.status()

    def _parse_bytes(self, payload: bytes) -> LicenseData:
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise LicenseError("License 文件必须为 UTF-8 编码") from exc

        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise LicenseError("License 文件解析失败") from exc

        if not isinstance(data, dict):
            raise LicenseError("License 文件格式无效")

        signature = data.get("signature")
        if not isinstance(signature, str) or not signature.strip():
            raise LicenseError("License 缺少签名")

        secret = os.getenv("LICENSE_SECRET")
        if not secret:
            raise LicenseError("服务器未配置 LICENSE_SECRET，无法验证 License")

        expected = _expected_signature(data, secret)
        if not hmac.compare_digest(signature.strip(), expected):
            raise LicenseError("License 签名校验失败")

        features = data.get("features", [])
        if not isinstance(features, (list, tuple, set)):
            raise LicenseError("License 字段 features 无效")

        licensee = str(data.get("licensee") or "").strip()
        product = str(data.get("product") or "").strip()
        issued_at = _optional_datetime(data.get("issued_at"), field="issued_at")
        not_before = _optional_datetime(data.get("not_before"), field="not_before")
        expires_at = _normalize_datetime(data.get("expires_at"), field="expires_at")
        feature_set = _canonical_features(features)

        now = datetime.now(timezone.utc)
        if not_before and now < not_before:
            raise LicenseError(f"License 尚未生效，将于 {not_before.isoformat()} 生效")
        if now > expires_at:
            raise LicenseError(f"License 已于 {expires_at.isoformat()} 过期")

        return LicenseData(
            licensee=licensee,
            product=product,
            issued_at=issued_at,
            not_before=not_before,
            expires_at=expires_at,
            features=feature_set,
            raw=data,
        )


license_manager = LicenseManager()

