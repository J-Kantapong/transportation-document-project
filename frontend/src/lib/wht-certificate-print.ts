import type { WhtCertificate, WhtIncomeType, WhtItem } from "@/lib/hr-api";
import { bahtText, formatMoney } from "@/lib/invoice";
import { escapeHtml, printHtmlDocument, safeFileName } from "@/lib/print-html";
import { canUseOfficialForm, OFFICIAL_FORM_STYLE, officialFormPageHtml } from "@/lib/wht-form-layout";

// หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ที่บริษัทออก (ผู้ใช้ 2026-10-06) - จัดหน้าตามใบตัวอย่างของบริษัท (ฟอร์มทางการของกรมสรรพากรเต็มรูปแบบ), A4
// วันที่ทุกช่องเป็นปี ค.ศ. (24/1/2026) ตามใบที่บริษัทใช้อยู่ - ไม่ใช่ พ.ศ.
// 1 ใบ = 2 หน้า (ฉบับที่ 1 แนบแบบแสดงรายการภาษี / ฉบับที่ 2 เก็บเป็นหลักฐาน) ทุกหน้าพิมพ์คำอธิบายทั้งสองฉบับไว้มุมบนเหมือนฟอร์มจริง
// ไม่พิมพ์ลายเซ็น (ผู้ใช้ 2026-10-06: เอาลายเซ็นออก - ต้นฉบับก็ไม่มี) ช่องลงชื่อเว้นว่างให้เซ็นเอง
// ใบที่ยกเลิกแล้วพิมพ์ซ้ำได้ มีลายน้ำ "ยกเลิก"

const esc = (t: string | null | undefined) => escapeHtml(t ?? "");

