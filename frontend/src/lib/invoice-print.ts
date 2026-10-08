import { editableItems, JOB_LABEL, sourceItems, type Invoice, type JobSnapshot, type JobType } from "@/lib/billing-api";
import { COMPANY_PROFILE, personalIssuerOf } from "@/lib/company-profile";
import { bahtText, formatMoney, invoiceContentSummary, invoiceFaceLines, isoToThaiDate, jobsOfItems, round2, sortLinesByPlate } from "@/lib/invoice";

// ใบวางบิล/ใบแจ้งหนี้ + เอกสารแนบรายคัน (A4 แนวตั้ง) ตามแบบที่บริษัทใช้อยู่ใน Google Sheet "Invoice Tradeinter":
// หน้าบิลรวมยอดเป็นไม่กี่บรรทัด รายละเอียดรถรายคันอยู่ในเอกสารแนบ (บิล 100 คัน = หน้าบิล 1 หน้า + เอกสารแนบ 3 หน้า)
// ใช้ HTML ชุดเดียวกันทั้งแสดงตัวอย่างบนจอ (iframe srcDoc) และพิมพ์จริง
// status / voidReason ไม่มีในตัวอย่างบิลที่ยังไม่ได้ออก - บิลที่ยกเลิกแล้วพิมพ์ซ้ำได้แต่มีลายน้ำ "ยกเลิก" ทุกหน้า
// (พบ 2026-09-27: เดิมพิมพ์ออกมาเหมือนบิลปกติ ถ้าหลุดไปถึงลูกค้าจะเท่ากับเรียกเก็บรถชุดเดียวกันซ้ำกับบิลใบใหม่)
export type PrintableInvoice = Pick<
  Invoice,
  | "invoiceNo"
  | "issueDate"
  | "customer"
  | "jobLabel"
  | "extras"
  | "vatRate"
  | "whtRate"
  | "feeTotal"
  | "serviceTotal"
  | "goodsTotal"
  | "vatAmount"
  | "whtAmount"
  | "netTotal"
  | "lines"
  | "items"
> &
  Partial<Pick<Invoice, "status" | "voidReason" | "account" | "quotationNo" | "poNumber" | "faceLayout">>;

const isPersonal = (inv: PrintableInvoice) => inv.account === "PERSONAL";

// หัวผู้ออกบิล: บัญชีบริษัท = บริษัท + เลขผู้เสียภาษี, บัญชีบุคคล = ชื่อตามบัญชีธนาคาร ไม่มีเลขผู้เสียภาษี (ผู้ใช้ 2026-09-27)
function issuerHtml(inv: PrintableInvoice): string {
  if (isPersonal(inv)) {
    const p = personalIssuerOf(inv.customer.payee);
    return `<div><b>${escapeHtml(p.name)}</b>${p.addressLines.length ? `<br><span class="k">${p.addressLines.map(escapeHtml).join("<br>")}</span>` : ""}</div>`;
  }
  const co = COMPANY_PROFILE;
  return `<div><b class="en">${escapeHtml(co.nameEn)}</b><br>${escapeHtml(co.nameTh)}<br>
<span class="k">เลขที่เสียภาษี ${escapeHtml(co.taxId)}<br>${co.addressLines.map(escapeHtml).join("<br>")}<br>โทร ${escapeHtml(co.phone)} · ${escapeHtml(co.email)}</span></div>`;
}

const paymentLinesOf = (inv: PrintableInvoice) => (isPersonal(inv) ? personalIssuerOf(inv.customer.payee).paymentLines : COMPANY_PROFILE.paymentLines);

export const ATTACHMENT_ROWS_PER_PAGE = 40;

