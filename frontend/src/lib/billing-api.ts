import { request } from "@/lib/api";

// ส่งงานลูกค้า (พนักงาน) - ดู backend/src/delivery/delivery.service.ts
// DONE = ส่งเล่มและป้ายครบแล้ว (อยู่ในรายการคันอื่นของใบยื่น / ตอบ 409 ถ้าหน้าที่เปิดค้างไว้บันทึกซ้ำ)
export type DeliveryKind = "FULL" | "NO_PLATE" | "PLATE_ONLY" | "WAITING_PLATE" | "DONE";

// งานสลับเลขส่งคืนลูกค้าในใบเดียวกับรถจดใหม่ได้ (ผู้ใช้ 2026-09-28) - แถวในคิว/ใบส่งงานจึงมาจาก 2 ที่
export type DeliverySource = "VEHICLE" | "PLATE_SWAP";

export interface DeliveryRow {
  id: string; // vehicleId หรือ plateSwapId แล้วแต่ source
  source: DeliverySource;
  customerId: string;
  customerName: string;
  chassis: string;
  brandName: string;
  body: string | null;
  vehicleKind: "car" | "moto"; // แถวงานสลับเลขไม่มี body ให้ดู (ผู้ใช้ 2026-09-28)
  plateCategory: string | null;
  plateNumber: string | null;
  receiptNo: string | null;
  kind: DeliveryKind;
  plateReceived: boolean;
  deliveredDate: string | null;
  plateDeliveredDate: string | null; // null ทั้งที่ deliveredDate มีค่า = ป้ายค้างส่ง
  recipient: string | null;
  note: string | null;
  invoiceNo: string | null; // บัญชีวางบิลแล้วในบิลเลขนี้
  // ใบยื่นล่าสุด = lot ของรถคันนี้ (หน้า Delivery จัดการ์ดตามใบยื่น ผู้ใช้ 2026-09-26)
  submitDate: string | null;
  urgent: boolean;
  submittedAt: string | null;
  submissionStatus: string | null;
  receiptReceived: boolean;
  bookReceived: boolean;
  // ใบที่ส่งเล่มไป (เฉพาะคันที่ส่งเล่มแล้ว) - ปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ในรายงานส่งงานอ้างถึงใบนี้
  bookSlip: { id: string; slipNo: number; date: string } | null;
}

// ใบส่งงาน Delivery: บันทึกส่ง 1 ครั้ง = 1 ใบ บอกแยกรายคันว่ารอบนี้ส่งใบเสร็จ / เล่ม / ป้าย (ไม่มีราคา)
export interface DeliverySlipItem {
  id: string; // id ของแถว - ใช้ระบุแถวตอนยกเลิก/ติ๊กป้าย (แถวงานสลับเลขไม่มี vehicleId)
  vehicleId: string | null;
  plateSwapId: string | null;
  source: DeliverySource;
  chassis: string;
  brandName: string;
  body: string | null;
  vehicleKind: "car" | "moto"; // แถวงานสลับเลขไม่มี body ให้ดู (ผู้ใช้ 2026-09-28)
  plateText: string; // "8ขง 363" หรือ "" ถ้ายังไม่มีทะเบียน
  receiptNo: string | null;
  receipt: boolean;
  book: boolean;
  plate: boolean;
  // ยกเลิกรายคัน (คีย์ผิด) - รายการยังอยู่ในใบพร้อมเหตุผล แต่ไม่นับและไม่พิมพ์
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  invoiceNo: string | null; // วางบิลแล้ว = ยกเลิก / เปลี่ยนวันที่ส่งไม่ได้
  billingClosed: boolean; // ปิดงาน - วางบิลนอกระบบ = ล็อกใบส่งเล่มเหมือนวางบิลแล้ว จนกว่า ADMIN เปิดงานกลับ (2026-09-27)
  ownerName: string | null; // ติดไฟแนนซ์ = ผู้ครอบครอง, ไม่ติด = ผู้ถือกรรมสิทธิ์
  // ส่งเล่มในใบนี้ ป้ายส่งตามไปในใบอื่น (อ่านสด) - null = ป้ายไปในใบนี้แล้ว / ยังค้างส่ง
  plateSentLater: { slipNo: number; date: string } | null;
}

