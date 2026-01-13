from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote_plus

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from .license import ensure_license_directory

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
        f"@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DATABASE}?charset=utf8mb4"
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
        connect_args={
            "charset": "utf8mb4",
            "use_unicode": True,
            "init_command": "SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci",
        },
    )

    @event.listens_for(engine, "connect")
    def _set_mysql_charset(dbapi_connection, connection_record) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
            cursor.execute("SET CHARACTER SET utf8mb4")
            cursor.execute("SET character_set_connection=utf8mb4")
        finally:
            cursor.close()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def init_db() -> None:
    """Create database tables if they do not exist."""
    # Late import to avoid circular dependency
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    _ensure_cluster_schema()
    _ensure_inspection_schema()
    _ensure_inspection_runs_schema()
    _ensure_inspection_results_schema()
    _ensure_audit_log_schema()
    _ensure_inspection_agents_schema()


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
    base = Path("data")
    (base / "reports").mkdir(parents=True, exist_ok=True)
    (base / "configs").mkdir(parents=True, exist_ok=True)
    (base / "state").mkdir(parents=True, exist_ok=True)
    ensure_license_directory()


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

    if "description" not in existing_columns:
        column_type = "TEXT" if dialect == "sqlite" else "TEXT"
        statements.append(
            f"ALTER TABLE cluster_configs ADD COLUMN description {column_type} NULL"
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

    if "execution_mode" not in existing_columns:
        column_type = "TEXT" if dialect == "sqlite" else "VARCHAR(20)"
        statements.append(
            f"ALTER TABLE cluster_configs ADD COLUMN execution_mode {column_type} NOT NULL DEFAULT 'agent'"
        )

    if "default_agent_id" not in existing_columns:
        column_type = "INTEGER" if dialect == "sqlite" else "INT"
        statements.append(
            f"ALTER TABLE cluster_configs ADD COLUMN default_agent_id {column_type} NULL"
        )

    if "is_archived" not in existing_columns:
        if dialect == "sqlite":
            statements.append(
                "ALTER TABLE cluster_configs "
                "ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"
            )
        else:
            statements.append(
                "ALTER TABLE cluster_configs "
                "ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0"
            )

    if dialect != "sqlite":
        statements.append(
            "ALTER TABLE cluster_configs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def _ensure_inspection_schema() -> None:
    inspector = inspect(engine)
    if "inspection_items" not in inspector.get_table_names():
        return

    existing_columns = {column["name"] for column in inspector.get_columns("inspection_items")}
    dialect = engine.dialect.name
    statements: list[str] = []
    if dialect != "sqlite":
        unique_index_names: set[str] = set()
        for constraint in inspector.get_unique_constraints("inspection_items"):
            if constraint.get("column_names") == ["name"] and constraint.get("name"):
                unique_index_names.add(constraint["name"])
        for index in inspector.get_indexes("inspection_items"):
            if (
                index.get("unique")
                and index.get("column_names") == ["name"]
                and index.get("name")
            ):
                unique_index_names.add(index["name"])
        for index_name in sorted(unique_index_names):
            statements.append(
                f"ALTER TABLE inspection_items DROP INDEX {index_name}"
            )

    if "config_json" not in existing_columns:
        column_type = "TEXT"
        statements.append(
            f"ALTER TABLE inspection_items ADD COLUMN config_json {column_type} NULL"
        )

    if "prometheus_version" not in existing_columns:
        if dialect == "sqlite":
            statements.append(
                "ALTER TABLE inspection_items "
                "ADD COLUMN prometheus_version TEXT NOT NULL DEFAULT '3.2'"
            )
        else:
            statements.append(
                "ALTER TABLE inspection_items "
                "ADD COLUMN prometheus_version VARCHAR(20) NOT NULL DEFAULT '3.2'"
            )

    if "is_archived" not in existing_columns:
        if dialect == "sqlite":
            statements.append(
                "ALTER TABLE inspection_items ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0"
            )
        else:
            statements.append(
                "ALTER TABLE inspection_items ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0"
            )

    if dialect != "sqlite":
        statements.extend(
            [
                "ALTER TABLE inspection_items CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
                "ALTER TABLE inspection_items MODIFY name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
                "ALTER TABLE inspection_items MODIFY description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL",
                "ALTER TABLE inspection_items MODIFY check_type VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
                "ALTER TABLE inspection_items MODIFY prometheus_version VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '3.2'",
            ]
        )
        if "config_json" in existing_columns:
            statements.append(
                "ALTER TABLE inspection_items MODIFY config_json TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL"
            )
        statements.append(
            "ALTER TABLE inspection_items MODIFY is_archived TINYINT(1) NOT NULL DEFAULT 0"
        )

    if statements:
        with engine.begin() as connection:
            for statement in statements:
                connection.execute(text(statement))

    if dialect == "sqlite":
        if _sqlite_inspection_items_has_unique_name():
            refreshed_columns = {
                column["name"]
                for column in inspect(engine).get_columns("inspection_items")
            }
            _rebuild_sqlite_inspection_items_table(refreshed_columns)
        return

    if not statements:
        return


def _ensure_inspection_runs_schema() -> None:
    inspector = inspect(engine)
    if "inspection_runs" not in inspector.get_table_names():
        return

    existing_columns = {
        column["name"] for column in inspector.get_columns("inspection_runs")
    }
    dialect = engine.dialect.name
    statements: list[str] = []
    updates: list[str] = []

    if "total_items" not in existing_columns:
        column_type = "INTEGER" if dialect == "sqlite" else "INT"
        statements.append(
            f"ALTER TABLE inspection_runs ADD COLUMN total_items {column_type} NOT NULL DEFAULT 0"
        )

    if "processed_items" not in existing_columns:
        column_type = "INTEGER" if dialect == "sqlite" else "INT"
        statements.append(
            f"ALTER TABLE inspection_runs ADD COLUMN processed_items {column_type} NOT NULL DEFAULT 0"
        )
    if "plan_json" not in existing_columns:
        column_type = "TEXT" if dialect == "sqlite" else "TEXT"
        statements.append(
            f"ALTER TABLE inspection_runs ADD COLUMN plan_json {column_type} NULL"
        )
    if "prometheus_version" not in existing_columns:
        if dialect == "sqlite":
            statements.append(
                "ALTER TABLE inspection_runs "
                "ADD COLUMN prometheus_version TEXT NOT NULL DEFAULT '3.2'"
            )
        else:
            statements.append(
                "ALTER TABLE inspection_runs "
                "ADD COLUMN prometheus_version VARCHAR(20) NOT NULL DEFAULT '3.2'"
            )
    if "executor" not in existing_columns:
        column_type = "TEXT" if dialect == "sqlite" else "VARCHAR(20)"
        statements.append(
            f"ALTER TABLE inspection_runs ADD COLUMN executor {column_type} NOT NULL DEFAULT 'server'"
        )
    if "agent_status" not in existing_columns:
        column_type = "TEXT" if dialect == "sqlite" else "VARCHAR(20)"
        statements.append(
            f"ALTER TABLE inspection_runs ADD COLUMN agent_status {column_type} NULL"
        )
    if "agent_id" not in existing_columns:
        column_type = "INTEGER" if dialect == "sqlite" else "INT"
        statements.append(
            f"ALTER TABLE inspection_runs ADD COLUMN agent_id {column_type} NULL"
        )

    if dialect != "sqlite":
        statements.append(
            "ALTER TABLE inspection_runs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
        )

    if "status" in existing_columns:
        updates.extend(
            [
                "UPDATE inspection_runs SET status = 'queued' WHERE status = 'pending'",
                "UPDATE inspection_runs SET status = 'finished' WHERE status = 'completed'",
                "UPDATE inspection_runs SET status = 'failed' WHERE status = 'incomplete'",
            ]
        )
    if "agent_status" in existing_columns:
        updates.extend(
            [
                "UPDATE inspection_runs SET agent_status = 'finished' WHERE agent_status = 'completed'",
                "UPDATE inspection_runs SET agent_status = 'queued' WHERE agent_status = 'pending'",
            ]
        )

    if not statements and not updates:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        for statement in updates:
            connection.execute(text(statement))


def _ensure_inspection_results_schema() -> None:
    inspector = inspect(engine)
    if "inspection_results" not in inspector.get_table_names():
        return

    columns = inspector.get_columns("inspection_results")
    column_names = {column["name"] for column in columns}
    dialect = engine.dialect.name

    # SQLite requires table rebuild when altering column nullability
    if dialect == "sqlite":
        needs_rebuild = (
            "item_name_cached" not in column_names
            or any(
                column["name"] == "item_id" and not column["nullable"]
                for column in columns
            )
        )
        if needs_rebuild:
            _rebuild_sqlite_inspection_results_table(column_names)
        return

    statements: list[str] = []
    item_id_fk = next(
        (
            fk
            for fk in inspector.get_foreign_keys("inspection_results")
            if fk["referred_table"] == "inspection_items"
        ),
        None,
    )
    if item_id_fk and item_id_fk.get("name"):
        statements.append(
            f"ALTER TABLE inspection_results DROP FOREIGN KEY {item_id_fk['name']}"
        )
    if "item_name_cached" not in column_names:
        statements.append(
            "ALTER TABLE inspection_results "
            "ADD COLUMN item_name_cached VARCHAR(100) "
            "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci "
            "NOT NULL DEFAULT ''"
        )
    statements.append(
        "ALTER TABLE inspection_results MODIFY item_id INTEGER NULL"
    )
    statements.append(
        "ALTER TABLE inspection_results "
        "ADD CONSTRAINT fk_inspection_results_item "
        "FOREIGN KEY (item_id) REFERENCES inspection_items(id) ON DELETE SET NULL"
    )
    statements.append(
        "ALTER TABLE inspection_results "
        "CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    )

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
        connection.execute(
            text(
                "UPDATE inspection_results r "
                "LEFT JOIN inspection_items i ON r.item_id = i.id "
                "SET r.item_name_cached = "
                "CASE "
                "WHEN r.item_name_cached IS NOT NULL AND r.item_name_cached <> '' "
                "THEN r.item_name_cached "
                "WHEN i.name IS NOT NULL THEN i.name "
                "ELSE r.item_name_cached "
                "END"
            )
        )

def _sqlite_inspection_items_has_unique_name() -> bool:
    if engine.dialect.name != "sqlite":
        return False
    with engine.begin() as connection:
        indexes = connection.execute(
            text("PRAGMA index_list('inspection_items')")
        ).fetchall()
        for row in indexes:
            mapping = row._mapping if hasattr(row, "_mapping") else row
            index_name = mapping[1]
            is_unique = mapping[2]
            if not is_unique:
                continue
            columns = connection.execute(
                text(f"PRAGMA index_info('{index_name}')")
            ).fetchall()
            column_names = []
            for column in columns:
                column_mapping = (
                    column._mapping if hasattr(column, "_mapping") else column
                )
                column_names.append(column_mapping[2])
            if column_names == ["name"]:
                return True
    return False


def _rebuild_sqlite_inspection_items_table(existing_columns: set[str]) -> None:
    def _column_or_default(column: str, default_sql: str) -> str:
        return column if column in existing_columns else default_sql

    with engine.begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=OFF"))
        connection.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS inspection_items_tmp (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    description TEXT NULL,
                    check_type TEXT NOT NULL DEFAULT 'custom',
                    prometheus_version TEXT NOT NULL DEFAULT '3.2',
                    config_json TEXT NULL,
                    is_archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
        )

        name_expr = _column_or_default("name", "''")
        description_expr = _column_or_default("description", "NULL")
        check_type_expr = _column_or_default("check_type", "'custom'")
        prom_expr = _column_or_default("prometheus_version", "'3.2'")
        config_expr = _column_or_default("config_json", "NULL")
        archived_expr = _column_or_default("is_archived", "0")
        created_expr = _column_or_default("created_at", "CURRENT_TIMESTAMP")
        updated_expr = _column_or_default("updated_at", "CURRENT_TIMESTAMP")

        connection.execute(
            text(
                f"""
                INSERT INTO inspection_items_tmp (
                    id,
                    name,
                    description,
                    check_type,
                    prometheus_version,
                    config_json,
                    is_archived,
                    created_at,
                    updated_at
                )
                SELECT
                    id,
                    {name_expr},
                    {description_expr},
                    {check_type_expr},
                    {prom_expr},
                    {config_expr},
                    {archived_expr},
                    {created_expr},
                    {updated_expr}
                FROM inspection_items
                """
            )
        )
        connection.execute(text("DROP TABLE inspection_items"))
        connection.execute(
            text("ALTER TABLE inspection_items_tmp RENAME TO inspection_items")
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_inspection_items_name "
                "ON inspection_items(name)"
            )
        )
        connection.execute(text("PRAGMA foreign_keys=ON"))


def _rebuild_sqlite_inspection_results_table(existing_columns: set[str]) -> None:
    with engine.begin() as connection:
        connection.execute(text("PRAGMA foreign_keys=OFF"))
        connection.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS inspection_results_tmp (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER NOT NULL,
                    item_id INTEGER NULL,
                    status TEXT NOT NULL,
                    detail TEXT NULL,
                    suggestion TEXT NULL,
                    item_name_cached TEXT NOT NULL DEFAULT '',
                    FOREIGN KEY(run_id) REFERENCES inspection_runs(id) ON DELETE CASCADE,
                    FOREIGN KEY(item_id) REFERENCES inspection_items(id) ON DELETE SET NULL
                )
                """
            )
        )

        if "item_name_cached" in existing_columns:
            name_source = (
                "CASE WHEN r.item_name_cached IS NOT NULL AND r.item_name_cached <> '' "
                "THEN r.item_name_cached "
                "WHEN i.name IS NOT NULL THEN i.name "
                "ELSE '' END"
            )
        else:
            name_source = "COALESCE(i.name, '')"

        connection.execute(
            text(
                f"""
                INSERT INTO inspection_results_tmp (
                    id, run_id, item_id, status, detail, suggestion, item_name_cached
                )
                SELECT
                    r.id,
                    r.run_id,
                    r.item_id,
                    r.status,
                    r.detail,
                    r.suggestion,
                    {name_source}
                FROM inspection_results AS r
                LEFT JOIN inspection_items AS i ON r.item_id = i.id
                """
            )
        )
        connection.execute(text("DROP TABLE inspection_results"))
        connection.execute(
            text("ALTER TABLE inspection_results_tmp RENAME TO inspection_results")
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_inspection_results_run_id "
                "ON inspection_results(run_id)"
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS idx_inspection_results_item_id "
                "ON inspection_results(item_id)"
            )
        )
        connection.execute(text("PRAGMA foreign_keys=ON"))

def _ensure_audit_log_schema() -> None:
    inspector = inspect(engine)
    if "audit_logs" not in inspector.get_table_names():
        return

    dialect = engine.dialect.name
    if dialect == "sqlite":
        return

    statements = [
        "ALTER TABLE audit_logs CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
        "ALTER TABLE audit_logs MODIFY action VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
        "ALTER TABLE audit_logs MODIFY entity_type VARCHAR(50) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
        "ALTER TABLE audit_logs MODIFY description TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL",
    ]

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))


def _ensure_inspection_agents_schema() -> None:
    inspector = inspect(engine)
    if "inspection_agents" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("inspection_agents")}
    dialect = engine.dialect.name
    statements: list[str] = []

    if "prometheus_url" not in columns:
        column_type = "TEXT" if dialect == "sqlite" else "VARCHAR(255)"
        statements.append(
            f"ALTER TABLE inspection_agents ADD COLUMN prometheus_url {column_type} NULL"
        )
    if "nodes_output" not in columns:
        column_type = "TEXT" if dialect == "sqlite" else "TEXT"
        statements.append(
            f"ALTER TABLE inspection_agents ADD COLUMN nodes_output {column_type} NULL"
        )
    if "nodes_output_at" not in columns:
        column_type = "DATETIME" if dialect == "sqlite" else "DATETIME"
        statements.append(
            f"ALTER TABLE inspection_agents ADD COLUMN nodes_output_at {column_type} NULL"
        )
    if "nodes_report_requested_at" not in columns:
        column_type = "DATETIME" if dialect == "sqlite" else "DATETIME"
        statements.append(
            f"ALTER TABLE inspection_agents ADD COLUMN nodes_report_requested_at {column_type} NULL"
        )

    if dialect != "sqlite":
        statements.extend(
            [
                "ALTER TABLE inspection_agents CONVERT TO CHARACTER SET utf8mb4 "
                "COLLATE utf8mb4_unicode_ci",
                "ALTER TABLE inspection_agents MODIFY name VARCHAR(100) "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
                "ALTER TABLE inspection_agents MODIFY token VARCHAR(64) "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL",
                "ALTER TABLE inspection_agents MODIFY description TEXT "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL",
                "ALTER TABLE inspection_agents MODIFY prometheus_url VARCHAR(255) "
                "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL",
            ]
        )

    if not statements:
        return

    with engine.begin() as connection:
        for statement in statements:
            connection.execute(text(statement))
