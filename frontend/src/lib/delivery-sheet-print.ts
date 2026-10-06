import { DELIVERY_HEADER } from "@/lib/company-profile";
import { isoToDisplayDate } from "@/lib/date";
import { esc, FIT_SCRIPT, fitCell, htmlDocument, SLIP_STYLE, tick } from "@/lib/delivery-print";
import { SHEET_SOURCE_LABEL, type SheetGroup, type SheetRow, type SheetSection } from "@/lib/delivery-sheet";
import { downloadHtmlAsPdf } from "@/lib/pdf-export";
import { printHtmlDocument, safeFileName } from "@/lib/print-html";
import { slipNoText } from "@/lib/billing-api";

// ใบส่งงานรวมทุกประเภท (ผู้ใช้ 2026-10-05): 1 ใบ = เจ้าของงาน 1 ราย x 1 วัน แบ่งช่วงตามประเภทงาน - หน้าตา/สไตล์เดียวกับใบ DL
// (หัวบริษัท, ขาวดำ, ทุกแถวสูงเท่ากัน, ช่องลงชื่อท้ายใบ) ไม่มีราคา ไม่ใช่ใบ DL (ไม่มีเลข DL ของตัวเอง) - อ้างเลข DL ที่รวมอยู่ท้ายใบ
// รถจดใหม่/สลับเลข: ช่องเล่ม/ป้ายเป็นวงกลมทึบเหมือนใบ DL, ประเภทอื่น: ช่อง "รายการ" บอกว่างานอะไร (ยามาฮ่าไม่มีรายคัน มีแต่ขนาด + จำนวน)

const SECTION_STYLE = `
  .slip .sec th { text-align: left; font-size: 10.5pt; border-bottom: 0.6px solid #9a9a9a; padding: 1.8mm 2mm 1mm; }
  .slip .sec th span { font-weight: 400; font-size: 8.5pt; }
  .slip .grid + .grid { margin-top: 5mm; }
`;

const COLS = {
  ticks: ["12mm", "40mm", "24mm", "26mm", "", "10mm", "10mm"], // ลำดับ ตัวถัง ทะเบียน ยี่ห้อ เจ้าของ เล่ม ป้าย
  plain: ["12mm", "40mm", "24mm", "26mm", "", "38mm"], // ลำดับ ตัวถัง ทะเบียน ยี่ห้อ เจ้าของ รายการ
  yamaha: ["12mm", ""], // ลำดับ รายการ
};

const colgroup = (widths: string[]) => `<colgroup>${widths.map((w) => `<col${w ? ` style="width:${w}"` : ""}>`).join("")}</colgroup>`;

function sectionHtml(section: SheetSection): string {
  const first = section.rows[0];
  const label = SHEET_SOURCE_LABEL[section.source];
  // ใบ DL บอกว่าวันที่คือวันส่งงานอยู่แล้ว - ประเภทอื่นบอกว่าวันที่ของใบนี้มาจากวันอะไร (ไม่มีขั้นส่งงานของตัวเอง)
  const note = section.source === "VEHICLE" || section.source === "PLATE_SWAP" ? "" : ` <span>· ${esc(first.dateLabel)}</span>`;
  const title = (cols: number) => `<tr class="sec"><th colspan="${cols}">${esc(label)} ${section.rows.length} รายการ${note}</th></tr>`;

  if (section.source === "YAMAHA") {
    const body = section.rows.map((r, n) => `<tr><td class="c">${n + 1}</td>${fitCell(r.detail)}</tr>`).join("");
    return `<table class="grid rows">${colgroup(COLS.yamaha)}<thead>${title(2)}<tr><th class="c">ลำดับ</th><th>รายการ</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="edge"><td colspan="2"></td></tr></tfoot></table>`;
  }
  if (section.source === "VEHICLE" || section.source === "PLATE_SWAP") {
    const body = section.rows
      .map(
        (r, n) => `<tr><td class="c no">${n + 1}</td>${fitCell(r.chassis)}${fitCell(r.plateText || "—")}${fitCell(r.brand)}${fitCell(r.ownerName || "—")}<td class="tick">${tick(!!r.book)}</td><td class="tick">${tick(!!r.plate)}</td></tr>`,
      )
      .join("");
    return `<table class="grid rows">${colgroup(COLS.ticks)}<thead>${title(7)}<tr><th class="c">ลำดับ</th><th>เลขตัวถัง</th><th>เลขทะเบียน</th><th>ยี่ห้อ</th><th>ชื่อเจ้าของ</th><th class="c">เล่ม</th><th class="c">ป้าย</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="edge"><td colspan="7"></td></tr></tfoot></table>`;
  }
  const ownerHead = section.source === "TRANSFER" ? "ผู้รับโอน" : "ชื่อเจ้าของ";
  const body = section.rows
    .map(
      (r: SheetRow, n) => `<tr><td class="c no">${n + 1}</td>${fitCell(r.chassis)}${fitCell(r.plateText || "—")}${fitCell(r.brand || "—")}${fitCell(r.ownerName || "—")}${fitCell(r.detail)}</tr>`,
    )
    .join("");
  return `<table class="grid rows">${colgroup(COLS.plain)}<thead>${title(6)}<tr><th class="c">ลำดับ</th><th>เลขตัวถัง</th><th>เลขทะเบียน</th><th>ยี่ห้อ</th><th>${ownerHead}</th><th>รายการ</th></tr></thead><tbody>${body}</tbody><tfoot><tr class="edge"><td colspan="6"></td></tr></tfoot></table>`;
}