export interface DeliverySlip {
  id: string;
  slipNo: number;
  date: string; // YYYY-MM-DD
  recipient: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  cancelledAt: string | null; // ยกเลิกทั้งใบ (ทุกคันถูกยกเลิก)
  cancelReason: string | null;
  cancelledBy: string | null;
  customer: { id: string; name: string; company: string | null; branch: string | null; address: string | null; phone: string | null; displayName: string };
  // ใบเก่าที่รวมรถยนต์ + จักรยานยนต์: คันอีกประเภทที่ยังไม่ยกเลิกซึ่งผู้ใช้นี้ไม่เห็น (ADMIN = 0)
  hiddenItems: number;
  items: DeliverySlipItem[];
}

export const slipNoText = (slipNo: number) => `DL-${String(slipNo).padStart(5, "0")}`;

// ใบที่เหลือเฉพาะคันที่ยังไม่ยกเลิก - ใช้พิมพ์ / นับ / ทำ PDF
export const activeSlip = (slip: DeliverySlip): DeliverySlip => ({ ...slip, items: slip.items.filter((i) => !i.cancelledAt) });

// วางบิลในนามบริษัท (บัญชี) - ดู backend/src/billing/billing.service.ts
// บัญชีรับเงินของลูกค้า (ผู้ใช้ 2026-09-27) - COMPANY = บัญชีบริษัท (มี VAT), PERSONAL = บัญชีบุคคล (เช่น SPI, YMAC)
export type BillingAccount = "COMPANY" | "PERSONAL";
export const ACCOUNT_LABEL: Record<BillingAccount, string> = { COMPANY: "บัญชีบริษัท", PERSONAL: "บัญชีบุคคล" };

export interface AccountPeriod {
  id: string;
  account: BillingAccount;
  effectiveFrom: string; // ISO - ใช้ตั้งแต่วันนี้ งานก่อนหน้ายังอยู่บัญชีเดิม
  remark: string;
  createdBy: string | null;
  createdAt: string;
}

export interface BillingTerms {
  vat: boolean;
  whtRate: number;
  whtSpecialRate: number | null;
  whtSpecialUntil: string | null; // ISO
  // เครดิตเทอม (วัน นับจากวันออกบิล, ผู้ใช้ 2026-09-28) - null = ไม่ได้ตั้ง · ไม่ใช้คิดยอด ใช้หาวันครบกำหนดชำระ
  creditDays?: number | null;
}

// ใบกำกับภาษี/ใบเสร็จรับเงิน (TV) ออกตอนรับเงิน (ผู้ใช้ 2026-09-28) - ดู backend/src/billing/tax-invoice.service.ts
export type WhtMethod = "NONE" | "PAPER" | "EWHT";
export const WHT_METHOD_LABEL: Record<WhtMethod, string> = { NONE: "ไม่หัก", PAPER: "50 ทวิ กระดาษ", EWHT: "e-WHT" };

export interface TaxInvoice {
  id: string;
  taxInvoiceNo: string;
  invoiceId: string;
  invoiceNo: string;
  invoiceIssueDate: string;
  customerId: string;
  customer: { name: string; branch: string | null; address: string | null; taxId: string | null };
  buyerNotVatRegistered: boolean;
  issueDate: string; // = วันที่รับเงิน
  createdAt: string;
  vatRate: number;
  feeTotal: number;
  serviceTotal: number;
  goodsTotal: number;
  vatAmount: number;
  grandTotal: number; // ก่อนหัก ณ ที่จ่าย
  whtAmount: number; // ที่ลูกค้าหักจริง
  receivedAmount: number;
  whtMethod: WhtMethod;
  whtCertificate: { id: string; method: WhtMethod; certificateNo: string | null; certificateDate: string | null; amount: number; hasFile: boolean } | null;
  whtRemindedAt: string | null;
  replacesNo: string | null; // ออกแทนใบที่ยกเลิก
  replacedByNo: string | null;
  replacementIssuedAt: string | null; // ใบแทน (ต้นฉบับหาย)
  replacementReason: string | null;
  status: "ISSUED" | "CANCELLED";
  cancelledAt: string | null;
  cancelReason: string | null;
  // สำหรับพิมพ์บรรทัดหน้าใบ (ชุดเดียวกับหน้าใบวางบิล)
  jobLabel: string;
  extras: Array<{ label: string; amount: number }>;
  whtRate: number;
  lines: InvoiceLine[];
  items: InvoiceItem[];
  lineCount: number;
}

