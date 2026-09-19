import type { DocumentSubmission } from "@/lib/api";

// ใบส่งงานรถยนต์ (ตัวอย่าง "ยื่นเอกสารจดใหม่.pdf"): กระดาษ A4 แนวตั้ง หน้าละ 20 คัน หัวใบ (ชื่อบริษัท/วันที่/หมายเหตุ/รวม)
// ซ้ำทุกหน้า - ยอด "รวม" คือยอดของทั้งใบ (ทุกหน้า) ไม่ใช่เฉพาะหน้านั้น ตามตัวอย่าง
export const JOB_SHEET_ROWS_PER_PAGE = 20;

export interface JobSheetRow {
  brand: string;
  chassis: string;
  fee: number; // ค่าธรรมเนียม (รายการ Bill)
  tax: number | null; // null = ยังคำนวณภาษีไม่ได้
  plate: string; // "หมวด-เลข" หรือว่าง
}

export interface JobSheet {
  key: string; // "วันที่ ISO|ชื่อหัวใบเริ่มต้น" - ใช้ผูกชื่อที่ผู้ใช้แก้ไขกับแต่ละใบ
  title: string;
  dateText: string; // เช่น 22/9/2026
  note: string;
  total: number;
  rows: JobSheetRow[];
}

// คอลัมน์ [หัวข้อ, ความกว้าง %] - รวม 100% สัดส่วนใกล้ตัวอย่าง แต่ขยายคอลัมน์ ลำดับ/ยี่ห้อ/ค่าธรรมเนียมเล็กน้อยให้ข้อความไม่ตัดบรรทัดบนกระดาษ A4
const COLUMNS: Array<[string, number]> = [
  ["ลำดับ", 8],
  ["ยี่ห้อ", 12],
  ["เลขตัวรถ", 33],
  ["ค่าธรรมเนียม", 16],
  ["ค่าภาษี", 14],
  ["เลขทะเบียน", 17],
];

