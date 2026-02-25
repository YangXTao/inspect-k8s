import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timedelta
from typing import Iterable, Optional, Tuple

from sqlalchemy.orm import Session

from . import models

AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "inspect_session")
# 默认 24 小时，满足“长时间不操作 24 小时自动登出”
SESSION_TTL_HOURS = int(os.getenv("AUTH_SESSION_TTL_HOURS", "24"))
SESSION_IDLE_TIMEOUT_SECONDS = int(
    os.getenv("AUTH_SESSION_IDLE_TIMEOUT_SECONDS", str(24 * 3600))
)
COOKIE_SAMESITE = os.getenv("AUTH_COOKIE_SAMESITE", "lax").lower()
COOKIE_SECURE = os.getenv("AUTH_COOKIE_SECURE", "false").lower() in {
    "1",
    "true",
    "yes",
}
PASSWORD_ITERATIONS = int(os.getenv("AUTH_PASSWORD_ITERATIONS", "120000"))
PASSWORD_SALT_BYTES = 16
AUTH_CHALLENGE_TTL_SECONDS = int(os.getenv("AUTH_CHALLENGE_TTL_SECONDS", "300"))
AUTH_NONCE_SECRET = os.getenv("AUTH_NONCE_SECRET")
AUTH_NONCE_SECRET_BYTES = (
    AUTH_NONCE_SECRET.encode("utf-8")
    if AUTH_NONCE_SECRET
    else secrets.token_bytes(32)
)

KNOWN_PERMISSIONS = {
    "schedule.read",
    "schedule.create",
    "schedule.update",
    "schedule.delete",
    "history.read",
    "history.create",
    "history.update",
    "history.delete",
    "license.view",
    "license.upload",
    "prometheus.read",
    "prometheus.create",
    "prometheus.update",
    "prometheus.delete",
    "inspectionItem.read",
    "inspectionItem.create",
    "inspectionItem.update",
    "inspectionItem.delete",
    "role.read",
    "role.create",
    "role.update",
    "role.delete",
    "user.read",
    "user.create",
    "user.update",
    "user.delete",
    "clusterAgent.read",
    "clusterAgent.test",
    "clusterAgent.create",
    "clusterAgent.update",
    "clusterAgent.delete",
    "runRecord.read",
    "runRecord.delete",
    "result.read",
    "result.delete",
    "report.read",
    "report.delete",
    "audit.read",
    "system.read",
    "system.update",
}

READ_ONLY_PERMISSIONS = {
    "schedule.read",
    "history.read",
    "license.view",
    "prometheus.read",
    "inspectionItem.read",
    "role.read",
    "user.read",
    "clusterAgent.read",
    "runRecord.read",
    "result.read",
}


def hash_password(password: str, salt: Optional[str] = None) -> str:
    if salt is None:
        salt_bytes = secrets.token_bytes(PASSWORD_SALT_BYTES)
        salt = salt_bytes.hex()
    else:
        try:
            salt_bytes = bytes.fromhex(salt)
        except ValueError:
            salt_bytes = salt.encode("utf-8")
            salt = salt_bytes.hex()
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_bytes,
        PASSWORD_ITERATIONS,
    )
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iterations_text, salt, expected = encoded.split("$", 3)
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    try:
        iterations = int(iterations_text)
    except ValueError:
        return False
    try:
        salt_bytes = bytes.fromhex(salt)
    except ValueError:
        return False
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt_bytes,
        iterations,
    ).hex()
    return hmac.compare_digest(digest, expected)


def parse_password_hash(encoded: str) -> Optional[Tuple[int, str, bytes]]:
    try:
        algo, iterations_text, salt, digest_hex = encoded.split("$", 3)
    except ValueError:
        return None
    if algo != "pbkdf2_sha256":
        return None
    try:
        iterations = int(iterations_text)
        digest_bytes = bytes.fromhex(digest_hex)
    except ValueError:
        return None
    return iterations, salt, digest_bytes