export interface TaxInvoiceSeries {
  enabled: boolean;
  series: Array<{ year: number; lastNumber: number; nextNo: string; issuedInSystem: number }>;
}

export interface TaxInvoicePreview {
  enabled: boolean;
  buyer: { name: string; branch: string | null; address: string | null; taxId: string | null };
  missing: string[];
  missingIfNotRegistered: string[];
  nextNo: string | null;
  lastIssued: { taxInvoiceNo: string; issueDate: string } | null;
  replaces: { id: string; taxInvoiceNo: string; cancelReason: string | null; whtCertificateId: string | null } | null;
}

export interface WhtPendingRow {
  id: string;
  taxInvoiceNo: string;
  invoiceNo: string;
  issueDate: string;
  customerId: string;
  customerName: string;
  whtAmount: number;
  whtMethod: WhtMethod;
  remindedAt: string | null;
  daysWaiting: number;
}

export interface WhtCertificate {
  id: string;
  customerId: string;
  customerName: string;
  method: WhtMethod;
  certificateNo: string | null;
  certificateDate: string | null;
  amount: number;
  note: string | null;
  hasFile: boolean;
  originalName: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  taxInvoices: Array<{ id: string; taxInvoiceNo: string; whtAmount: number }>;
  taxInvoiceWhtTotal: number;
}

export const whtCertificateFilePath = (id: string) => `/api/billing/wht-certificates/${encodeURIComponent(id)}/file`;

export type RateVehicleKind = "CAR" | "MOTO" | "ANY";
// BASE = ราคาหลัก 1 แถวต่อคัน, OTHER_PROVINCE (ขอใช้ = จดจังหวัดอื่น) / URGENT (ด่วน) / PLATE_REQUEST (ขอใช้เลขทะเบียน,
// ผู้ใช้ 2026-09-28 Spac EV - คนละเรื่องกับ OTHER_PROVINCE) / TRANSFER_NOTICE (แจ้งย้าย จริง = จดต่างจังหวัด ไม่ใช่กรุงเทพฯ,
// ผู้ใช้ 2026-09-28 Spac EV) = ค่าเพิ่มที่บวกให้เอง
// PLATE_SWAP (ผู้ใช้ 2026-09-28 Spac EV) = รถคันนี้เป็น "รถใหม่" ของงานสลับเลข คิดเพิ่มจากค่าจดทะเบียนปกติ
export type RateKind = "BASE" | "OTHER_PROVINCE" | "URGENT" | "PLATE_REQUEST" | "TRANSFER_NOTICE" | "PLATE_SWAP" | "PLATE_SWAP_GIVEN";

// งานสลับเลขที่ติดมากับรถคันนี้ (ผู้ใช้ 2026-09-28) - ค่าใบเสร็จกรมฯ ของรถเก่าเก็บแยกจากใบเสร็จของรถใหม่
export interface BillingPlateSwap {
  id: string;
  oldChassis: string;
  oldPlateText: string;
  receiptNo: string | null;
  receiptAmount: number | null; // ว่าง = ยังไม่ได้กรอกยอดใบเสร็จของงานสลับเลข -> ติ๊กวางบิลไม่ได้
  receiptEstimate: number | null; // ยอด Bill ที่ระบบคิดไว้ตอนทำงานสลับเลข - ไม่ตรง = เตือนให้ตรวจ
}

export interface ServiceFeeRate {
  id: string;
  label: string;
  vehicleKind: RateVehicleKind;
  ccMin: number | null;
  ccMax: number | null;
  // ราคาแยกตามรุ่น/ยี่ห้อผู้ผลิตที่ CC ทับซ้อนกัน (ผู้ใช้ 2026-09-28, MC Superbike: เลขตัวถังขึ้นต้น ML=885 / JH=2685
  // ทั้งคู่อยู่ในช่วง 300-799cc) - เทียบไม่สนตัวพิมพ์ใหญ่เล็ก null/ว่าง = ไม่จำกัด
  chassisPrefix: string | null;
  amount: number;
  vatInclusive: boolean;
  includesReceipt: boolean; // ราคาเหมารวมค่าใบเสร็จกรมขนส่งแล้ว (ผู้ใช้ 2026-09-27, YMAC)
  kind: RateKind;
  sortOrder: number;
}

