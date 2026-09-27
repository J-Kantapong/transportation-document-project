import type { Invoice } from "@/lib/billing-api";
import { COMPANY_PROFILE, PERSONAL_PROFILE } from "@/lib/company-profile";
import { bahtText, formatMoney, invoiceFaceLines, isoToThaiDate, round2, sortLinesByPlate } from "@/lib/invoice";

// ใบวางบิล/ใบแจ้งหนี้ + เอกสารแนบรายคัน (A4 แนวตั้ง) ตามแบบที่บริษัทใช้อยู่ใน Google Sheet "Invoice Tradeinter":
// หน้าบิลรวมยอดเป็นไม่กี่บรรทัด รายละเอียดรถรายคันอยู่ในเอกสารแนบ (บิล 100 คัน = หน้าบิล 1 หน้า + เอกสารแนบ 3 หน้า)
// ใช้ HTML ชุดเดียวกันทั้งแสดงตัวอย่างบนจอ (iframe srcDoc) และพิมพ์จริง
// status / voidReason ไม่มีในตัวอย่างบิลที่ยังไม่ได้ออก - บิลที่ยกเลิกแล้วพิมพ์ซ้ำได้แต่มีลายน้ำ "ยกเลิก" ทุกหน้า
// (พบ 2026-09-27: เดิมพิมพ์ออกมาเหมือนบิลปกติ ถ้าหลุดไปถึงลูกค้าจะเท่ากับเรียกเก็บรถชุดเดียวกันซ้ำกับบิลใบใหม่)
export type PrintableInvoice = Pick<
  Invoice,
  "invoiceNo" | "issueDate" | "customer" | "jobLabel" | "extras" | "vatRate" | "whtRate" | "feeTotal" | "serviceTotal" | "vatAmount" | "whtAmount" | "netTotal" | "lines"
> &
  Partial<Pick<Invoice, "status" | "voidReason" | "account">>;

const isPersonal = (inv: PrintableInvoice) => inv.account === "PERSONAL";

// หัวผู้ออกบิล: บัญชีบริษัท = บริษัท + เลขผู้เสียภาษี, บัญชีบุคคล = ชื่อตามบัญชีธนาคาร ไม่มีเลขผู้เสียภาษี (ผู้ใช้ 2026-09-27)
function issuerHtml(inv: PrintableInvoice): string {
  if (isPersonal(inv)) {
    const p = PERSONAL_PROFILE;
    return `<div><b>${escapeHtml(p.name)}</b>${p.addressLines.length ? `<br><span class="k">${p.addressLines.map(escapeHtml).join("<br>")}</span>` : ""}</div>`;
  }
  const co = COMPANY_PROFILE;
  return `<div><b class="en">${escapeHtml(co.nameEn)}</b><br>${escapeHtml(co.nameTh)}<br>
<span class="k">เลขที่เสียภาษี ${escapeHtml(co.taxId)}<br>${co.addressLines.map(escapeHtml).join("<br>")}<br>โทร ${escapeHtml(co.phone)} · ${escapeHtml(co.email)}</span></div>`;
}

const paymentLinesOf = (inv: PrintableInvoice) => (isPersonal(inv) ? PERSONAL_PROFILE.paymentLines : COMPANY_PROFILE.paymentLines);

export const ATTACHMENT_ROWS_PER_PAGE = 40;

// เลขที่เอกสารแนบล้อกับเลขใบวางบิล (ผู้ใช้ 2026-09-28): IV2026-121 -> IV2026-121-A พิมพ์ใต้เลขที่บนหน้าบิลและหัวเอกสารแนบทุกหน้า
const attachmentNo = (inv: PrintableInvoice) => (inv.invoiceNo ? `${inv.invoiceNo}-A` : "—");
const attachmentPageCount = (inv: PrintableInvoice) => Math.max(1, Math.ceil(inv.lines.length / ATTACHMENT_ROWS_PER_PAGE));

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const customerTitle = (c: PrintableInvoice["customer"]) => `${c.name}${c.branch ? ` (${c.branch})` : ""}`;