// ค.ศ. YYYY-MM-DD -> "24/1/2026"
function dmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])}/${Number(m[2])}/${m[1]}` : iso;
}

// เลขประจำตัว 13 หลัก -> ช่องตัวเลข 1-4-5-2-1 เหมือนฟอร์มจริง; รูปแบบอื่น (พนักงานต่างชาติ) พิมพ์เป็นข้อความ
function idBoxes(id: string): string {
  const d = id.replace(/[\s-]/g, "");
  if (!/^\d{13}$/.test(d)) return `<span class="idtext">${esc(id)}</span>`;
  const cells = (s: string) => [...s].map((c) => `<span class="c">${c}</span>`).join("");
  return `<span class="ids">${cells(d[0])}<i>-</i>${cells(d.slice(1, 5))}<i>-</i>${cells(d.slice(5, 10))}<i>-</i>${cells(d.slice(10, 12))}<i>-</i>${cells(d[12])}</span>`;
}

const cb = (on: boolean) => `<span class="cb${on ? " on" : ""}"></span>`;
const money = (n: number) => formatMoney(n);

// แถวตามข้อของฟอร์มทางการ (ข้อ 4(ข) เงินปันผลพิมพ์เป็นแถวว่างไว้ - ระบบนี้ไม่ออกให้เงินปันผล)
const DIVIDEND_ROWS = `
<tr><td class="t ind1">(ข) เงินปันผล เงินส่วนแบ่งของกำไร ฯลฯ ตามมาตรา 40 (4) (ข)</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind2">(1) กรณีผู้ได้รับเงินปันผลได้รับเครดิตภาษี โดยจ่ายจากกำไรสุทธิของกิจการที่ต้องเสียภาษีเงินได้นิติบุคคลในอัตราดังนี้</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(1.1) อัตราร้อยละ 30 ของกำไรสุทธิ</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(1.2) อัตราร้อยละ 25 ของกำไรสุทธิ</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(1.3) อัตราร้อยละ 20 ของกำไรสุทธิ</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(1.4) อัตราอื่น ๆ (ระบุ) ................ ของกำไรสุทธิ</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind2">(2) กรณีผู้ได้รับเงินปันผลไม่ได้รับเครดิตภาษี เนื่องจากจ่ายจาก</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(2.1) กำไรสุทธิของกิจการที่ได้รับยกเว้นภาษีเงินได้นิติบุคคล</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(2.2) เงินปันผลหรือเงินส่วนแบ่งของกำไรที่ได้รับยกเว้นไม่ต้องนำมารวมคำนวณเป็นรายได้เพื่อเสียภาษีเงินได้นิติบุคคล</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(2.3) กำไรสุทธิส่วนที่ได้หักผลขาดทุนสุทธิยกมาไม่เกิน 5 ปี ก่อนรอบระยะเวลาบัญชีปัจจุบัน</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(2.4) กำไรที่รับรู้ตามวิธีส่วนได้เสีย (equity method)</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>
<tr><td class="t ind3">(2.5) อื่น ๆ (ระบุ) ................</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>`;

const LABEL: Record<WhtIncomeType, string> = {
  SALARY: "1. เงินเดือน ค่าจ้าง เบี้ยเลี้ยง โบนัส ฯลฯ ตามมาตรา 40 (1)",
  FEE: "2. ค่าธรรมเนียม ค่านายหน้า ฯลฯ ตามมาตรา 40 (2)",
  ROYALTY: "3. ค่าแห่งลิขสิทธิ์ ฯลฯ ตามมาตรา 40 (3)",
  INTEREST: "4. (ก) ดอกเบี้ย ฯลฯ ตามมาตรา 40 (4) (ก)",
  SERVICE: "5. การจ่ายเงินที่ต้องหักภาษี ณ ที่จ่ายตามคำสั่งกรมสรรพากรที่ออกตามมาตรา 3 เตรส เช่น รางวัล ส่วนลดหรือประโยชน์ใด ๆ เนื่องจากการส่งเสริมการขาย รางวัลในการประกวด การแข่งขัน การชิงโชค ค่าแสดงของนักแสดงสาธารณะ ค่าจ้างทำของ ค่าโฆษณา ค่าเช่า ค่าขนส่ง ค่าบริการ ค่าเบี้ยประกันวินาศภัย ฯลฯ",
  OTHER: "6. อื่น ๆ (ระบุ)",
};

function dateCell(i: WhtItem): string {
  return esc(i.dateLabel || dmy(i.paidDate));
}

function line(type: WhtIncomeType, items: WhtItem[]): string {
  const mine = items.filter((i) => i.incomeType === type);
  const showsDescription = type === "SERVICE" || type === "OTHER";
  if (!mine.length) return `<tr><td class="t">${esc(LABEL[type])}</td><td class="c"></td><td class="n"></td><td class="n"></td></tr>`;
  return mine
    .map(
      (i, idx) =>
        `<tr><td class="t">${idx === 0 ? esc(LABEL[type]) : ""}${showsDescription && i.description ? `<div class="sp">(ระบุ) ${esc(i.description)}</div>` : ""}</td><td class="c">${dateCell(i)}</td><td class="n">${money(i.amountPaid)}</td><td class="n">${money(i.taxWithheld)}</td></tr>`,
    )
    .join("");
}

function rowsHtml(items: WhtItem[]): string {
  return [line("SALARY", items), line("FEE", items), line("ROYALTY", items), line("INTEREST", items), DIVIDEND_ROWS, line("SERVICE", items), line("OTHER", items)].join("");
}

export interface WhtPrintOptions {
  assetBase?: string; // ที่อยู่ที่เปิดภาพฟอร์มเปล่าได้ (ค่าเริ่มต้นตอนพิมพ์จากหน้าเว็บ = origin ของหน้านั้น)
}

function pageHtml(c: WhtCertificate): string {
  const form = c.formType;
  return `<section class="page">
  ${c.status === "CANCELLED" ? `<div class="wm">ยกเลิก</div>` : ""}
  <div class="top">
    <div class="copies"><div><b>ฉบับที่ 1</b> (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย ใช้แนบพร้อมกับแบบแสดงรายการภาษี)</div><div><b>ฉบับที่ 2</b> (สำหรับผู้ถูกหักภาษี ณ ที่จ่าย เก็บไว้เป็นหลักฐาน)</div></div>
  </div>
  <div class="frame">
    <div class="head">
      <div class="title"><div class="h1">หนังสือรับรองการหักภาษี ณ ที่จ่าย</div><div class="h2">ตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร</div></div>
      <div class="no"><div>เล่มที่ <span class="dots w16"></span></div><div>เลขที่ <b>${esc(c.certificateNo)}</b></div></div>
    </div>

    <div class="party">
      <div class="who"><div class="l1"><b>ผู้มีหน้าที่หักภาษี ณ ที่จ่าย :</b> -</div>
        <div class="l2"><span class="k">ชื่อ</span> <b>${esc(c.payer.nameTh)}</b></div>
        <div class="hint">(ให้ระบุว่าเป็น บุคคล นิติบุคคล บริษัท สมาคม หรือคณะบุคคล)</div>
        <div class="l2"><span class="k">ที่อยู่</span> ${esc(c.payer.addressLines.join(" "))}</div>
        <div class="hint">(ให้ระบุ ชื่ออาคาร/หมู่บ้าน ห้องเลขที่ ชั้นที่ เลขที่ ตรอก/ซอย หมู่ที่ ถนน ตำบล/แขวง อำเภอ/เขต จังหวัด)</div></div>
      <div class="pid"><div class="idl">เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)*</div>${idBoxes(c.payer.taxId)}</div>
    </div>

    <div class="party">
      <div class="who"><div class="l1"><b>ผู้ถูกหักภาษี ณ ที่จ่าย :</b> -</div>
        <div class="l2"><span class="k">ชื่อ</span> <b>${esc(c.payeeName)}</b></div>
        <div class="hint">(ให้ระบุว่าเป็น บุคคล นิติบุคคล บริษัท สมาคม หรือคณะบุคคล)</div>
        <div class="l2"><span class="k">ที่อยู่</span> ${c.payeeAddress ? esc(c.payeeAddress) : `<span class="dots w120"></span>`}</div>
        <div class="hint">(ให้ระบุ ชื่ออาคาร/หมู่บ้าน ห้องเลขที่ ชั้นที่ เลขที่ ตรอก/ซอย หมู่ที่ ถนน ตำบล/แขวง อำเภอ/เขต จังหวัด)</div></div>
      <div class="pid"><div class="idl">เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)*</div>${idBoxes(c.payeeTaxId)}</div>
    </div>

    <div class="forms">
      <div class="seq"><span class="k">ลำดับที่</span> <span class="seqbox"></span> <span class="k">ในแบบ</span><div class="hint">(ให้สามารถอ้างอิงหรือสอบยันกันได้ระหว่างลำดับที่ตามหนังสือรับรองฯ กับแบบยื่นรายการภาษีหัก ณ ที่จ่าย)</div></div>
      <div class="fg">
        <div>${cb(form === "PND1K")} (1) ภ.ง.ด.1ก</div><div>${cb(false)} (2) ภ.ง.ด.1ก พิเศษ</div><div>${cb(false)} (3) ภ.ง.ด.2</div><div>${cb(form === "PND3")} (4) ภ.ง.ด.3</div>
        <div>${cb(false)} (5) ภ.ง.ด.2ก</div><div>${cb(false)} (6) ภ.ง.ด.3ก</div><div>${cb(false)} (7) ภ.ง.ด.53</div><div></div>
      </div>
    </div>

    <table class="items">
      <thead><tr><th>ประเภทเงินได้พึงประเมินที่จ่าย</th><th class="w-date">วัน เดือน<br>หรือปีภาษี ที่จ่าย</th><th class="w-num">จำนวนเงินที่จ่าย</th><th class="w-num">ภาษีที่หัก<br>และนำส่งไว้</th></tr></thead>
      <tbody>
        ${rowsHtml(c.items)}
        <tr class="sum"><td class="t" colspan="2"><b>รวมเงินที่จ่ายและภาษีที่หักนำส่ง</b></td><td class="n"><b>${money(c.totalPaid)}</b></td><td class="n"><b>${money(c.totalTax)}</b></td></tr>
      </tbody>
    </table>
    <div class="words"><b>รวมเงินภาษีที่หักนำส่ง (ตัวอักษร)</b><span class="wbox">${c.totalTax > 0 ? esc(bahtText(c.totalTax)) : "ศูนย์บาทถ้วน"}</span></div>

    <div class="fund"><b>เงินที่จ่ายเข้า</b> กบข./กสจ./กองทุนสงเคราะห์ครูโรงเรียนเอกชน ........... บาท &nbsp; กองทุนประกันสังคม <b>${money(c.ssoAmount)}</b> บาท &nbsp; กองทุนสำรองเลี้ยงชีพ <b>${money(c.providentFund)}</b> บาท</div>

    <div class="paym"><b>ผู้จ่ายเงิน</b>
      ${cb(c.payMethod === "WITHHOLD")} (1) หัก ณ ที่จ่าย&nbsp;&nbsp;${cb(c.payMethod === "FOREVER")} (2) ออกให้ตลอดไป&nbsp;&nbsp;${cb(c.payMethod === "ONCE")} (3) ออกให้ครั้งเดียว&nbsp;&nbsp;${cb(false)} (4) อื่น ๆ (ระบุ) ..........
    </div>
    ${c.note ? `<div class="note"><b>หมายเหตุ</b> ${esc(c.note)}</div>` : ""}

    <div class="foot">
      <div class="warn"><b>คำเตือน</b> ผู้มีหน้าที่ออกหนังสือรับรองการหักภาษี ณ ที่จ่ายฝ่าฝืนไม่ปฏิบัติตามมาตรา 50 ทวิ แห่งประมวลรัษฎากร ต้องรับโทษทางอาญาตามมาตรา 35 แห่งประมวลรัษฎากร</div>
      <div class="cert">ขอรับรองว่าข้อความและตัวเลขดังกล่าวข้างต้นถูกต้องตรงกับความจริงทุกประการ
        <div class="sg">
          <div class="sl"></div>
          <div>ลงชื่อ <span class="sgn"></span> ผู้จ่ายเงิน</div>
          <div class="date"><b>${esc(dmy(c.issueDate))}</b></div>
          <div class="hint">(วัน เดือน ปี ที่ออกหนังสือรับรองฯ)</div>
        </div>
      </div>
      <div class="seal">ประทับตรา<br>นิติบุคคล<br>(ถ้ามี)</div>
    </div>
  </div>
  <div class="notes">
    <div><b>หมายเหตุ</b> เลขประจำตัวผู้เสียภาษีอากร (13 หลัก)* หมายถึง</div>
    <div>1. กรณีบุคคลธรรมดาไทย ให้ใช้เลขประจำตัวประชาชนของกรมการปกครอง</div>
    <div>2. กรณีนิติบุคคล ให้ใช้เลขทะเบียนนิติบุคคลของกรมพัฒนาธุรกิจการค้า</div>
    <div>3. กรณีอื่น ๆ นอกเหนือจากข้อ 1 และ 2 ให้ใช้เลขประจำตัวผู้เสียภาษีอากร (13 หลัก) ของกรมสรรพากร</div>
  </div>