const signBox = (role: string) => `<div class="signbox"><div class="role">${role}</div>
<div class="line"></div><div class="who">(${"&nbsp;".repeat(40)})</div>
<div class="date">วันที่ ______ / ______ / __________</div></div>`;

function groupHtml(group: SheetGroup): string {
  const co = DELIVERY_HEADER;
  const bySource = group.sections.map((s) => `${SHEET_SOURCE_LABEL[s.source]} ${s.rows.length}`).join(" · ");
  const dlRef = group.slipNos.length ? ` · อ้างอิงใบส่งงาน ${group.slipNos.map(slipNoText).join(", ")}` : "";
  return `<section class="slip">
<div class="head">
<div class="co">
<div class="name">${esc(co.name)}</div>
<div>${co.addressLines.map(esc).join("<br>")}</div>
<div>เลขประจำตัวผู้เสียภาษี : ${esc(co.taxId)}</div>
<div>โทร : ${esc(co.phone)}<span class="gap"></span>อีเมล : ${esc(co.email)}</div>
</div>
<div class="doc"><div class="title">ใบส่งงาน<span>รวมทุกงาน</span></div>
<div class="row"><span class="k">วันที่</span><b>${esc(isoToDisplayDate(group.date))}</b></div></div>
</div>
<div class="info"><div class="card"><div class="label">เจ้าของงาน</div><div class="main">${esc(group.ownerLabel)}</div></div></div>
${group.sections.map(sectionHtml).join("\n")}
<div class="tail">
<p class="ref">${esc(group.ownerLabel)} · ${esc(isoToDisplayDate(group.date))} · รวม ${group.count} รายการ (${esc(bySource)})${esc(dlRef)}</p>
<div class="sign">${signBox("ผู้ส่งงาน")}${signBox("ผู้รับงาน")}</div>
</div>
</section>`;
}

export function buildDeliverySheetHtml(groups: SheetGroup[]): string {
  return htmlDocument("ใบส่งงานรวมทุกงาน", "size: A4 portrait; margin: 12mm;", SLIP_STYLE + SECTION_STYLE, groups.map(groupHtml).join("\n") + FIT_SCRIPT);
}

export function printDeliverySheets(groups: SheetGroup[]): void {
  printHtmlDocument(buildDeliverySheetHtml(groups));
}

// ชื่อไฟล์ PDF: ใบเดียว = วันที่-เจ้าของงาน, หลายใบ = ชื่อกลางๆ ตามช่วงวันที่ที่เลือก
export function deliverySheetPdfName(groups: SheetGroup[], range: { from: string; to: string }): string {
  if (groups.length === 1) return safeFileName(`ใบส่งงานรวม-${groups[0].date}-${groups[0].ownerLabel}`) + ".pdf";
  const span = [range.from, range.to].filter(Boolean).join("_") || "ทั้งหมด";
  return safeFileName(`ใบส่งงานรวม-${span}`) + ".pdf";
}

export function downloadDeliverySheetPdf(groups: SheetGroup[], range: { from: string; to: string }): Promise<void> {
  return downloadHtmlAsPdf(buildDeliverySheetHtml(groups), deliverySheetPdfName(groups, range), { orientation: "portrait", marginMm: 12 });
}
