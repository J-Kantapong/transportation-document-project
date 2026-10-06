import type { RateKind } from "@/lib/billing-api";
import { COMPANY_PROFILE, PERSONAL_PROFILE } from "@/lib/company-profile";
import { bahtText, formatMoney, isoToThaiDate, round2 } from "@/lib/invoice";
import { escapeHtml, PRINT_CSS, printHtml } from "@/lib/invoice-print";
import type { PayslipSignature } from "@/lib/hr-api";
import { quotationGrandTotal, type Quotation, type QuotationItem } from "@/lib/quotation-api";

// ใบเสนอราคา (ผู้ใช้ 2026-10-01) - หน้าตาเดียวกับใบวางบิล (CSS ชุดเดียวกัน) ต่างกันที่: ชื่อเอกสาร, วันยืนราคา, เรื่อง,
// ยอดรวมก่อนหัก ณ ที่จ่าย (หัก ณ ที่จ่ายเป็นหมายเหตุ), เงื่อนไข, ช่องเซ็น ผู้เสนอราคา / ผู้อนุมัติ (ลูกค้า)
// แบบราคาต่อคันพิมพ์เป็นตารางราคา ไม่มียอดรวม · ร่างและใบที่ยกเลิก/ถูกแทนที่มีลายน้ำ
export type PrintableQuotation = Pick<
  Quotation,
  | "quotationNo"
  | "kind"
  | "status"
  | "customer"
  | "issueDate"
  | "validUntil"
  | "title"
  | "conditions"
  | "account"
  | "vatRate"
  | "whtRate"
  | "feeTotal"
  | "serviceTotal"
  | "goodsTotal"
  | "vatAmount"
  | "whtAmount"
  | "items"
>;

export const RATE_KIND_LABEL: Record<RateKind, string> = {
  BASE: "ราคาหลัก",
  OTHER_PROVINCE: "ค่าเพิ่ม: ขอใช้ (จดจังหวัดอื่น)",
  URGENT: "ค่าเพิ่ม: ด่วน",
  PLATE_REQUEST: "ค่าเพิ่ม: ขอใช้เลขทะเบียน",
  TRANSFER_NOTICE: "ค่าเพิ่ม: แจ้งย้าย",
  PLATE_SWAP: "ค่าเพิ่ม: สลับเลข",
  PLATE_SWAP_GIVEN: "ค่าเพิ่ม: สลับเลข (ลูกค้าจ่ายเอง)",
};

const cc = (n: number) => n.toLocaleString("en-US");

// เงื่อนไขของแถวราคาเป็นข้อความสั้น เช่น "จักรยานยนต์ · 300 ถึงต่ำกว่า 800 cc · เลขตัวถังขึ้นต้น ML"
export function rateConditionText(it: Pick<QuotationItem, "rateKind" | "vehicleKind" | "ccMin" | "ccMax" | "chassisPrefix">): string {
  const parts: string[] = [];
  if (it.rateKind && it.rateKind !== "BASE") parts.push(RATE_KIND_LABEL[it.rateKind].replace("ค่าเพิ่ม: ", "ค่าเพิ่มเมื่อ"));
  if (it.vehicleKind === "CAR") parts.push("รถยนต์");
  if (it.vehicleKind === "MOTO") parts.push("จักรยานยนต์");
  if (it.ccMin !== null && it.ccMax !== null) parts.push(`${cc(it.ccMin)} ถึงต่ำกว่า ${cc(it.ccMax)} cc`);
  else if (it.ccMin !== null) parts.push(`ตั้งแต่ ${cc(it.ccMin)} cc`);
  else if (it.ccMax !== null) parts.push(`ต่ำกว่า ${cc(it.ccMax)} cc`);
  if (it.chassisPrefix) parts.push(`เลขตัวถังขึ้นต้น ${it.chassisPrefix}`);
  return parts.join(" · ");
}

