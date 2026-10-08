import type { PayslipSignature, WhtCertificate, WhtIncomeType, WhtItem } from "@/lib/hr-api";
import { bahtText, formatMoney } from "@/lib/invoice";
import { escapeHtml } from "@/lib/print-html";

// 50 ทวิ แบบ "เหมือนฟอร์มของบริษัทเป๊ะ" (ผู้ใช้ 2026-10-06: ให้พิมพ์ออกมาเหมือน PDF ที่บริษัทใช้อยู่)
// พื้น = ภาพฟอร์มเปล่าของกรมสรรพากร (public/forms/wht-50tawi-blank.png, 300 dpi, ได้จากไฟล์ 2026-xxx.pdf โดยซ่อนช่องกรอก - ไม่มีข้อมูลส่วนบุคคล)
// ข้อมูลวางทับตามตำแหน่งช่องกรอกของไฟล์ PDF ต้นฉบับ (หน่วย pt, หน้า A4 595 x 842, จุดเริ่มต้นมุมล่างซ้าย - ค่าอ่านจาก /Rect ของช่อง)
// ฟอนต์ค่าที่กรอกในต้นฉบับคือ Microsoft Sans Serif ขนาด ~10pt (ช่องเลข 13 หลักเป็นช่องแยกตัวอักษร 17 ช่อง) วัดจากไฟล์จริงด้วย pdftotext -bbox

type Box = readonly [number, number, number, number]; // x1, y1, x2, y2

const PAGE_W = 595;
const PAGE_H = 842;
const esc = (t: string | null | undefined) => escapeHtml(t ?? "");

interface RowBoxes {
  date: Box;
  pay: Box;
  tax: Box;
  spec?: Box;
}

const ROWS: Record<WhtIncomeType, RowBoxes> = {
  SALARY: { date: [327.2, 533.3, 402.5, 546.0], pay: [411.0, 533.1, 490.0, 546.8], tax: [496.0, 533.8, 560.5, 546.7] },
  FEE: { date: [328.0, 519.4, 403.3, 533.4], pay: [410.1, 519.8, 489.1, 533.5], tax: [495.5, 518.8, 560.0, 531.7] },
  ROYALTY: { date: [327.7, 504.4, 403.3, 518.1], pay: [410.8, 503.7, 489.8, 517.4], tax: [495.5, 504.0, 560.0, 516.9] },
  INTEREST: { date: [328.0, 490.4, 403.3, 504.8], pay: [411.6, 490.0, 490.7, 503.7], tax: [495.5, 489.8, 560.0, 502.7] },
  // ข้อ 5: ข้อความของข้อสูง 4 บรรทัด คอลัมน์ขวามีที่ว่างตลอด จึงวางได้สูงสุด 4 รายการ (บรรทัดล่างสุดคือช่องจริงของแบบ)
  SERVICE: { date: [326.5, 216.3, 402.7, 230.4], pay: [409.4, 216.3, 488.9, 230.4], tax: [496.4, 214.7, 561.0, 229.6] },
  OTHER: { date: [326.5, 198.9, 402.7, 213.0], pay: [409.4, 198.9, 488.9, 213.0], tax: [496.4, 198.3, 561.0, 213.2], spec: [96.0, 197.1, 324.7, 213.8] },
};

const SERVICE_SLOT_STEP = 14.6;
const SERVICE_SLOTS = 4;

const TOTAL = { pay: [409.4, 180.1, 488.4, 195.5] as Box, tax: [495.5, 180.4, 560.0, 195.9] as Box };
const WORDS: Box = [184.6, 157.6, 557.5, 176.8];
const FUND = { gov: [216.2, 141.1, 273.4, 156.4] as Box, sso: [356.7, 141.2, 407.3, 156.5] as Box, pvd: [484.0, 139.1, 546.1, 154.4] as Box };

const CHECK_FORM: Record<string, Box> = {
  "1": [209.3, 602.5, 222.0, 615.2], // ภ.ง.ด.1ก
  "2": [288.0, 602.5, 300.7, 615.2],
  "3": [394.7, 601.9, 407.3, 614.5],
  "4": [471.3, 601.9, 484.0, 614.5], // ภ.ง.ด.3
  "5": [209.3, 583.9, 222.0, 596.5],
  "6": [287.3, 583.9, 300.0, 596.5],
  "7": [394.7, 583.9, 407.3, 596.5],
};
const CHECK_PAY: Record<string, Box> = {
  WITHHOLD: [82.5, 119.1, 94.0, 130.8],
  FOREVER: [177.3, 120.5, 188.2, 132.5],
  ONCE: [282.3, 119.8, 294.3, 131.8],
  OTHER: [393.7, 119.2, 405.7, 131.2],
};

