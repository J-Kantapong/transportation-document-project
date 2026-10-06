import { COMPANY_PROFILE } from "@/lib/company-profile";
import type { PayrollItem, PayrollRun } from "@/lib/hr-api";
import { monthLabel, type PayslipSignature } from "@/lib/hr-api";
import { bahtText, formatMoney } from "@/lib/invoice";
import { escapeHtml, printHtmlDocument, safeFileName } from "@/lib/print-html";

// สลิปเงินเดือน (ผู้ใช้ 2026-10-05) - 1 ใบต่อ 1 หน้า A4, ขาวดำ (ผู้ใช้ 2026-10-06) ใช้พิมพ์หรือ "บันทึกเป็น PDF" ผ่านหน้าต่างพิมพ์ของเบราว์เซอร์
// ข้อมูลเงินเดือนส่วนบุคคล: พิมพ์จากหน้ารอบเงินเดือนที่ ADMIN เปิดเท่านั้น
// ไม่พิมพ์ยอดสะสมตั้งแต่ต้นปี (ผู้ใช้ 2026-10-06): ระบบเพิ่งเริ่มใช้ ยอดของปี 2569 จะน้อยกว่าความจริง (item.ytd ยังส่งมาจาก API ไว้ใช้ทีหลัง)
// บริษัทไม่หักภาษี ณ ที่จ่ายพนักงาน (ผู้ใช้ 2026-10-06): บรรทัดภาษีขึ้นบนสลิปเฉพาะคนที่มียอดภาษีจริง
// ตัวเลขเงินทุกตัวบนสลิปใช้ฟอนต์เดียวกันและขนาดเท่ากัน (ผู้ใช้ 2026-10-06) - ต่างกันแค่น้ำหนัก (ยอดรวม/สุทธิตัวหนา) ไม่ใช้ขนาดแยกลำดับ

const esc = (t: string | null | undefined) => escapeHtml(t ?? "");
// สลิปให้พนักงานถือ: วันที่ทั้งหมดเป็น พ.ศ. (ข้อมูลในระบบเป็น ค.ศ. ISO)
const thaiDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
};
// รายการหัก/รายได้ที่เป็น 0 แสดง "-" ; ยอดรวมรายได้ใช้ formatMoney ตรงๆ
const money = (n: number) => (n === 0 ? "-" : formatMoney(n));
// เลขประจำตัวผู้เสียภาษี 13 หลัก -> 0-1155-56016-80-1 (ถ้ารูปแบบไม่ใช่ 13 หลัก แสดงตามเดิม)
const taxIdText = (id: string) => {
  const d = id.replace(/\D/g, "");
  return d.length === 13 ? `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}` : id;
};

type Row = { label: string; note?: string | null; amount: number };

function rowsHtml(list: Row[]): string {
  return list
    .map(
      (r) =>
        `<div class="row"><div class="lbl">${esc(r.label)}${r.note ? `<span class="note">${esc(r.note)}</span>` : ""}</div><div class="num">${money(r.amount)}</div></div>`,
    )
    .join("");
}

// ตัวเลือกการพิมพ์: ลายเซ็นผู้จ่ายเงิน (ผู้ใช้ 2026-10-06) - มี = พิมพ์ลายเซ็น + ชื่อ + วันที่จ่ายให้อัตโนมัติ ไม่มี = ช่องเซ็นเปล่าเหมือนเดิม
export interface PayslipOptions {
  signature?: PayslipSignature | null;
}

const DOTTED_DATE = "วันที่ ........ / ........ / ............";