// เลขที่เอกสารแนบล้อกับเลขใบวางบิล (ผู้ใช้ 2026-09-28): IV2026-121 -> IV2026-121-A พิมพ์ใต้เลขที่บนหน้าบิลและหัวเอกสารแนบทุกหน้า
const attachmentNo = (inv: PrintableInvoice) => (inv.invoiceNo ? `${inv.invoiceNo}-A` : "—");
const attachmentPageCount = (inv: PrintableInvoice) => attachmentPagesHtml(inv).length;
// บิลกำหนดเองที่ไม่มีรถและไม่มีงานอื่น (ผู้ใช้ 2026-09-29) ไม่มีเอกสารแนบ - หน้าบิลหน้าเดียว
// งานอื่นๆ ในบิล (ผู้ใช้ 2026-10-07) มีตารางของตัวเองในใบแนบ จึงนับเป็นใบแนบด้วย
export const hasInvoiceAttachment = (inv: Pick<PrintableInvoice, "lines" | "items">) => inv.lines.length > 0 || sourceItems(inv.items).length > 0;
const hasAttachment = hasInvoiceAttachment;
// ข้อความอ้างใบแนบ: บิลที่มีแต่รถใช้คำเดิมเป๊ะ (บิลเก่าพิมพ์ซ้ำต้องเหมือนที่ลูกค้าได้รับ) บิลที่มีงานอื่นเพิ่ม "/รายงาน"
export const attachmentDetailText = (inv: Pick<PrintableInvoice, "items">) =>
  sourceItems(inv.items).length ? "รายละเอียดรายคัน/รายงานตามเอกสารแนบ" : "รายละเอียดรถรายคันตามเอกสารแนบ";

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const customerTitle = (c: PrintableInvoice["customer"]) => `${c.name}${c.branch ? ` (${c.branch})` : ""}`;

const isVoid = (inv: PrintableInvoice) => inv.status === "VOID";
const voidMarkHtml = (inv: PrintableInvoice) => (isVoid(inv) ? `<div class="void-mark" aria-hidden="true">ยกเลิก</div>` : "");
const voidNoteHtml = (inv: PrintableInvoice) =>
  isVoid(inv) ? `<span class="void-note">บิลนี้ยกเลิกแล้ว${inv.voidReason ? ` – ${escapeHtml(inv.voidReason)}` : ""}</span>` : "";

// บิลที่ออกจากใบเสนอราคา (ผู้ใช้ 2026-10-01): อ้างเลขใบเสนอราคาและเลข PO ของลูกค้าใต้วันที่ออก
const referenceHtml = (inv: PrintableInvoice) =>
  `${inv.quotationNo ? `<br>อ้างอิงใบเสนอราคา ${escapeHtml(inv.quotationNo)}` : ""}${inv.poNumber ? `<br>PO ${escapeHtml(inv.poNumber)}` : ""}`;

function headHtml(inv: PrintableInvoice, docTitle: string): string {
  return `<div class="co">${issuerHtml(inv)}
<div class="doc">${escapeHtml(docTitle)}<br><span class="k small">เลขที่ ${escapeHtml(inv.invoiceNo || "—")}<br>${hasAttachment(inv) ? `เอกสารแนบเลขที่ ${escapeHtml(attachmentNo(inv))} (${attachmentPageCount(inv)} หน้า)<br>` : ""}วันที่ออก ${escapeHtml(isoToThaiDate(inv.issueDate))}${referenceHtml(inv)}</span></div></div>
${isVoid(inv) ? `<div style="margin-top:3mm">${voidNoteHtml(inv)}</div>` : ""}
<div class="meta"><span class="k">ชื่อลูกค้า</span><br><b>${escapeHtml(customerTitle(inv.customer))}</b><br>
<span class="k">เลขที่เสียภาษี ${escapeHtml(inv.customer.taxId || "—")}<br>${escapeHtml(inv.customer.address || "")}</span></div>`;
}

