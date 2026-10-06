import { zipSync, strToU8, type Zippable } from "fflate";
import { fetchAuthedBlob } from "@/lib/api";
import { WHT_METHOD_LABEL, whtCertificateFilePath, type TaxInvoice } from "@/lib/billing-api";
import { isoToDisplayDate } from "@/lib/date";
import { round2 } from "@/lib/invoice";
import { htmlToPdfBlob } from "@/lib/pdf-export";
import { buildTaxInvoiceBundleHtml } from "@/lib/tax-invoice-print";

// ชุดส่งบัญชีรายเดือน (ผู้ใช้ 2026-10-06: ส่งอีเมลเดือนละครั้ง เอาครบทุกอย่าง): ไฟล์ ZIP ไฟล์เดียวมี
//  1) tax-sales-report.xlsx  รายงานภาษีขาย (+ ค่าธรรมเนียมทดรองจ่าย ยอดหัก ณ ที่จ่าย) และชีท 50 ทวิ ของเดือน
//  2) tax-invoice-copies.pdf สำเนาใบกำกับทุกใบ เรียงตามเลขที่ (ใบที่ยกเลิกมีลายน้ำ)
//  3) 50tawi/…               ไฟล์ 50 ทวิ ที่แนบไว้กับใบกำกับของเดือนนั้น
//  4) summary.txt            สรุปจำนวน/ยอด และไฟล์ที่ดึงไม่สำเร็จ (ถ้ามี)
// สร้างบนหน้าเว็บทั้งหมด (ข้อมูลจาก GET /api/billing/tax-invoices?month=) - ชื่อไฟล์ข้างใน ASCII ล้วนกันชื่อไทยเพี้ยนในโปรแกรมแตกไฟล์บางตัว
// ระบบยังไม่ส่งอีเมลเอง (ยังไม่มีบริการส่งอีเมล) - ผู้ใช้ดาวน์โหลดแล้วแนบอีเมลเอง

const SALES_SHEET = "ภาษีขาย";
const WHT_SHEET = "50 ทวิ";
const MAX_EMAIL_BYTES = 20 * 1024 * 1024; // เกินนี้อีเมลหลายเจ้าไม่รับไฟล์แนบ

const isActive = (t: TaxInvoice) => t.status === "ISSUED";

export function salesTaxRows(rows: TaxInvoice[]) {
  return rows.map((t, i) => {
    const off = !isActive(t); // ใบที่ยกเลิก: เก็บเลขไว้ในรายงาน ยอดเป็น 0
    const cert = t.whtCertificate;
    return {
      ลำดับ: i + 1,
      "วัน เดือน ปี": isoToDisplayDate(t.issueDate),
      เลขที่ใบกำกับ: t.taxInvoiceNo,
      เลขที่ใบวางบิล: t.invoiceNo ?? "",
      "ชื่อผู้ซื้อสินค้า/ผู้รับบริการ": t.customer.name,
      เลขประจำตัวผู้เสียภาษี: t.customer.taxId ?? "",
      สถานประกอบการ: t.customer.taxId ? t.customer.branch || "สำนักงานใหญ่" : "",
      "มูลค่าสินค้าหรือบริการ (ก่อน VAT)": off ? 0 : round2(t.serviceTotal + t.goodsTotal),
      ภาษีมูลค่าเพิ่ม: off ? 0 : t.vatAmount,
      "ค่าธรรมเนียมทดรองจ่าย (ไม่มี VAT)": off ? 0 : t.feeTotal,
      รวมตามใบกำกับ: off ? 0 : t.grandTotal,
      "ภาษีหัก ณ ที่จ่าย": off ? 0 : t.whtAmount,
      รับสุทธิ: off ? 0 : t.receivedAmount,
      "สถานะ 50 ทวิ": off || t.whtAmount <= 0 ? "" : cert ? `ได้แล้ว (${WHT_METHOD_LABEL[cert.method]})` : "รอ 50 ทวิ",
      หมายเหตุ: off ? `ยกเลิก - ${t.cancelReason ?? ""}` : t.replacesNo ? `ออกแทน ${t.replacesNo}` : "",
    };
  });
}

