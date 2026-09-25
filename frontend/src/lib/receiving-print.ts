import { isoToDisplayDate } from "@/lib/date";
import { escapeHtml, printHtmlDocument, safeFileName } from "@/lib/print-html";

// ปริ้นรายการรถรอรับป้าย/รับเล่มไปยื่นขนส่ง (ผู้ใช้ 2026-09-26): พนักงานเลือกชุดงาน (ใบยื่น) ที่จะปริ้น
// แต่ละใบเป็นตารางของตัวเอง ลำดับรถตามที่เลือกบนหน้าจอ (ลำดับที่ยื่นเป็นค่าเริ่มต้น หรือเรียงตามหมวด+เลขทะเบียน)
export interface ReceivingPrintRow {
  plateCategory: string | null;
  plateNumber: string | null;
  receiptNo?: string | null;
  chassis: string;
}

export interface ReceivingPrintSheet {
  date: string; // YYYY-MM-DD วันที่ยื่น
  label: string; // กลุ่มใบส่งงาน เช่น รย.1 แบบธรรมดา
  owner: string; // เจ้าของงาน (ลูกค้า)
  rows: ReceivingPrintRow[];
}

const esc = (text: string | null | undefined) => escapeHtml(text ?? "");

function sheetHtml(sheet: ReceivingPrintSheet): string {
  const rows = sheet.rows
    .map(
      (r, i) => `<tr><td class="c">${i + 1}</td><td>${esc(r.plateCategory) || "—"}</td><td>${esc(r.plateNumber) || "—"}</td>
<td>${esc(r.receiptNo) || "—"}</td><td>${esc(r.chassis)}</td><td></td></tr>`,
    )
    .join("");
  return `<section>
<h2>วันที่ยื่น ${esc(sheet.date ? isoToDisplayDate(sheet.date) : "ไม่ทราบ")} · ${esc(sheet.label)} · ${esc(sheet.owner)} · ${sheet.rows.length} คัน</h2>
<table><thead><tr><th class="c">ลำดับ</th><th>หมวด</th><th>เลขทะเบียน</th><th>เลขที่ใบเสร็จ</th><th>เลขตัวถัง</th><th>หมายเหตุ</th></tr></thead>
<tbody>${rows}</tbody></table>
</section>`;
}

export function buildReceivingListHtml(title: string, orderText: string, sheets: ReceivingPrintSheet[]): string {
  const total = sheets.reduce((n, s) => n + s.rows.length, 0);
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif; color: #000; font-size: 10pt; }
  h1 { font-size: 16pt; margin: 0 0 1mm; }
  h2 { font-size: 11.5pt; margin: 5mm 0 1.5mm; }
  p { margin: 0 0 2mm; }
  section { break-inside: auto; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th, td { border: 1.5px solid #000; padding: 1.2mm 1.5mm; text-align: left; vertical-align: middle; }
  th { background: #eee; font-weight: 700; }
  .c { text-align: center; width: 10mm; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<p>${sheets.length} ใบยื่น · ${total} คัน · ${esc(orderText)}</p>
${sheets.map(sheetHtml).join("")}
</body>
</html>`;
}

export function printReceivingList(title: string, orderText: string, sheets: ReceivingPrintSheet[]): void {
  const total = sheets.reduce((n, s) => n + s.rows.length, 0);
  printHtmlDocument(buildReceivingListHtml(title, orderText, sheets), safeFileName(`${title} ${sheets.length} ใบ ${total} คัน`));
}
