from __future__ import annotations

from dataclasses import dataclass
from contextvars import ContextVar, Token
from typing import Optional


@dataclass(frozen=True)
class AuditActor:
    user_id: Optional[int]
    username: Optional[str]
    ip_address: Optional[str]
    user_agent: Optional[str]


_AUDIT_CONTEXT: ContextVar[Optional[AuditActor]] = ContextVar(
    "audit_context", default=None
)


def set_audit_actor(actor: Optional[AuditActor]) -> Token:
    return _AUDIT_CONTEXT.set(actor)


def reset_audit_actor(token: Token) -> None:
    _AUDIT_CONTEXT.reset(token)


def get_audit_actor() -> Optional[AuditActor]:
    return _AUDIT_CONTEXT.get()
