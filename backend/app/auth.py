import base64
import binascii
import hashlib
import hmac
import os
import secrets
import time
from datetime import datetime, timedelta
from typing import Optional, Tuple

from sqlalchemy.orm import Session

from . import models

AUTH_COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "inspect_session")
SESSION_TTL_HOURS = int(os.getenv("AUTH_SESSION_TTL_HOURS", "168"))
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
        is_active=True,
        auth_provider="local",
    )
    db.add(user)
    db.commit()


def create_session(db: Session, user: models.AuthUser) -> models.AuthSession:
    session_id = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(hours=SESSION_TTL_HOURS)
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
    if session.expires_at <= now:
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
        db.add(session)
        db.commit()
    return user