function invoicePageHtml(inv: PrintableInvoice): string {
  const rows = invoiceFaceLines(inv)
    .map((l) => `<tr><td>${escapeHtml(l.name)}</td><td class="r">${l.qty}</td><td class="r">${formatMoney(l.unit)}</td><td class="r">${formatMoney(round2(l.qty * l.unit))}</td></tr>`)
    .join("");
  return `<section class="page face">${voidMarkHtml(inv)}${headHtml(inv, "ใบวางบิล/ใบแจ้งหนี้")}
<table class="items"><colgroup><col><col style="width:12%"><col style="width:18%"><col style="width:20%"></colgroup>
<thead><tr><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคาต่อหน่วย</th><th class="r">จำนวนเงิน (บาท)</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot"><div><span class="k">เงื่อนไขการชำระเงิน :</span><br>${paymentLinesOf(inv).map(escapeHtml).join("<br>")}<br>
${hasAttachment(inv) ? `<span class="k">${attachmentDetailText(inv)}เลขที่ ${escapeHtml(attachmentNo(inv))}</span>` : ""}</div>
<div class="tot"><div><span>ค่าธรรมเนียม</span><span>${formatMoney(inv.feeTotal)}</span></div>
<div><span>ค่าบริการ</span><span>${formatMoney(inv.serviceTotal)}</span></div>
${inv.goodsTotal > 0 ? `<div><span>ค่าสินค้า</span><span>${formatMoney(inv.goodsTotal)}</span></div>` : ""}
${inv.vatRate > 0 ? `<div><span>ภาษีมูลค่าเพิ่ม ${inv.vatRate}%</span><span>${formatMoney(inv.vatAmount)}</span></div>` : ""}
${inv.whtRate > 0 ? `<div><span>ภาษีหัก ณ ที่จ่าย ${inv.whtRate}%${inv.goodsTotal > 0 ? " (จากค่าบริการ)" : ""}</span><span>${formatMoney(inv.whtAmount)}</span></div>` : ""}
<div class="g"><span>จำนวนเงินทั้งสิ้น</span><span>${formatMoney(inv.netTotal)}</span></div></div></div>
<div class="baht">(${escapeHtml(bahtText(inv.netTotal))})</div>
<div class="sign"><div>ผู้ออกใบวางบิล/ใบแจ้งหนี้<br><span class="k">วันที่ : ${escapeHtml(isoToThaiDate(inv.issueDate))}</span></div><div>ผู้รับสินค้า/บริการ<br><span class="k">วันที่ : ____/____/______</span></div></div>
</section>`;
}

// ตารางหนึ่งในใบแนบ: รถจดใหม่ 1 ตาราง (คอลัมน์เดิม) + งานอื่นๆ ตารางละประเภทงาน (ผู้ใช้ 2026-10-07) ทุกตารางคอลัมน์เท่ากันและมีแถวรวม
// บิลที่มีตารางเดียวพิมพ์เหมือนก่อนมีงานอื่น (ไม่มีชื่อตาราง ไม่มีแถวรวมทุกตาราง)
interface AttachmentTable {
  title: string;
  count: number; // จำนวนคัน / งาน
  unit: string; // "คัน" | "งาน"
  feeHead: string; // หัวคอลัมน์ค่าธรรมเนียม: ใบเสร็จ / ค่าธรรมเนียม / ภาษีที่ชำระ
  refHead: string; // หัวคอลัมน์อ้างอิง: เลขที่ใบเสร็จ / วันที่ชำระ
  rows: Array<{ cells: string[]; fee: number; service: number }>; // cells = ยี่ห้อ, เลขตัวรถ, ทะเบียน, อ้างอิง (escape แล้ว)
  fee: number;
  service: number;
}

const GRID_COLGROUP = `<colgroup><col style="width:5%"><col style="width:10%"><col style="width:21%"><col style="width:11%"><col style="width:13%"><col style="width:10%"><col style="width:11%"><col style="width:8%"><col style="width:11%"></colgroup>`;