function certFileName(tvs: TaxInvoice[], certId: string, certNo: string | null, ext: string) {
  const safe = (certNo ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return `50tawi/${tvs.map((x) => x.taxInvoiceNo).join("+")}_${safe || certId.slice(-6)}.${ext}`;
}

const extOf = (type: string) => (type.includes("pdf") ? "pdf" : type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg");

// ไฟล์ Excel รายงานภาษีขาย (ชีท "ภาษีขาย" + แถวรวมของใบที่ยังใช้อยู่ + ชีท "50 ทวิ") - ใช้ทั้งปุ่ม Excel เดี่ยวและชุดส่งบัญชี
export async function buildSalesTaxExcel(rows: TaxInvoice[], fileNameByCert: Map<string, string> = new Map()): Promise<Uint8Array> {
  const XLSX = await import("xlsx");
  const book = XLSX.utils.book_new();

  const active = rows.filter(isActive);
  const sum = (f: (t: TaxInvoice) => number) => round2(active.reduce((s, t) => s + f(t), 0));
  const sheet = XLSX.utils.json_to_sheet(salesTaxRows(rows));
  // แถวรวมท้ายตาราง (เฉพาะใบที่ยังใช้อยู่ - ตรงกับยอดที่ลง ภ.พ.30)
  XLSX.utils.sheet_add_aoa(
    sheet,
    [["", "", "", "", "", "", "รวม (ไม่นับใบที่ยกเลิก)", sum((t) => t.serviceTotal + t.goodsTotal), sum((t) => t.vatAmount), sum((t) => t.feeTotal), sum((t) => t.grandTotal), sum((t) => t.whtAmount), sum((t) => t.receivedAmount)]],
    { origin: -1 },
  );
  sheet["!cols"] = [{ wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 38 }, { wch: 16 }, { wch: 22 }, { wch: 18 }, { wch: 14 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 32 }];
  XLSX.utils.book_append_sheet(book, sheet, SALES_SHEET);

  const whtRows = active
    .filter((t) => t.whtAmount > 0)
    .map((t) => ({
      เลขที่ใบกำกับ: t.taxInvoiceNo,
      "วัน เดือน ปี": isoToDisplayDate(t.issueDate),
      ลูกค้า: t.customer.name,
      ภาษีที่ลูกค้าหัก: t.whtAmount,
      แบบ: t.whtCertificate ? WHT_METHOD_LABEL[t.whtCertificate.method] : WHT_METHOD_LABEL[t.whtMethod],
      สถานะ: t.whtCertificate ? "ได้แล้ว" : "รอ 50 ทวิ",
      "เลขที่หนังสือรับรอง / เลขอ้างอิง": t.whtCertificate?.certificateNo ?? "",
      วันที่ในหนังสือรับรอง: t.whtCertificate?.certificateDate ? isoToDisplayDate(t.whtCertificate.certificateDate) : "",
      ยอดตามหนังสือรับรอง: t.whtCertificate?.amount ?? "",
      ไฟล์ในชุดส่งบัญชี: t.whtCertificate ? (fileNameByCert.get(t.whtCertificate.id) ?? (t.whtCertificate.hasFile ? "" : "ไม่มีไฟล์")) : "",
    }));
  const whtSheet = XLSX.utils.json_to_sheet(whtRows.length ? whtRows : [{ เลขที่ใบกำกับ: "ไม่มีใบกำกับที่ลูกค้าหัก ณ ที่จ่ายในเดือนนี้" }]);
  whtSheet["!cols"] = [{ wch: 14 }, { wch: 12 }, { wch: 38 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 24 }, { wch: 18 }, { wch: 18 }, { wch: 44 }];
  XLSX.utils.book_append_sheet(book, whtSheet, WHT_SHEET);

  return new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

export interface AccountingPackage {
  blob: Blob;
  fileName: string;
  sizeBytes: number;
  tooBigForEmail: boolean;
  taxInvoices: number;
  cancelled: number;
  certificateFiles: number;
  warnings: string[];
}

export async function buildAccountingPackage(month: string, rows: TaxInvoice[], onProgress: (text: string) => void): Promise<AccountingPackage> {
  const warnings: string[] = [];
  const active = rows.filter(isActive);
  const files: Zippable = {};

  // 50 ทวิ: ไฟล์เดียวอาจครอบคลุมหลายใบกำกับ - เก็บไฟล์เดียว ตั้งชื่อด้วยเลข TV ทุกใบที่ครอบคลุม
  const certs = new Map<string, TaxInvoice[]>();
  for (const t of active) if (t.whtCertificate?.hasFile) certs.set(t.whtCertificate.id, [...(certs.get(t.whtCertificate.id) ?? []), t]);
  const fileNameByCert = new Map<string, string>();
  let n = 0;
  for (const [certId, tvs] of certs) {
    n += 1;
    onProgress(`ดึงไฟล์ 50 ทวิ ${n}/${certs.size}...`);
    const cert = tvs[0].whtCertificate!;
    try {
      const blob = await fetchAuthedBlob(whtCertificateFilePath(certId));
      const name = certFileName(tvs, certId, cert.certificateNo, extOf(blob.type));
      files[name] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      fileNameByCert.set(certId, name);
    } catch (err) {
      warnings.push(`ดึงไฟล์ 50 ทวิ ของ ${tvs.map((x) => x.taxInvoiceNo).join(", ")} ไม่สำเร็จ: ${err instanceof Error ? err.message : "ไม่ทราบสาเหตุ"}`);
    }
  }

  onProgress("สร้าง Excel รายงานภาษีขาย...");
  files["tax-sales-report.xlsx"] = [await buildSalesTaxExcel(rows, fileNameByCert), { level: 0 }];

  onProgress(`สร้าง PDF สำเนาใบกำกับ ${rows.length} ใบ (ใช้เวลาสักครู่)...`);
  const pdf = await htmlToPdfBlob(buildTaxInvoiceBundleHtml(rows), { orientation: "portrait", marginMm: 12 });
  files["tax-invoice-copies.pdf"] = [new Uint8Array(await pdf.arrayBuffer()), { level: 0 }];

  const sum = (f: (t: TaxInvoice) => number) => round2(active.reduce((s, t) => s + f(t), 0));
  const waiting = active.filter((t) => t.whtAmount > 0 && !t.whtCertificate);
  files["summary.txt"] = strToU8(
    [
      `ชุดส่งบัญชี - ใบกำกับภาษี เดือน ${month}`,
      `ใบกำกับที่ใช้อยู่ ${active.length} ใบ · ยกเลิก ${rows.length - active.length} ใบ (ในไฟล์ PDF/Excel เรียงตามเลขที่)`,
      `มูลค่าสินค้า/บริการ ${sum((t) => t.serviceTotal + t.goodsTotal).toFixed(2)} · VAT ${sum((t) => t.vatAmount).toFixed(2)} · ค่าธรรมเนียมทดรองจ่าย ${sum((t) => t.feeTotal).toFixed(2)}`,
      `รวมตามใบกำกับ ${sum((t) => t.grandTotal).toFixed(2)} · หัก ณ ที่จ่าย ${sum((t) => t.whtAmount).toFixed(2)} · รับสุทธิ ${sum((t) => t.receivedAmount).toFixed(2)}`,
      `ไฟล์ 50 ทวิ ในชุดนี้ ${fileNameByCert.size} ไฟล์ · ใบกำกับที่ยังรอ 50 ทวิ ${waiting.length} ใบ${waiting.length ? ` (${waiting.map((t) => t.taxInvoiceNo).join(", ")})` : ""}`,
      ...(warnings.length ? ["", "ข้อควรตรวจ:", ...warnings.map((w) => `- ${w}`)] : []),
      "",
      "tax-sales-report.xlsx = รายงานภาษีขาย (ชีท 'ภาษีขาย') + รายการ 50 ทวิ (ชีท '50 ทวิ')",
      "tax-invoice-copies.pdf = สำเนาใบกำกับทุกใบ ใบที่ยกเลิกมีลายน้ำ",
      "50tawi/ = ไฟล์ 50 ทวิ ที่ลูกค้าส่งมา ชื่อไฟล์ขึ้นต้นด้วยเลขใบกำกับที่ครอบคลุม",
    ].join("\r\n"),
  );

  onProgress("รวมเป็นไฟล์ ZIP...");
  const zipped = zipSync(files);
  const blob = new Blob([zipped as BlobPart], { type: "application/zip" });
  return {
    blob,
    fileName: `ชุดส่งบัญชี-ใบกำกับภาษี-${month}.zip`,
    sizeBytes: blob.size,
    tooBigForEmail: blob.size > MAX_EMAIL_BYTES,
    taxInvoices: rows.length,
    cancelled: rows.length - active.length,
    certificateFiles: fileNameByCert.size,
    warnings,
  };
}
