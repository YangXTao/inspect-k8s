from __future__ import annotations

import os
import re
from datetime import datetime, timezone, timedelta
try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # type: ignore
from pathlib import Path
from typing import Iterable, Optional, Tuple

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
    LongTable,
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from xml.sax.saxutils import escape

from .crud import CONNECTION_TEST_OPERATOR, SCHEDULED_AUDIT_SUFFIX
from .models import InspectionResult, InspectionRun
from .schemas import _extract_connection_meta

REPORTS_ROOT = Path("data/reports")
PDF_REPORTS_DIR = REPORTS_ROOT / "pdf"
MARKDOWN_REPORTS_DIR = REPORTS_ROOT / "md"


def _to_base36(value: int) -> str:
    if value == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    result = ""
    while value:
        value, rem = divmod(value, 36)
        result = digits[rem] + result
    return result


def _parse_certificate_detail(
    text: str | None,
) -> Optional[tuple[list[str], list[list[str]]]]:
    if not text:
        return None
    raw = str(text).strip()
    if not raw:
        return None
    lines = [
        line.strip()
        for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        if line.strip()
    ]
    if len(lines) < 2:
        return None
    header_line = lines[0]
    has_name_column = "证书名称" in header_line and "过期时间" in header_line
    has_two_columns = "组件" in header_line and (
        "过期时间" in header_line or "证书过期时间" in header_line
    )
    if not has_name_column and not has_two_columns:
        return None
    rows: list[list[str]] = []
    for line in lines[1:]:
        tokens = [token for token in line.split() if token]
        if len(tokens) < 3:
            continue
        if has_two_columns and not has_name_column:
            rows.append([tokens[0], " ".join(tokens[1:])])
            continue
        date_tokens: list[str] = []
        last_token = tokens[-1]
        if len(tokens) >= 5 and last_token in {"GMT", "UTC"}:
            date_tokens = tokens[-5:]
        elif re.match(r"\d{4}-\d{2}-\d{2}", last_token):
            date_tokens = tokens[-1:]
        else:
            date_tokens = tokens[-3:]
        name_tokens = tokens[1 : len(tokens) - len(date_tokens)]
        if not name_tokens:
            continue
        rows.append([tokens[0], " ".join(name_tokens), " ".join(date_tokens)])
    if not rows:
        return None
    headers = ["组件", "证书名称", "过期时间"] if has_name_column else ["组件", "过期时间"]
    return (headers, rows)


def _hash_cluster_slug(seed: str) -> str:
    encoded = seed.encode("utf-16-le")
    hash_value = 0
    for index in range(0, len(encoded), 2):
        code_unit = encoded[index] | (encoded[index + 1] << 8)
        hash_value = (hash_value * 33 + code_unit) & 0xFFFFFFFF
        if hash_value & 0x80000000:
            hash_value -= 0x100000000
    base36 = _to_base36(abs(hash_value)).upper()
    return base36[-4:].rjust(4, "0")


def _build_cluster_slug(cluster_id: Optional[int], cluster_name: Optional[str]) -> str:
    if cluster_id is None:
        return "C-0000"
    seed = f"{cluster_id}:{cluster_name or ''}"
    return f"C-{_hash_cluster_slug(seed)}"


def _get_report_dir_for_run(run: InspectionRun, base_dir: Path) -> Path:
    cluster = getattr(run, "cluster", None)
    cluster_id = getattr(cluster, "id", None) or getattr(run, "cluster_id", None)
    cluster_name = getattr(cluster, "name", None) or getattr(run, "cluster_name", None)
    return base_dir / _build_cluster_slug(cluster_id, cluster_name)


def get_cluster_report_dirs(
    cluster_id: Optional[int], cluster_name: Optional[str]
) -> tuple[Path, Path]:
    slug = _build_cluster_slug(cluster_id, cluster_name)
    return (PDF_REPORTS_DIR / slug, MARKDOWN_REPORTS_DIR / slug)


def _prepare_output_path(default_dir: Path, filename: str, output_path: Optional[Path | str] = None) -> Path:
    if output_path is None:
        default_dir.mkdir(parents=True, exist_ok=True)
        candidate = default_dir / filename
        if not candidate.exists():
            return candidate
        stem = candidate.stem
        suffix = candidate.suffix
        for index in range(1, 1000):
            unique_path = candidate.with_name(f"{stem}-{index}{suffix}")
            if not unique_path.exists():
                return unique_path
        return candidate
    path = Path(output_path)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _resolve_cst_timezone() -> timezone:
    if ZoneInfo is not None:
        try:
            return ZoneInfo("Asia/Shanghai")  # type: ignore[arg-type]
        except Exception:
            pass
    return timezone(timedelta(hours=8))