function slipHtml(run: PayrollRun, item: PayrollItem, options: PayslipOptions): string {
  const income: Row[] = [{ label: "เงินเดือน", amount: item.salary }];
  if (item.otherIncome) income.push({ label: "รายได้อื่น", note: item.otherIncomeNote, amount: item.otherIncome });
  const deductions: Row[] = [{ label: "ประกันสังคม", amount: item.ssoAmount }];
  if (item.taxAmount) deductions.push({ label: "ภาษีหัก ณ ที่จ่าย", amount: item.taxAmount });
  if (item.otherDeduction) deductions.push({ label: "หักอื่น", note: item.deductionNote, amount: item.otherDeduction });
  const gross = item.salary + item.otherIncome;
  const totalDeduction = item.ssoAmount + item.taxAmount + item.otherDeduction;
  const sig = options.signature?.exists && options.signature.imageDataUrl?.startsWith("data:image/png;base64,") ? options.signature : null;
  const payerDate = run.payDate ? `วันที่ ${esc(thaiDate(run.payDate))}` : DOTTED_DATE;
  const company = COMPANY_PROFILE;
  const taxLine = company.taxId ? `เลขประจำตัวผู้เสียภาษี ${taxIdText(company.taxId)}` : "";
  return `<section class="slip">
  <header class="head">
    <div class="co">
      <div class="co-name">${esc(company.nameTh)}</div>
      <div class="co-addr">${company.addressLines.map(esc).join("<br>")}${taxLine ? `<br>${esc(taxLine)}` : ""}</div>
    </div>
    <div class="ttl">
      <div class="chip"><span class="chip-th">สลิปเงินเดือน</span><span class="chip-en">PAYSLIP</span></div>
      <div class="ttl-meta">งวด <b>${esc(monthLabel(run.month))}</b>${run.payDate ? `<br>วันที่จ่าย <b>${esc(thaiDate(run.payDate))}</b>` : ""}</div>
    </div>
  </header>

  <div class="emp${item.position ? "" : " nopos"}">
    <div class="f code"><span class="k">รหัสพนักงาน</span><span class="v">${esc(item.code)}</span></div>
    <div class="f name"><span class="k">ชื่อ-สกุล</span><span class="v">${esc(item.fullName)}</span></div>
    ${item.position ? `<div class="f pos"><span class="k">ตำแหน่ง</span><span class="v">${esc(item.position)}</span></div>` : ""}
  </div>

  <div class="cols">
    <div class="panel">
      <div class="ph"><span>รายได้</span><span class="u">บาท</span></div>
      <div class="rows">${rowsHtml(income)}</div>
      <div class="pf"><span>รวมรายได้</span><span class="num">${formatMoney(gross)}</span></div>
    </div>
    <div class="panel">
      <div class="ph"><span>รายการหัก</span><span class="u">บาท</span></div>
      <div class="rows">${rowsHtml(deductions)}</div>
      <div class="pf"><span>รวมรายการหัก</span><span class="num">${money(totalDeduction)}</span></div>
    </div>
  </div>

  <div class="net">
    <div class="net-l">
      <div class="net-k">จ่ายสุทธิ</div>
      <div class="net-t">(${esc(bahtText(item.netPay))})</div>
    </div>
    <div class="net-r"><span class="num">${formatMoney(item.netPay)}</span><span class="net-u">บาท</span></div>
  </div>

  <div class="sign">
    <div class="sg">${sig ? `<div class="sl"><img src="${sig.imageDataUrl}" alt=""></div>` : `<div class="sl"></div>`}<div class="who">ผู้จ่ายเงิน</div><div class="sd">${sig?.signerName ? `(${esc(sig.signerName)})<br>` : ""}${payerDate}</div></div>
    <div class="sg"><div class="sl"></div><div class="who">ผู้รับเงิน</div><div class="sd">${DOTTED_DATE}</div></div>
  </div>
  <footer class="foot">เอกสารลับ เฉพาะผู้รับเงินเดือนเท่านั้น</footer>
</section>`;
}

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">`;

