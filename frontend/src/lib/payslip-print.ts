import { COMPANY_PROFILE } from "@/lib/company-profile";
import type { PayrollItem, PayrollRun } from "@/lib/hr-api";
import { monthLabel } from "@/lib/hr-api";
import { bahtText, formatMoney } from "@/lib/invoice";
import { escapeHtml, printHtmlDocument, safeFileName } from "@/lib/print-html";

// สลิปเงินเดือน (ผู้ใช้ 2026-10-05) - 2 ใบต่อหน้า A4 ใช้พิมพ์หรือ "บันทึกเป็น PDF" ผ่านหน้าต่างพิมพ์ของเบราว์เซอร์
// ข้อมูลเงินเดือนส่วนบุคคล: พิมพ์จากหน้ารอบเงินเดือนที่ ADMIN เปิดเท่านั้น

const esc = (t: string | null | undefined) => escapeHtml(t ?? "");
// สลิปให้พนักงานถือ: วันที่ทั้งหมดเป็น พ.ศ. (ข้อมูลในระบบเป็น ค.ศ. ISO)
const thaiDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
};
const money = (n: number) => (n === 0 ? "-" : formatMoney(n));

function slipHtml(run: PayrollRun, item: PayrollItem): string {
  const income: Array<[string, number]> = [["เงินเดือน", item.salary]];
  if (item.otherIncome) income.push([item.otherIncomeNote ? `รายได้อื่น (${item.otherIncomeNote})` : "รายได้อื่น", item.otherIncome]);
  const deductions: Array<[string, number]> = [
    ["ประกันสังคม", item.ssoAmount],
    ["ภาษีหัก ณ ที่จ่าย", item.taxAmount],
  ];
  if (item.otherDeduction) deductions.push([item.deductionNote ? `หักอื่น (${item.deductionNote})` : "หักอื่น", item.otherDeduction]);
  const gross = item.salary + item.otherIncome;
  const totalDeduction = item.ssoAmount + item.taxAmount + item.otherDeduction;
  const rows = Math.max(income.length, deductions.length);
  const line = (list: Array<[string, number]>, i: number) => (list[i] ? `<td>${esc(list[i][0])}</td><td class="n">${money(list[i][1])}</td>` : "<td></td><td></td>");
  return `<section class="slip">
  <div class="head">
    <div><b>${esc(COMPANY_PROFILE.nameTh)}</b><br>${COMPANY_PROFILE.addressLines.map(esc).join("<br>")}</div>
    <div class="title"><b>สลิปเงินเดือน</b><br>งวด ${esc(monthLabel(run.month))}${run.payDate ? `<br>วันที่จ่าย ${esc(thaiDate(run.payDate))}` : ""}</div>
  </div>
  <div class="who">รหัส <b>${esc(item.code)}</b> &nbsp; ชื่อ <b>${esc(item.fullName)}</b> &nbsp; ตำแหน่ง ${esc(item.position)}</div>
  <table>
    <thead><tr><th colspan="2">รายได้</th><th colspan="2">รายการหัก</th></tr></thead>
    <tbody>
      ${Array.from({ length: rows }, (_, i) => `<tr>${line(income, i)}${line(deductions, i)}</tr>`).join("")}
      <tr class="sum"><td>รวมรายได้</td><td class="n">${formatMoney(gross)}</td><td>รวมรายการหัก</td><td class="n">${money(totalDeduction)}</td></tr>
    </tbody>
  </table>
  <div class="net">จ่ายสุทธิ <b>${formatMoney(item.netPay)}</b> บาท <span>(${esc(bahtText(item.netPay))})</span></div>
  ${
    item.ytd
      ? `<div class="ytd">สะสมตั้งแต่ต้นปี ${Number(run.month.slice(0, 4)) + 543} ถึง ${esc(monthLabel(run.month))}: รายได้ ${formatMoney(item.ytd.income)} · ประกันสังคม ${formatMoney(item.ytd.sso)} · ภาษีหัก ณ ที่จ่าย ${formatMoney(item.ytd.tax)} บาท</div>`
      : ""
  }
  <div class="sign"><div>ลงชื่อ ................................................ ผู้รับเงิน</div><div class="muted">เอกสารลับ เฉพาะผู้รับเงินเดือน</div></div>
</section>`;
}

const STYLE = `
@page{size:A4;margin:10mm}
*{box-sizing:border-box}
body{font-family:"Sarabun","Noto Sans Thai","Tahoma",sans-serif;font-size:11pt;color:#111;margin:0}
.slip{height:136mm;border:1px solid #444;padding:7mm 8mm;margin-bottom:5mm;break-inside:avoid;page-break-inside:avoid;display:flex;flex-direction:column;gap:3mm}
.head{display:flex;justify-content:space-between;gap:10mm;font-size:10pt;line-height:1.5}
.title{text-align:right;font-size:11pt}.title b{font-size:15pt}
.who{border-top:1px solid #444;border-bottom:1px solid #444;padding:2mm 0}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #888;padding:1.4mm 2.5mm;vertical-align:top}
th{background:#f0f0f0;text-align:center}
td.n{text-align:right;white-space:nowrap}
tr.sum td{font-weight:700;background:#f7f7f7}
.net{font-size:12pt;border:1px solid #444;padding:2.5mm 3mm}.net b{font-size:14pt}.net span{font-size:10pt}
.ytd{font-size:9.5pt;color:#333}
.sign{margin-top:auto;display:flex;justify-content:space-between;align-items:end;font-size:10pt}
.muted{color:#666;font-size:9pt}
.slip:nth-child(2n){margin-bottom:0}
`;

export function payslipDocumentHtml(run: PayrollRun, items: PayrollItem[]): string {
  const body = items.map((item) => slipHtml(run, item)).join("\n");
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>สลิปเงินเดือน ${esc(monthLabel(run.month))}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function printPayslips(run: PayrollRun, items: PayrollItem[]): void {
  if (!items.length) return;
  const html = payslipDocumentHtml(run, items);
  const name = items.length === 1 ? `สลิปเงินเดือน ${items[0].code} ${monthLabel(run.month)}` : `สลิปเงินเดือน ${monthLabel(run.month)}`;
  printHtmlDocument(html, safeFileName(name));
}