function attachmentTables(inv: PrintableInvoice): AttachmentTable[] {
  const tables: AttachmentTable[] = [];
  const lines = sortLinesByPlate(inv.lines);
  if (lines.length) {
    // ค่าธรรมเนียมของรถในตารางนี้ = ทั้งบิลหักบรรทัดค่าธรรมเนียมที่ไม่ใช่ของรถ (งานอื่นๆ มีตารางของตัวเอง บรรทัดพิมพ์เองอยู่ในหน้าบิล)
    const feeCars = round2(inv.feeTotal - inv.items.filter((it) => it.kind === "FEE").reduce((s, it) => s + it.amount, 0));
    tables.push({
      title: `${inv.jobLabel} ${lines.length} คัน`,
      count: lines.length,
      unit: "คัน",
      feeHead: "ใบเสร็จ",
      refHead: "เลขที่ใบเสร็จ",
      rows: lines.map((l) => ({
        cells: [escapeHtml(l.brandName.toUpperCase()), escapeHtml(l.chassis), escapeHtml(l.plateText || "—"), escapeHtml(l.receiptNo || "—")],
        // แถวรายคัน = ค่าใบเสร็จจดทะเบียน + ใบเสร็จแจ้งย้ายของคันนั้น (ผู้ใช้ 2026-10-08: รวมกัน ไม่เพิ่มคอลัมน์)
        // ค่าใบเสร็จของรถเก่าในงานสลับเลขยังอยู่ในแถวรวมผ่าน feeCars เหมือนเดิม
        fee: round2(l.receiptAmount + (l.transferReceiptAmount ?? 0)),
        service: l.serviceFee,
      })),
      fee: feeCars,
      service: round2(lines.reduce((s, l) => s + l.serviceFee, 0)),
    });
  }
  // งานอื่นๆ: จัดกลุ่มตามประเภทงาน เรียงตามวันที่เสร็จแล้วทะเบียน · ยอดอ่านจาก 2 บรรทัดของงาน (FEE / SERVICE) ข้อมูลรถจาก snapshot
  const byType = new Map<JobType, Array<{ snap: JobSnapshot; fee: number; service: number; deductionMark: string }>>();
  for (const job of jobsOfItems(inv.items)) {
    const snap = job.items.find((it) => it.sourceSnapshot)?.sourceSnapshot;
    if (!snap) continue;
    const fee = job.items.filter((it) => it.kind === "FEE").reduce((s, it) => s + it.amount, 0);
    const service = job.items.filter((it) => it.kind === "SERVICE").reduce((s, it) => s + it.amount, 0);
    const list = byType.get(job.type) ?? [];
    list.push({ snap, fee, service, deductionMark: "" });
    byType.set(job.type, list);
  }
  for (const [type, list] of byType) {
    list.sort((a, b) => a.snap.doneDate.localeCompare(b.snap.doneDate) || a.snap.plateText.localeCompare(b.snap.plateText));
    const classes = new Set(list.map((j) => j.snap.vehicleClass));
    const classText = classes.size === 1 ? ` (${[...classes][0] === "MOTO" ? "มอเตอร์ไซค์" : "รถยนต์"})` : "";
    const isTax = type === "TAX_RENEWAL";
    tables.push({
      title: `${JOB_LABEL[type]}${classText} ${list.length} งาน`,
      count: list.length,
      unit: "งาน",
      feeHead: isTax ? "ภาษีที่ชำระ" : "ค่าธรรมเนียม",
      refHead: isTax ? "วันที่คืนเอกสาร" : "เลขที่ใบเสร็จ",
      rows: list.map((j) => ({
        cells: [
          escapeHtml((j.snap.brand ?? "").toUpperCase() || "—"),
          escapeHtml(j.snap.chassis),
          escapeHtml(j.snap.plateText || "—"),
          escapeHtml(isTax ? isoToThaiDate(j.snap.doneDate) : j.snap.receiptNo || "—"),
        ],
        fee: j.fee,
        service: j.service,
      })),
      fee: round2(list.reduce((s, j) => s + j.fee, 0)),
      service: round2(list.reduce((s, j) => s + j.service, 0)),
    });
  }
  return tables;
}

// หน่วยบรรทัดในใบแนบ (ชื่อตาราง / หัวตาราง / แถว / แถวรวม) ไว้แบ่งหน้าทีละ ATTACHMENT_ROWS_PER_PAGE หน่วย
// ตารางที่ข้ามหน้าพิมพ์หัวตารางซ้ำและชื่อตาราง "(ต่อ)" · ไม่ปล่อยชื่อตาราง + หัวตารางค้างท้ายหน้าโดยไม่มีแถว
type AttachmentUnit = { html: string; kind: "title" | "head" | "row" | "sum" | "grand" };
// น้ำหนักต่อหน่วย (หน่วย = ความสูง 1 แถว): หัวตารางและแถวรวมไม่นับ เพื่อให้บิลตารางเดียวแบ่งหน้าเหมือนเดิมเป๊ะ
// (40 คัน = 1 หน้า, ก่อน 2026-10-07 นับเฉพาะแถวรถ) ชื่อตาราง = ระยะห่าง + หัว + แถวรวมของตารางถัดไป ≈ 3 แถว
const UNIT_WEIGHT: Record<AttachmentUnit["kind"], number> = { title: 3, head: 0, row: 1, sum: 0, grand: 2 };