const RUN_NO: Box = [519.3, 764.7, 560.0, 780.7];
const PAYER = { id: [374.7, 744.0, 558.4, 758.7] as Box, name: [53.9, 729.1, 316.3, 745.2] as Box, address: [60.8, 705.7, 550.4, 721.6] as Box };
const PAYEE = { id: [375.3, 675.6, 557.6, 690.3] as Box, name: [53.2, 657.6, 314.9, 671.1] as Box, address: [59.2, 627.0, 549.6, 643.3] as Box };

// วัน/เดือน/ปี ท้ายฟอร์ม: ตำแหน่งกึ่งกลางของตัวเลขในไฟล์ต้นฉบับ (x) และกึ่งกลางแนวตั้ง (y)
const SIGN_DATE = { dayX: 349.3, monthX: 389.3, yearX: 441.65, y: 79.6, size: 10 };
const SIGNATURE_BOX: Box = [362, 87, 470, 108]; // ก้นกรอบอยู่ที่เส้นลงชื่อ (y ~88) สูงไม่เกินบรรทัด "ขอรับรองว่า..." มากนัก

// ข้อมูลผู้จ่ายตามที่พิมพ์ในใบเดิมของบริษัท (ชื่อไม่มี "(สำนักงานใหญ่)" ที่อยู่เขียนย่อ) - ใช้เมื่อเลขผู้เสียภาษีของผู้จ่ายตรงกับบริษัท
const KNOWN_PAYER_TAX_ID = "0115556016801";
const KNOWN_PAYER_ADDRESS = "3/1 ซ.31(อักษรลักษณ์ 4) ต.ปากน้ำ อ.เมือง จ.สมุทรปราการ 10270";

export const OFFICIAL_FORM_IMAGE = "/forms/wht-50tawi-blank.png";

export function canUseOfficialForm(c: WhtCertificate): boolean {
  const count = (type: WhtIncomeType) => c.items.filter((i) => i.incomeType === type).length;
  return c.items.every((i) => i.incomeType in ROWS) && count("SERVICE") <= SERVICE_SLOTS && (["SALARY", "FEE", "ROYALTY", "INTEREST", "OTHER"] as WhtIncomeType[]).every((t) => count(t) <= 1);
}

function dmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : iso;
}

const pctX = (x: number) => ((x / PAGE_W) * 100).toFixed(4);
const pctY = (y: number) => ((y / PAGE_H) * 100).toFixed(4);

interface TextOpts {
  size?: number;
  align?: "left" | "center" | "right";
  inset?: number; // ระยะห่างจากขอบช่องด้านที่ชิด (pt)
  bold?: boolean;
  shrink?: boolean; // ลดขนาดตัวอักษรถ้ายาวเกินช่อง
}

// ข้อความในช่อง: จัดกึ่งกลางแนวตั้ง ตามขอบช่องเดิม
function text(box: Box, value: string, o: TextOpts = {}): string {
  if (!value) return "";
  const [x1, y1, x2, y2] = box;
  const inset = o.inset ?? 2;
  let size = o.size ?? 10;
  if (o.shrink) {
    const width = x2 - x1 - inset * 2;
    const est = [...value].length * 0.56 * size; // ประมาณความกว้างของ Microsoft Sans Serif
    if (est > width) size = Math.max(6, (size * width) / est);
  }
  const align = o.align ?? "left";
  const justify = align === "center" ? "center" : align === "right" ? "flex-end" : "flex-start";
  const pad = align === "right" ? `padding-right:calc(var(--u)*${inset})` : align === "left" ? `padding-left:calc(var(--u)*${inset})` : "";
  return `<div class="fv" style="left:${pctX(x1)}%;top:${pctY(PAGE_H - y2)}%;width:${pctX(x2 - x1)}%;height:${pctY(y2 - y1)}%;justify-content:${justify};${pad};font-size:calc(var(--u)*${size.toFixed(2)});${o.bold ? "font-weight:700;" : ""}">${esc(value)}</div>`;
}