const isVoid = (inv: PrintableInvoice) => inv.status === "VOID";
const voidMarkHtml = (inv: PrintableInvoice) => (isVoid(inv) ? `<div class="void-mark" aria-hidden="true">ยกเลิก</div>` : "");
const voidNoteHtml = (inv: PrintableInvoice) =>
  isVoid(inv) ? `<span class="void-note">บิลนี้ยกเลิกแล้ว${inv.voidReason ? ` – ${escapeHtml(inv.voidReason)}` : ""}</span>` : "";

function headHtml(inv: PrintableInvoice, docTitle: string): string {
  return `<div class="co">${issuerHtml(inv)}
<div class="doc">${escapeHtml(docTitle)}<br><span class="k small">เลขที่ ${escapeHtml(inv.invoiceNo || "—")}<br>เอกสารแนบเลขที่ ${escapeHtml(attachmentNo(inv))} (${attachmentPageCount(inv)} หน้า)<br>วันที่ออก ${escapeHtml(isoToThaiDate(inv.issueDate))}</span></div></div>
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
<span class="k">รายละเอียดรถรายคันตามเอกสารแนบเลขที่ ${escapeHtml(attachmentNo(inv))}</span></div>
<div class="tot"><div><span>ค่าธรรมเนียม</span><span>${formatMoney(inv.feeTotal)}</span></div>
<div><span>ค่าดำเนินการ</span><span>${formatMoney(inv.serviceTotal)}</span></div>
${inv.vatRate > 0 ? `<div><span>ภาษีมูลค่าเพิ่ม ${inv.vatRate}%</span><span>${formatMoney(inv.vatAmount)}</span></div>` : ""}
${inv.whtRate > 0 ? `<div><span>ภาษีหัก ณ ที่จ่าย ${inv.whtRate}%</span><span>${formatMoney(inv.whtAmount)}</span></div>` : ""}
<div class="g"><span>จำนวนเงินทั้งสิ้น</span><span>${formatMoney(inv.netTotal)}</span></div></div></div>
<div class="baht">(${escapeHtml(bahtText(inv.netTotal))})</div>
<div class="sign"><div>ผู้ออกใบวางบิล/ใบแจ้งหนี้<br><span class="k">วันที่ : ${escapeHtml(isoToThaiDate(inv.issueDate))}</span></div><div>ผู้รับสินค้า/บริการ<br><span class="k">วันที่ : ____/____/______</span></div></div>
</section>`;
}

