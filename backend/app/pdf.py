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
    doc = SimpleDocTemplate(
        str(report_path),
        pagesize=A4,
        leftMargin=36,
        rightMargin=36,
        topMargin=36,
        bottomMargin=36,
    )
    styles = getSampleStyleSheet()
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
            name="SectionHeading",
            parent=styles["Heading2"],
            spaceBefore=12,
            spaceAfter=6,
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
    story.append(Paragraph(subtitle, styles["BodyText"]))
    story.append(Paragraph(f"Cluster: {getattr(run.cluster, 'name', 'N/A')}", styles["BodyText"]))
    story.append(
        Paragraph(
            f"Created: {format_dt(run.created_at)} | Completed: {format_dt(run.completed_at or datetime.utcnow())}",
            styles["BodyText"],
        )
    )

    story.append(Spacer(1, 12))

    if logo_path:
        from reportlab.platypus import Image  # local import to avoid optional dependency issues

        story.append(Image(logo_path, width=120, height=50))
        story.append(Spacer(1, 12))

    story.append(Paragraph("Summary", styles["SectionHeading"]))
    summary_text = run.summary or "No summary provided."
    story.append(Paragraph(summary_text, styles["BodyText"]))
    story.append(Spacer(1, 12))

    story.append(Paragraph("Inspection Details", styles["SectionHeading"]))

    header = ["Check Item", "Status", "Detail", "Suggestion"]
    data = [[Paragraph(text, styles["BodyText"]) for text in header]]

    status_colors = {
        "passed": colors.HexColor("#16a34a"),
        "warning": colors.HexColor("#f59e0b"),
        "failed": colors.HexColor("#dc2626"),
    }

    detail_style = styles["Muted"]

    results_list = list(results)
    for result in results_list:
        status = result.status.lower()
        status_label = status.capitalize()
        data.append(
            [
                Paragraph(result.item.name, styles["BodyText"]),
                Paragraph(status_label, styles["BodyText"]),
                Paragraph(result.detail or "-", detail_style),
                Paragraph(result.suggestion or "-", detail_style),
            ]
        )

    table = Table(data, colWidths=[120, 70, 200, 190], repeatRows=1)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (0, 0), (-1, 0), "LEFT"),
        ("TOPPADDING", (0, 0), (-1, 0), 8),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
        ("BACKGROUND", (0, 1), (-1, -1), colors.whitesmoke),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.lightgrey),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
    ]

    for idx, result in enumerate(results_list, start=1):
        status = result.status.lower()
        commands.append(("TEXTCOLOR", (1, idx), (1, idx), status_colors.get(status, colors.HexColor("#111827"))))
        commands.append(("FONTNAME", (1, idx), (1, idx), "Helvetica-Bold"))

    table.setStyle(TableStyle(commands))
    story.append(table)

    doc.build(story)

    return str(report_path)