export type ServiceFeeRateInput = Omit<ServiceFeeRate, "id" | "sortOrder">;

export interface BillingVehicle {
  id: string;
  chassis: string;
  brandName: string;
  body: string | null;
  isMoto: boolean;
  cc: number | null;
  weight: number | null;
  plateCategory: string | null;
  plateNumber: string | null;
  deliveredDate: string;
  account: BillingAccount; // บัญชีของลูกค้า ณ วันส่งงานของคันนี้
  recipient: string | null;
  plateDelivered: boolean;
  receiptNo: string | null;
  receiptAmount: number | null;
  receiptAmountSource: "RECEIPT" | "BILL_ESTIMATE" | "NONE"; // BILL_ESTIMATE = พนักงานไม่ได้กรอกยอดใบเสร็จ ใช้ยอด Bill ที่ระบบคำนวณแทน
  receiptImageIds: string[]; // รูปใบเสร็จของการยื่นล่าสุด (ใหม่สุดก่อน) - แสดงในช่อง "แก้" ให้เทียบยอด
  receiptEstimate: number | null; // ยอด Bill ที่ระบบคำนวณตอนยื่นจากข้อมูลรถ - ไม่ตรงกับใบเสร็จจริง = หน้าวางบิลเตือน (ผู้ใช้ 2026-09-28)
  requestedPlateNumber: boolean;
  suggestedRateId: string | null;
  suggestedServiceFee: number | null; // ราคาหลัก + ค่าเพิ่มที่ระบบเลือก (ก่อนหักยอด)
  urgent: boolean; // การยื่นล่าสุดเป็นงานด่วน
  otherProvince: boolean; // ขอใช้ = จังหวัดที่จดทะเบียน ≠ จังหวัดเจ้าของรถ
  transferNotice: boolean; // แจ้งย้าย = จดต่างจังหวัด ไม่ใช่กรุงเทพฯ (ต่างจาก otherProvince)
  plateSwap: BillingPlateSwap | null; // รถคันนี้เป็นรถใหม่ของงานสลับเลข (null = ไม่ใช่)
  // จับคู่อัตโนมัติจากข้อมูลรถ (ผู้ใช้ 2026-09-28): ค่าเพิ่มขอใช้ (จดจังหวัดอื่น) / ด่วนที่ระบบติ๊กให้
  suggestedAddOnIds: string[];
}

export interface BillingCustomer {
  id: string;
  name: string;
  company: string | null;
  branch: string | null;
  address: string | null;
  taxId: string | null;
  account: BillingAccount; // บัญชีที่ใช้วันนี้
  terms: BillingTerms;
  rates: ServiceFeeRate[];
  vehicles: BillingVehicle[];
}

export interface InvoiceLine {
  id: string;
  vehicleId: string;
  chassis: string;
  brandName: string;
  body: string | null;
  plateText: string;
  receiptNo: string | null;
  deliveredDate: string;
  receiptAmount: number;
  serviceFee: number;
  serviceLabel: string | null;
  deduction: number;
  deductionNote: string | null;
  // งานสลับเลขของรถคันนี้ + ค่าใบเสร็จกรมฯ ของรถเก่า (ผู้ใช้ 2026-09-28) - บรรทัดเก่าเป็น null ทั้งคู่
  // ยอดค่าธรรมเนียมของบรรทัด = receiptAmount + swapReceiptAmount
  plateSwapId: string | null;
  swapReceiptAmount: number | null;
}

// บรรทัดกำหนดเอง (ผู้ใช้ 2026-09-29): FEE = ค่าธรรมเนียมราชการ ไม่มี VAT ไม่หัก · SERVICE = ค่าบริการ VAT + หัก · GOODS = ขายสินค้า VAT ไม่หัก
export type InvoiceItemKind = "FEE" | "SERVICE" | "GOODS";
export const ITEM_KIND_LABEL: Record<InvoiceItemKind, string> = { FEE: "ค่าธรรมเนียมราชการ", SERVICE: "ค่าบริการ", GOODS: "ขายสินค้า" };

export interface InvoiceItem {
  id?: string;
  kind: InvoiceItemKind;
  description: string;
  quantity: number; // จำนวน เช่น 12 คัน
  unitPrice: number; // ราคาต่อหน่วยก่อน VAT
  amount: number; // quantity x unitPrice (backend คำนวณเองตอนบันทึก)
  cost: number | null; // ต้นทุนต่อหน่วย ภายใน ไม่พิมพ์บนบิล (null = ไม่ทราบ, FEE = null เสมอ)
}

