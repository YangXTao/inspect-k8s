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
)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont

from .models import InspectionResult, InspectionRun
from .schemas import _extract_connection_meta



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


def generate_markdown_report(
    *,
    run: InspectionRun,
    results: Iterable[InspectionResult],
    display_id: Optional[str] = None,
    output_path: Optional[Path] = None,
) -> str:
    reports_dir = Path("reports")
    reports_dir.mkdir(exist_ok=True)

    if output_path is None:
        safe_name = _build_report_basename(display_id, run.id)
        path = reports_dir / f"{safe_name}.md"
    else:
        path = Path(output_path)
        if not path.is_absolute():
            path = reports_dir / path
    path.parent.mkdir(parents=True, exist_ok=True)

    results_list = list(results)
    cluster_name, version_label, node_count_label = _get_cluster_meta(run)

    total_checks = len(results_list)
    passed_count = sum(1 for item in results_list if item.status.lower() == "passed")
    warning_count = sum(1 for item in results_list if item.status.lower() == "warning")
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

    display_label = str(display_id or run.id)
    lines: list[str] = []
    lines.append(f"# {cluster_name} 巡检报告")
    lines.append("")
    lines.append("| 项目 | 内容 |")
    lines.append("| --- | --- |")
    lines.append(f"| 巡检编号 | {display_label} |")
    lines.append(f"| 巡检人 | {_sanitize(run.operator) if run.operator else '未填写'} |")
    lines.append(f"| 目标集群 | {cluster_name} |")
    lines.append(f"| 集群版本 | {version_label} |")
    lines.append(f"| 节点数量 | {node_count_label} |")
    lines.append(f"| 巡检开始时间 | {_format_dt(run.created_at)} |")
    lines.append(f"| 巡检完成时间 | {_format_dt(run.completed_at or datetime.utcnow())} |")
    lines.append("")

    lines.append("## 巡检概览")
    lines.append("")
    lines.append("| 项目 | 数量 |")
    lines.append("| --- | --- |")
    lines.append(f"| 检查项总数 | {total_checks} |")
    lines.append(f"| 通过项 | {passed_count} |")
    lines.append(f"| 告警项 | {warning_count} |")
    lines.append(f"| 失败项 | {failed_count} |")
    lines.append("")

    summary_text = (run.summary or "").strip() or "暂无巡检摘要。"
    lines.append("## 巡检摘要")
    lines.append("")
    lines.append(summary_text.replace("\r\n", "\n"))
    lines.append("")

    lines.append("## 巡检明细")
    lines.append("")
    lines.append("| 巡检项 | 状态 | 详情 | 建议 |")
    lines.append("| --- | --- | --- | --- |")
    status_labels = {
        "passed": "通过",
        "warning": "告警",
        "failed": "失败",
    }
    for item in results_list:
        status = item.status.lower()
        status_label = status_labels.get(status, item.status)
        item_name = _sanitize(item.item.name if item.item else item.item_name_cached or "巡检项已删除")
        detail = _sanitize(item.detail)
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
    reports_dir = Path("reports")
    reports_dir.mkdir(exist_ok=True)

    if display_id:
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "-", display_id).strip("-_") or f"inspection-run-{run.id}"
    else:
        safe_name = f"inspection-run-{run.id}"

    report_path = reports_dir / f"{safe_name}.pdf"

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

    doc = SimpleDocTemplate(
        str(report_path),
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )
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

    tz = _resolve_cst_timezone()

    def format_dt(value: datetime | None) -> str:
        if value is None:
            return "未记录"
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        localized = value.astimezone(tz)
        return f"{localized.strftime('%Y-%m-%d %H:%M:%S')} 中国标准时间"

    results_list = list(results)
    cluster_name, version_label, node_count_label = _get_cluster_meta(run)
    total_checks = len(results_list)
    passed_count = sum(1 for item in results_list if item.status.lower() == "passed")
    warning_count = sum(1 for item in results_list if item.status.lower() == "warning")
    failed_count = sum(1 for item in results_list if item.status.lower() == "failed")

    story: list[object] = []
    story.append(Paragraph(f"{cluster_name} 巡检报告", styles["Title"]))
    story.append(Spacer(1, 10))

    meta_rows = [
        ("巡检编号", str(display_id or run.id)),
        ("巡检人", run.operator or "未填写"),
        ("目标集群", cluster_name),
        ("集群版本", version_label),
        ("节点数量", node_count_label),
        ("巡检开始时间", format_dt(run.created_at)),
        ("巡检完成时间", format_dt(run.completed_at or datetime.utcnow())),
    ]
    meta_table_data = [
        [Paragraph(label, styles["MetaLabel"]), Paragraph(value, styles["MetaValue"])]
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
        ("通过项", passed_count, "#dcfce7"),
        ("警告项", warning_count, "#fef3c7"),
        ("失败项", failed_count, "#fee2e2"),
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
    summary_text = (run.summary or "").strip() or "暂无巡检摘要。"
    story.append(Paragraph(summary_text, styles["Muted"]))
    story.append(Spacer(1, 14))

    story.append(Paragraph("巡检明细", styles["SectionHeading"]))

    header = ["检查项", "状态", "详情", "建议"]
    data = [[Paragraph(text, styles["TableHeader"]) for text in header]]

    status_colors = {
        "passed": colors.HexColor("#16a34a"),
        "warning": colors.HexColor("#f59e0b"),
        "failed": colors.HexColor("#dc2626"),
    }
    status_backgrounds = {
        "passed": colors.HexColor("#dcfce7"),
        "warning": colors.HexColor("#fef3c7"),
        "failed": colors.HexColor("#fee2e2"),
    }

    detail_style = styles["BodyText"]
    suggestion_style = styles["Muted"]

    for result in results_list:
        status = result.status.lower()
        status_label = {
            "passed": "通过",
            "warning": "警告",
            "failed": "失败",
        }.get(status, result.status)
        data.append(
            [
                Paragraph(
                    result.item.name if result.item else (result.item_name_cached or "巡检项已删除"),
                    styles["BodyText"],
                ),
                Paragraph(status_label, styles["TableStatus"]),
                Paragraph(result.detail or "-", detail_style),
                Paragraph(result.suggestion or "-", suggestion_style),
            ]
        )
    table = Table(data, colWidths=[130, 70, 210, 160], repeatRows=1)

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