function attachmentUnits(inv: PrintableInvoice, tables: AttachmentTable[]): AttachmentUnit[] {
  const vatOf = (fee: number) => round2((fee * inv.vatRate) / 100);
  const multi = tables.length > 1;
  const units: AttachmentUnit[] = [];
  const deductionLines = inv.lines.filter((l) => l.deduction > 0);
  const marked = new Set(deductionLines.map((l) => l.chassis));
  tables.forEach((t, ti) => {
    const title = multi ? `${ti + 1}. ${t.title}` : "";
    const head = `<thead><tr><th>#</th><th>ยี่ห้อ</th><th>เลขตัวรถ</th><th>ทะเบียน</th><th>${escapeHtml(t.refHead)}</th><th class="r">${escapeHtml(t.feeHead)}</th><th class="r">ค่าบริการ</th><th class="r">VAT ${inv.vatRate}%</th><th class="r">รวม</th></tr></thead>`;
    if (title) units.push({ html: `<div class="tbl-title">${escapeHtml(title)}</div>`, kind: "title" });
    units.push({ html: `<table class="grid">${GRID_COLGROUP}${head}<tbody>`, kind: "head" });
    t.rows.forEach((r, i) => {
      const vat = vatOf(r.service);
      // คันที่มีหักยอด (ลูกค้าชำระค่าขอใช้เลขเอง) ใส่ * ท้ายค่าบริการเหมือนเดิม - อ่านจากเลขตัวรถที่ escape แล้ว (เลขตัวรถไม่มีอักขระพิเศษ)
      const star = t.unit === "คัน" && marked.has(r.cells[1]) ? " *" : "";
      units.push({
        html: `<tr><td>${i + 1}</td><td>${r.cells[0]}</td><td class="mono">${r.cells[1]}</td><td>${r.cells[2]}</td><td>${r.cells[3]}</td><td class="r">${formatMoney(r.fee)}</td><td class="r">${formatMoney(r.service)}${star}</td><td class="r">${formatMoney(vat)}</td><td class="r">${formatMoney(round2(r.fee + r.service + vat))}</td></tr>`,
        kind: "row",
      });
    });
    const vatSum = round2(t.rows.reduce((s, r) => s + vatOf(r.service), 0));
    units.push({
      html: `<tr class="sum"><td colspan="5">รวม ${t.count} ${t.unit}</td><td class="r">${formatMoney(t.fee)}</td><td class="r">${formatMoney(t.service)}</td><td class="r">${formatMoney(vatSum)}</td><td class="r">${formatMoney(round2(t.fee + t.service + vatSum))}</td></tr></tbody></table>`,
      kind: "sum",
    });
  });
  if (multi) {
    const fee = round2(tables.reduce((s, t) => s + t.fee, 0));
    const service = round2(tables.reduce((s, t) => s + t.service, 0));
    const vat = round2(tables.reduce((s, t) => s + t.rows.reduce((v, r) => v + vatOf(r.service), 0), 0));
    const count = tables.reduce((s, t) => s + t.count, 0);
    units.push({
      html: `<table class="grid" style="margin-top:4mm">${GRID_COLGROUP}<tbody><tr class="sum"><td colspan="5">รวมทุกตาราง ${count} รายการ</td><td class="r">${formatMoney(fee)}</td><td class="r">${formatMoney(service)}</td><td class="r">${formatMoney(vat)}</td><td class="r">${formatMoney(round2(fee + service + vat))}</td></tr></tbody></table>`,
      kind: "grand",
    });
  }
  return units;
}

