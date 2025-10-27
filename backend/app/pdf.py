from __future__ import annotations

import re
from datetime import datetime, timezone, timedelta
try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None  # type: ignore
from pathlib import Path
from typing import Iterable

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



def _resolve_cst_timezone() -> timezone:
    if ZoneInfo is not None:
        try:
            return ZoneInfo("Asia/Shanghai")  # type: ignore[arg-type]
        except Exception:
            pass
    return timezone(timedelta(hours=8))

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
        candidates: list[tuple[str, Path, int | None]] = [
            ("MicrosoftYaHei", Path("C:/Windows/Fonts/msyh.ttc"), 0),
            ("MicrosoftYaHei", Path("C:/Windows/Fonts/msyh.ttf"), None),
            ("MicrosoftYaHeiUI", Path("C:/Windows/Fonts/msyhl.ttc"), 0),
            ("SourceHanSansCN", Path("/System/Library/Fonts/STHeiti Light.ttc"), 0),
            ("SourceHanSansCN", Path("/System/Library/Fonts/STHeiti Medium.ttc"), 0),
            ("NotoSansCJK", Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"), 0),
            ("NotoSansCJK", Path("/usr/share/fonts/truetype/noto/NotoSansCJKsc-Regular.otf"), None),
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
            name="SectionHeading",
            parent=styles["Heading2"],
            spaceBefore=12,
            spaceAfter=6,
            fontName=base_font,
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
            return "N/A"
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S %Z")

    story = []
    story.append(Paragraph("Kubernetes Inspection Report", styles["Title"]))
    story.append(Spacer(1, 6))
    subtitle = f"Inspection ID: {display_id or run.id}"
    if run.operator:
        subtitle += f" | Operator: {run.operator}"
    story.append(Paragraph(subtitle, styles["Meta"]))
    story.append(Paragraph(f"Cluster: {getattr(run.cluster, 'name', 'N/A')}", styles["Meta"]))
    story.append(
        Paragraph(
            f"Created: {format_dt(run.created_at)} | Completed: {format_dt(run.completed_at or datetime.utcnow())}",
            styles["Meta"],
        )
    )

    story.append(Spacer(1, 12))

    if logo_path:
        from reportlab.platypus import Image  # local import to avoid optional dependency issues

        story.append(Image(logo_path, width=120, height=50))
        story.append(Spacer(1, 12))

    story.append(Paragraph("Summary", styles["SectionHeading"]))
    summary_text = run.summary or "No summary provided."
    story.append(Paragraph(summary_text, styles["Muted"]))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Inspection Details", styles["SectionHeading"]))

    header = ["Check Item", "Status", "Detail", "Suggestion"]
    data = [[Paragraph(text, styles["TableHeader"]) for text in header]]

    status_colors = {
        "passed": colors.HexColor("#15803d"),
        "warning": colors.HexColor("#b45309"),
        "failed": colors.HexColor("#b91c1c"),
    }
    status_backgrounds = {
        "passed": colors.HexColor("#dcfce7"),
        "warning": colors.HexColor("#fef3c7"),
        "failed": colors.HexColor("#fee2e2"),
    }

    detail_style = styles["BodyText"]
    suggestion_style = styles["Muted"]

    results_list = list(results)
    for result in results_list:
        status = result.status.lower()
        status_label = status.capitalize()
        data.append(
            [
                Paragraph(result.item.name, styles["BodyText"]),
                Paragraph(status_label, styles["TableStatus"]),
                Paragraph(result.detail or "-", detail_style),
                Paragraph(result.suggestion or "-", suggestion_style),
            ]
        )

    table = Table(data, colWidths=[120, 70, 200, 190], repeatRows=1)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#101c3a")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#f9fafb")),
        ("FONTNAME", (0, 0), (-1, 0), base_font),
        ("ALIGN", (0, 0), (-1, 0), "CENTER"),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.HexColor("#f8fafc"), colors.white]),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d1d9e6")),
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