export interface Invoice {
  id: string;
  invoiceNo: string;
  issueDate: string;
  customerId: string;
  customer: { name: string; branch: string | null; address: string | null; taxId: string | null };
  jobLabel: string;
  extras: Array<{ label: string; amount: number }>;
  vatRate: number;
  whtRate: number;
  feeTotal: number;
  serviceTotal: number;
  goodsTotal: number;
  vatAmount: number;
  whtAmount: number;
  netTotal: number;
  items: InvoiceItem[];
  status: "ISSUED" | "PAID" | "VOID";
  paidDate: string | null;
  taxInvoiceNo: string | null;
  voidReason: string | null;
  dueDate?: string | null; // วันครบกำหนดชำระ (ผู้ใช้ 2026-09-28) - null = ลูกค้าไม่ได้ตั้งเครดิตเทอมตอนออกบิล
  taxInvoice?: { id: string; taxInvoiceNo: string } | null; // ใบกำกับในระบบที่ยังใช้อยู่
  account?: BillingAccount; // บัญชีบุคคล = หัวบิลชื่อบุคคล + บัญชีรับเงินบุคคล ไม่มี VAT (บิลเก่าก่อน 2026-09-27 = บัญชีบริษัท)
  // หน้าแก้บิลส่งกลับเป็น expectedUpdatedAt - มีคนแก้/รับเงิน/ยกเลิกไปก่อน backend ตอบ 409 (ผู้ใช้ 2026-09-27)
  updatedAt: string | null;
  // จำนวนประวัติแก้ / ยกเลิก / ยกเลิกการรับเงิน (มาเฉพาะใน listInvoices)
  historyCount?: number;
  lines: InvoiceLine[];
}

// แก้บิลที่ยังไม่รับเงิน เลขที่เดิม (ผู้ใช้ 2026-09-27) - ช่องที่ไม่ส่ง = ไม่แก้, lines = เฉพาะคันที่แก้ (id = InvoiceLine.id)
// removeLineIds = เอารถออกจากบิล (รถกลับเข้าคิวรอวางบิล), applyCurrentTerms = คิด VAT/หัก ณ ที่จ่ายตามเงื่อนไขปัจจุบันของลูกค้า
// refreshLineIds = ดึงข้อมูลรถล่าสุด (ทะเบียน เลขที่ใบเสร็จ ยี่ห้อ ประเภทรถ เลขตัวถัง วันที่ส่งงาน) ลงบิลรายคัน - backend อ่านใหม่ตอนบันทึก
export interface UpdateInvoiceInput {
  issueDate?: string;
  jobLabel?: string;
  extras?: Array<{ label: string; amount: number }>;
  lines?: Array<{ id: string; receiptAmount: number; serviceFee: number; serviceLabel: string | null; deduction: number; deductionNote: string | null }>;
  removeLineIds?: string[];
  refreshLineIds?: string[];
  applyCurrentTerms?: boolean;
  items?: InvoiceItem[]; // บรรทัดกำหนดเอง ส่งมา = แทนที่ทั้งชุด
  whtRate?: number; // ส่งมา = ใช้อัตรานี้ (มาก่อน applyCurrentTerms)
  expectedUpdatedAt?: string | null;
  remark: string;
}

// ข้อมูลรถปัจจุบันของแต่ละคันในบิล (GET /api/billing/invoices/:id/live-lines) - หน้าแก้บิลเทียบกับข้อมูลที่บิลเก็บไว้
// deliveredDate = null ถ้ารถไม่มีวันที่ส่งงานแล้ว (บิลเก็บวันที่เดิมไว้), receiptAmount = ยอดใบเสร็จที่พนักงานกรอกไว้ (คำแนะนำเท่านั้น)
export interface InvoiceLiveLine {
  id: string; // InvoiceLine.id
  chassis: string;
  brandName: string;
  body: string | null;
  plateText: string;
  receiptNo: string | null;
  deliveredDate: string | null;
  receiptAmount: number | null;
}

// ประวัติของบิล (AuditLog) - changes = { ช่อง: { from, to } }, action = update | unpay | void
export interface InvoiceHistoryEntry {
  id: string;
  action: string;
  remark: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  editedBy: string | null;
  createdAt: string;
}

