import type { TaxInvoice } from "@/lib/billing-api";
import { COMPANY_PROFILE } from "@/lib/company-profile";
import { bahtText, formatMoney, invoiceFaceLines, isoToThaiDate, round2 } from "@/lib/invoice";
import { escapeHtml, PRINT_CSS, printHtml } from "@/lib/invoice-print";

// ใบกำกับภาษี/ใบเสร็จรับเงิน (ผู้ใช้ 2026-09-28) - หน้าตาเดียวกับใบวางบิล (CSS ชุดเดียวกัน) ต่างกันที่:
// ชื่อเอกสาร + ป้ายต้นฉบับ/สำเนา, เลข TV + อ้างอิงเลขใบวางบิล, วันที่ = วันรับเงิน, ช่องยอดรวมก่อนหัก ณ ที่จ่ายแล้วต่อด้วย
// ยอดหักจริงและรับชำระสุทธิ, "ได้รับเงินแล้ว" แทนเงื่อนไขชำระเงิน, ช่องเซ็นช่องเดียว "ผู้รับเงิน"
// รายละเอียดรถรายคันไม่พิมพ์ซ้ำ - อ้างเอกสารแนบของใบวางบิล (IV…-A, ผู้ใช้เลือกแบบ ก)
// mode: original = ต้นฉบับ + สำเนา (พิมพ์ต้นฉบับได้เฉพาะวันที่ออกใบ) · copy = สำเนาอย่างเดียว · replacement = ใบแทน + สำเนา
export type TaxInvoicePrintMode = "original" | "copy" | "replacement";

function buyerHtml(t: TaxInvoice): string {
  const c = t.customer;
  const taxLine = c.taxId ? `เลขที่เสียภาษี ${escapeHtml(c.taxId)} · สาขา ${escapeHtml(c.branch || "สำนักงานใหญ่")}` : t.buyerNotVatRegistered ? "ผู้ซื้อไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม" : "";
  return `<div class="meta"><span class="k">ชื่อลูกค้า</span><br><b>${escapeHtml(c.name)}</b><br>
<span class="k">${taxLine}${taxLine ? "<br>" : ""}${escapeHtml(c.address || "")}</span></div>`;
}

