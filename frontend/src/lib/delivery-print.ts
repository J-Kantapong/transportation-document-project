import { slipNoText, type DeliveryRow, type DeliverySlip, type DeliverySlipItem } from "@/lib/billing-api";
import { isoToDisplayDate } from "@/lib/date";
import { downloadHtmlAsPdf } from "@/lib/pdf-export";
import { escapeHtml, printHtmlDocument } from "@/lib/print-html";

// ใบส่งงาน Delivery (ให้ผู้รับเซ็น) และรายงานส่งงานย้อนหลัง - ผู้ใช้ 2026-09-25: บอกแยกรายคันว่าส่งใบเสร็จ / เล่ม / ป้าย
// ห้ามมีราคา (พนักงานส่งของไม่เห็นราคา)
const TICK = "✓";

const esc = (text: string | null | undefined) => escapeHtml(text ?? "");
const tick = (sent: boolean) => (sent ? TICK : "");

export interface DeliveryCounts {
  vehicles: number;
  receipt: number;
  book: number;
  plate: number;
}

export function countItems(items: DeliverySlipItem[]): DeliveryCounts {
  return {
    vehicles: items.length,
    receipt: items.filter((i) => i.receipt).length,
    book: items.filter((i) => i.book).length,
    plate: items.filter((i) => i.plate).length,
  };
}