</section>`;
}

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">`;

// ฟอร์มยาว (มีแถวเงินปันผล) ต้องพอดี 1 หน้า A4: ตัวหนังสือ 9pt, ขอบกระดาษแคบ
const STYLE = `
@page{size:A4;margin:8mm 10mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Sarabun","Noto Sans Thai","Leelawadee UI","Tahoma",sans-serif;font-size:8.5pt;line-height:1.22;color:#000;font-variant-numeric:tabular-nums lining-nums;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{position:relative;break-after:page;page-break-after:always;break-inside:avoid;height:279mm}
.page:last-child{break-after:auto;page-break-after:auto}
.wm{position:absolute;left:0;right:0;top:100mm;text-align:center;font-size:96pt;font-weight:700;opacity:.08;transform:rotate(-24deg);pointer-events:none;z-index:2}
.top{display:flex;justify-content:space-between;font-size:8.5pt;margin-bottom:1.5mm}
.copies{line-height:1.3}
.frame{border:.9pt solid #000}
.head{display:flex;justify-content:space-between;align-items:stretch;border-bottom:.9pt solid #000}
.title{flex:1;text-align:center;padding:1.5mm 0}
.h1{font-size:13pt;font-weight:700;line-height:1.3}
.h2{font-size:9.5pt}
.no{width:48mm;border-left:.9pt solid #000;padding:1mm 2mm;display:flex;flex-direction:column;justify-content:center;gap:.5mm}
.party{display:flex;border-bottom:.9pt solid #000}
.who{flex:1;padding:.6mm 2mm}
.l1{margin-bottom:.2mm}.l2{line-height:1.25}
.hint{font-size:6.8pt;color:#333;line-height:1.15}
.pid{width:86mm;border-left:.9pt solid #000;padding:.8mm 2mm}
.idl{font-size:8pt;margin-bottom:.8mm}
.ids{display:inline-flex;align-items:center;gap:.4mm}
.ids .c{display:inline-block;width:4.3mm;height:5mm;border:.6pt solid #000;text-align:center;font-weight:600;line-height:5mm}
.ids i{font-style:normal;margin:0 .3mm}
.idtext{font-weight:600}
.forms{display:flex;border-bottom:.9pt solid #000;padding:.6mm 2mm;gap:3mm;align-items:center}
.seq{width:62mm}
.seqbox{display:inline-block;width:24mm;height:5mm;border:.6pt solid #000;vertical-align:middle}
.fg{flex:1;display:grid;grid-template-columns:repeat(4,1fr);gap:1mm 2mm}
.dots{display:inline-block;border-bottom:.5pt dotted #000;height:1em;vertical-align:baseline}
.dots.w16{width:16mm}.dots.w120{width:70mm}
.cb{display:inline-block;width:3.2mm;height:3.2mm;border:.6pt solid #000;vertical-align:-.5mm;margin-right:.8mm}
.cb.on{background:#000;box-shadow:inset 0 0 0 .55mm #fff}
table.items{width:100%;border-collapse:collapse}
table.items th,table.items td{border:.6pt solid #000;border-top:0;padding:.25mm 1.5mm;vertical-align:top}
table.items th{font-weight:700;text-align:center;line-height:1.25;border-top:0;padding:1mm}
table.items th:first-child,table.items td:first-child{border-left:0}
table.items th:last-child,table.items td:last-child{border-right:0}
.w-date{width:30mm}.w-num{width:34mm}
td.t{line-height:1.15;font-size:8pt}
td.ind1{padding-left:4mm}td.ind2{padding-left:7mm}td.ind3{padding-left:10mm}
td.c{text-align:center}
td.n{text-align:right;white-space:nowrap}
.sp{font-size:8.5pt}
tr.sum td{padding:.8mm 1.5mm;font-size:9pt}
.words{display:flex;align-items:center;gap:3mm;padding:.8mm 2mm;border-bottom:.9pt solid #000}
.wbox{flex:1;background:#d9d9d9;padding:.8mm 3mm;font-weight:700;font-size:10pt}
.fund{padding:.8mm 2mm;border-bottom:.9pt solid #000;font-size:8pt}
.paym{padding:.8mm 2mm;border-bottom:.9pt solid #000}
.note{padding:.6mm 2mm;border-bottom:.9pt solid #000}
.foot{display:grid;grid-template-columns:44mm 1fr 22mm;gap:3mm;padding:1.5mm 2mm;align-items:start}
.warn{font-size:7pt;line-height:1.2;border:.6pt solid #000;padding:1mm 1.5mm}
.cert{text-align:center;padding-top:.5mm}
.sg{margin:1mm auto 0;width:84mm}
.sg .sl{height:10mm;display:flex;align-items:flex-end;justify-content:center}
.sg .sl img{max-height:9.5mm;max-width:46mm;object-fit:contain}
.sgn{display:inline-block;min-width:44mm;border-bottom:.5pt dotted #000;font-weight:600}
.date{margin-top:.5mm}
.seal{border:.6pt solid #000;border-radius:50%;width:20mm;height:20mm;display:flex;align-items:center;justify-content:center;text-align:center;font-size:7.5pt;line-height:1.25;color:#333;margin-top:1mm}
.notes{margin-top:1mm;font-size:7pt;line-height:1.2}
`;