// รถที่ปิดงาน - วางบิลนอกระบบ (ผู้ใช้ 2026-09-27)
export interface ClosedBillingVehicle {
  id: string;
  chassis: string;
  brandName: string;
  body: string | null;
  plateText: string;
  customerId: string;
  customerName: string;
  deliveredDate: string | null;
  closedAt: string; // ISO timestamp
  note: string | null;
  closedBy: string | null;
}

// GET /api/billing/invoices: บิลรอรับเงินครบทุกใบ + ประวัติ (รับเงินแล้ว / ยกเลิก) ใหม่สุดทีละหน้า (พบ 2026-09-27)
// offset > 0 = โหลดประวัติเพิ่ม (ส่งกลับเฉพาะประวัติ), limit = ขนาดหน้าประวัติ (ค่าเริ่มต้น 200 สูงสุด 1,000)
export interface InvoiceList {
  invoices: Invoice[];
  hasMore: boolean; // ยังมีประวัติเก่ากว่านี้
  outstanding: { count: number; total: number }; // บิลรอรับเงินทั้งหมดในระบบ นับฝั่ง server (ตรงกับหน้าภาพรวม)
}

export interface CreateInvoiceInput {
  customerId: string;
  invoiceNo: string;
  issueDate: string;
  jobLabel: string;
  // plateSwapId + swapReceiptAmount = งานสลับเลขของรถคันนี้ (ผู้ใช้ 2026-09-28) ต้องส่งมาคู่กันหรือไม่ส่งเลย
  lines: Array<{
    vehicleId: string;
    receiptAmount: number;
    serviceFee: number;
    serviceLabel: string | null;
    deduction: number;
    deductionNote: string | null;
    plateSwapId?: string | null;
    swapReceiptAmount?: number | null;
  }>;
  extras: Array<{ label: string; amount: number }>;
  whtRate?: number; // อัตราหัก ณ ที่จ่ายของบิลนี้ ไม่ส่ง = ตามเงื่อนไขลูกค้า (ผู้ใช้ 2026-09-29)
}

// บิลกำหนดเอง (ผู้ใช้ 2026-09-29) - งานเก่าจากระบบเดิม / ขายสินค้า ไม่มีรถ
export interface CreateCustomInvoiceInput {
  customerId: string;
  invoiceNo: string;
  issueDate: string;
  jobLabel: string;
  items: InvoiceItem[];
  whtRate?: number;
}