def build_login_challenge(username: str) -> str:
    issued_at = int(time.time())
    nonce = secrets.token_urlsafe(16)
    payload = f"{issued_at}.{nonce}.{username}"
    signature = hmac.new(
        AUTH_NONCE_SECRET_BYTES, payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return f"{issued_at}.{nonce}.{signature}"


def verify_login_challenge(username: str, token: str) -> bool:
    try:
        issued_at_text, nonce, signature = token.split(".", 2)
        issued_at = int(issued_at_text)
    except ValueError:
        return False
    now = int(time.time())
    if abs(now - issued_at) > AUTH_CHALLENGE_TTL_SECONDS:
        return False
    payload = f"{issued_at}.{nonce}.{username}"
    expected = hmac.new(
        AUTH_NONCE_SECRET_BYTES, payload.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def verify_login_proof(
    username: str, token: str, proof_b64: str, password_hash: str
) -> bool:
    if not verify_login_challenge(username, token):
        return False
    parsed = parse_password_hash(password_hash)
    if not parsed:
        return False
    _, _, digest_bytes = parsed
    try:
        proof_bytes = base64.b64decode(proof_b64, validate=True)
    except (binascii.Error, ValueError):
        return False
    expected = hmac.new(
        digest_bytes, token.encode("utf-8"), hashlib.sha256
    ).digest()
    return hmac.compare_digest(expected, proof_bytes)


def ensure_default_admin(db: Session) -> None:
    existing = db.query(models.AuthUser.id).limit(1).first()
    if existing:
        return
    user = models.AuthUser(
        username="admin",
        display_name="admin",
        password_hash=hash_password("admin"),
        role="admin",
        roles_json=json.dumps(["admin"], ensure_ascii=True),
        is_active=True,
        auth_provider="local",
    )
    db.add(user)
    db.commit()


def _parse_permissions(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    normalized: list[str] = []
    for value in payload:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed != "*" and trimmed not in KNOWN_PERMISSIONS:
            continue
        normalized.append(trimmed)
    return sorted(set(normalized))


def _parse_roles(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        payload = json.loads(raw)
    except Exception:
        return []
    if not isinstance(payload, list):
        return []
    normalized: list[str] = []
    for value in payload:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if not trimmed:
            continue
        normalized.append(trimmed)
    return sorted(set(normalized))


def _dump_permissions(permissions: Iterable[str]) -> str:
    normalized: list[str] = []
    for value in permissions:
        if not isinstance(value, str):
            continue
        trimmed = value.strip()
        if not trimmed:
            continue
        if trimmed != "*" and trimmed not in KNOWN_PERMISSIONS:
            continue
        normalized.append(trimmed)
    unique = sorted(set(normalized))
    return json.dumps(unique, ensure_ascii=True)


def normalize_permissions(permissions: Iterable[str]) -> list[str]:
    return _parse_permissions(_dump_permissions(permissions))


def parse_permissions_json(raw: str | None) -> list[str]:
    return _parse_permissions(raw)


def ensure_default_roles(db: Session) -> None:
    defaults = [
        {
            "name": "admin",
            "display_name": "管理员",
            "description": "拥有全部权限。",
            "permissions": ["*"],
            "is_system": True,
        },
        {
            "name": "inspector",
            "display_name": "运维巡检人员",
            "description": "可管理巡检任务与查看巡检结果。",
            "permissions": sorted(
                {
                    "schedule.read",
                    "schedule.create",
                    "schedule.update",
                    "schedule.delete",
                    "history.read",
                    "history.create",
                    "history.update",
                    "history.delete",
                    "license.view",
                    "inspectionItem.create",
                    "inspectionItem.update",
                    "inspectionItem.delete",
                    "inspectionItem.read",
                    "clusterAgent.read",
                    "clusterAgent.test",
                    "runRecord.read",
                    "runRecord.delete",
                    "result.read",
                    "report.read",
                    "report.delete",
                }
            ),
            "is_system": True,
        },
        {
            "name": "readonly",
            "display_name": "只读管理员",
            "description": "仅可查看数据，不允许新增、修改或删除。",
            "permissions": sorted(READ_ONLY_PERMISSIONS),
            "is_system": True,
        },
    ]
    for payload in defaults:
        role = (
            db.query(models.AuthRole)
            .filter(models.AuthRole.name == payload["name"])
            .first()
        )
        if role:
            role.display_name = payload["display_name"]
            role.description = payload["description"]
            role.permissions_json = _dump_permissions(payload["permissions"])
            role.is_system = True
            db.add(role)
            continue
        role = models.AuthRole(
            name=payload["name"],
            display_name=payload["display_name"],
            description=payload["description"],
            permissions_json=_dump_permissions(payload["permissions"]),
            is_system=True,
        )
        db.add(role)
    db.commit()


def get_role_permissions(db: Session, role_name: str | None) -> set[str]:
    if not role_name:
        return set()
    role = (
        db.query(models.AuthRole)
        .filter(models.AuthRole.name == role_name)
        .first()
    )
    if not role and role_name == "admin":
        return {"*"}
    if not role:
        return set()
    return set(_parse_permissions(role.permissions_json))


def get_user_role_names(user: models.AuthUser) -> list[str]:
    roles = _parse_roles(user.roles_json)
    if roles:
        return roles
    if user.role:
        return [user.role]
    return []


def get_user_permissions(db: Session, user: models.AuthUser) -> list[str]:
    permissions: set[str] = set()
    for role_name in get_user_role_names(user):
        permissions |= get_role_permissions(db, role_name)
    if "*" in permissions:
        return sorted(KNOWN_PERMISSIONS | {"*"})
    return sorted(permissions)


def user_has_permission(
    db: Session, user: models.AuthUser, permission: str
) -> bool:
    permissions: set[str] = set()
    for role_name in get_user_role_names(user):
        permissions |= get_role_permissions(db, role_name)
    if "*" in permissions:
        return True
    return permission in permissions


def user_has_any_permission(
    db: Session, user: models.AuthUser, permissions: Iterable[str]
) -> bool:
    perms: set[str] = set()
    for role_name in get_user_role_names(user):
        perms |= get_role_permissions(db, role_name)
    if "*" in perms:
        return True
    for permission in permissions:
        if permission in perms:
            return True
    return False


def create_session(db: Session, user: models.AuthUser) -> models.AuthSession:
    session_id = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(seconds=SESSION_IDLE_TIMEOUT_SECONDS)
    session = models.AuthSession(
        id=session_id,
        user_id=user.id,
        expires_at=expires_at,
    )
    db.add(session)
    return session


def get_user_from_session(
    db: Session, session_id: Optional[str]
) -> Optional[models.AuthUser]:
    if not session_id:
        return None
    session = (
        db.query(models.AuthSession)
        .filter(models.AuthSession.id == session_id)
        .first()
    )
    if not session:
        return None
    now = datetime.utcnow()
    idle_seconds = SESSION_IDLE_TIMEOUT_SECONDS
    last_seen = session.last_seen_at or session.created_at or session.expires_at
    if session.expires_at <= now or (now - last_seen).total_seconds() > idle_seconds:
        db.delete(session)
        db.commit()
        return None
    user = session.user
    if not user or not user.is_active:
        return None
    if (
        session.last_seen_at is None
        or (now - session.last_seen_at).total_seconds() > 300
    ):
        session.last_seen_at = now
        # 滑动过期：有操作则刷新过期时间
        session.expires_at = now + timedelta(seconds=idle_seconds)
        db.add(session)
        db.commit()
    # 避免会话关闭后访问用户字段触发 DetachedInstanceError
    try:
        db.refresh(user)
    except Exception:
        pass
    db.expunge(user)
    return user