// minimal clean (ผู้ใช้ 2026-10-06): ไม่มีพื้นสี/พื้นดำ/กรอบ - ใช้ตัวอักษรกับเส้นบางอย่างเดียว เหมาะกับเลเซอร์ขาวดำและถ่ายเอกสาร
// ตัวรองไม่จางกว่า #333, เส้นย่อยใช้ #888 ขึ้นไปเพื่อให้เครื่องถ่ายเอกสารยังเห็น
// ตัวเลขเงินทุกตัว = .num (ขนาด 12pt ฟอนต์เดียวกัน เลขกว้างเท่ากัน) ยอดรวม/สุทธิแค่ตัวหนา ยอดสุทธิไม่ขยายขนาด (ผู้ใช้ 2026-10-06)
const STYLE = `
@page{size:A4;margin:16mm 18mm}
*{box-sizing:border-box}
:root{--ink:#000;--mute:#333;--hair:#999;--num:12pt}
html,body{margin:0;padding:0}
body{font-family:"Sarabun","Noto Sans Thai","Leelawadee UI","Tahoma",sans-serif;font-size:11.5pt;line-height:1.6;color:var(--ink);font-variant-numeric:tabular-nums lining-nums;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.num{font-family:inherit;font-size:var(--num);font-weight:400;line-height:1.6;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums lining-nums;font-feature-settings:"tnum" 1,"lnum" 1}
.k{color:var(--mute)}

.slip{display:flex;flex-direction:column;min-height:260mm;break-inside:avoid;page-break-inside:avoid;break-after:page;page-break-after:always}
.slip:last-child{break-after:auto;page-break-after:auto}

.head{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm;padding-bottom:6mm;border-bottom:1pt solid var(--ink)}
.co{min-width:0;flex:1}
.co-name{font-size:14pt;font-weight:700;line-height:1.45;overflow-wrap:anywhere}
.co-addr{font-size:9.5pt;color:var(--mute);line-height:1.6;overflow-wrap:anywhere}
.ttl{flex:none;text-align:right}
.chip{display:block}
.chip-th{font-size:17pt;font-weight:700;line-height:1.3}
.chip-en{display:none}
.ttl-meta{font-size:10.5pt;line-height:1.6;margin-top:1mm;color:var(--mute)}
.ttl-meta b{color:var(--ink);font-weight:600}

.emp{display:grid;grid-template-columns:32mm 1fr auto;gap:0 8mm;align-items:end;padding:6mm 0 5mm}
.emp.nopos{grid-template-columns:32mm 1fr}
.emp .f{display:flex;flex-direction:column;min-width:0}
.emp .pos{text-align:right}
.emp .k{font-size:9.5pt;line-height:1.4}
.emp .v{font-size:12pt;font-weight:600;line-height:1.5;overflow-wrap:anywhere}

.cols{display:grid;grid-template-columns:1fr 1fr;gap:14mm;margin-top:4mm}
.panel{display:flex;flex-direction:column;min-width:0;min-height:56mm}
.ph{display:flex;justify-content:space-between;align-items:baseline;padding:0 0 2mm;border-bottom:1pt solid var(--ink);font-weight:700;font-size:11.5pt}
.ph .u{font-weight:400;font-size:9.5pt;color:var(--mute)}
.rows{flex:1 1 auto}
.row{display:grid;grid-template-columns:1fr auto;gap:5mm;padding:2.6mm 0;border-bottom:.5pt solid var(--hair);align-items:start;break-inside:avoid}
.row:last-child{border-bottom:0}
.row .lbl{min-width:0;overflow-wrap:anywhere}
.row .note{display:block;font-size:9.5pt;color:var(--mute);line-height:1.4}
.pf{display:flex;justify-content:space-between;align-items:baseline;gap:5mm;padding:2.4mm 0 0;border-top:.75pt solid var(--ink);font-weight:700}
.pf .num{font-weight:700}

.net{display:flex;justify-content:space-between;align-items:baseline;gap:10mm;margin-top:10mm;padding:3.5mm 0;border-top:1pt solid var(--ink);border-bottom:1pt solid var(--ink);break-inside:avoid}
.net-l{min-width:0;flex:1;display:flex;align-items:baseline;gap:6mm;flex-wrap:wrap}
.net-k{font-size:12pt;font-weight:700}
.net-t{font-size:10pt;color:var(--mute);line-height:1.5;overflow-wrap:anywhere}
.net-r{flex:none;display:flex;align-items:baseline;gap:2.5mm;white-space:nowrap}
.net-r .num{font-weight:700}
.net-u{font-size:11.5pt}

.sign{display:grid;grid-template-columns:1fr 1fr;gap:28mm;margin-top:30mm;text-align:center;break-inside:avoid}
.sg .sl{border-bottom:.5pt solid var(--ink);margin-bottom:2mm;height:13mm;display:flex;align-items:flex-end;justify-content:center}
.sg .sl img{max-height:11mm;max-width:40mm;object-fit:contain;display:block}
.sg .who{font-weight:600}
.sg .sd{font-size:9.5pt;color:var(--mute)}
.foot{margin-top:auto;text-align:center;font-size:9pt;color:var(--mute)}
`;

export function payslipDocumentHtml(run: PayrollRun, items: PayrollItem[], options: PayslipOptions = {}): string {
  const body = items.map((item) => slipHtml(run, item, options)).join("\n");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>สลิปเงินเดือน ${esc(monthLabel(run.month))}</title>${FONT_LINK}<style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function printPayslips(run: PayrollRun, items: PayrollItem[], options: PayslipOptions = {}): void {
  if (!items.length) return;
  const html = payslipDocumentHtml(run, items, options);
  const name = items.length === 1 ? `สลิปเงินเดือน ${items[0].code} ${monthLabel(run.month)}` : `สลิปเงินเดือน ${monthLabel(run.month)}`;
  printHtmlDocument(html, safeFileName(name));
}
