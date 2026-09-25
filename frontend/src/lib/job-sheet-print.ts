import type { DocumentSubmission } from "@/lib/api";
import { escapeHtml, printHtmlDocument, safeFileName } from "@/lib/print-html";

// ใบส่งงาน 2 แบบตามตัวอย่าง PDF ของผู้ใช้ (กระดาษ A4 แนวตั้ง หัวใบซ้ำทุกหน้า):
// - "car" (ยื่นเอกสารจดใหม่.pdf): หน้าละ 20 คัน หัวใบ = ชื่อบริษัท/วันที่/หมายเหตุ/รวม - "รวม" คือยอดของทั้งใบ (ทุกหน้า)
//   ไม่ใช่เฉพาะหน้านั้น
// - "moto" (ยื่นเอกสารจดใหม่รถจักรยานยนต์.pdf): หน้าละ 30 คัน หัวใบ = "มนต์ชัย จิตกุศลรุ่งเรือง - {เจ้าของงาน}" + วันที่ ไม่มียอดรวม/หมายเหตุ
export type JobSheetKind = "car" | "moto";

// ชื่อที่ขึ้นต้นหัวใบมอเตอร์ไซค์ทุกใบเสมอ (ผู้ใช้กำหนด) - ส่วนที่แก้ไขได้คือชื่อเจ้าของงานที่ตามหลัง
export const MOTO_TITLE_PREFIX = "มนต์ชัย จิตกุศลรุ่งเรือง";

export function jobSheetPrintedTitle(sheet: Pick<JobSheet, "kind" | "title">): string {
  return sheet.kind === "moto" ? `${MOTO_TITLE_PREFIX} - ${sheet.title}` : sheet.title;
}

export function jobSheetRowsPerPage(kind: JobSheetKind): number {
  return kind === "moto" ? 30 : 20;
}

export interface JobSheetRow {
  brand: string;
  chassis: string;
  fee: number; // ค่าธรรมเนียม (รายการ Bill)
  tax: number | null; // null = ยังคำนวณภาษีไม่ได้
  plateCategory: string; // หมวดทะเบียน (ว่างถ้ายังไม่มี)
  plateNumber: string;
  owner: string; // ผู้ถือกรรมสิทธิ์ (ใช้เฉพาะแบบ moto) - ว่างถ้ายังไม่ได้ระบุชื่อ
}

export interface JobSheet {
  kind: JobSheetKind;
  key: string; // "วันที่ ISO|ชื่อหัวใบเริ่มต้น" - ใช้ผูกชื่อที่ผู้ใช้แก้ไขกับแต่ละใบ
  title: string;
  dateText: string; // เช่น 22/9/2026
  note: string; // เฉพาะแบบ car
  total: number; // แบบ car: ยอด "รวม" ที่พิมพ์ / แบบ moto: ผลรวมค่าธรรมเนียม+ภาษี (แสดงในหน้าต่างก่อนพิมพ์ ไม่พิมพ์ลงใบ)
  rows: JobSheetRow[];
}

// คอลัมน์ [หัวข้อ, ความกว้าง %] - รวม 100% สัดส่วนใกล้ตัวอย่าง แต่ขยายคอลัมน์ลำดับ/ค่าธรรมเนียมเล็กน้อยให้ข้อความไม่ตัดบรรทัดบน A4
const CAR_COLUMNS: Array<[string, number]> = [
  ["ลำดับ", 8],
  ["ยี่ห้อ", 12],
  ["เลขตัวรถ", 33],
  ["ค่าธรรมเนียม", 16],
  ["ค่าภาษี", 14],
  ["เลขทะเบียน", 17],
];

// ผู้ถือกรรมสิทธิ์กว้างสุด เพราะชื่อบริษัทไฟแนนซ์ยาว (เช่น "บริษัท อยุธยา แคปปิตอล ออโต้ ลีส จำกัด (มหาชน)")
const MOTO_COLUMNS: Array<[string, number]> = [
  ["ลำดับ", 7],
  ["เลขตัวรถ", 24],
  ["ผู้ถือกรรมสิทธิ์", 39],
  ["ค่าธรรมเนียม", 14],
  ["เลขทะเบียน", 16],
];