function pageHtml(t: TaxInvoice, tag: string): string {
  const co = COMPANY_PROFILE;
  const cancelled = t.status === "CANCELLED";
  const rows = invoiceFaceLines(t)
    .map((l) => `<tr><td>${escapeHtml(l.name)}</td><td class="r">${l.qty}</td><td class="r">${formatMoney(l.unit)}</td><td class="r">${formatMoney(round2(l.qty * l.unit))}</td></tr>`)
    .join("");
  const attachmentNo = `${t.invoiceNo}-A`;
  const refs = [
    `อ้างอิงใบวางบิล ${escapeHtml(t.invoiceNo)}`,
    t.lineCount ? `เอกสารแนบเลขที่ ${escapeHtml(attachmentNo)}` : "",
    t.replacesNo ? `ออกแทนใบเลขที่ ${escapeHtml(t.replacesNo)} (ยกเลิก)` : "",
  ].filter(Boolean);
  const replacementNote =
    tag === "ใบแทน" && t.replacementIssuedAt
      ? `<div class="k" style="margin-top:2mm">ใบแทนออกให้วันที่ ${escapeHtml(isoToThaiDate(t.replacementIssuedAt.slice(0, 10)))}${t.replacementReason ? ` เนื่องจาก ${escapeHtml(t.replacementReason)}` : ""}</div>`
      : "";
  return `<section class="page face">${cancelled ? `<div class="void-mark" aria-hidden="true">ยกเลิก</div>` : ""}
<div class="co"><div><b class="en">${escapeHtml(co.nameEn)}</b><br>${escapeHtml(co.nameTh)}<br>
<span class="k">เลขที่เสียภาษี ${escapeHtml(co.taxId)}<br>${co.addressLines.map(escapeHtml).join("<br>")}<br>โทร ${escapeHtml(co.phone)} · ${escapeHtml(co.email)}</span></div>
<div class="doc"><span class="tag">${escapeHtml(tag)}</span><br>ใบกำกับภาษี/ใบเสร็จรับเงิน<br><span class="k small">เลขที่ ${escapeHtml(t.taxInvoiceNo)}<br>${refs.join("<br>")}<br>วันที่ ${escapeHtml(isoToThaiDate(t.issueDate))}</span></div></div>
${cancelled ? `<div style="margin-top:3mm"><span class="void-note">ใบกำกับนี้ยกเลิกแล้ว${t.cancelReason ? ` – ${escapeHtml(t.cancelReason)}` : ""}</span></div>` : ""}
${replacementNote}
${buyerHtml(t)}
<table class="items"><colgroup><col><col style="width:12%"><col style="width:18%"><col style="width:20%"></colgroup>
<thead><tr><th>รายการ</th><th class="r">จำนวน</th><th class="r">ราคาต่อหน่วย</th><th class="r">จำนวนเงิน (บาท)</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot"><div><span class="k">ได้รับเงินแล้ว :</span><br>${COMPANY_PROFILE.paymentLines.map(escapeHtml).join("<br>")}<br>วันที่ ${escapeHtml(isoToThaiDate(t.issueDate))}<br>
${t.lineCount ? `<span class="k">รายละเอียดรถรายคันตามเอกสารแนบเลขที่ ${escapeHtml(attachmentNo)}</span><br>` : ""}
${t.feeTotal > 0 ? `<span class="k">ค่าธรรมเนียมกรมการขนส่งทางบกเป็นเงินทดรองจ่าย ไม่รวมในมูลค่าที่คิดภาษีมูลค่าเพิ่ม</span>` : ""}</div>
<div class="tot">${t.feeTotal > 0 ? `<div><span>ค่าธรรมเนียม (ทดรองจ่าย)</span><span>${formatMoney(t.feeTotal)}</span></div>` : ""}
<div><span>ค่าบริการ</span><span>${formatMoney(t.serviceTotal)}</span></div>
${t.goodsTotal > 0 ? `<div><span>ค่าสินค้า</span><span>${formatMoney(t.goodsTotal)}</span></div>` : ""}
<div><span>ภาษีมูลค่าเพิ่ม ${t.vatRate}%</span><span>${formatMoney(t.vatAmount)}</span></div>
<div class="g"><span>รวมเงินทั้งสิ้น</span><span>${formatMoney(t.grandTotal)}</span></div>
${t.whtAmount > 0 ? `<div class="k"><span>หัก ภาษี ณ ที่จ่าย</span><span>${formatMoney(t.whtAmount)}</span></div><div class="paid"><span>รับชำระสุทธิ</span><span>${formatMoney(t.receivedAmount)}</span></div>` : ""}</div></div>
<div class="baht">(${escapeHtml(bahtText(t.grandTotal))})</div>
<div class="sign one"><div>ผู้รับเงิน<br><span class="k">วันที่ : ${escapeHtml(isoToThaiDate(t.issueDate))}</span></div></div>
</section>`;
}

const EXTRA_CSS = `
  .tag { display: inline-block; border: 1.5px solid #111; padding: 0 3mm; font-size: 10pt; font-weight: 600; margin-bottom: 1.5mm; }
  .tot .paid { border-top: 1px dashed #999; margin-top: 1mm; padding-top: 1.5mm; font-weight: 600; }
  .sign.one { justify-content: flex-end; }
  .sign.one div { flex: 0 0 70mm; }
`;

export function buildTaxInvoiceHtml(t: TaxInvoice, mode: TaxInvoicePrintMode): string {
  // ใบที่ยกเลิกแล้วพิมพ์ได้แค่สำเนา (มีลายน้ำ) ไว้เก็บเข้าแฟ้ม
  const tags = t.status === "CANCELLED" || mode === "copy" ? ["สำเนา"] : mode === "replacement" ? ["ใบแทน", "สำเนา"] : ["ต้นฉบับ", "สำเนา"];
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${t.status === "CANCELLED" ? "ยกเลิก - " : ""}${escapeHtml(t.taxInvoiceNo)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600&display=swap" rel="stylesheet">
<style>
${PRINT_CSS}${EXTRA_CSS}</style>
</head>
<body>
${tags.map((tag) => pageHtml(t, tag)).join("\n")}
</body>
</html>`;
}

export function printTaxInvoice(t: TaxInvoice, mode: TaxInvoicePrintMode): void {
  printHtml(buildTaxInvoiceHtml(t, mode));
}

// พิมพ์ต้นฉบับได้เฉพาะวันที่กดออกใบ (เผื่อกระดาษติด) - หลังจากนั้นพิมพ์ได้แค่สำเนา ต้นฉบับหาย = ออกใบแทน (ผู้ใช้ 2026-09-28)
export function canPrintOriginal(t: TaxInvoice, todayIso: string): boolean {
  if (t.status !== "ISSUED") return false;
  const created = new Date(t.createdAt);
  const bangkok = new Date(created.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return bangkok === todayIso;
}