function issuerHtml(q: PrintableQuotation): string {
  if (q.account === "PERSONAL") {
    const p = PERSONAL_PROFILE;
    return `<div><b>${escapeHtml(p.name)}</b>${p.addressLines.length ? `<br><span class="k">${p.addressLines.map(escapeHtml).join("<br>")}</span>` : ""}</div>`;
  }
  const co = COMPANY_PROFILE;
  return `<div><b class="en">${escapeHtml(co.nameEn)}</b><br>${escapeHtml(co.nameTh)}<br>
<span class="k">เลขที่เสียภาษี ${escapeHtml(co.taxId)}<br>${co.addressLines.map(escapeHtml).join("<br>")}<br>โทร ${escapeHtml(co.phone)} · ${escapeHtml(co.email)}</span></div>`;
}

// ตัวเลือกการพิมพ์: ลายเซ็นผู้เสนอราคา (ผู้ใช้ 2026-10-06, ชุดเดียวกับสลิปเงินเดือน) พิมพ์เฉพาะใบที่ออกเลขแล้วและยังใช้ได้
// ร่าง / ยกเลิก / ถูกแทนที่ไม่พิมพ์ลายเซ็น กันเอาใบที่ยังไม่อนุมัติหรือเลิกใช้ไปใช้ต่อ
export interface QuotationPrintOptions {
  signature?: Pick<PayslipSignature, "exists" | "imageDataUrl" | "signerName"> | null;
}

const markOf = (q: PrintableQuotation) => (q.status === "DRAFT" ? "ร่าง" : q.status === "CANCELLED" || q.status === "SUPERSEDED" ? "ยกเลิก" : "");

function jobBodyHtml(q: PrintableQuotation): string {
  const rows = q.items
    .map(
      (it, i) =>
        `<tr><td>${i + 1}</td><td>${escapeHtml(it.description)}</td><td class="r">${it.quantity.toLocaleString("en-US")}</td><td class="r">${formatMoney(it.unitPrice)}</td><td class="r">${formatMoney(it.amount)}</td></tr>`,
    )
    .join("");
  const grand = quotationGrandTotal(q);
  const whtNote =
    q.whtRate > 0
      ? `<div class="k note">หมายเหตุ: เมื่อชำระเงิน หักภาษี ณ ที่จ่าย ${q.whtRate}% จากค่าบริการ = ${formatMoney(q.whtAmount)} บาท คงเหลือชำระ ${formatMoney(round2(grand - q.whtAmount))} บาท</div>`
      : "";
  return `<table class="items"><colgroup><col style="width:8%"><col><col style="width:12%"><col style="width:17%"><col style="width:19%"></colgroup>
<thead><tr><th>ลำดับ</th><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคาต่อหน่วย</th><th class="r">จำนวนเงิน (บาท)</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot"><div>${conditionsHtml(q)}</div>
<div class="tot">${q.feeTotal > 0 ? `<div><span>ค่าธรรมเนียม</span><span>${formatMoney(q.feeTotal)}</span></div>` : ""}
<div><span>ค่าบริการ</span><span>${formatMoney(q.serviceTotal)}</span></div>
${q.goodsTotal > 0 ? `<div><span>ค่าสินค้า</span><span>${formatMoney(q.goodsTotal)}</span></div>` : ""}
${q.vatRate > 0 ? `<div><span>ภาษีมูลค่าเพิ่ม ${q.vatRate}%</span><span>${formatMoney(q.vatAmount)}</span></div>` : ""}
<div class="g"><span>รวมทั้งสิ้น</span><span>${formatMoney(grand)}</span></div></div></div>
<div class="baht">(${escapeHtml(bahtText(grand))})</div>${whtNote}`;
}

