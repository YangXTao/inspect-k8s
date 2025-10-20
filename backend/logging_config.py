from __future__ import annotations

import logging
from logging.config import dictConfig
from typing import Any, Dict
from datetime import datetime

try:
  from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python <3.9 fallback
  from backports.zoneinfo import ZoneInfo  # type: ignore


class BeijingTimeFormatter(logging.Formatter):
  """Logging formatter that renders timestamps in Asia/Shanghai time."""

  def formatTime(self, record: logging.LogRecord, datefmt: str | None = None) -> str:  # noqa: N802
    dt = datetime.fromtimestamp(record.created, ZoneInfo("Asia/Shanghai"))
    if datefmt:
      return dt.strftime(datefmt)
    return dt.isoformat(timespec="seconds")


def _build_config() -> Dict[str, Any]:
  formatter = {
    "format": "[%(asctime)s] %(levelname)s %(name)s: %(message)s",
    "datefmt": "%Y-%m-%d %H:%M:%S",
    "()": BeijingTimeFormatter,
  }

  return {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
      "beijing": formatter,
    },
    "handlers": {
      "default": {
        "formatter": "beijing",
        "class": "logging.StreamHandler",
      },
      "uvicorn.access": {
        "formatter": "beijing",
        "class": "logging.StreamHandler",
      },
    },
    "loggers": {
      "": {"handlers": ["default"], "level": "INFO"},
      "uvicorn": {"handlers": ["default"], "level": "INFO", "propagate": False},
      "uvicorn.error": {
        "handlers": ["default"],
        "level": "INFO",
        "propagate": False,
      },
      "uvicorn.access": {
        "handlers": ["uvicorn.access"],
        "level": "INFO",
        "propagate": False,
      },
    },
  }


def configure_logging() -> None:
  """Apply the Beijing-time logging configuration once."""
  dictConfig(_build_config())
