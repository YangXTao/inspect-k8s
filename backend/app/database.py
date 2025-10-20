from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote_plus

from sqlalchemy import create_engine, text, inspect
from sqlalchemy.orm import declarative_base, sessionmaker, Session

DEFAULT_DATABASE_URL = "sqlite:///./inspection.db"

MYSQL_HOST = os.getenv("MYSQL_HOST")
MYSQL_USER = os.getenv("MYSQL_USER")
MYSQL_PASSWORD = os.getenv("MYSQL_PASSWORD")
MYSQL_DATABASE = os.getenv("MYSQL_DATABASE")
MYSQL_PORT = os.getenv("MYSQL_PORT", "3306")

if all([MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE]):
    encoded_password = quote_plus(MYSQL_PASSWORD)
    DATABASE_URL = (
        f"mysql+pymysql://{MYSQL_USER}:{encoded_password}"
        f"@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DATABASE}"
    )
else:
    DATABASE_URL = DEFAULT_DATABASE_URL

if DATABASE_URL.startswith("sqlite"):
    engine = create_engine(
        DATABASE_URL,
        connect_args={"check_same_thread": False},
    )
else:
    engine = create_engine(
        DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=1800,
    )
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def init_db() -> None:
    """Create database tables if they do not exist."""
    # Late import to avoid circular dependency
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_cluster_schema()


@contextmanager
def get_session() -> Session:
    """Yield a database session and guarantee closure."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_runtime_directories() -> None:
    """Ensure directories for storing generated assets exist."""
    Path("reports").mkdir(exist_ok=True)
    Path("configs").mkdir(exist_ok=True)


def _ensure_cluster_schema() -> None:
    """Ensure new cluster columns exist without requiring manual migration."""
    inspector = inspect(engine)
    if "cluster_configs" not in inspector.get_table_names():
        return

    existing_columns = {
        column["name"] for column in inspector.get_columns("cluster_configs")
    }

    statements = []
    dialect = engine.dialect.name

    if "connection_status" not in existing_columns:
        if dialect == "sqlite":
            statements.append(
                "ALTER TABLE cluster_configs "
                "ADD COLUMN connection_status TEXT DEFAULT 'unknown'"
            )
        else:
            statements.append(
                "ALTER TABLE cluster_configs "
                "ADD COLUMN connection_status VARCHAR(20) NOT NULL DEFAULT 'unknown'"
            )

    if "connection_message" not in existing_columns:
        column_type = "TEXT" if dialect == "sqlite" else "TEXT"
        statements.append(
            f"ALTER TABLE cluster_configs ADD COLUMN connection_message {column_type} NULL"
        )

    if "last_checked_at" not in existing_columns:
        if dialect == "sqlite":
            statements.append(
                "ALTER TABLE cluster_configs ADD COLUMN last_checked_at TEXT NULL"
            )
        else:
            statements.append(
                "ALTER TABLE cluster_configs ADD COLUMN last_checked_at DATETIME NULL"
            )

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