def _format_dt(value: Optional[datetime]) -> str:
    if value is None:
        return "未记录"
    tz = _resolve_cst_timezone()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    localized = value.astimezone(tz)
    return f"{localized.strftime('%Y-%m-%d %H:%M:%S')} 中国标准时间"


def _build_report_basename(display_id: Optional[str], run_id: int) -> str:
    if display_id:
        return re.sub(r"[^A-Za-z0-9._-]", "-", display_id).strip("-_") or f"inspection-run-{run_id}"
    return f"inspection-run-{run_id}"


def _get_cluster_meta(run: InspectionRun) -> Tuple[str, str, str]:
    cluster = getattr(run, "cluster", None)
    cluster_name = getattr(cluster, "name", None) or "未知集群"
    connection_message = getattr(cluster, "connection_message", None)
    version, node_count = _extract_connection_meta(connection_message)
    version_label = version or "未知"
    node_count_label = str(node_count) if node_count is not None else "未知"
    return cluster_name, version_label, node_count_label


def _get_rancher_meta(run: InspectionRun) -> Tuple[Optional[str], Optional[str]]:
    cluster = getattr(run, "cluster", None)
    if not cluster or not getattr(cluster, "is_rancher_local", False):
        return None, None
    rancher_version = getattr(cluster, "rancher_version", None)
    rancher_count = getattr(cluster, "rancher_cluster_count", None)
    version_label = rancher_version or "未知"
    count_label = str(rancher_count) if rancher_count is not None else "未知"
    return version_label, count_label


def _resolve_run_type_label(operator: Optional[str]) -> str:
    trimmed = (operator or "").strip()
    if not trimmed:
        return "手动"
    if trimmed == CONNECTION_TEST_OPERATOR:
        return "系统校验"
    if trimmed.endswith(SCHEDULED_AUDIT_SUFFIX):
        return "定时"
    return "手动"


def generate_markdown_report(
    *,
    run: InspectionRun,
    results: Iterable[InspectionResult],
    display_id: Optional[str] = None,
    output_path: Optional[Path | str] = None,
) -> str:
    safe_name = _build_report_basename(display_id, run.id)
    report_dir = _get_report_dir_for_run(run, MARKDOWN_REPORTS_DIR)
    path = _prepare_output_path(report_dir, f"{safe_name}.md", output_path)

    results_list = list(results)
    cluster_name, version_label, node_count_label = _get_cluster_meta(run)
    cluster = getattr(run, "cluster", None)
    cluster_id = getattr(cluster, "id", None) or getattr(run, "cluster_id", None)
    cluster_display_id = (
        _build_cluster_slug(cluster_id, cluster_name)
        if cluster_id is not None
        else None
    )
    cluster_label = (
        f"{cluster_name} ({cluster_display_id})"
        if cluster_display_id
        else cluster_name
    )

    total_checks = len(results_list)
    passed_count = sum(1 for item in results_list if item.status.lower() == "passed")
    warning_count = sum(1 for item in results_list if item.status.lower() == "warning")
    critical_count = sum(1 for item in results_list if item.status.lower() == "critical")
    failed_count = sum(1 for item in results_list if item.status.lower() == "failed")

    def _sanitize(text: str | None) -> str:
        if not text:
            return "-"
        return (
            str(text)
            .replace("|", r"\|")
            .replace("\r\n", "<br/>")
            .replace("\n", "<br/>")
            .strip()
        )

    def _format_detail(text: str | None) -> str:
        parsed = _parse_certificate_detail(text)
        if not parsed:
            return _sanitize(text)
        headers, rows = parsed
        header_html = "".join(f"<th>{escape(header)}</th>" for header in headers)
        body_html = "".join(
            "<tr>"
            + "".join(f"<td>{escape(cell)}</td>" for cell in row)
            + "</tr>"
            for row in rows
        )
        return f"<table><thead><tr>{header_html}</tr></thead><tbody>{body_html}</tbody></table>"

    display_label = str(display_id or run.id)
    lines: list[str] = []
    lines.append(f"# {cluster_name} 巡检报告")
    lines.append("")
    lines.append("| 项目 | 内容 |")
    lines.append("| --- | --- |")
    lines.append(f"| 巡检编号 | {display_label} |")
    lines.append(f"| 巡检类型 | {_resolve_run_type_label(run.operator)} |")
    lines.append(f"| 目标集群 | {cluster_label} |")
    lines.append(f"| 集群版本 | {version_label} |")
    lines.append(f"| 节点数量 | {node_count_label} |")
    rancher_version_label, rancher_count_label = _get_rancher_meta(run)
    if rancher_version_label is not None:
        lines.append(f"| Rancher 版本 | {rancher_version_label} |")
    lines.append(f"| 巡检开始时间 | {_format_dt(run.created_at)} |")
    lines.append(f"| 巡检完成时间 | {_format_dt(run.completed_at or datetime.utcnow())} |")
    lines.append("")

    lines.append("## 巡检概览")
    lines.append("")
    lines.append("| 项目 | 数量 |")
    lines.append("| --- | --- |")
    lines.append(f"| 检查项总数 | {total_checks} |")
    lines.append(f"| 通过 | {passed_count} |")
    lines.append(f"| 告警 | {warning_count} |")
    lines.append(f"| 严重 | {critical_count} |")
    lines.append(f"| 失败 | {failed_count} |")
    lines.append("")

    summary_text = (run.summary or "").strip() or "暂无摘要"
    lines.append("## 巡检摘要")
    lines.append("")
    lines.append(summary_text.replace("\r\n", "\n"))
    lines.append("")

    lines.append("## 巡检明细")
    lines.append("")
    lines.append("| 检查项 | 状态 | 详情 | 建议 |")
    lines.append("| --- | --- | --- | --- |")
    status_labels = {
        "passed": "通过",
        "warning": "告警",
        "critical": "严重",
        "failed": "失败",
    }
    for item in results_list:
        status = item.status.lower()
        status_label = status_labels.get(status, item.status)
        item_name = _sanitize(item.item.name if item.item else item.item_name_cached or "巡检项已删除")
        detail = _format_detail(item.detail)
        suggestion = _sanitize(item.suggestion)
        lines.append(f"| {item_name} | {status_label} | {detail} | {suggestion} |")

    content = "\n".join(lines).strip() + "\n"
    path.write_text(content, encoding="utf-8")
    return str(path)