// ช่องเลขประจำตัว 17 ช่อง: ตัวอักษรอยู่กึ่งกลางแต่ละช่อง รูปแบบ 1 4 5 2 1 (เว้นวรรคตรงช่วงขีดของฟอร์ม)
function comb(box: Box, id: string, size = 10): string {
  const digits = id.replace(/[\s-]/g, "");
  if (!/^\d{13}$/.test(digits)) return text(box, id, { size, shrink: true });
  const chars = [...`${digits[0]} ${digits.slice(1, 5)} ${digits.slice(5, 10)} ${digits.slice(10, 12)} ${digits[12]}`];
  const [x1, y1, x2, y2] = box;
  const cell = (x2 - x1) / chars.length;
  return chars
    .map((ch, i) => (ch === " " ? "" : text([x1 + cell * i, y1, x1 + cell * (i + 1), y2], ch, { size, align: "center", inset: 0 })))
    .join("");
}

function check(box: Box): string {
  const [x1, y1, x2, y2] = box;
  return `<div class="fv ck" style="left:${pctX(x1)}%;top:${pctY(PAGE_H - y2)}%;width:${pctX(x2 - x1)}%;height:${pctY(y2 - y1)}%;font-size:calc(var(--u)*11)">✔</div>`;
}

const shift = (box: Box, dy: number): Box => [box[0], box[1] + dy, box[2], box[3] + dy];

// วันที่ ~9.5pt, ตัวเลขเงิน ~10.1pt (วัดจากความกว้างข้อความในไฟล์ต้นฉบับ)
function itemCells(item: WhtItem, row: RowBoxes, dy: number, dateSize: number, moneySize: number): string {
  const date = item.dateLabel || dmy(item.paidDate);
  return (
    text(shift(row.date, dy), date, { size: dateSize, align: "center", inset: 0, shrink: true }) +
    text(shift(row.pay, dy), formatMoney(item.amountPaid), { size: moneySize, align: "right", inset: 2 }) +
    text(shift(row.tax, dy), formatMoney(item.taxWithheld), { size: moneySize, align: "right", inset: 2 })
  );
}

export interface OfficialFormOptions {
  signature?: PayslipSignature | null;
  assetBase?: string; // เช่น https://host หรือ file:///.../public - ต่อด้วย OFFICIAL_FORM_IMAGE
}