export function formatSheetMoney(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ISO YYYY-MM-DD -> d/m/yyyy แบบไม่เติมศูนย์นำหน้า (22/9/2026) ตามตัวอย่าง
export function sheetDateText(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${Number(match[3])}/${Number(match[2])}/${match[1]}` : iso;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const amountOf = (items: unknown, match: (label: string) => boolean): number =>
  (Array.isArray(items) ? (items as Array<{ label: string; amount: number }>) : []).filter((i) => match(i.label)).reduce((s, i) => s + Number(i.amount), 0);

// ยอดของรถ 1 คันที่รวมในช่อง "รวม": ค่าธรรมเนียม + ภาษี + ลงขัน + ด่วน (ลงขัน/ด่วนอยู่ในรายการ No bill และไม่แสดงเป็นคอลัมน์บนใบ
// แต่รวมอยู่ในยอดรวม - ยอดในตัวอย่าง 42,564 = 13 คัน x (355 + ลงขัน 40) + ภาษีรวม 37,429) ไม่รวมค่าอากร
export function jobSheetRowTotal(r: DocumentSubmission): number {
  const longkhan = amountOf(r.noBillItems, (l) => l.startsWith("ลงขัน") && !l.includes("ด่วน"));
  const urgent = amountOf(r.noBillItems, (l) => l.includes("ด่วน"));
  return Number(r.billFeeTotal) + Number(r.taxAmount ?? 0) + longkhan + urgent;
}

export function toJobSheetRow(r: DocumentSubmission): JobSheetRow {
  const v = r.vehicle;
  return {
    brand: v.brand.name.toUpperCase(),
    chassis: v.chassis,
    fee: Number(r.billFeeTotal),
    tax: r.taxAmount === null ? null : Number(r.taxAmount),
    plate: v.plateCategory && v.plateNumber ? `${v.plateCategory}-${v.plateNumber}` : "",
  };
}

// แบ่งรายการเป็นใบส่งงานตาม (ชื่อหัวใบเริ่มต้น, วันที่ยื่น) - 1 ใบต่อ 1 บริษัทต่อ 1 วัน เรียงตามลำดับที่บันทึก
// titleOverrides: key ของใบ -> ชื่อหัวใบที่ผู้ใช้แก้ไข (ไม่กระทบการแบ่งใบ)
export function buildJobSheets(
  records: DocumentSubmission[],
  note: string,
  defaultTitleFor: (r: DocumentSubmission) => string,
  titleOverrides: Record<string, string> = {},
): JobSheet[] {
  const groups = new Map<string, { key: string; defaultTitle: string; date: string; records: DocumentSubmission[] }>();
  for (const r of [...records].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const defaultTitle = defaultTitleFor(r);
    const date = r.submitDate.slice(0, 10);
    const key = `${date}|${defaultTitle}`;
    if (!groups.has(key)) groups.set(key, { key, defaultTitle, date, records: [] });
    groups.get(key)!.records.push(r);
  }
  return [...groups.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.defaultTitle.localeCompare(b.defaultTitle, "th"))
    .map((g) => ({
      key: g.key,
      title: titleOverrides[g.key] ?? g.defaultTitle,
      dateText: sheetDateText(g.date),
      note,
      total: g.records.reduce((sum, r) => sum + jobSheetRowTotal(r), 0),
      rows: g.records.map(toJobSheetRow),
    }));
}

function pageHtml(sheet: JobSheet, pageIndex: number): string {
  const start = pageIndex * JOB_SHEET_ROWS_PER_PAGE;
  const cells = (row: JobSheetRow | undefined) =>
    row
      ? [row.brand, row.chassis, formatSheetMoney(row.fee), row.tax === null ? "-" : formatSheetMoney(row.tax), row.plate]
      : ["", "", "", "", ""];
  const body = Array.from({ length: JOB_SHEET_ROWS_PER_PAGE }, (_, i) => {
    const row = sheet.rows[start + i];
    return `<tr><td>${start + i + 1}</td>${cells(row)
      .map((c) => `<td>${escapeHtml(c)}</td>`)
      .join("")}</tr>`;
  }).join("");
  const cols = COLUMNS.map(([, w]) => `<col style="width:${w}%">`).join("");
  const head = COLUMNS.map(([label]) => `<th>${escapeHtml(label)}</th>`).join("");

  return `<section class="page">
<table class="box"><tr><td colspan="2" class="title">${escapeHtml(sheet.title)}</td></tr>
<tr><td class="left">วันที่ : ${escapeHtml(sheet.dateText)}</td><td class="right" rowspan="2"><span>รวม</span><b>${formatSheetMoney(sheet.total)}</b></td></tr>
<tr><td class="left note">หมายเหตุ : ${escapeHtml(sheet.note)}</td></tr></table>
<table class="grid"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="pageno">${pageIndex + 1}</div>
</section>`;
}

export function jobSheetPageCount(sheet: JobSheet): number {
  return Math.max(1, Math.ceil(sheet.rows.length / JOB_SHEET_ROWS_PER_PAGE));
}

export function buildJobSheetHtml(sheets: JobSheet[]): string {
  const pages = sheets.flatMap((sheet) => Array.from({ length: jobSheetPageCount(sheet) }, (_, i) => pageHtml(sheet, i))).join("\n");
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>ใบส่งงาน</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; }
  body { font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif; color: #000; font-size: 10pt; }
  /* 1 section = 1 หน้า A4 (พื้นที่พิมพ์สูง 277mm) - เว้นสูงไว้น้อยกว่าเล็กน้อยกันล้นไปหน้าเปล่า */
  .page { position: relative; height: 274mm; page-break-after: always; break-after: page; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  /* เส้น 2px: Chrome ปัดความหนาเส้นเป็นจำนวนเต็ม px - เส้นบางกว่า 1px จะเป็นสีเทาจาง/ขาดใน PDF viewer (เหมือนใบส่งตรวจรถ) */
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  /* nowrap: ข้อความในตารางต้องอยู่บรรทัดเดียว (ไม่ตัด TOYOTA / ลำดับ) - คอลัมน์กว้างพอสำหรับข้อมูลจริงแล้ว */
  td, th { border: 2px solid #000; text-align: center; vertical-align: middle; padding: 0 0.8mm; white-space: nowrap; }
  .box { margin-bottom: 7mm; }
  .box .title { height: 12mm; font-size: 20pt; font-weight: 700; white-space: normal; }
  .box .left { width: 50%; height: 10mm; text-align: left; font-weight: 700; padding: 0 1.5mm; white-space: normal; }
  .box .right { width: 50%; text-align: left; font-weight: 700; position: relative; }
  .box .right span { display: inline-block; width: 45%; text-align: center; }
  .box .right b { position: absolute; right: 1.5mm; top: 50%; transform: translateY(-50%); }
  .grid th { height: 10mm; font-style: italic; font-weight: 700; }
  .grid td { height: 10.4mm; }
  .pageno { position: absolute; right: 0; bottom: 0; font-size: 9pt; }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

// พิมพ์ผ่าน iframe ที่ซ่อนไว้ - ผู้ใช้เลือกเครื่องพิมพ์หรือ "บันทึกเป็น PDF" ในหน้าต่างพิมพ์ของเบราว์เซอร์ (วิธีเดียวกับใบส่งตรวจรถ
// เพราะแสดงภาษาไทยได้ถูกต้องโดยไม่ต้องฝังฟอนต์)
export function printJobSheets(sheets: JobSheet[]): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  iframe.srcdoc = buildJobSheetHtml(sheets);

  iframe.onload = async () => {
    const win = iframe.contentWindow;
    if (!win) return;
    await Promise.race([win.document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    win.addEventListener("afterprint", () => setTimeout(() => iframe.remove(), 0));
    win.focus();
    win.print();
  };

  document.body.appendChild(iframe);
}