function attachmentPagesHtml(inv: PrintableInvoice): string[] {
  const tables = attachmentTables(inv);
  if (tables.length === 0) return [];
  const units = attachmentUnits(inv, tables);
  const typed = editableItems(inv.items);

  // แบ่งหน้า: หน้าละไม่เกิน 40 หน่วย ตารางที่ต่อข้ามหน้าขึ้นหัวตารางใหม่ (ชื่อตาราง "(ต่อ)" ถ้ามีชื่อ)
  const pages: string[][] = [];
  let page: string[] = [];
  let used = 0; // น้ำหนักที่ใช้ไปในหน้านี้
  let openTable: { title: string | null; head: string } | null = null;
  const flush = () => {
    if (page.length === 0) return;
    if (openTable) page.push(`</tbody></table>`);
    pages.push(page);
    page = [];
    used = 0;
    if (openTable) {
      if (openTable.title) {
        page.push(`<div class="tbl-title">${escapeHtml(openTable.title)} (ต่อ)</div>`);
        used += UNIT_WEIGHT.title;
      }
      page.push(openTable.head);
    }
  };
  let pendingTitle: string | null = null;
  for (const u of units) {
    // ชื่อตาราง + หัวตารางต้องมีแถวตามอย่างน้อย 1 แถวในหน้าเดียวกัน
    const need = UNIT_WEIGHT[u.kind] + (u.kind === "title" || u.kind === "head" ? UNIT_WEIGHT.row : 0);
    if (used + need > ATTACHMENT_ROWS_PER_PAGE) flush();
    used += UNIT_WEIGHT[u.kind];
    if (u.kind === "title") {
      pendingTitle = u.html.replace(/<[^>]+>/g, "");
      page.push(u.html);
      continue;
    }
    if (u.kind === "head") {
      openTable = { title: pendingTitle, head: u.html };
      pendingTitle = null;
      page.push(u.html);
      continue;
    }
    if (u.kind === "sum") openTable = null;
    page.push(u.html);
  }
  if (page.length) pages.push(page);

  const pageCount = pages.length;
  const summary = invoiceContentSummary(inv);
  const deductions = [...new Set(inv.lines.filter((l) => l.deduction > 0).map((l) => `${l.deductionNote || "หักยอด"} ${formatMoney(l.deduction)} บาท`))];
  const notes = `${deductions.length ? `<div class="k note">* ${deductions.map(escapeHtml).join(" / ")}</div>` : ""}
${typed.length ? `<div class="k note">รายการอื่นของบิลนี้ ${typed.length} บรรทัด (${typed.map((it) => `${escapeHtml(it.description)} ${formatMoney(it.amount)}`).join(", ")}) แสดงในหน้าใบวางบิล ไม่รวมในตารางนี้</div>` : ""}
${inv.extras.length ? `<div class="k note">ค่าใช้จ่ายอื่นๆ ของบิล (${inv.extras.map((e) => `${escapeHtml(e.label)} ${formatMoney(e.amount)}`).join(", ")}) แสดงในหน้าใบวางบิล ไม่รวมในตารางนี้</div>` : ""}`;

  return pages.map(
    (body, p) => `<section class="page att">${voidMarkHtml(inv)}<div class="atthead"><div><b>เอกสารแนบเลขที่ ${escapeHtml(attachmentNo(inv))}</b> <span class="k">(ของใบวางบิล ${escapeHtml(inv.invoiceNo || "—")})</span> · ${escapeHtml(customerTitle(inv.customer))}${isVoid(inv) ? ` · ${voidNoteHtml(inv)}` : ""}<br>
<span class="k">${escapeHtml(summary)} · วันที่ออก ${escapeHtml(isoToThaiDate(inv.issueDate))}</span></div><div class="k">หน้า ${p + 1}/${pageCount}</div></div>
${body.join("\n")}${p === pageCount - 1 ? notes : ""}</section>`,
  );
}

