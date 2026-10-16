import { jsPDF } from "jspdf";
import type { ReportSection, ResilienceScores } from "@/lib/reportBuilder";

export interface ReportPdfInput {
  composeFileName: string | null;
  sections: ReportSection[];
  scores: ResilienceScores;
  criticalCount: number;
  warningCount: number;
}

const PAGE_WIDTH = 210;
const PAGE_HEIGHT = 297;
const MARGIN = 16;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = PAGE_HEIGHT - 14;

function pdfText(value: string): string {
  return value
    .replaceAll("↳", "->")
    .replaceAll("⚠", "!")
    .replaceAll("✓", "OK")
    .replaceAll("↔", "<->")
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .replaceAll("`", "")
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
}

function fileSlug(name: string | null): string {
  const base = (name ?? "compose")
    .replace(/\.(ya?ml)$/i, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return base || "compose";
}

export function downloadReportPdf(input: ReportPdfInput): void {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: false });
  let y = 36;

  const newPage = () => {
    doc.addPage();
    y = MARGIN;
  };

  const ensure = (height: number) => {
    if (y + height > BOTTOM) newPage();
  };

  const writeWrapped = (
    text: string,
    options: {
      size: number;
      style?: "normal" | "bold";
      font?: "helvetica" | "courier";
      color?: [number, number, number];
      indent?: number;
      width?: number;
      after?: number;
    },
  ) => {
    const indent = options.indent ?? 0;
    const width = options.width ?? CONTENT_WIDTH - indent;
    const font = options.font ?? "helvetica";
    const style = options.style ?? "normal";
    const color = options.color ?? [40, 40, 40];
    doc.setFont(font, style);
    doc.setFontSize(options.size);
    const lines = doc.splitTextToSize(pdfText(text), width) as string[];
    const lineHeight = options.size * 0.42 + 1.15;
    for (const line of lines) {
      ensure(lineHeight);
      doc.setFont(font, style);
      doc.setFontSize(options.size);
      doc.setTextColor(...color);
      doc.text(line, MARGIN + indent, y);
      y += lineHeight;
    }
    y += options.after ?? 1.4;
  };

  doc.setFillColor(18, 18, 18);
  doc.rect(0, 0, PAGE_WIDTH, 28, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text("MetricMantis Resilience Report", MARGIN, 12);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(200, 200, 200);
  doc.text(
    input.composeFileName ? pdfText(input.composeFileName) : "Docker Compose analysis",
    MARGIN,
    19,
  );
  doc.text(new Date().toLocaleString(), MARGIN, 24);

  writeWrapped(
    `Overall resilience score: ${input.scores.overall}/10    Critical findings: ${input.criticalCount}    Warnings: ${input.warningCount}`,
    { size: 10, style: "bold", color: [24, 24, 24], after: 3 },
  );

  for (const section of input.sections) {
    ensure(14);
    doc.setDrawColor(220, 220, 220);
    doc.line(MARGIN, y, PAGE_WIDTH - MARGIN, y);
    y += 6;
    writeWrapped(`${section.number}. ${section.title}`, {
      size: 13,
      style: "bold",
      color: [16, 16, 16],
      after: 2,
    });

    for (const text of section.paragraphs) {
      writeWrapped(text, { size: 10.5 });
    }

    for (const bullet of section.bullets ?? []) {
      const sub = bullet.startsWith("↳");
      writeWrapped(sub ? pdfText(bullet) : `- ${pdfText(bullet)}`, {
        size: 10,
        color: sub ? [90, 90, 90] : [40, 40, 40],
        indent: sub ? 8 : 2,
        after: 0.6,
      });
    }
    if (section.bullets?.length) y += 1.5;

    for (const row of section.table ?? []) {
      ensure(6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(40, 40, 40);
      doc.text(pdfText(row.label), MARGIN + 2, y);
      doc.setFont("helvetica", "bold");
      doc.text(pdfText(row.score), PAGE_WIDTH - MARGIN, y, { align: "right" });
      y += 6;
    }
    if (section.table?.length) y += 2;

    const block = section.code || section.log;
    if (block) {
      writeWrapped(block, {
        size: 8.5,
        font: "courier",
        color: [50, 50, 50],
        indent: 2,
        width: CONTENT_WIDTH - 4,
        after: 3,
      });
    }
  }

  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(130, 130, 130);
    doc.text(`MetricMantis  ·  ${page} / ${pages}`, MARGIN, PAGE_HEIGHT - 8);
  }

  const filename = `metricmantis-${fileSlug(input.composeFileName)}-report.pdf`;
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