export interface NextInvoiceNumbers {
  suggestedInvoiceNo: string;
  suggestedPersonalInvoiceNo: string;
  lastInvoiceNo: string | null;
  lastPersonalInvoiceNo: string | null;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const billingApi = {
  // lotVehicles = คันอื่นในใบยื่นเดียวกันที่ยังไม่พร้อมส่งหรือส่งครบแล้ว (แสดงอย่างเดียว)
  deliveryQueue: () => request<{ vehicles: DeliveryRow[]; lotVehicles: DeliveryRow[] }>("/api/delivery/queue"),
  deliveryRecent: () => request<{ vehicles: DeliveryRow[] }>("/api/delivery/recent"),
  // บันทึกส่งงาน = api.submitDelivery ใน lib/api.ts (ส่ง items พร้อมชนิดงานที่ผู้ใช้ยืนยัน)
  // truncated = ใบในช่วงนี้เกินที่แสดงได้ครั้งเดียว (500 ใบล่าสุด)
  deliverySlips: (params: { from?: string; to?: string; customerId?: string }) =>
    request<{ slips: DeliverySlip[]; truncated: boolean }>(`/api/delivery/slips?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as string[][])}`),
  deliverySlip: (id: string) => request<DeliverySlip>(`/api/delivery/slips/${encodeURIComponent(id)}`),
  // แก้ / ยกเลิกใบส่งงานที่คีย์ผิด (ต้องมีเหตุผล) - ADMIN / STAFF_CAR / STAFF_MOTO ตามประเภทรถ
  updateDeliverySlip: (id: string, data: { recipient: string; date: string; remark: string }) =>
    request<DeliverySlip>(`/api/delivery/slips/${encodeURIComponent(id)}`, json("PATCH", data)),
  // ระบุแถวด้วย id ของแถว - แถวงานสลับเลขไม่มี vehicleId ให้ใช้ (ผู้ใช้ 2026-09-28)
  cancelDeliverySlip: (id: string, data: { itemIds: string[]; remark: string }) =>
    request<DeliverySlip>(`/api/delivery/slips/${encodeURIComponent(id)}/cancel`, json("POST", data)),

  // เลขบิลรันแยกตามบัญชี - suggestedPersonalInvoiceNo ว่าง = ยังไม่เคยออกบิลบัญชีบุคคล
  billingQueue: () =>
    request<{ suggestedInvoiceNo: string; suggestedPersonalInvoiceNo: string; lastInvoiceNo: string | null; lastPersonalInvoiceNo: string | null; customers: BillingCustomer[] }>(
      "/api/billing/queue",
    ),
  // remark บังคับ - ค่าก่อน/หลังเก็บในประวัติลูกค้า (ผู้ใช้ 2026-09-27)
  updateTerms: (customerId: string, terms: BillingTerms & { remark: string }) =>
    request<{ terms: BillingTerms }>(`/api/billing/customers/${customerId}/terms`, json("PATCH", terms)),
  // บัญชีรับเงินพร้อมวันเริ่มใช้ (remark บังคับ) - ADMIN + ACCOUNTANT
  accountPeriods: (customerId: string) =>
    request<{ current: BillingAccount; periods: AccountPeriod[] }>(`/api/billing/customers/${encodeURIComponent(customerId)}/account`),
  setAccount: (customerId: string, data: { account: BillingAccount; effectiveFrom: string; remark: string }) =>
    request<{ current: BillingAccount; periods: AccountPeriod[] }>(`/api/billing/customers/${encodeURIComponent(customerId)}/account`, json("POST", data)),
  // ตั้งราคาล่วงหน้าให้ลูกค้าที่ยังไม่มีรถในคิววางบิล (ผู้ใช้ 2026-09-28)
  getRates: (customerId: string) => request<{ rates: ServiceFeeRate[] }>(`/api/billing/customers/${encodeURIComponent(customerId)}/rates`),
  replaceRates: (customerId: string, rates: ServiceFeeRateInput[]) =>
    request<{ rates: ServiceFeeRate[] }>(`/api/billing/customers/${customerId}/rates`, json("PUT", { rates })),
  listInvoices: (params: { offset?: number; limit?: number } = {}) =>
    request<InvoiceList>(`/api/billing/invoices?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`),
  createInvoice: (data: CreateInvoiceInput) => request<{ invoice: Invoice }>("/api/billing/invoices", json("POST", data)),
  createCustomInvoice: (data: CreateCustomInvoiceInput) => request<{ invoice: Invoice }>("/api/billing/custom-invoices", json("POST", data)),
  nextInvoiceNumbers: () => request<NextInvoiceNumbers>("/api/billing/next-invoice-no"),
  getInvoice: (id: string) => request<{ invoice: Invoice }>(`/api/billing/invoices/${encodeURIComponent(id)}`),
  markInvoicePaid: (id: string, data: { paidDate: string; taxInvoiceNo: string }) =>
    request<{ invoice: Invoice }>(`/api/billing/invoices/${id}/paid`, json("PATCH", data)),
  voidInvoice: (id: string, reason: string) => request<{ invoice: Invoice }>(`/api/billing/invoices/${id}/void`, json("PATCH", { reason })),
  // แก้บิล / ยกเลิกการรับเงิน / ประวัติ (ผู้ใช้ 2026-09-27) - ADMIN + ACCOUNTANT, ต้องมีเหตุผลทุกครั้ง
  updateInvoice: (id: string, data: UpdateInvoiceInput) =>
    request<{ invoice: Invoice }>(`/api/billing/invoices/${encodeURIComponent(id)}`, json("PATCH", data)),
  unpayInvoice: (id: string, remark: string) =>
    request<{ invoice: Invoice }>(`/api/billing/invoices/${encodeURIComponent(id)}/unpay`, json("PATCH", { remark })),
  invoiceHistory: (id: string) => request<{ entries: InvoiceHistoryEntry[] }>(`/api/billing/invoices/${encodeURIComponent(id)}/history`),
  invoiceLiveLines: (id: string) => request<{ lines: InvoiceLiveLine[] }>(`/api/billing/invoices/${encodeURIComponent(id)}/live-lines`),
  customerTerms: (customerId: string) => request<{ terms: BillingTerms }>(`/api/billing/customers/${encodeURIComponent(customerId)}/terms`),
  // ปิดงาน - วางบิลนอกระบบ (ADMIN + ACCOUNTANT) / เปิดงานกลับ (ADMIN) - รายการรถที่ปิดไว้ใหม่สุดก่อนทีละ 100 คัน
  closedVehicles: (offset = 0) => request<{ vehicles: ClosedBillingVehicle[]; hasMore: boolean }>(`/api/billing/vehicles/closed?offset=${offset}`),
  closeVehicleBilling: (vehicleId: string, note: string) =>
    request<{ vehicle: ClosedBillingVehicle }>(`/api/billing/vehicles/${encodeURIComponent(vehicleId)}/close`, json("POST", { note })),
  reopenVehicleBilling: (vehicleId: string, remark: string) =>
    request<{ id: string; reopened: boolean }>(`/api/billing/vehicles/${encodeURIComponent(vehicleId)}/reopen`, json("POST", { remark })),

  // ---------- ใบกำกับภาษี + 50 ทวิ (ผู้ใช้ 2026-09-28) ----------
  taxInvoiceSeries: () => request<TaxInvoiceSeries>("/api/billing/tax-invoices/series"),
  setTaxInvoiceSeries: (data: { year: number; lastNumber: number; remark: string }) =>
    request<TaxInvoiceSeries>("/api/billing/tax-invoices/series/set", json("POST", data)),
  taxInvoices: (month: string) => request<{ month: string; taxInvoices: TaxInvoice[] }>(`/api/billing/tax-invoices?month=${encodeURIComponent(month)}`),
  taxInvoice: (id: string) => request<{ taxInvoice: TaxInvoice }>(`/api/billing/tax-invoices/${encodeURIComponent(id)}`),
  taxInvoicePreview: (invoiceId: string) => request<TaxInvoicePreview>(`/api/billing/invoices/${encodeURIComponent(invoiceId)}/tax-invoice-preview`),
  issueTaxInvoice: (
    invoiceId: string,
    data: { paidDate: string; whtAmount: number; whtMethod: WhtMethod; buyerNotVatRegistered: boolean; expectedUpdatedAt: string | null },
  ) => request<{ taxInvoice: TaxInvoice }>(`/api/billing/invoices/${encodeURIComponent(invoiceId)}/tax-invoice`, json("POST", data)),
  cancelTaxInvoice: (id: string, remark: string) =>
    request<{ taxInvoice: TaxInvoice }>(`/api/billing/tax-invoices/${encodeURIComponent(id)}/cancel`, json("POST", { remark })),
  replacementTaxInvoice: (id: string, remark: string) =>
    request<{ taxInvoice: TaxInvoice }>(`/api/billing/tax-invoices/${encodeURIComponent(id)}/replacement`, json("POST", { remark })),
  whtPending: () => request<{ overdueDays: number; pending: WhtPendingRow[] }>("/api/billing/wht-pending"),
  whtRemind: (taxInvoiceIds: string[]) => request<{ updated: number }>("/api/billing/wht-pending/remind", json("POST", { taxInvoiceIds })),
  whtCertificates: (customerId?: string) =>
    request<{ certificates: WhtCertificate[] }>(`/api/billing/wht-certificates${customerId ? `?customerId=${encodeURIComponent(customerId)}` : ""}`),
  createWhtCertificate: (data: {
    method: "PAPER" | "EWHT";
    certificateNo: string;
    certificateDate: string;
    amount: number;
    note: string;
    taxInvoiceIds: string[];
    file: File | null;
  }) => {
    const form = new FormData();
    form.append("method", data.method);
    form.append("certificateNo", data.certificateNo);
    form.append("certificateDate", data.certificateDate);
    form.append("amount", String(data.amount));
    form.append("note", data.note);
    form.append("taxInvoiceIds", data.taxInvoiceIds.join(","));
    if (data.file) form.append("file", data.file, data.file.name);
    return request<{ id: string }>("/api/billing/wht-certificates", { method: "POST", body: form });
  },
  cancelWhtCertificate: (id: string, remark: string) =>
    request<{ ok: boolean }>(`/api/billing/wht-certificates/${encodeURIComponent(id)}/cancel`, json("POST", { remark })),
};
