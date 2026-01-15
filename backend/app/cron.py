from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Tuple


class CronValidationError(ValueError):
    pass


@dataclass(frozen=True)
class CronField:
    values: set[int]
    any: bool


@dataclass(frozen=True)
class ParsedCron:
    minute: CronField
    hour: CronField
    day: CronField
    month: CronField
    week: CronField


def _parse_int(value: str, field: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise CronValidationError(f"{field} contains invalid number '{value}'.") from exc


def _normalize_weekday(value: int) -> int:
    return 0 if value == 7 else value


def _parse_range(
    start: int,
    end: int,
    min_value: int,
    max_value: int,
    field: str,
    *,
    allow_sunday: bool,
) -> list[int]:
    if start > end:
        raise CronValidationError(f"{field} range {start}-{end} is invalid.")
    if start < min_value or end > max_value:
        raise CronValidationError(
            f"{field} range {start}-{end} out of bounds ({min_value}-{max_value})."
        )
    values = list(range(start, end + 1))
    if allow_sunday:
        values = [_normalize_weekday(value) for value in values]
    return values


def _parse_segment(
    segment: str,
    min_value: int,
    max_value: int,
    field: str,
    *,
    allow_sunday: bool,
) -> list[int]:
    if segment == "*":
        return list(range(min_value, max_value + 1))
    if "/" in segment:
        base, step_raw = segment.split("/", 1)
        step = _parse_int(step_raw, field)
        if step <= 0:
            raise CronValidationError(f"{field} step must be positive.")
        base = base or "*"
        if base == "*":
            start, end = min_value, max_value
        elif "-" in base:
            start_raw, end_raw = base.split("-", 1)
            start = _parse_int(start_raw, field)
            end = _parse_int(end_raw, field)
        else:
            start = _parse_int(base, field)
            end = start
        values = _parse_range(
            start, end, min_value, max_value, field, allow_sunday=allow_sunday
        )
        return values[::step]
    if "-" in segment:
        start_raw, end_raw = segment.split("-", 1)
        start = _parse_int(start_raw, field)
        end = _parse_int(end_raw, field)
        return _parse_range(
            start, end, min_value, max_value, field, allow_sunday=allow_sunday
        )
    value = _parse_int(segment, field)
    if value < min_value or value > max_value:
        raise CronValidationError(
            f"{field} value {value} out of bounds ({min_value}-{max_value})."
        )
    if allow_sunday:
        value = _normalize_weekday(value)
    return [value]


def _parse_field(
    raw: str,
    min_value: int,
    max_value: int,
    field: str,
    *,
    allow_sunday: bool = False,
) -> CronField:
    raw = raw.strip()
    if not raw:
        raise CronValidationError(f"{field} is empty.")
    values: set[int] = set()
    for part in raw.split(","):
        part = part.strip()
        if not part:
            raise CronValidationError(f"{field} contains empty segment.")
        values.update(
            _parse_segment(
                part,
                min_value,
                max_value,
                field,
                allow_sunday=allow_sunday,
            )
        )
    if not values:
        raise CronValidationError(f"{field} did not resolve to any values.")
    full_range = set(range(min_value, max_value + 1))
    if allow_sunday:
        full_range = {_normalize_weekday(value) for value in full_range}
    return CronField(values=values, any=values == full_range)


def parse_cron_expression(expression: str) -> ParsedCron:
    raw = (expression or "").strip()
    fields = raw.split()
    if len(fields) != 5:
        raise CronValidationError("Cron expression must contain 5 fields.")
    minute_raw, hour_raw, day_raw, month_raw, week_raw = fields
    return ParsedCron(
        minute=_parse_field(minute_raw, 0, 59, "minute"),
        hour=_parse_field(hour_raw, 0, 23, "hour"),
        day=_parse_field(day_raw, 1, 31, "day"),
        month=_parse_field(month_raw, 1, 12, "month"),
        week=_parse_field(week_raw, 0, 7, "week", allow_sunday=True),
    )


def cron_matches(expression: str, moment: datetime) -> bool:
    parsed = parse_cron_expression(expression)
    if moment.minute not in parsed.minute.values:
        return False
    if moment.hour not in parsed.hour.values:
        return False
    if moment.month not in parsed.month.values:
        return False

    day_match = moment.day in parsed.day.values
    cron_weekday = (moment.weekday() + 1) % 7
    week_match = cron_weekday in parsed.week.values

    if parsed.day.any and parsed.week.any:
        return True
    if parsed.day.any:
        return week_match
    if parsed.week.any:
        return day_match
    return day_match or week_match


def normalize_cron_expression(expression: str) -> str:
    parsed = parse_cron_expression(expression)
    fields: Iterable[Tuple[str, CronField]] = (
        ("minute", parsed.minute),
        ("hour", parsed.hour),
        ("day", parsed.day),
        ("month", parsed.month),
        ("week", parsed.week),
    )
    normalized = []
    for name, field in fields:
        values = sorted(field.values)
        if field.any:
            normalized.append("*")
            continue
        if len(values) == 1:
            normalized.append(str(values[0]))
            continue
        normalized.append(",".join(str(value) for value in values))
    return " ".join(normalized)