def generate_pdf_report(
    *,
    run: InspectionRun,
    results: Iterable[InspectionResult],
    logo_path: str | None = None,
    display_id: str | None = None,
) -> str:
    """Generate a nicely formatted PDF inspection report and return the path."""
    safe_name = _build_report_basename(display_id, run.id)
    report_dir = _get_report_dir_for_run(run, PDF_REPORTS_DIR)
    report_path = _prepare_output_path(report_dir, f"{safe_name}.pdf")

    def _register_font_family() -> str:
        """Register a modern Sans Serif font with CJK support if available."""
        env_font_path = os.getenv("PDF_REPORT_FONT_PATH")
        env_font_name = os.getenv("PDF_REPORT_FONT_NAME")
        if env_font_path:
            font_path = Path(env_font_path)
            if font_path.exists():
                font_name = env_font_name or font_path.stem
                try:
                    pdfmetrics.registerFont(TTFont(font_name, str(font_path)))
                    return font_name
                except Exception:
                    pass

        candidates: list[tuple[str, Path, int | None]] = [
            ("MicrosoftYaHei", Path("data/fonts/msyh.ttc"), 0),
            ("MicrosoftYaHei", Path("data/fonts/msyh.ttf"), None),
            ("MicrosoftYaHei", Path("/usr/share/fonts/truetype/msttcorefonts/msyh.ttc"), 0),
            ("MicrosoftYaHei", Path("/usr/share/fonts/truetype/microsoft/msyh.ttc"), 0),
            ("MicrosoftYaHei", Path("C:/Windows/Fonts/msyh.ttc"), 0),
            ("MicrosoftYaHei", Path("C:/Windows/Fonts/msyh.ttf"), None),
            ("MicrosoftYaHeiUI", Path("C:/Windows/Fonts/msyhl.ttc"), 0),
            ("SourceHanSansCN", Path("/System/Library/Fonts/STHeiti Light.ttc"), 0),
            ("SourceHanSansCN", Path("/System/Library/Fonts/STHeiti Medium.ttc"), 0),
            ("NotoSansCJK", Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"), 0),
            ("NotoSansCJK", Path("/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf"), None),
            ("NotoSansSC", Path("/usr/share/fonts/truetype/noto/NotoSansSC-Regular.otf"), None),
            ("NotoSansSC", Path("/usr/share/fonts/truetype/noto/NotoSansSC-Medium.otf"), None),
            ("WenQuanYi", Path("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"), 0),
        ]
        for name, font_path, sub_index in candidates:
            if font_path.exists():
                try:
                    if sub_index is None:
                        pdfmetrics.registerFont(TTFont(name, str(font_path)))
                    else:
                        pdfmetrics.registerFont(TTFont(name, str(font_path), subfontIndex=sub_index))
                    return name
                except Exception:
                    continue
        fallback = "STSong-Light"
        try:
            pdfmetrics.getFont(fallback)
        except KeyError:
            pdfmetrics.registerFont(UnicodeCIDFont(fallback))
        return fallback

    base_font = _register_font_family()
    latin_font = base_font

    def _wrap_latin(text: str | None) -> str:
        if text is None:
            return "-"
        raw = str(text)
        if not raw.strip():
            return "-"
        normalized = raw.replace("\r\n", "\n").replace("\r", "\n")

        def _wrap_line(line: str) -> str:
            if line == "":
                return ""
            if latin_font == base_font:
                return escape(line)
            parts: list[str] = []
            last = 0
            for match in re.finditer(r"[A-Za-z0-9][A-Za-z0-9 .:/_%+=,-]*", line):
                start, end = match.span()
                if start > last:
                    parts.append(escape(line[last:start]))
                parts.append(f'<font face="{latin_font}">{escape(match.group(0))}</font>')
                last = end
            if last < len(line):
                parts.append(escape(line[last:]))
            return "".join(parts)

        return "<br/>".join(_wrap_line(line) for line in normalized.split("\n"))

    def _split_text_for_table(
        text: str | None, max_lines: int = 18, max_chars_per_line: int = 120
    ) -> list[str]:
        if text is None:
            return ["-"]
        raw = str(text)
        if not raw.strip():
            return ["-"]
        normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
        lines = normalized.split("\n")
        wrapped: list[str] = []
        for line in lines:
            if line == "":
                wrapped.append("")
                continue
            while len(line) > max_chars_per_line:
                wrapped.append(line[:max_chars_per_line])
                line = line[max_chars_per_line:]
            wrapped.append(line)
        if not wrapped:
            return ["-"]
        chunks: list[str] = []
        for idx in range(0, len(wrapped), max_lines):
            chunk = "\n".join(wrapped[idx : idx + max_lines]).strip()
            chunks.append(chunk if chunk else "-")
        return chunks or ["-"]

    results_list = list(results)
    cluster_name, version_label, node_count_label = _get_cluster_meta(run)
    cluster = getattr(run, "cluster", None)
    cluster_id = getattr(cluster, "id", None) or getattr(run, "cluster_id", None)
    cluster_display_id = (
        _build_cluster_slug(cluster_id, cluster_name)
        if cluster_id is not None
        else None
    )
    cluster_label = (
        f"{cluster_name} ({cluster_display_id})"
        if cluster_display_id
        else cluster_name
    )

    doc = SimpleDocTemplate(
        str(report_path),
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )
    doc.title = f"{cluster_name} 巡检报告"
    doc.author = cluster_name
    styles = getSampleStyleSheet()
    styles["Title"].fontName = base_font
    styles["Title"].fontSize = 23
    styles["Title"].leading = 28
    styles["Title"].textColor = colors.HexColor("#0f172a")
    styles["Heading2"].fontName = base_font
    styles["Heading2"].textColor = colors.HexColor("#0f172a")
    styles["Heading2"].spaceBefore = 16
    styles["Heading2"].spaceAfter = 8
    styles["BodyText"].fontName = base_font
    styles["BodyText"].fontSize = 11
    styles["BodyText"].leading = 16
    styles["BodyText"].textColor = colors.HexColor("#111827")
    styles.add(
        ParagraphStyle(
            name="Muted",
            parent=styles["BodyText"],
            fontSize=10,
            leading=14,
            textColor=colors.HexColor("#4b5563"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="Meta",
            parent=styles["BodyText"],
            fontSize=11,
            leading=16,
            textColor=colors.HexColor("#4b5563"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="MetaLabel",
            parent=styles["BodyText"],
            fontSize=10,
            leading=14,
            textColor=colors.HexColor("#64748b"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="MetaValue",
            parent=styles["BodyText"],
            fontSize=11,
            leading=16,
            textColor=colors.HexColor("#0f172a"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="SectionHeading",
            parent=styles["Heading2"],
            spaceBefore=12,
            spaceAfter=6,
            fontName=base_font,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SummaryCard",
            parent=styles["BodyText"],
            fontName=base_font,
            fontSize=11,
            leading=18,
            alignment=1,  # center
            textColor=colors.HexColor("#0f172a"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="TableHeader",
            parent=styles["BodyText"],
            fontName=base_font,
            fontSize=12,
            leading=14,
            textColor=colors.HexColor("#f8fafc"),
            alignment=1,  # center
        )
    )
    styles.add(
        ParagraphStyle(
            name="TableStatus",
            parent=styles["BodyText"],
            fontName=base_font,
            fontSize=11,
            leading=14,
            textColor=colors.HexColor("#1f2937"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="CertHeader",
            parent=styles["BodyText"],
            fontName=base_font,
            fontSize=9.5,
            leading=12,
            textColor=colors.HexColor("#475569"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="CertCell",
            parent=styles["BodyText"],
            fontName=base_font,
            fontSize=9.5,
            leading=12,
            textColor=colors.HexColor("#0f172a"),
        )
    )

    tz = _resolve_cst_timezone()

    def format_dt(value: datetime | None) -> str:
        if value is None:
            return "未记录"
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        localized = value.astimezone(tz)
        return f"{localized.strftime('%Y-%m-%d %H:%M:%S')} 中国标准时间"

    total_checks = len(results_list)
    passed_count = sum(1 for item in results_list if item.status.lower() == "passed")
    warning_count = sum(1 for item in results_list if item.status.lower() == "warning")
    critical_count = sum(1 for item in results_list if item.status.lower() == "critical")
    failed_count = sum(1 for item in results_list if item.status.lower() == "failed")

    story: list[object] = []
    story.append(Paragraph(_wrap_latin(f"{cluster_name} 巡检报告"), styles["Title"]))
    story.append(Spacer(1, 10))

    meta_rows = [
        ("巡检编号", str(display_id or run.id)),
        ("巡检类型", _resolve_run_type_label(run.operator)),
        ("目标集群", cluster_label),
        ("集群版本", version_label),
        ("节点数量", node_count_label),
        ("巡检开始时间", format_dt(run.created_at)),
        ("巡检完成时间", format_dt(run.completed_at or datetime.utcnow())),
    ]
    rancher_version_label, rancher_count_label = _get_rancher_meta(run)
    if rancher_version_label is not None:
        meta_rows.insert(5, ("Rancher 版本", rancher_version_label))
    meta_table_data = [
        [Paragraph(label, styles["MetaLabel"]), Paragraph(_wrap_latin(value), styles["MetaValue"])]
        for label, value in meta_rows
    ]
    meta_table = Table(meta_table_data, colWidths=[90, doc.width - 90], hAlign="LEFT")
    meta_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
                ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(meta_table)
    story.append(Spacer(1, 16))

    if logo_path:
        from reportlab.platypus import Image  # local import to avoid optional dependency issues

        story.append(Image(logo_path, width=120, height=50))
        story.append(Spacer(1, 14))

    story.append(Paragraph("巡检概览", styles["SectionHeading"]))
    card_config = [
        ("检查项总数", total_checks, "#dbeafe"),
        ("通过", passed_count, "#dcfce7"),
        ("告警", warning_count, "#fef3c7"),
        ("严重", critical_count, "#fecdd3"),
        ("失败", failed_count, "#fee2e2"),
    ]
    card_cells: list[Paragraph] = []
    for label, value, bg_color in card_config:
        card_text = (
            f'<para alignment="center"><font size="18"><b>{value}</b></font>'
            f'<br/><font size="9" color="#64748b">{label}</font></para>'
        )
        card_cells.append(Paragraph(card_text, styles["SummaryCard"]))
    if card_cells:
        summary_table = Table(
            [card_cells],
            colWidths=[(doc.width - 18) / len(card_cells)] * len(card_cells),
            hAlign="LEFT",
        )
        summary_style = [
            ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
            ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#e2e8f0")),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 10),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 12),
        ]
        for idx, (_, _, bg_color) in enumerate(card_config):
            summary_style.append(("BACKGROUND", (idx, 0), (idx, 0), colors.HexColor(bg_color)))
        summary_table.setStyle(TableStyle(summary_style))
        story.append(summary_table)
        story.append(Spacer(1, 16))

    story.append(Paragraph("巡检摘要", styles["SectionHeading"]))
    summary_text = (run.summary or "").strip() or "暂无摘要"
    story.append(Paragraph(_wrap_latin(summary_text), styles["Muted"]))
    story.append(Spacer(1, 14))

    story.append(Paragraph("巡检明细", styles["SectionHeading"]))

    header = ["检查项", "状态", "详情", "建议"]
    data = [[Paragraph(text, styles["TableHeader"]) for text in header]]

    status_colors = {
        "passed": colors.HexColor("#16a34a"),
        "warning": colors.HexColor("#f59e0b"),
        "critical": colors.HexColor("#be123c"),
        "failed": colors.HexColor("#dc2626"),
    }
    status_backgrounds = {
        "passed": colors.HexColor("#dcfce7"),
        "warning": colors.HexColor("#fef3c7"),
        "critical": colors.HexColor("#fecdd3"),
        "failed": colors.HexColor("#fee2e2"),
    }

    detail_style = styles["BodyText"]
    suggestion_style = styles["Muted"]

    def _build_cert_table(headers: list[str], rows: list[list[str]]) -> Table:
        table_data: list[list[Paragraph]] = [
            [Paragraph(escape(header), styles["CertHeader"]) for header in headers]
        ]
        for row in rows:
            table_data.append(
                [Paragraph(_wrap_latin(cell), styles["CertCell"]) for cell in row]
            )
        col_widths = [70, 120] if len(headers) == 2 else [55, 95, 60]
        cert_table = Table(table_data, colWidths=col_widths)
        cert_table.setStyle(
            TableStyle(
                [
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 0),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 2),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ]
            )
        )
        return cert_table

    for result in results_list:
        status = result.status.lower()
        status_label = {
            "passed": "通过",
            "warning": "告警",
            "critical": "严重",
            "failed": "失败",
        }.get(status, result.status)
        cert_table = _parse_certificate_detail(result.detail)
        detail_chunks = ["__cert_table__"] if cert_table else _split_text_for_table(
            result.detail
        )
        suggestion_chunks = _split_text_for_table(result.suggestion)
        chunk_count = max(len(detail_chunks), len(suggestion_chunks))
        for chunk_index in range(chunk_count):
            name_cell = ""
            status_cell = ""
            if chunk_index == 0:
                name_cell = (
                    result.item.name
                    if result.item
                    else (result.item_name_cached or "巡检项已删除")
                )
                status_cell = status_label
            detail_text = (
                detail_chunks[chunk_index] if chunk_index < len(detail_chunks) else ""
            )
            suggestion_text = (
                suggestion_chunks[chunk_index] if chunk_index < len(suggestion_chunks) else ""
            )
            detail_cell = ""
            if cert_table and chunk_index == 0:
                headers, rows = cert_table
                detail_cell = _build_cert_table(headers, rows)
            elif detail_text:
                detail_cell = Paragraph(_wrap_latin(detail_text), detail_style)
            data.append(
                [
                    Paragraph(_wrap_latin(name_cell), styles["BodyText"]) if name_cell else "",
                    Paragraph(status_cell, styles["TableStatus"]) if status_cell else "",
                    detail_cell,
                    Paragraph(_wrap_latin(suggestion_text), suggestion_style)
                    if suggestion_text
                    else "",
                ]
            )
    table = LongTable(data, colWidths=[130, 70, 210, 160], repeatRows=1)

    commands = [

        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),

        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#f8fafc")),

        ("FONTNAME", (0, 0), (-1, 0), base_font),

        ("ALIGN", (0, 0), (-1, 0), "CENTER"),

        ("TOPPADDING", (0, 0), (-1, 0), 9),

        ("BOTTOMPADDING", (0, 0), (-1, 0), 9),

        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f8fafc"), colors.white]),

        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d7e0ea")),

        ("VALIGN", (0, 0), (-1, -1), "TOP"),

        ("LEFTPADDING", (0, 0), (-1, -1), 6),

        ("RIGHTPADDING", (0, 0), (-1, -1), 6),

        ("ALIGN", (1, 1), (1, -1), "CENTER"),

    ]



    for idx, result in enumerate(results_list, start=1):
        status = result.status.lower()
        commands.append(("TEXTCOLOR", (1, idx), (1, idx), status_colors.get(status, colors.HexColor("#111827"))))
        commands.append(("FONTNAME", (1, idx), (1, idx), base_font))
        bg_color = status_backgrounds.get(status)
        if bg_color is not None:
            commands.append(("BACKGROUND", (1, idx), (1, idx), bg_color))

    table.setStyle(TableStyle(commands))
    story.append(table)

    doc.build(story)

    return str(report_path)