const BASE_STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, "Segoe UI Symbol", sans-serif; color: #000; font-size: 10pt; }
  h1 { font-size: 18pt; margin: 0; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .grid th, .grid td { border: 1.5px solid #000; padding: 1.2mm 1.5mm; text-align: left; vertical-align: middle; }
  .grid th { background: #eee; font-weight: 700; }
  .grid .c { text-align: center; }
  .grid .tick { text-align: center; font-size: 12pt; font-weight: 700; width: 16mm; }
  .grid tfoot td { font-weight: 700; }
  .muted { color: #444; }
`;

function htmlDocument(title: string, pageRule: string, extraStyle: string, body: string): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page { ${pageRule} }
${BASE_STYLE}
${extraStyle}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function slipHtml(slip: DeliverySlip): string {
  const c = countItems(slip.items);
  const platePending = slip.items.filter((i) => !i.plate).length;
  const customerLines = [
    slip.customer.displayName + (slip.customer.branch ? ` (สาขา ${slip.customer.branch})` : ""),
    slip.customer.address ?? "",
    slip.customer.phone ? `โทร ${slip.customer.phone}` : "",
  ].filter(Boolean);
  const rows = slip.items
    .map(
      (i, n) => `<tr><td class="c">${n + 1}</td><td>${esc(i.plateText) || "—"}</td><td>${esc(i.chassis)}</td><td>${esc(i.brandName)}</td>
<td>${esc(i.receiptNo) || "—"}</td><td class="tick">${tick(i.receipt)}</td><td class="tick">${tick(i.book)}</td><td class="tick">${tick(i.plate)}</td></tr>`,
    )
    .join("");
  return `<section class="slip">
<div class="head"><h1>ใบส่งงาน</h1><div class="no"><b>เลขที่ ${esc(slipNoText(slip.slipNo))}</b><br>วันที่ส่ง ${esc(isoToDisplayDate(slip.date))}</div></div>
<table class="info"><tr><td class="k">ลูกค้า</td><td>${customerLines.map(esc).join("<br>")}</td></tr>
<tr><td class="k">ผู้รับ</td><td>${esc(slip.recipient)}</td></tr>
${slip.note ? `<tr><td class="k">หมายเหตุ</td><td>${esc(slip.note)}</td></tr>` : ""}</table>
<table class="grid"><thead><tr><th class="c" style="width:10mm">ลำดับ</th><th>ทะเบียน</th><th>เลขตัวถัง</th><th>ยี่ห้อ</th><th>เลขที่ใบเสร็จ</th>
<th class="c">ใบเสร็จ</th><th class="c">เล่ม</th><th class="c">ป้าย</th></tr></thead>
<tbody>${rows}</tbody>
<tfoot><tr><td colspan="5">รวม ${c.vehicles} คัน</td><td class="c">${c.receipt}</td><td class="c">${c.book}</td><td class="c">${c.plate}</td></tr></tfoot></table>
${platePending ? `<p>ป้ายยังไม่ออก ${platePending} คัน (ช่องป้ายว่าง) จะส่งตามทีหลัง</p>` : ""}
<table class="sign"><tr>
<td>ลงชื่อ ................................................ ผู้ส่ง<br>${slip.createdBy ? `(${esc(slip.createdBy)})` : "(................................................)"}<br>วันที่ ........../........../..........</td>
<td>ลงชื่อ ................................................ ผู้รับ<br>(${esc(slip.recipient)})<br>วันที่ ........../........../..........</td>
</tr></table>
</section>`;
}

const SLIP_STYLE = `
  .slip { page-break-after: always; break-after: page; }
  .slip:last-child { page-break-after: auto; break-after: auto; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4mm; }
  .head .no { text-align: right; font-size: 11pt; }
  .info { margin-bottom: 4mm; }
  .info td { padding: 0.8mm 0; vertical-align: top; }
  .info .k { width: 22mm; font-weight: 700; }
  .sign { margin-top: 14mm; }
  .sign td { width: 50%; text-align: center; line-height: 2.2; }
`;

export function buildDeliverySlipHtml(slips: DeliverySlip[]): string {
  const title = slips.length === 1 ? `ใบส่งงาน ${slipNoText(slips[0].slipNo)}` : "ใบส่งงาน";
  return htmlDocument(title, "size: A4 portrait; margin: 12mm;", SLIP_STYLE, slips.map(slipHtml).join("\n"));
}

export function printDeliverySlips(slips: DeliverySlip[]): void {
  printHtmlDocument(buildDeliverySlipHtml(slips));
}

export interface DeliveryReportInput {
  from: string; // YYYY-MM-DD หรือ "" = ไม่จำกัด
  to: string;
  customerName: string | null; // null = ทุกลูกค้า
  slips: DeliverySlip[];
  platePending: DeliveryRow[]; // ส่งเล่มไปแล้ว ป้ายยังไม่ได้ส่ง
}

export function buildDeliveryReportHtml(r: DeliveryReportInput): string {
  const items = r.slips.flatMap((s) => s.items);
  const c = countItems(items);
  const range = [r.from ? isoToDisplayDate(r.from) : "", r.to ? isoToDisplayDate(r.to) : ""].filter(Boolean).join(" - ") || "ทั้งหมด";
  const rows = r.slips
    .flatMap((s) =>
      s.items.map(
        (i, n) => `<tr${n === 0 ? ' class="first"' : ""}><td>${n === 0 ? esc(isoToDisplayDate(s.date)) : ""}</td><td>${n === 0 ? esc(slipNoText(s.slipNo)) : ""}</td>
<td>${n === 0 ? esc(s.customer.displayName) : ""}</td><td>${n === 0 ? esc(s.recipient) : ""}</td><td>${esc(i.plateText) || "—"}</td><td>${esc(i.chassis)}</td>
<td class="tick">${tick(i.receipt)}</td><td class="tick">${tick(i.book)}</td><td class="tick">${tick(i.plate)}</td></tr>`,
      ),
    )
    .join("");
  const pending = r.platePending
    .map(
      (v) => `<tr><td>${esc(v.customerName)}</td><td>${v.plateCategory && v.plateNumber ? esc(`${v.plateCategory} ${v.plateNumber}`) : "—"}</td><td>${esc(v.chassis)}</td>
<td>${v.deliveredDate ? esc(isoToDisplayDate(v.deliveredDate)) : "—"}</td><td>${v.kind === "PLATE_ONLY" ? "ป้ายมาแล้ว รอส่ง" : "รอป้ายออก"}</td></tr>`,
    )
    .join("");
  const body = `<h1>รายงานส่งงาน</h1>
<p>วันที่ส่ง ${esc(range)} · ลูกค้า ${esc(r.customerName ?? "ทั้งหมด")}<br>
${r.slips.length} ใบ · ${c.vehicles} รายการ · ใบเสร็จ ${c.receipt} · เล่ม ${c.book} · ป้าย ${c.plate}</p>
<table class="grid"><thead><tr><th>วันที่ส่ง</th><th>เลขที่ใบ</th><th>ลูกค้า</th><th>ผู้รับ</th><th>ทะเบียน</th><th>เลขตัวถัง</th>
<th class="c">ใบเสร็จ</th><th class="c">เล่ม</th><th class="c">ป้าย</th></tr></thead>
<tbody>${rows || '<tr><td colspan="9" class="c">ไม่มีรายการ</td></tr>'}</tbody></table>
<h2>ป้ายค้างส่ง (${r.platePending.length} คัน)</h2>
${
  r.platePending.length
    ? `<table class="grid"><thead><tr><th>ลูกค้า</th><th>ทะเบียน</th><th>เลขตัวถัง</th><th>ส่งเล่มเมื่อ</th><th>สถานะ</th></tr></thead><tbody>${pending}</tbody></table>`
    : "<p>ไม่มี</p>"
}`;
  return htmlDocument(
    "รายงานส่งงาน",
    "size: A4 landscape; margin: 10mm;",
    `h2 { font-size: 13pt; margin: 6mm 0 2mm; } p { margin: 2mm 0 4mm; } .grid tr.first td { border-top-width: 2.5px; }`,
    body,
  );
}

export function printDeliveryReport(r: DeliveryReportInput): void {
  printHtmlDocument(buildDeliveryReportHtml(r));
}

// ดาวน์โหลดเป็นไฟล์ PDF โดยตรง - ขอบกระดาษเท่ากับ @page ของแต่ละแบบ (ดู pdf-export.ts)
export function downloadDeliverySlipPdf(slip: DeliverySlip): Promise<void> {
  return downloadHtmlAsPdf(buildDeliverySlipHtml([slip]), `ใบส่งงาน-${slipNoText(slip.slipNo)}.pdf`, { orientation: "portrait", marginMm: 12 });
}

export function downloadDeliveryReportPdf(r: DeliveryReportInput): Promise<void> {
  const range = [r.from, r.to].filter(Boolean).join("_") || "ทั้งหมด";
  return downloadHtmlAsPdf(buildDeliveryReportHtml(r), `รายงานส่งงาน-${range}.pdf`, { orientation: "landscape", marginMm: 10 });
}
