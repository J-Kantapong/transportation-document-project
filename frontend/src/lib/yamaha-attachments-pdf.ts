import { fetchAuthedBlob, yamahaRelocationAttachmentUrl, type YamahaRelocationEntry } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";

// Export รูปใบเสร็จ + Report ของงานแจ้งย้ายยามาฮ่าเป็น PDF ไฟล์เดียว (ผู้ใช้ 2026-09-30)
// เรียงตามวันที่ของรายการ จากเก่าสุดไปใหม่สุด; ในแต่ละรายการใบเสร็จก่อนแล้วตามด้วย Report; 1 รูป = 1 หน้า A4
// หัวหน้า (วันที่ / จำนวนคัน / ชนิดไฟล์) วาดลง canvas พร้อมรูป เพราะ jsPDF ไม่มีฟอนต์ไทย
// ไฟล์ PDF ที่แนบไว้รวมเข้าไม่ได้ (ไม่มีตัวรวม PDF) - ข้ามแล้วส่งรายชื่อกลับให้หน้าเว็บแจ้งผู้ใช้

const PAGE_W = 1240; // A4 ที่ 150 dpi
const PAGE_H = 1754;
const MARGIN = 60;
const HEADER_H = 110;
const FONT = '"Noto Sans Thai", "Noto Sans Thai Looped", Tahoma, sans-serif';

export interface AttachmentPdfResult {
  pages: number;
  skippedPdfs: string[];
}

interface PageJob {
  url: string;
  title: string;
  subtitle: string;
}

function buildJobs(entries: YamahaRelocationEntry[]): { jobs: PageJob[]; skippedPdfs: string[] } {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  const jobs: PageJob[] = [];
  const skippedPdfs: string[] = [];
  for (const entry of sorted) {
    const title = `วันที่ ${isoToDisplayDate(entry.date) || entry.date} · ${entry.count} คัน`;
    for (const [label, files] of [
      ["ใบเสร็จ", entry.receipts],
      ["Report", entry.reports],
    ] as const) {
      files.forEach((file, i) => {
        const name = `${label}${files.length > 1 ? ` ${i + 1}/${files.length}` : ""}`;
        if (file.mimeType === "application/pdf") {
          skippedPdfs.push(`${isoToDisplayDate(entry.date)} ${name}${file.originalName ? ` (${file.originalName})` : ""}`);
          return;
        }
        jobs.push({ url: yamahaRelocationAttachmentUrl(file.id), title, subtitle: name });
      });
    }
  }
  return { jobs, skippedPdfs };
}

async function renderPage(job: PageJob): Promise<string> {
  const bitmap = await createImageBitmap(await fetchAuthedBlob(job.url));
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas ใช้ไม่ได้");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  ctx.fillStyle = "#18243c";
  ctx.textBaseline = "top";
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(job.title, MARGIN, MARGIN);
  ctx.font = `32px ${FONT}`;
  ctx.fillStyle = "#576781";
  ctx.fillText(job.subtitle, MARGIN, MARGIN + 54);

  const boxW = PAGE_W - MARGIN * 2;
  const boxH = PAGE_H - MARGIN * 2 - HEADER_H;
  const scale = Math.min(boxW / bitmap.width, boxH / bitmap.height, 1.5);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, MARGIN + (boxW - w) / 2, MARGIN + HEADER_H, w, h);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

export async function downloadYamahaAttachmentsPdf(
  entries: YamahaRelocationEntry[],
  fileName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<AttachmentPdfResult> {
  const { jobs, skippedPdfs } = buildJobs(entries);
  if (!jobs.length) return { pages: 0, skippedPdfs };
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  for (let i = 0; i < jobs.length; i++) {
    onProgress?.(i, jobs.length);
    const dataUrl = await renderPage(jobs[i]);
    if (i > 0) pdf.addPage();
    pdf.addImage(dataUrl, "JPEG", 0, 0, 210, 297);
  }
  onProgress?.(jobs.length, jobs.length);
  pdf.save(fileName);
  return { pages: jobs.length, skippedPdfs };
}
