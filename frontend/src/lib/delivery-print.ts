import { slipNoText, type DeliveryRow, type DeliverySlip, type DeliverySlipItem } from "@/lib/billing-api";
import { DELIVERY_HEADER } from "@/lib/company-profile";
import { isoToDisplayDate } from "@/lib/date";
import { downloadHtmlAsPdf } from "@/lib/pdf-export";
import { escapeHtml, printHtmlDocument } from "@/lib/print-html";

// ใบส่งงาน Delivery (ให้ผู้รับเซ็น) และรายงานส่งงานย้อนหลัง - ผู้ใช้ 2026-09-25: บอกแยกรายคันว่าส่งใบเสร็จ / เล่ม / ป้าย
// ห้ามมีราคา (พนักงานส่งของไม่เห็นราคา)
// ผู้ใช้ 2026-09-26: ใบเสร็จส่งไปพร้อมใบวางบิล ไม่ได้ไปกับใบส่งงาน -> ไม่มีช่องใบเสร็จ
// ช่องใบส่งงานตามผู้ใช้ 2026-09-26: ลำดับ, เลขตัวถัง, เลขทะเบียน, ยี่ห้อ, ชื่อเจ้าของ (+ ติ๊กเล่ม / ป้าย)
// ส่งแล้ว = วงกลมทึบ (ผู้ใช้ 2026-09-26 ขอเปลี่ยนจากติ๊ก)
const TICK = "●";

const esc = (text: string | null | undefined) => escapeHtml(text ?? "");
const tick = (sent: boolean) => (sent ? TICK : "");

export interface DeliveryCounts {
  vehicles: number;
  book: number;
  plate: number;
}