// หน้าตาเหมือนใบ PDF ที่บริษัทใช้อยู่ (ผู้ใช้ 2026-10-06): ฟอร์มเปล่าของสรรพากรเป็นพื้น + ข้อมูลวางทับตามช่องกรอกเดิม (lib/wht-form-layout.ts)
// ใบที่มีรายการเกินช่องของแบบ (เช่น ข้อ 5 เกิน 4 รายการ) ใช้หน้าแบบเดิมด้านล่างแทน เพื่อไม่ให้ข้อมูลหายไป
export function whtDocumentHtml(certs: WhtCertificate[], options: WhtPrintOptions = {}): string {
  if (certs.every(canUseOfficialForm)) {
    const body = certs.flatMap((c) => [officialFormPageHtml(c, options), officialFormPageHtml(c, options)]).join("\n");
    const title = certs.length === 1 ? `50 ทวิ ${certs[0].certificateNo}` : `50 ทวิ ${certs.length} ใบ`;
    return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${OFFICIAL_FORM_STYLE}</style></head><body>${body}</body></html>`;
  }
  // 1 ใบ = 2 หน้าเหมือนกัน (ฉบับที่ 1 + ฉบับที่ 2) เพื่อไม่ต้องถ่ายเอกสารเพิ่ม
  const body = certs.flatMap((c) => [pageHtml(c), pageHtml(c)]).join("\n");
  const title = certs.length === 1 ? `50 ทวิ ${certs[0].certificateNo}` : `50 ทวิ ${certs.length} ใบ`;
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>${esc(title)}</title>${FONT_LINK}<style>${STYLE}</style></head><body>${body}</body></html>`;
}

export function printWhtCertificates(certs: WhtCertificate[], options: WhtPrintOptions = {}): void {
  if (!certs.length) return;
  const name = certs.length === 1 ? `50 ทวิ ${certs[0].certificateNo} ${certs[0].payeeName}` : `50 ทวิ ${certs.length} ใบ ปี ${certs[0].taxYear}`;
  // ภาพฟอร์มเปล่าอยู่ที่ /forms/... ของเว็บเดียวกัน - iframe srcdoc ไม่มี base URL จึงต้องใส่ origin เต็ม
  const assetBase = options.assetBase ?? (typeof window === "undefined" ? "" : window.location.origin);
  printHtmlDocument(whtDocumentHtml(certs, { ...options, assetBase }), safeFileName(name));
}