// ชื่อที่ยาวเกินช่องที่ขนาดปกติ: ย่อตัวอักษร และถ้ายาวมากให้ขึ้นบรรทัดใหม่ได้ (2 บรรทัดในแถวเดียว) แทนการล้นทับช่องถัดไป
function ownerCellClass(owner: string): string {
  if (owner.length > 56) return "owner xs";
  if (owner.length > 38) return "owner sm";
  return "owner";
}

export function formatSheetMoney(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ISO YYYY-MM-DD -> d/m/yyyy แบบไม่เติมศูนย์นำหน้า (22/9/2026) ตามตัวอย่าง
export function sheetDateText(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${Number(match[3])}/${Number(match[2])}/${match[1]}` : iso;
}

const amountOf = (items: unknown, match: (label: string) => boolean): number =>
  (Array.isArray(items) ? (items as Array<{ label: string; amount: number }>) : []).filter((i) => match(i.label)).reduce((s, i) => s + Number(i.amount), 0);

// ยอดของรถ 1 คันที่รวมในช่อง "รวม" ของใบรถยนต์: ค่าธรรมเนียม + ภาษี + ลงขัน + ด่วน (ลงขัน/ด่วนอยู่ในรายการ No bill และไม่แสดงเป็นคอลัมน์บนใบ
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
    plateCategory: v.plateCategory ?? "",
    plateNumber: v.plateNumber ?? "",
    owner: v.owner?.name?.trim() ?? "",
  };
}

// แบ่งรายการเป็นใบส่งงานตาม (ชื่อหัวใบเริ่มต้น, วันที่ยื่น) - 1 ใบต่อ 1 เจ้าของงานต่อ 1 วัน เรียงตามลำดับที่บันทึก
// titleOverrides: key ของใบ -> ชื่อหัวใบที่ผู้ใช้แก้ไข (ไม่กระทบการแบ่งใบ)
export function buildJobSheets(
  kind: JobSheetKind,
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
      kind,
      key: g.key,
      title: titleOverrides[g.key] ?? g.defaultTitle,
      dateText: sheetDateText(g.date),
      note,
      total: g.records.reduce((sum, r) => sum + (kind === "moto" ? Number(r.billFeeTotal) + Number(r.taxAmount ?? 0) : jobSheetRowTotal(r)), 0),
      rows: g.records.map(toJobSheetRow),
    }));
}

export function jobSheetPageCount(sheet: JobSheet): number {
  return Math.max(1, Math.ceil(sheet.rows.length / jobSheetRowsPerPage(sheet.kind)));
}

// แบบ moto: "ค่าธรรมเนียม" ในใบ = ค่าธรรมเนียม (Bill) + ภาษี รวมเป็นช่องเดียว (ตัวอย่าง 315 = 215 + ภาษี รย.12 100) ไม่รวมลงขัน/ค่าอากร
// ภาษีคำนวณไม่ได้ = พิมพ์ "-" ทั้งช่อง ไม่พิมพ์ยอดที่ขาดภาษีให้เข้าใจผิดว่าครบ
function rowCells(kind: JobSheetKind, row: JobSheetRow | undefined): string[] {
  if (!row) return kind === "moto" ? ["", "", "", ""] : ["", "", "", "", ""];
  const hasPlate = row.plateCategory !== "" && row.plateNumber !== "";
  // รูปแบบเลขทะเบียนตามตัวอย่างของแต่ละใบ: รถยนต์ "8ขง-363" (มีขีด) / มอเตอร์ไซค์ "2ฆธ8959" (ไม่มีขีด)
  if (kind === "moto") {
    const plate = hasPlate ? `${row.plateCategory}${row.plateNumber}` : "";
    return [row.chassis, row.owner, row.tax === null ? "-" : formatSheetMoney(row.fee + row.tax), plate];
  }
  const plate = hasPlate ? `${row.plateCategory}-${row.plateNumber}` : "";
  return [row.brand, row.chassis, formatSheetMoney(row.fee), row.tax === null ? "-" : formatSheetMoney(row.tax), plate];
}

function pageHtml(sheet: JobSheet, pageIndex: number): string {
  const perPage = jobSheetRowsPerPage(sheet.kind);
  const start = pageIndex * perPage;
  const columns = sheet.kind === "moto" ? MOTO_COLUMNS : CAR_COLUMNS;
  const body = Array.from({ length: perPage }, (_, i) => {
    const cells = rowCells(sheet.kind, sheet.rows[start + i]);
    // แบบ moto: ช่อง index 1 คือผู้ถือกรรมสิทธิ์
    const cellClass = (c: string, idx: number) => (sheet.kind === "moto" && idx === 1 ? ` class="${ownerCellClass(c)}"` : "");
    return `<tr><td>${start + i + 1}</td>${cells.map((c, idx) => `<td${cellClass(c, idx)}>${escapeHtml(c)}</td>`).join("")}</tr>`;
  }).join("");
  const cols = columns.map(([, w]) => `<col style="width:${w}%">`).join("");
  const head = columns.map(([label]) => `<th>${escapeHtml(label)}</th>`).join("");

  if (sheet.kind === "moto") {
    // หัวใบและหัวตารางอยู่ตารางเดียวกันติดกัน (ตามตัวอย่าง): แถวบน = "มนต์ชัย จิตกุศลรุ่งเรือง - เจ้าของงาน" (กลาง) + "วันที่" + วันที่ตัวใหญ่
    return `<section class="page moto">
<table class="grid"><colgroup>${cols}</colgroup><thead>
<tr class="mhead"><th colspan="3" class="mtitle">${escapeHtml(jobSheetPrintedTitle(sheet))}</th><th class="mdatel">วันที่</th><th class="mdate">${escapeHtml(sheet.dateText)}</th></tr>
<tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="pageno">${pageIndex + 1}</div>
</section>`;
  }

  return `<section class="page">
<table class="box"><tr><td colspan="2" class="title">${escapeHtml(sheet.title)}</td></tr>
<tr><td class="left">วันที่ : ${escapeHtml(sheet.dateText)}</td><td class="right" rowspan="2"><span>รวม</span><b>${formatSheetMoney(sheet.total)}</b></td></tr>
<tr><td class="left note">หมายเหตุ : ${escapeHtml(sheet.note)}</td></tr></table>
<table class="grid"><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="pageno">${pageIndex + 1}</div>
</section>`;
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
  /* แบบมอเตอร์ไซค์: 30 แถว/หน้า แถวเตี้ยกว่าแบบรถยนต์ */
  .moto .grid th { height: 8mm; }
  .moto .grid td { height: 7.9mm; }
  .moto .grid .mhead th { height: 9mm; font-style: normal; }
  .moto .mtitle { font-size: 14pt; white-space: normal; }
  .moto .mdatel { font-size: 8pt; text-align: right; font-style: normal; }
  .moto .mdate { font-size: 14pt; }
  .moto .grid td.owner { overflow: hidden; }
  .moto .grid td.owner.sm { font-size: 8.5pt; }
  .moto .grid td.owner.xs { font-size: 7pt; line-height: 1.1; white-space: normal; }
  .pageno { position: absolute; right: 0; bottom: 0; font-size: 9pt; }
</style>
</head>
<body>
${pages}
</body>
</html>`;
}

// พิมพ์ผ่าน iframe ที่ซ่อนไว้ (ดู print-html.ts) - วิธีเดียวกับใบส่งตรวจรถ
// ชื่อไฟล์ = วันที่-ชื่อหัวใบ (ส่วนที่แก้ได้ ไม่มีคำนำหน้าของใบมอเตอร์ไซค์)-จำนวนคัน เช่น "25-09-2026-MC Superbike-5 คัน" (หลายใบคั่นด้วย ", ")
export function jobSheetFileName(sheets: JobSheet[]): string {
  const pad = (n: string) => n.padStart(2, "0");
  const parts = sheets.map((s) => {
    const [d, m, y] = s.dateText.split("/");
    const date = y ? `${pad(d)}-${pad(m)}-${y}` : s.dateText;
    return `${date}-${s.title.trim()}-${s.rows.length} คัน`;
  });
  return safeFileName(parts.join(", "));
}

export function printJobSheets(sheets: JobSheet[]): void {
  printHtmlDocument(buildJobSheetHtml(sheets), jobSheetFileName(sheets));
}