function attachmentPagesHtml(inv: PrintableInvoice): string[] {
  const lines = sortLinesByPlate(inv.lines);
  const pageCount = Math.max(1, Math.ceil(lines.length / ATTACHMENT_ROWS_PER_PAGE));
  const vatOf = (fee: number) => round2((fee * inv.vatRate) / 100);
  const serviceCars = round2(lines.reduce((s, l) => s + l.serviceFee, 0));
  const vatCars = round2(lines.reduce((s, l) => s + vatOf(l.serviceFee), 0));

  return Array.from({ length: pageCount }, (_, p) => {
    const slice = lines.slice(p * ATTACHMENT_ROWS_PER_PAGE, (p + 1) * ATTACHMENT_ROWS_PER_PAGE);
    const rows = slice
      .map((l, i) => {
        const vat = vatOf(l.serviceFee);
        return `<tr><td>${p * ATTACHMENT_ROWS_PER_PAGE + i + 1}</td><td>${escapeHtml(l.brandName.toUpperCase())}</td><td class="mono">${escapeHtml(l.chassis)}</td><td>${escapeHtml(l.plateText || "—")}</td>
<td>${escapeHtml(l.receiptNo || "—")}</td><td class="r">${formatMoney(l.receiptAmount)}</td><td class="r">${formatMoney(l.serviceFee)}${l.deduction > 0 ? " *" : ""}</td><td class="r">${formatMoney(vat)}</td><td class="r">${formatMoney(round2(l.receiptAmount + l.serviceFee + vat))}</td></tr>`;
      })
      .join("");
    const last = p === pageCount - 1;
    const totalRow = last
      ? `<tr class="sum"><td colspan="5">รวม ${lines.length} คัน</td><td class="r">${formatMoney(inv.feeTotal)}</td><td class="r">${formatMoney(serviceCars)}</td><td class="r">${formatMoney(vatCars)}</td><td class="r">${formatMoney(round2(inv.feeTotal + serviceCars + vatCars))}</td></tr>`
      : "";
    const deductions = [...new Set(lines.filter((l) => l.deduction > 0).map((l) => `${l.deductionNote || "หักยอด"} ${formatMoney(l.deduction)} บาท`))];
    const notes = last
      ? `${deductions.length ? `<div class="k note">* ${deductions.map(escapeHtml).join(" / ")}</div>` : ""}
${inv.extras.length ? `<div class="k note">ค่าใช้จ่ายอื่นๆ ของบิล (${inv.extras.map((e) => `${escapeHtml(e.label)} ${formatMoney(e.amount)}`).join(", ")}) แสดงในหน้าใบวางบิล ไม่รวมในตารางนี้</div>` : ""}`
      : "";
    return `<section class="page att">${voidMarkHtml(inv)}<div class="atthead"><div><b>เอกสารแนบเลขที่ ${escapeHtml(attachmentNo(inv))}</b> <span class="k">(ของใบวางบิล ${escapeHtml(inv.invoiceNo || "—")})</span> · ${escapeHtml(customerTitle(inv.customer))}${isVoid(inv) ? ` · ${voidNoteHtml(inv)}` : ""}<br>
<span class="k">${escapeHtml(inv.jobLabel)} ${lines.length} คัน · วันที่ออก ${escapeHtml(isoToThaiDate(inv.issueDate))}</span></div><div class="k">หน้า ${p + 1}/${pageCount}</div></div>
<table class="grid"><colgroup><col style="width:5%"><col style="width:10%"><col style="width:21%"><col style="width:11%"><col style="width:13%"><col style="width:10%"><col style="width:11%"><col style="width:8%"><col style="width:11%"></colgroup>
<thead><tr><th>#</th><th>ยี่ห้อ</th><th>เลขตัวรถ</th><th>ทะเบียน</th><th>เลขที่ใบเสร็จ</th><th class="r">ใบเสร็จ</th><th class="r">ค่าดำเนินการ</th><th class="r">VAT ${inv.vatRate}%</th><th class="r">รวม</th></tr></thead>
<tbody>${rows}${totalRow}</tbody></table>${notes}</section>`;
  });
}

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
  @page { size: A4 portrait; margin: 12mm 14mm; }
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
  .atthead { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 3mm; }
  .grid th { border-top: 1px solid #111; border-bottom: 1px solid #111; padding: 1.2mm .8mm; font-size: 8.5pt; font-weight: 600; text-align: left; }
  .grid th.r { text-align: right; }
  /* แถวเตี้ยพอให้ 40 คัน (ATTACHMENT_ROWS_PER_PAGE) อยู่ใน A4 หน้าเดียว - เดิมล้นไปหน้าใหม่ 1-2 แถว บิล 61 คันพิมพ์ออกมา 4 หน้า (พบ 2026-09-28) */
  .grid td { padding: .8mm .8mm; font-size: 8.5pt; line-height: 1.25; border-bottom: 1px solid #e2e2e2; white-space: nowrap; overflow: hidden; }
  .grid .mono { font-family: Consolas, "Courier New", monospace; font-size: 8pt; }
  .grid .sum td { border-top: 1px solid #111; border-bottom: 0; font-weight: 600; padding-top: 1.6mm; }
  .note { margin-top: 2mm; font-size: 8.5pt; }
  @media screen { body { padding: 10mm 12mm; } .page { margin-bottom: 10mm; padding-bottom: 10mm; border-bottom: 1px dashed #bbb; } .page:last-child { border-bottom: 0; } }
</style>
</head>
<body>
${invoicePageHtml(inv)}
${attachmentPagesHtml(inv).join("\n")}
</body>
</html>`;
}

// พิมพ์ผ่าน iframe ที่ซ่อนไว้ (วิธีเดียวกับใบส่งงาน) - เลือกเครื่องพิมพ์หรือ "บันทึกเป็น PDF" ได้จากหน้าต่างพิมพ์ของเบราว์เซอร์
export function printInvoice(inv: PrintableInvoice): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  iframe.srcdoc = buildInvoiceHtml(inv);

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