// CSS ชุดเดียวกันของใบวางบิลและใบกำกับภาษี (lib/tax-invoice-print.ts) - หน้าตาเหมือนกัน (ผู้ใช้ 2026-09-28)
export const PRINT_CSS = `  @page { size: A4 portrait; margin: 12mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif; color: #111; font-size: 10pt; line-height: 1.5; font-variant-numeric: tabular-nums; }
  .page { position: relative; page-break-after: always; break-after: page; }
  .void-mark { position: absolute; left: 0; right: 0; top: 30%; text-align: center; font-size: 110pt; font-weight: 600; color: rgba(190, 0, 0, .16); transform: rotate(-30deg); pointer-events: none; z-index: 1; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .void-note { color: #b00000; font-weight: 600; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .k { color: #555; }
  .small { font-size: 10pt; font-weight: 400; }
  .r { text-align: right; }
  .co { display: flex; justify-content: space-between; gap: 8mm; }
  .co .en { font-size: 13pt; letter-spacing: .3px; }
  .doc { font-size: 15pt; font-weight: 600; text-align: right; white-space: nowrap; }
  .meta { margin-top: 5mm; padding-top: 4mm; border-top: 1px solid #999; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .items { margin-top: 6mm; }
  .items th { border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 2mm 1mm; text-align: left; font-weight: 600; }
  .items th.r { text-align: right; }
  .items td { padding: 1.8mm 1mm; border-bottom: 1px solid #ddd; vertical-align: top; }
  .foot { display: flex; justify-content: space-between; gap: 8mm; margin-top: 6mm; }
  .tot { width: 78mm; flex-shrink: 0; }
  .tot div { display: flex; justify-content: space-between; padding: .8mm 0; }
  .tot .g { border-top: 1px solid #111; margin-top: 1mm; padding-top: 2mm; font-weight: 600; font-size: 11.5pt; }
  .baht { text-align: right; margin-top: 2mm; color: #555; }
  .sign { display: flex; justify-content: space-between; gap: 20mm; margin-top: 22mm; text-align: center; }
  /* ช่องเซ็นผู้ออกบิล/ผู้รับชิดขอบล่างของหน้าบิล (ผู้ใช้ 2026-09-28) - หน้าบิลสูงเกือบเต็มพื้นที่พิมพ์ A4 (297 - ขอบ 24 = 273mm)
     เผื่อไว้ 5mm ไม่ให้ล้นเป็นหน้าว่าง · ช่องเซ็นดันลงล่างด้วย margin-top: auto */
  @media print { .face { display: flex; flex-direction: column; min-height: 268mm; } .face .sign { margin-top: auto; padding-top: 22mm; } }
  .sign div { flex: 1; border-top: 1px solid #999; padding-top: 2mm; }
  .atthead { display: flex; justify-content: space-between; align-items: flex-end; gap: 6mm; margin-bottom: 3mm; }
  .atthead > .k:last-child { white-space: nowrap; flex-shrink: 0; }
  .grid th { border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 1.2mm .8mm; font-size: 8.5pt; font-weight: 600; text-align: left; }
  .grid th.r { text-align: right; }
  /* แถวเตี้ยพอให้ 40 คัน (ATTACHMENT_ROWS_PER_PAGE) อยู่ใน A4 หน้าเดียว - เดิมล้นไปหน้าใหม่ 1-2 แถว บิล 61 คันพิมพ์ออกมา 4 หน้า (พบ 2026-09-28) */
  .grid td { padding: .8mm .8mm; font-size: 8.5pt; line-height: 1.25; border-bottom: 1px solid #e2e2e2; white-space: nowrap; overflow: hidden; }
  .grid .mono { font-family: Consolas, "Courier New", monospace; font-size: 8pt; }
  .grid .sum td { border-top: 1px solid #111; border-bottom: 0; font-weight: 600; padding-top: 1.6mm; }
  .note { margin-top: 2mm; font-size: 8.5pt; }
  /* ชื่อตารางในใบแนบที่มีหลายตาราง (งานอื่นๆ ผู้ใช้ 2026-10-07) */
  .tbl-title { margin: 5mm 0 1.5mm; font-weight: 600; font-size: 10pt; }
  .tbl-title:first-child { margin-top: 2mm; }
  @media screen { body { padding: 10mm 12mm; } .page { margin-bottom: 10mm; padding-bottom: 10mm; border-bottom: 1px dashed #bbb; } .page:last-child { border-bottom: 0; } }
`;

export function buildInvoiceHtml(inv: PrintableInvoice): string {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${isVoid(inv) ? "ยกเลิก - " : ""}${escapeHtml(inv.invoiceNo || "ใบวางบิล")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&display=swap" rel="stylesheet">
<style>
${PRINT_CSS}</style>
</head>
<body>
${invoicePageHtml(inv)}
${hasAttachment(inv) ? attachmentPagesHtml(inv).join("\n") : ""}
</body>
</html>`;
}

// พิมพ์ผ่าน iframe ที่ซ่อนไว้ (วิธีเดียวกับใบส่งงาน) - เลือกเครื่องพิมพ์หรือ "บันทึกเป็น PDF" ได้จากหน้าต่างพิมพ์ของเบราว์เซอร์
export function printInvoice(inv: PrintableInvoice): void {
  printHtml(buildInvoiceHtml(inv));
}

export function printHtml(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  iframe.srcdoc = html;

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
