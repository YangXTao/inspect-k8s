from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Iterable

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import (
    SimpleDocTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from .models import InspectionResult, InspectionRun


def generate_pdf_report(
    *,
    run: InspectionRun,
    results: Iterable[InspectionResult],
    logo_path: str | None = None,
) -> str:
    """Generate a PDF report and return the filesystem path."""
    reports_dir = Path("reports")
    reports_dir.mkdir(exist_ok=True)

    report_path = reports_dir / f"inspection-run-{run.id}.pdf"
    doc_path = str(report_path)
    doc = SimpleDocTemplate(doc_path, pagesize=A4)
    styles = getSampleStyleSheet()
    story = []

    story.append(Paragraph("Kubernetes Inspection Report", styles["Title"]))
    story.append(Spacer(1, 12))
    story.append(
        Paragraph(
            f"Run ID: {run.id} | Operator: {run.operator or 'N/A'}",
            styles["Normal"],
        )
    )
    story.append(
        Paragraph(f"Cluster: {getattr(run.cluster, 'name', 'N/A')}", styles["Normal"])
    )
    story.append(
        Paragraph(
            f"Created: {run.created_at:%Y-%m-%d %H:%M:%S} UTC | "
            f"Completed: {run.completed_at or datetime.utcnow():%Y-%m-%d %H:%M:%S} UTC",
            styles["Normal"],
        )
    )
    story.append(Spacer(1, 12))
    if logo_path:
        from reportlab.platypus import Image  # local import to avoid optional dep

        story.append(Image(logo_path, width=120, height=60))
        story.append(Spacer(1, 12))

    data = [["Item", "Status", "Detail", "Suggestion"]]
    for result in results:
        data.append(
            [
                result.item.name,
                result.status,
                result.detail or "",
                result.suggestion or "",
            ]
        )

    table = Table(data, repeatRows=1)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2937")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
                ("ALIGN", (0, 0), (-1, -1), "LEFT"),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("BOTTOMPADDING", (0, 0), (-1, 0), 8),
                ("BACKGROUND", (0, 1), (-1, -1), colors.HexColor("#f3f4f6")),
                ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
            ]
        )
    )

    story.append(table)
    story.append(Spacer(1, 12))
    story.append(Paragraph(run.summary or "No summary provided.", styles["Italic"]))

    doc.build(story)

    return doc_path