export function countItems(items: DeliverySlipItem[]): DeliveryCounts {
  return {
    vehicles: items.length,
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

// ทุกแถวสูงเท่ากัน (ผู้ใช้ 2026-09-26): ช่องกว้างคงที่ ข้อความบรรทัดเดียว ข้อความยาวย่อตัวอักษรลงจนพอดีช่อง
// วัดความกว้างจริงในเอกสาร (FIT_SCRIPT) หลังฟอนต์โหลดเสร็จ - ทั้งหน้าต่างพิมพ์และบันทึก PDF รอ fonts.ready ก่อนเสมอ
// .slip กว้างเท่าพื้นที่พิมพ์ A4 (210 - ขอบ 12mm x2) จึงวัดบนจอได้ตรงกับบนกระดาษ ย่อได้ต่ำสุด 6pt แล้วค่อยตัดด้วย "…"
const fitCell = (text: string, align = "") => `<td class="fit${align ? ` ${align}` : ""}"><span>${esc(text)}</span></td>`;

// วัดที่ span (ความกว้างข้อความจริง) เทียบกับพื้นที่ในช่อง - scrollWidth ของ td ในตาราง table-layout: fixed เชื่อไม่ได้
const FIT_SCRIPT = `<script>
(function () {
  function fit() {
    document.querySelectorAll("td.fit").forEach(function (td) {
      var span = td.firstElementChild;
      var cs = getComputedStyle(td);
      var room = td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      span.style.fontSize = "";
      var pt = 10;
      while (span.getBoundingClientRect().width > room && pt > 6) {
        pt -= 0.25;
        span.style.fontSize = pt + "pt";
      }
    });
  }
  // วัดซ้ำทุกครั้งที่ความกว้างตัวอักษรอาจเปลี่ยน: ฟอนต์ Noto Sans Thai โหลดเสร็จช้ากว่าหน้า และก่อนพิมพ์
  fit();
  window.addEventListener("load", fit);
  window.addEventListener("beforeprint", fit);
  if (document.fonts) {
    document.fonts.ready.then(fit);
    document.fonts.addEventListener("loadingdone", fit);
  }
})();
</script>`;

function slipHtml(slip: DeliverySlip): string {
  const c = countItems(slip.items);
  const platePending = slip.items.filter((i) => !i.plate).length;
  const customer = slip.customer;
  const customerName = customer.displayName + (customer.branch ? ` (สาขา ${customer.branch})` : "");
  const rows = slip.items
    .map(
      (i, n) => `<tr><td class="c no">${n + 1}</td>${fitCell(i.chassis)}${fitCell(i.plateText || "—")}${fitCell(i.brandName)}
${fitCell(i.ownerName || "—")}<td class="tick">${tick(i.book)}</td><td class="tick">${tick(i.plate)}</td></tr>`,
    )
    .join("");
  const co = DELIVERY_HEADER;
  const signBox = (role: string, name: string | null) => `<div class="signbox"><div class="role">${role}</div>
<div class="line"></div><div class="who">(${name ? esc(name) : "&nbsp;".repeat(40)})</div>
<div class="date">วันที่ ______ / ______ / __________</div></div>`;
  return `<section class="slip">
<div class="head">
<div class="co">
<div class="name">${esc(co.name)}</div>
<div>${co.addressLines.map(esc).join("<br>")}</div>
<div>เลขประจำตัวผู้เสียภาษี : ${esc(co.taxId)}</div>
<div>โทร : ${esc(co.phone)}<span class="gap"></span>อีเมล : ${esc(co.email)}</div>
</div>
<div class="doc"><div class="title">ใบส่งงาน<span>DELIVERY NOTE</span></div>
<div class="row"><span class="k">เลขที่</span><b>${esc(slipNoText(slip.slipNo))}</b></div>
<div class="row"><span class="k">วันที่ส่ง</span><b>${esc(isoToDisplayDate(slip.date))}</b></div></div>
</div>
<div class="info">
<div class="card grow"><div class="label">ลูกค้า</div><div class="main">${esc(customerName)}</div>
${customer.address ? `<div>${esc(customer.address)}</div>` : ""}${customer.phone ? `<div>โทร ${esc(customer.phone)}</div>` : ""}
${slip.note ? `<div class="label sub">หมายเหตุ</div><div>${esc(slip.note)}</div>` : ""}</div>
</div>
<table class="grid rows"><colgroup><col style="width:12mm"><col style="width:43mm"><col style="width:22mm"><col style="width:25mm"><col><col style="width:10mm"><col style="width:10mm"></colgroup>
<thead><tr><th class="c">ลำดับ</th><th>เลขตัวถัง</th><th>เลขทะเบียน</th><th>ยี่ห้อ</th><th>ชื่อเจ้าของ</th>
<th class="c">เล่ม</th><th class="c">ป้าย</th></tr></thead>
<tbody>${rows}
<tr class="total"><td colspan="5">รวม ${c.vehicles} คัน</td><td class="c">${c.book}</td><td class="c">${c.plate}</td></tr></tbody>
<tfoot><tr class="edge"><td colspan="7"></td></tr></tfoot></table>
<div class="tail">
<p class="ref">ใบส่งงานเลขที่ ${esc(slipNoText(slip.slipNo))} · ${esc(customer.displayName)} · รวม ${c.vehicles} คัน</p>
${platePending ? `<p class="note">ป้ายยังไม่ออก ${platePending} คัน (ช่องป้ายว่าง) จะส่งตามทีหลัง</p>` : ""}
<div class="sign">${signBox("ผู้ส่งงาน", slip.createdBy)}${signBox("ผู้รับงาน", slip.recipient)}</div>
</div>
</section>`;
}

// ใบส่งงานพิมพ์ขาวดำเป็นหลัก (ผู้ใช้ 2026-09-26): ไม่มีพื้นสี ตัวอักษรดำทั้งหมด - เด่นด้วยเส้นกับตัวหนาแทนการถมสี
// ประหยัดหมึก คมทุกเครื่องพิมพ์ ถ่ายเอกสารต่อได้ชัด โครงเดิม: หัวบริษัท + กล่องชื่อเอกสาร, การ์ดลูกค้า, ตาราง, ช่องลงชื่อ
const LINE = "#9a9a9a";
const SLIP_STYLE = `
  .slip { page-break-after: always; break-after: page; width: 186mm; }
  .slip:last-child { page-break-after: auto; break-after: auto; }
  /* หัวบริษัท: ข้อมูลบริษัท + กล่องชื่อเอกสารด้านขวา - ไม่มีโลโก้ (ผู้ใช้ 2026-09-26) */
  .head { display: flex; align-items: stretch; gap: 5mm; padding-bottom: 3.5mm; margin-bottom: 4mm; border-bottom: 2px solid #000; }
  .co { flex: 1; font-size: 8.8pt; line-height: 1.55; align-self: center; }
  .co .name { font-size: 14pt; font-weight: 700; line-height: 1.3; margin-bottom: 0.8mm; }
  .co .gap { display: inline-block; width: 6mm; }
  .doc { flex: none; width: 56mm; border: 1.5px solid #000; border-radius: 2.5mm; }
  .doc .title { text-align: center; font-size: 17pt; font-weight: 700; line-height: 1.15; padding: 2mm 0 1.6mm; border-bottom: 1.5px solid #000; }
  .doc .title span { display: block; font-size: 7pt; font-weight: 400; letter-spacing: 3px; margin-top: 0.8mm; }
  .doc .row { display: flex; justify-content: space-between; align-items: baseline; padding: 1.9mm 4mm; }
  .doc .row + .row { border-top: 0.8px solid ${LINE}; }
  .doc .row .k { font-size: 8.8pt; }
  .doc .row b { font-size: 11.5pt; }
  /* การ์ดลูกค้า (ชื่อผู้รับอยู่ในช่องลงชื่อผู้รับงานแล้ว ไม่ต้องซ้ำด้านบน - ผู้ใช้ 2026-09-26) */
  .info { margin-bottom: 4mm; }
  .card { border: 1px solid #000; border-radius: 2mm; padding: 2.2mm 3.5mm; font-size: 9pt; line-height: 1.5; }
  .card .label { font-size: 7.8pt; letter-spacing: 0.3px; }
  .card .label.sub { margin-top: 1.2mm; }
  .card .main { font-size: 11pt; font-weight: 700; }
  /* ตาราง: ช่องกว้างคงที่ ทุกแถวสูงเท่ากัน (ผู้ใช้ 2026-09-26) - หัวตารางตัวหนาพื้นขาว เส้นใต้หนา, แถวคั่นเส้นบาง */
  .slip .grid.rows { table-layout: fixed; border: 1.5px solid #000; border-bottom: 0; }
  /* tfoot ว่างสูง 0 มีแค่เส้นบนหนา - เบราว์เซอร์พิมพ์ tfoot ซ้ำท้ายทุกหน้า จึงเป็นเส้นปิดล่างของตารางทุกหน้าที่ถูกตัด */
  .slip .grid.rows tfoot td { height: 0; padding: 0; border: 0; border-top: 1.5px solid #000; }
  .slip .grid th, .slip .grid td { border: 0; border-bottom: 0.6px solid ${LINE}; padding: 1.2mm 2mm; }
  .slip .grid td + td, .slip .grid th + th { border-left: 0.6px solid ${LINE}; }
  .slip .grid th { background: none; font-size: 9pt; font-weight: 700; white-space: nowrap; border-bottom: 1.5px solid #000; }
  .slip .grid.rows td { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; height: 7.8mm; line-height: 5mm; }
  /* การจัดแนว: ลำดับ / เล่ม / ป้าย กึ่งกลาง, ตัวถัง / ทะเบียน / ยี่ห้อ / ชื่อ ชิดซ้าย (ผู้ใช้ 2026-09-26) - หัวตารางตามคอลัมน์ของตัวเอง
     ข้อความที่ถูกย่อ (FIT_SCRIPT) ตั้ง line-height 0 ไม่ให้ดันเส้นฐานของบรรทัด จึงอยู่ระดับเดียวกับช่องอื่นในแถว */
  .slip .grid th.c, .slip .grid td.c { text-align: center; }
  .slip .grid td.fit span { line-height: 0; }
  .slip .grid .tick { font-size: 11pt; line-height: 1; }
  /* แถวรวมอยู่ใน tbody ไม่ใช่ tfoot - tfoot ถูกพิมพ์ซ้ำท้ายทุกหน้า (ใช้เป็นเส้นปิดล่างด้านบนแทน) */
  .slip .grid tr.total td { font-weight: 700; border-top: 1.5px solid #000; border-bottom: 0; }
  /* ท้ายใบ (หมายเหตุ + ช่องลงชื่อ) ไม่แยกหน้า - ถ้าตกไปหน้าใหม่ บรรทัด .ref บอกว่าเป็นของใบไหน รวมกี่คัน */
  .slip .tail { break-inside: avoid; page-break-inside: avoid; margin-top: 3.5mm; }
  .slip .tail .ref { font-size: 9pt; font-weight: 700; margin: 0 0 1mm; }
  .slip .tail .note { font-size: 9pt; margin: 0; }
  .sign { display: flex; gap: 8mm; margin-top: 8mm; }
  .signbox { flex: 1; border: 1px solid #000; border-radius: 2mm; padding: 3mm 6mm 3.5mm; text-align: center; font-size: 9.5pt; }
  .signbox .role { font-weight: 700; font-size: 10pt; }
  .signbox .line { border-bottom: 1px dotted #000; height: 14mm; margin: 0 4mm 1.8mm; }
  .signbox .who { margin-bottom: 1.5mm; }
  .signbox .date { font-size: 9pt; }
`;

export function buildDeliverySlipHtml(slips: DeliverySlip[]): string {
  const title = slips.length === 1 ? `ใบส่งงาน ${slipNoText(slips[0].slipNo)}` : "ใบส่งงาน";
  return htmlDocument(title, "size: A4 portrait; margin: 12mm;", SLIP_STYLE, slips.map(slipHtml).join("\n") + FIT_SCRIPT);
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
<td class="tick">${tick(i.book)}</td><td class="tick">${tick(i.plate)}</td></tr>`,
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
${r.slips.length} ใบ · ${c.vehicles} รายการ · เล่ม ${c.book} · ป้าย ${c.plate}</p>
<table class="grid"><thead><tr><th>วันที่ส่ง</th><th>เลขที่ใบ</th><th>ลูกค้า</th><th>ผู้รับ</th><th>ทะเบียน</th><th>เลขตัวถัง</th>
<th class="c">เล่ม</th><th class="c">ป้าย</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" class="c">ไม่มีรายการ</td></tr>'}</tbody></table>
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