export function officialFormPageHtml(c: WhtCertificate, options: OfficialFormOptions): string {
  const sig = options.signature?.exists && options.signature.imageDataUrl?.startsWith("data:image/png;base64,") ? options.signature : null;
  const parts: string[] = [];

  // เลขที่ (เล่มที่เว้นว่างเหมือนใบเดิม)
  parts.push(text(RUN_NO, c.certificateNo, { size: 8.7, inset: 2 }));

  // ผู้จ่าย (ผู้มีหน้าที่หักภาษี) - แถวเลข 13 หลักแรก
  const isKnownPayer = c.payer.taxId === KNOWN_PAYER_TAX_ID;
  parts.push(comb(PAYER.id, c.payer.taxId));
  parts.push(text(PAYER.name, c.payer.nameTh.replace(/\s*\(สำนักงานใหญ่\)\s*$/, ""), { inset: 4.8, shrink: true }));
  parts.push(text(PAYER.address, isKnownPayer ? KNOWN_PAYER_ADDRESS : c.payer.addressLines.join(" "), { size: 10.35, inset: 2, shrink: true }));

  // ผู้ถูกหักภาษี (ผู้รับเงิน)
  parts.push(comb(PAYEE.id, c.payeeTaxId));
  parts.push(text(PAYEE.name, c.payeeName, { inset: 2, shrink: true }));
  parts.push(text(PAYEE.address, c.payeeAddress ?? "", { size: 10.7, inset: 2, shrink: true }));

  // ในแบบ: 1 = ภ.ง.ด.1ก, 4 = ภ.ง.ด.3
  parts.push(check(CHECK_FORM[c.formType === "PND1K" ? "1" : "4"]));

  // รายการเงินได้
  for (const type of ["SALARY", "FEE", "ROYALTY", "INTEREST", "OTHER"] as WhtIncomeType[]) {
    const item = c.items.find((i) => i.incomeType === type);
    if (!item) continue;
    parts.push(itemCells(item, ROWS[type], 0, 9.5, 10.1));
    if (type === "OTHER") parts.push(text(ROWS.OTHER.spec!, item.description ?? "", { size: 10, inset: 2, shrink: true }));
  }
  const services = c.items.filter((i) => i.incomeType === "SERVICE");
  services.forEach((item, i) => {
    // รายการเดียวใช้ช่องบรรทัดล่างสุดของแบบ หลายรายการเรียงต่อกันขึ้นไปโดยรายการสุดท้ายอยู่ล่างสุด
    const slotFromBottom = services.length - 1 - i;
    parts.push(itemCells(item, ROWS.SERVICE, slotFromBottom * SERVICE_SLOT_STEP, 9.5, 10.1));
  });

  // รวม + ตัวอักษร
  parts.push(text(TOTAL.pay, formatMoney(c.totalPaid), { size: 10.25, align: "right", inset: 2 }));
  parts.push(text(TOTAL.tax, formatMoney(c.totalTax), { size: 10.25, align: "right", inset: 2 }));
  parts.push(text(WORDS, c.totalTax > 0 ? bahtText(c.totalTax) : "ศูนย์บาทถ้วน", { size: 13.2, inset: 2.4, shrink: true }));

  // เงินสมทบ (ว่างถ้าไม่มี เหมือนใบเดิม)
  if (c.ssoAmount > 0) parts.push(text(FUND.sso, formatMoney(c.ssoAmount), { size: 9.5, align: "right", inset: 2 }));
  if (c.providentFund > 0) parts.push(text(FUND.pvd, formatMoney(c.providentFund), { size: 9.5, align: "right", inset: 2 }));

  // ผู้จ่ายเงิน
  parts.push(check(CHECK_PAY[c.payMethod === "WITHHOLD" ? "WITHHOLD" : c.payMethod === "FOREVER" ? "FOREVER" : "ONCE"]));
  if (c.note) parts.push(text([468.0, 117.9, 557.6, 132.3], c.note, { size: 8, inset: 2, shrink: true }));

  // ลงชื่อ + วัน เดือน ปี ที่ออก
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(c.issueDate);
  if (d) {
    const at = (x: number, v: string) => text([x - 20, SIGN_DATE.y - 8, x + 20, SIGN_DATE.y + 8], v, { size: SIGN_DATE.size, align: "center", inset: 0 });
    parts.push(at(SIGN_DATE.dayX, String(Number(d[3]))), at(SIGN_DATE.monthX, String(Number(d[2]))), at(SIGN_DATE.yearX, d[1]));
  }
  if (sig) {
    const [x1, y1, x2, y2] = SIGNATURE_BOX;
    parts.push(`<img class="sig" src="${sig.imageDataUrl}" alt="" style="left:${pctX(x1)}%;top:${pctY(PAGE_H - y2)}%;width:${pctX(x2 - x1)}%;height:${pctY(y2 - y1)}%">`);
  }

  const bg = `${options.assetBase ?? ""}${OFFICIAL_FORM_IMAGE}`;
  return `<section class="fpage"><img class="bg" src="${bg}" alt="">${c.status === "CANCELLED" ? `<div class="wm">ยกเลิก</div>` : ""}${parts.join("")}</section>`;
}

export const OFFICIAL_FORM_STYLE = `
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{-webkit-print-color-adjust:exact;print-color-adjust:exact}
.fpage{--u:calc(210mm/595);position:relative;width:210mm;height:297mm;overflow:hidden;break-after:page;page-break-after:always}
.fpage:last-child{break-after:auto;page-break-after:auto}
.fpage .bg{position:absolute;left:0;top:0;width:100%;height:100%;display:block}
.fv{position:absolute;display:flex;align-items:center;white-space:nowrap;overflow:hidden;line-height:1;color:#000;font-family:"Microsoft Sans Serif","Tahoma","Leelawadee UI","Noto Sans Thai","Sarabun",sans-serif;font-variant-numeric:tabular-nums}
.fv.ck{justify-content:center;font-family:"Segoe UI Symbol","Zapf Dingbats","Noto Sans Symbols 2","DejaVu Sans",sans-serif;font-weight:700}
.fpage .sig{position:absolute;object-fit:contain;display:block}
.fpage .wm{position:absolute;left:0;right:0;top:32%;text-align:center;font:700 calc(var(--u)*110) "Sarabun","Tahoma",sans-serif;color:#000;opacity:.08;transform:rotate(-24deg);pointer-events:none}
`;