function rateBodyHtml(q: PrintableQuotation): string {
  const rows = q.items
    .map((it, i) => {
      const flags = [it.vatInclusive ? "รวม VAT แล้ว" : "", it.includesReceipt ? "รวมค่าใบเสร็จกรมขนส่งแล้ว" : ""].filter(Boolean).join(" · ");
      const condition = [rateConditionText(it), flags].filter(Boolean).join(" · ");
      return `<tr><td>${i + 1}</td><td>${escapeHtml(it.description)}${condition ? `<br><span class="k">${escapeHtml(condition)}</span>` : ""}</td><td class="r">${formatMoney(it.unitPrice)}</td></tr>`;
    })
    .join("");
  const exVat = q.vatRate > 0 && q.items.some((it) => !it.vatInclusive);
  const notes = [
    exVat ? `ราคาที่ไม่ได้ระบุว่ารวม VAT แล้ว ยังไม่รวมภาษีมูลค่าเพิ่ม ${q.vatRate}%` : "",
    q.items.some((it) => !it.includesReceipt) ? "ราคาเป็นค่าบริการต่อคัน ไม่รวมค่าธรรมเนียมตามใบเสร็จกรมการขนส่งทางบก ซึ่งเรียกเก็บตามจริง" : "",
  ].filter(Boolean);
  return `<table class="items"><colgroup><col style="width:8%"><col><col style="width:24%"></colgroup>
<thead><tr><th>ลำดับ</th><th>รายการ</th><th class="r">ราคาต่อคัน (บาท)</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot"><div>${notes.map((n) => `<span class="k">${escapeHtml(n)}</span>`).join("<br>")}${notes.length ? "<br>" : ""}${conditionsHtml(q)}</div></div>`;
}

const conditionsHtml = (q: PrintableQuotation) =>
  `<span class="k">ยืนราคาถึงวันที่ ${escapeHtml(isoToThaiDate(q.validUntil))}</span>${
    q.conditions ? `<br><span class="k">เงื่อนไข :</span><br>${escapeHtml(q.conditions).replace(/\n/g, "<br>")}` : ""
  }`;

export function buildQuotationHtml(q: PrintableQuotation, options: QuotationPrintOptions = {}): string {
  const c = q.customer;
  const mark = markOf(q);
  const sig = !mark && q.quotationNo && options.signature?.exists && options.signature.imageDataUrl?.startsWith("data:image/png;base64,") ? options.signature : null;
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${mark ? `${mark} - ` : ""}${escapeHtml(q.quotationNo || "ใบเสนอราคา")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&display=swap" rel="stylesheet">
<style>
${PRINT_CSS}
  /* ช่องเซ็น (ผู้เสนอราคา / ผู้อนุมัติ) ชิดล่างสุดของหน้าพิมพ์ (ผู้ใช้ 2026-10-06): พื้นที่พิมพ์ A4 สูง 273 มม. (ขอบ 12 มม. บนล่าง) เว้น 1 มม. กันล้นไปหน้าถัดไป */
  @media print { .face { min-height: 272mm; } }
</style>
</head>
<body>
<section class="page face">${mark ? `<div class="void-mark" aria-hidden="true">${mark}</div>` : ""}
<div class="co">${issuerHtml(q)}
<div class="doc">ใบเสนอราคา<br><span class="k small">เลขที่ ${escapeHtml(q.quotationNo || "— (ร่าง)")}<br>วันที่ ${escapeHtml(isoToThaiDate(q.issueDate))}<br>ยืนราคาถึง ${escapeHtml(isoToThaiDate(q.validUntil))}</span></div></div>
<div class="meta"><span class="k">เสนอ</span><br><b>${escapeHtml(c.name)}${c.branch ? ` (${escapeHtml(c.branch)})` : ""}</b><br>
<span class="k">${c.taxId ? `เลขที่เสียภาษี ${escapeHtml(c.taxId)}<br>` : ""}${escapeHtml(c.address || "")}</span>
${q.title ? `<div style="margin-top:2mm"><span class="k">เรื่อง</span> ${escapeHtml(q.title)}</div>` : ""}</div>
${q.kind === "RATE" ? rateBodyHtml(q) : jobBodyHtml(q)}
<div class="sign"><div style="position:relative">${sig ? `<img src="${sig.imageDataUrl}" alt="" style="position:absolute;left:50%;bottom:100%;transform:translateX(-50%);max-height:11mm;max-width:40mm;margin-bottom:.6mm">` : ""}ผู้เสนอราคา${sig?.signerName ? `<br><span class="k">(${escapeHtml(sig.signerName)})</span>` : ""}<br><span class="k">วันที่ : ${escapeHtml(isoToThaiDate(q.issueDate))}</span></div><div>ผู้อนุมัติ (ลูกค้า)<br><span class="k">วันที่ : ____/____/______</span></div></div>
</section>
</body>
</html>`;
}

export function printQuotation(q: PrintableQuotation, options: QuotationPrintOptions = {}): void {
  printHtml(buildQuotationHtml(q, options));
}
