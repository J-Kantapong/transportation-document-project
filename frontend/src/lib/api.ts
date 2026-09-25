import { getToken, redirectToLogin } from './auth';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3000';

export interface RowError {
  row: number;
  errors: string[];
}

export class ApiError extends Error {
  rows?: RowError[];

  constructor(message: string, rows?: RowError[]) {
    super(message);
    this.name = 'ApiError';
    this.rows = rows;
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // แนบ token ล็อกอินทุกคำขอ (ดู lib/auth.ts) - หน้า login/register ยังไม่มี token ก็ส่งได้ปกติ
  const token = getToken();
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      // FormData (อัปโหลดรูป) ให้ browser ตั้ง Content-Type multipart เอง
      headers:
        init?.body instanceof FormData
          ? { ...auth, ...(init.headers as Record<string, string> | undefined) }
          : { 'Content-Type': 'application/json', ...auth, ...(init?.headers as Record<string, string> | undefined) },
    });
  } catch {
    throw new ApiError('ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองใหม่');
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError('ไม่สามารถเชื่อมต่อระบบได้ กรุณาลองใหม่');
  }

  // 401 ระหว่างใช้งาน = token หมดอายุหรือบัญชีถูกระงับ -> กลับไปหน้าล็อกอิน (ยกเว้นตอนกำลังล็อกอินเอง)
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    redirectToLogin();
    throw new ApiError('กรุณาเข้าสู่ระบบใหม่');
  }

  if (!res.ok) {
    const body = data as { error?: string; errors?: RowError[] };
    const error = new ApiError(body?.error ?? 'ดำเนินการไม่สำเร็จ', body?.errors);
    throw error;
  }

  return data as T;
}

export interface Customer {
  id: string;
  name: string;
  company: string | null;
  branch: string | null;
  address: string | null;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Brand {
  id: string;
  name: string;
}

export type OwnerType = 'INDIVIDUAL' | 'JURISTIC';

// บริษัทไฟแนนซ์ - GET/POST /api/finance-companies (เพิ่มจากหน้าเพิ่มข้อมูลรถจดใหม่เหมือนยี่ห้อ)
export interface FinanceCompany {
  id: string;
  name: string;
}

// งานสลับเลขที่ผูกกับรถจดใหม่คันหนึ่ง (รถคันนี้รับเลขจากรถเก่า)
export interface VehiclePlateSwap {
  id: string;
  oldOwnerName: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string | null; // ทะเบียนที่รถเก่าจะได้ - ยังไม่รู้ตอนยื่นงานสลับเลขได้
  newPlateNumber: string | null;
  submitDate: string; // YYYY-MM-DD
  returnedDate: string | null;
}

export interface Vehicle {
  id: string;
  date: string;
  customerId: string;
  chassis: string;
  engine: string | null;
  brandId: string;
  fuel: string | null;
  cc: string | null;
  weight: string | null;
  color: string | null;
  body: string | null;
  registrationProvince: string | null;
  ownerProvince: string | null;
  createdAt: string;
  customerName: string;
  brandName: string;
  // Step 4: ยื่นเอกสารจดทะเบียน (ภาษีรถประจำปี)
  firstRegistrationDate: string | null;
  isFactoryNew: boolean | null;
  ownerId: string | null;
  // ownerName = ชื่อผู้ถือกรรมสิทธิ์ (ติ๊กไฟแนนซ์ = ชื่อไฟแนนซ์อัตโนมัติ / ไม่ติ๊ก = ชื่อที่กรอกในหน้าเพิ่มข้อมูลรถ)
  // hirerName = ชื่อผู้ครอบครอง กรอกเฉพาะรถติดไฟแนนซ์ (null เมื่อไม่มีไฟแนนซ์)
  ownerName: string | null;
  hirerName: string | null;
  // เจ้าของรถตามทะเบียน - กรอกตั้งแต่หน้าเพิ่มข้อมูลรถจดใหม่ (ประเภทเจ้าของรถ + ติ๊กไฟแนนซ์) และหน้ายื่นเอกสารใช้ต่อ
  // ติ๊กไฟแนนซ์: ownerType = JURISTIC (ไฟแนนซ์เป็นเจ้าของ), hirerType = ประเภทที่ผู้ใช้เลือก, financeName = ชื่อไฟแนนซ์
  // ไม่ติ๊ก: ownerType = ประเภทที่เลือก, hirerType/finance = null - ใช้ helper ใน lib/vehicle-owner.ts แทนการอ่านตรงๆ
  ownerType: OwnerType | null;
  hirerType: OwnerType | null;
  financeCompanyId: string | null;
  financeName: string | null;
  // Step 4: เลขทะเบียนที่ขอ/ได้รับ - mutable, กรอกทีหลังได้ตอนใบเสร็จกรมขนส่งออกเลขให้
  plateCategory: string | null;
  plateNumber: string | null;
  // true = ยื่นเอกสารไปแล้วและยังรอใบเสร็จอยู่ (DocumentSubmission ล่าสุดค้างสถานะ PENDING) - ยื่นซ้ำไม่ได้
  // จนกว่าจะได้รับใบเสร็จหรือยื่นไม่สำเร็จ
  // งานสลับเลขที่รถคันนี้เป็น "รถใหม่" ผู้รับเลขจากรถเก่า (ผู้ใช้ 2026-09-23) - null = ไม่มีงานสลับเลข
  // หน้ายื่นเอกสาร (Step 4) แสดงทะเบียนที่จะได้จากงานสลับเลข และกดใช้เป็นเลขที่ขอได้ - ดู backend/src/plate-swap/
  plateSwap: VehiclePlateSwap | null;
  pendingDocumentSubmission: boolean;
}

// รถที่ถูกลบไว้ (ผู้ใช้ 2026-09-23) - ADMIN เท่านั้นที่เรียกดู/กู้คืนได้ ดู backend/src/vehicles/vehicles.service.ts
export interface DeletedVehicle extends Vehicle {
  deletedAt: string | null;
  deletedReason: string | null;
  deletedByName: string | null; // ชื่อเล่น (ถ้ามี) ของผู้ที่กดลบ
}

// หน้าค้นหารถ (ผู้ใช้ 2026-09-25) - สถานะคำนวณฝั่ง backend ด้วย waitsFor() ตัวเดียวกับภาพรวมผู้บริหาร
export const VEHICLE_SEARCH_STAGES = [
  ['transfer', 'รอแจ้งย้าย/ตัดบัญชี'],
  ['inspectSend', 'รอส่งตรวจรถ'],
  ['inspectResult', 'รอผลตรวจรถ'],
  ['submit', 'รอยื่นเอกสาร'],
  ['receipt', 'รอใบเสร็จ'],
  ['plate', 'รอรับป้าย'],
  ['book', 'รอรับเล่ม'],
  ['delivery', 'รอส่งงานลูกค้า'],
  ['plateDelivery', 'รอส่งป้ายตามหลัง'],
  ['billing', 'รอวางบิล'],
] as const;
export type VehicleSearchStage = (typeof VEHICLE_SEARCH_STAGES)[number][0];
export type VehicleSearchStatus = VehicleSearchStage | 'done' | 'problem';

export interface VehicleSearchParams {
  q?: string;
  from?: string;
  to?: string;
  status?: string;
  kind?: string;
}

export interface VehicleStageStatus {
  stage: VehicleSearchStage;
  label: string;
  href: string;
  since: string;
  days: number;
  sla: number;
  late: boolean;
  flags: string[];
  reason: string | null;
}

export interface VehicleSearchRow {
  id: string;
  date: string;
  kind: 'car' | 'moto';
  customerName: string;
  brandName: string;
  chassis: string;
  engine: string | null;
  plate: string | null;
  statuses: VehicleStageStatus[]; // ว่าง = จบงานแล้ว
  problem: boolean;
}

export interface VehicleSearchResult {
  vehicles: VehicleSearchRow[];
  total: number; // ตรงเงื่อนไขทั้งหมด (รวมสถานะ)
  all: number; // ตรงคำค้น/วันที่/ประเภทรถ ก่อนกรองสถานะ
  hasMore: boolean;
  counts: Record<VehicleSearchStatus, number>;
}

// รถในหน้ายื่นเอกสาร (Step 4) - ดู backend/src/document-submission/submission-eligibility.ts สำหรับกฎ:
// แจ้งย้าย/ตัดบัญชีเสร็จ + ตรวจผ่านไม่เกิน 90 วัน ณ วันที่ยื่น + ไม่มีรายการที่รอใบเสร็จ/ได้ใบเสร็จแล้ว
export interface SubmitCandidate extends Vehicle {
  inspectionResultDate: string | null; // วันที่ตรวจผ่าน (ค.ศ. YYYY-MM-DD)
  inspectionValidUntil: string | null; // วันสุดท้ายที่ยังยื่นได้ = วันที่ตรวจผ่าน + 89 วัน
  submitBlockReason: string | null; // null = ยื่นได้ ณ วันที่ยื่นที่ส่งไป
  // ครั้งล่าสุดที่ยื่นไม่สำเร็จ (FAILED) - null = ไม่เคยยื่นไม่สำเร็จ หรือยื่นสำเร็จ/ค้างอยู่หลังจากนั้นแล้ว
  lastFailedSubmission: { submitDate: string; failRemark: string | null } | null;
}

export interface DocumentSubmissionPreviewResult {
  vehicleId: string;
  fee?: FeePreview;
  tax?: TaxBreakdown;
  error?: string; // มีเมื่อคำนวณคันนั้นไม่ได้ (ไม่พบรถ / ตัวเลือกไม่ถูกต้อง)
}

// Step 4 (ยื่นเอกสารจดทะเบียนรถใหม่): ค่าธรรมเนียม Bill/No bill - ดู
// backend/src/document-submission/document-fee-calculator.ts สำหรับ logic การคำนวณจริง
export type PlateNumberOption = "NONE" | "NORMAL" | "AUCTION";
export type NewPlateOption = "NONE" | "BLACKWHITE" | "AUCTION";

export interface FeeItem {
  label: string;
  amount: number;
}

export interface FeePreview {
  isMoto: boolean;
  isOtherProvince: boolean;
  hasExtraRequest: boolean;
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: number;
  noBillTotal: number;
}

export interface DocumentSubmissionOptionsInput {
  plateNumberOption: PlateNumberOption;
  includePlateFee: boolean;
  newPlateOption: NewPlateOption | null; // รถยนต์เท่านั้น - null สำหรับมอเตอร์ไซค์
  relocateAddon: boolean; // รถยนต์เท่านั้น
  stopUseRelocateOut: boolean; // มอเตอร์ไซค์เท่านั้น
  urgent: boolean;
}

export interface CreateDocumentSubmissionInput extends DocumentSubmissionOptionsInput {
  submitDate: string; // ค.ศ. YYYY-MM-DD
  plateCategory: string | null;
  plateNumber: string | null;
  // ประเภทเจ้าของรถ - backend find-or-create VehicleOwner แบบไม่ระบุชื่อให้เอง undefined = ไม่แก้ไข
  // เจ้าของรถเดิม (ใช้ตอนนำเข้าหลายคันพร้อมกัน ซึ่งไม่ทราบเจ้าของรถ) - undefined ถูกตัดออกจาก JSON โดย
  // JSON.stringify เอง จึง backend เห็นเป็น "ไม่ได้ส่งมา" พอดี
  ownerType?: OwnerType;
}

export type DocumentSubmissionStatus = "PENDING" | "RECEIPT_RECEIVED" | "FAILED";

export interface DocumentSubmission {
  id: string;
  vehicleId: string;
  submitDate: string;
  status: DocumentSubmissionStatus;
  plateNumberOption: PlateNumberOption;
  includePlateFee: boolean;
  newPlateOption: NewPlateOption | null;
  relocateAddon: boolean;
  stopUseRelocateOut: boolean;
  urgent: boolean;
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billFeeTotal: string;
  noBillTotal: string;
  taxAmount: string | null;
  createdAt: string;
  updatedAt: string;
  receiptReceivedDate: string | null; // วันที่ได้ใบเสร็จกลับมาถึงออฟฟิศ
  receiptDate: string | null; // วันที่ที่พิมพ์บนใบเสร็จ (วันที่ทางการ) - null = รายการก่อน 2026-09-25
  receiptAmount: string | null; // ยอดบนใบเสร็จจริงที่พนักงานกรอก - เทียบกับ billFeeTotal + taxAmount
  receiptNo: string | null; // เลขที่ใบเสร็จ (AI กรอกให้ พนักงานแก้ได้)
  failRemark: string | null; // เหตุผลที่ยื่นไม่สำเร็จ - มีเฉพาะ status FAILED
  receiptCarriedAt: string | null; // ตรวจใบยื่นแล้วยังไม่ได้ใบเสร็จ/ยังไม่รู้สาเหตุ -> ค้างอยู่ในใบยื่นเดิม ("ยังขาด" ในหน้ารับใบเสร็จ)
  vehicle: {
    chassis: string;
    body: string | null;
    plateCategory: string | null;
    plateNumber: string | null;
    customer: { name: string; company: string | null };
    brand: { name: string };
    owner: { name: string | null; ownerType: OwnerType; hirerType: OwnerType | null; financeCompanyId: string | null } | null;
  };
  receipts?: ReceiptSummary[]; // รูปใบเสร็จที่แนบแล้ว (เก่าสุดก่อน) - มีเฉพาะผลจาก listDocumentSubmissions
}

// รูปใบเสร็จ - ดู backend/src/receipts/receipts.service.ts
// POST /api/receipts (multipart: file, submissionId ไม่บังคับ) · GET /api/receipts/unassigned · GET /api/receipts/:id/image
// PATCH /api/receipts/:id {submissionId} = จับคู่กับรายการ · DELETE /api/receipts/:id (รายการที่รับใบเสร็จแล้วลบไม่ได้)
export interface ReceiptImage {
  id: string;
  submissionId: string | null; // null = อัปโหลดหลายใบแล้วยังไม่จับคู่กับรถ
  mimeType: string;
  sizeBytes: number;
  originalName: string | null;
  extractionSource: string; // NONE = ยังไม่ได้ใช้ AI อ่าน | model id
  extraction: ReceiptExtraction | null;
  readPending: boolean; // true = อัปโหลดหลายใบแล้ว AI ยังอ่านอยู่เบื้องหลัง (ถามผลด้วย getReceipts)
  createdAt: string;
}

// ผลที่ AI อ่านจากใบเสร็จ - ดู backend/src/receipts/receipt-extraction.ts (วันที่เป็น ค.ศ. แล้ว)
export interface ReceiptReading {
  receiptNo: string | null;
  date: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  chassis: string | null;
  weightKg: number | null;
  items: Array<{ label: string; amount: number }>;
  total: number | null;
  uncertainFields: string[]; // ช่องที่ AI ไม่มั่นใจ: receiptNo | date | plate | chassis | weightKg | items | total
}

// ใบเสร็จที่ AI อ่านได้ซ้ำกับที่มีในระบบ: receiptNo = เลขที่ใบเสร็จซ้ำ · chassis = รถคันนี้มีใบเสร็จแล้ว (เตือน ไม่บล็อก)
export interface ReceiptDuplicate {
  by: "receiptNo" | "chassis";
  receiptNo: string | null;
  chassis: string | null;
  receivedDate: string | null; // YYYY-MM-DD
}

export type ReceiptExtraction = (
  | {
      reading: ReceiptReading;
      checks: { chassisValid: boolean; receiptNoValid: boolean; plateValid: boolean; itemsSumMatchesTotal: boolean };
    }
  | { error: string }
) & {
  // chassis = ระบบจับคู่กับรถให้จากเลขตัวถัง / chassis-mismatch = เลขตัวถังในใบเสร็จไม่ตรงกับรถที่แนบ
  // chassis-near = เลขตัวถังใกล้เคียงรถคันนี้ (เลขท้าย 6 ตัวตรง, 11 ตัวแรกต่างไม่เกิน 2) - AI น่าจะอ่านเพี้ยน ให้เช็กกับรูป
  match?: "chassis" | "chassis-near" | "chassis-mismatch" | null;
  duplicate?: ReceiptDuplicate | null; // ไม่มี = รูปก่อน 2026-09-24
};

export type ReceiptSummary = Pick<ReceiptImage, 'id' | 'extractionSource' | 'extraction' | 'createdAt'>;

export type ReceiptCheckEntry =
  | { submissionId: string; action: 'RECEIVED'; plateCategory: string; plateNumber: string; receiptAmount?: string; receiptNo?: string; receiptDate?: string }
  | { submissionId: string; action: 'FAILED'; failRemark: string }
  | { submissionId: string; action: 'CARRY' };

export const receiptImageUrl = (id: string) => `${API_BASE_URL}/api/receipts/${id}/image`;

// รูปป้าย/รูปเล่มทะเบียน (Step 6/7) - ดู backend/src/plate-photos/, book-photos/ (ผู้ใช้ 2026-09-26: ไม่มี AI แล้ว)
// POST /api/plate-photos/attach, /api/book-photos/attach (multipart: file, vehicleId, date YYYY-MM-DD) = แนบรูปให้รถคันนั้นแล้วบันทึกรับทันที
// GET /api/plate-photos/:id/image · GET /api/book-photos/:id/image
export type PlateKind = "car" | "moto";

export const platePhotoImageUrl = (id: string) => `${API_BASE_URL}/api/plate-photos/${id}/image`;
export const bookPhotoImageUrl = (id: string) => `${API_BASE_URL}/api/book-photos/${id}/image`;

// หลังได้รับใบเสร็จ: รับป้ายทะเบียน / รับเล่มทะเบียน / Delivery - ดู backend/src/receiving/receiving.service.ts
export type ReceivingStep = "plate" | "book" | "delivery";

export interface ReceivingRow {
  id: string; // vehicleId
  date: string;
  customerName: string;
  chassis: string;
  brandName: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  receiptNo: string | null; // เลขที่ใบเสร็จของการยื่นครั้งล่าสุด
  submitDate: string | null; // วันที่ยื่นของการยื่นครั้งล่าสุด - ใช้จัดกลุ่มตามใบยื่น (รับป้าย/รับเล่ม)
  urgent: boolean;
  submittedAt: string | null; // เวลาที่บันทึกยื่น (ลำดับในใบส่งงาน) - ค่าเริ่มต้นของการเรียงในหน้ารับป้าย/รับเล่ม
  platePhotoId: string | null; // รูปป้ายที่ใช้ยืนยันการรับป้าย - ดูรูปที่ platePhotoImageUrl(id) (เฉพาะขั้น plate)
  bookPhotoId: string | null; // รูปเล่มที่ใช้ยืนยันการรับเล่ม - ดูรูปที่ bookPhotoImageUrl(id) (เฉพาะขั้น book)
  doneDate: string | null;
  recipient: string | null; // เฉพาะ delivery
  note: string | null; // เฉพาะ delivery
}

export interface BulkDocumentSubmissionEntry extends CreateDocumentSubmissionInput {
  vehicleId: string;
}

export interface VehicleOwnerInput {
  name?: string;
  ownerType: OwnerType;
  isHirePurchaseBusiness: boolean;
  hirerType: OwnerType | null;
}

export interface VehicleOwner {
  id: string;
  name: string | null;
  ownerType: OwnerType;
  isHirePurchaseBusiness: boolean;
  hirerType: OwnerType | null;
  createdAt: string;
}

export interface TaxBreakdown {
  vehicleFamily: 'RY1' | 'RY2' | 'RY3' | 'RY12' | null;
  fuelGroup: 'ICE' | 'HEV' | 'PHEV' | 'BEV' | null;
  baseAmount: number | null;
  discountPercent: number | null;
  juristicMultiplier: 1 | 2;
  juristicReason: string;
  amount: number | null;
  amountSatang: number | null;
  reason: string | null;
  status: 'CALCULATED' | 'MISSING_INPUT' | 'MISSING_VERIFIED_RULE';
}

export interface TaxCalculation {
  id: string;
  vehicleId: string;
  status: string;
  vehicleFamily: string | null;
  fuelGroup: string | null;
  baseAmount: string | null;
  incentiveDiscountPercent: string | null;
  juristicMultiplier: number;
  finalAmount: string | null;
  reason: string | null;
  createdAt: string;
}

export interface TransferNoticeVehicle {
  id: string;
  date: string;
  customerName: string;
  chassis: string;
  brandName: string;
  body: string | null;
  registrationProvince: string | null;
  status: 'ตัดบัญชี' | 'แจ้งย้าย' | null;
  suggestedCost: string | null;
  transferDone: boolean;
  transferCompletedDate: string | null;
  transferCost: string | null;
}

export interface InspectionVehicle {
  id: string;
  date: string;
  customerName: string;
  chassis: string;
  engine: string | null;
  color: string | null;
  brandName: string;
  body: string | null;
  registrationProvince: string | null;
  suggestedCost: string | null; // ราคาตรวจรถ (No bill) ตามตาราง
  // รอบ 1 และรอบ 2 ใช้ช่องชุดเดียวกัน - inspectionRound บอกว่าข้อมูลส่งตรวจ/ผลตรวจชุดนี้เป็นของรอบไหน
  inspectionRound: 1 | 2;
  round2Due: boolean; // ผลตรวจผ่านครบ 90 วันแล้วยังไม่ได้ยื่นเอกสาร - ต้องตรวจรอบ 2 (ยังไม่ได้ส่ง)
  suggestedBillCost: string | null; // ค่าตรวจรถ (Bill) 50 บาท - มีเฉพาะรอบ 2
  inspectionSentType: 'ส่งตรวจนอก' | 'เอารถมาตรวจเอง' | null;
  inspectionSentDate: string | null;
  inspectionSentCost: string | null; // ราคาตรวจรถ (No bill)
  inspectionSentBillCost: string | null; // ค่าตรวจรถ (Bill)
  inspectionResult: 'ผ่าน' | 'ไม่ผ่าน' | null;
  inspectionResultDate: string | null;
  inspectionResultCost: string | null; // ราคาตรวจรถ (No bill)
  inspectionResultBillCost: string | null; // ค่าตรวจรถ (Bill) - เฉพาะรอบ 2
  inspectionFailRemark: string | null;
  submitted: boolean; // ยื่นเอกสารแล้ว (มีรายการยื่นที่ยังไม่ยกเลิก/ไม่สำเร็จ)
  submitDeadline: string | null; // วันสุดท้ายที่ยื่นได้ (ตรวจผ่าน + 89 วัน) - null = ไม่ผ่าน/ยังไม่มีผล/ยื่นแล้ว
}

export type YamahaRelocationSize = 'SMALL' | 'LARGE';

// ไฟล์แนบของรายการแจ้งย้ายยามาฮ่า - ทุกรายการต้องมี ใบเสร็จ (RECEIPT) + Report (REPORT) อย่างละ 1 ไฟล์ (รูปหรือ PDF)
// ตัวไฟล์โหลดด้วย yamahaRelocationAttachmentUrl(id) (ต้องส่ง Authorization - ดู openAuthedFile ใน component)
export type YamahaRelocationAttachmentKind = 'RECEIPT' | 'REPORT';

export interface YamahaRelocationAttachment {
  id: string;
  kind: YamahaRelocationAttachmentKind;
  mimeType: string;
  sizeBytes: number;
  originalName: string | null;
  createdAt: string;
}

export interface YamahaRelocationEntry {
  id: string;
  date: string;
  size: YamahaRelocationSize;
  count: number;
  billFee: string;
  noBillFee: string;
  createdAt: string;
  receipt: YamahaRelocationAttachment | null; // null เฉพาะรายการเก่าที่บันทึกก่อนมีไฟล์แนบ
  report: YamahaRelocationAttachment | null;
}

export const yamahaRelocationAttachmentUrl = (id: string) => `${API_BASE_URL}/api/yamaha-relocation/attachments/${id}/file`;

export interface YamahaRelocationSummary {
  totalCount: number;
  billFee: number;
  noBillFee: number;
  totalFee: number;
}

export interface NewCustomerInput {
  name: string;
  company: string;
  branch: string;
  address: string;
  taxId: string;
  phone: string;
  email: string;
}

// --- ต่อภาษี ---------------------------------------------------------------------
export interface TaxRenewalFeeItem {
  label: string;
  amount: number;
}

// หนึ่งรอบปีภาษี - ค้างหลายปีจะมีหลายรอบ แต่ละรอบมีส่วนลดอายุรถและเงินเพิ่มของตัวเอง
export interface TaxRenewalCycle {
  dueDate: string;
  vehicleYear: number;
  annualVehicleTax: number;
  ageDiscountRate: number;
  lateMonths: number;
  lateFee: number;
}

export interface TaxRenewalTax {
  registrationCode: string;
  taxMethod: string;
  vehicleYear: number;
  vehicleAgeYears: number;
  annualVehicleTax: number;
  lateMonths: number;
  lateFee: number;
  inspectionRequired: boolean;
  taxCycleCount: number;
  cycles: TaxRenewalCycle[];
  grandTotal: number;
  warnings: string[];
  calculationDetails: Array<{ label: string; formula?: string; amount?: number }>;
}

export interface TaxRenewalPreview {
  tax: TaxRenewalTax;
  fees: {
    billItems: TaxRenewalFeeItem[];
    noBillItems: TaxRenewalFeeItem[];
    billTotal: number;
    noBillTotal: number;
    total: number;
  };
}

// ผลค้นหารถมาต่อภาษี (เลขตัวถัง / เลขเครื่อง / เลขทะเบียน / ชื่อลูกค้า / ผู้ถือกรรมสิทธิ์ / ผู้ครอบครอง)
export interface TaxRenewalVehicleHit {
  id: string;
  chassis: string;
  engine: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  body: string | null;
  fuel: string | null;
  cc: number | null;
  weight: number | null;
  firstRegistrationDate: string | null;
  ownerType: "INDIVIDUAL" | "JURISTIC" | null;
  ownerName: string | null; // ผู้ถือกรรมสิทธิ์ - ติดไฟแนนซ์ = ชื่อไฟแนนซ์
  hirerName: string | null; // ผู้ครอบครอง - null เมื่อไม่มีไฟแนนซ์
  customerName: string | null;
}

export interface TaxRenewalInput {
  submitDate?: string; // วันที่ยื่นงาน - บังคับตอนบันทึก (preview ไม่ใช้)
  vehicleId?: string | null;
  customerId?: string | null;
  chassis?: string; // บังคับเมื่อกรอกรถเอง - รถที่เลือกจากระบบใช้เลขตัวถังของ Vehicle
  engine?: string | null;
  plateCategory?: string;
  plateNumber?: string;
  registrationProvince?: string | null;
  vehicleType?: string;
  fuel?: string;
  cc?: string | number | null;
  weight?: string | number | null;
  firstRegistrationDate?: string;
  ownerType?: 'INDIVIDUAL' | 'JURISTIC';
  ownerName?: string | null;
  taxExpiryDate: string;
  inspectionConfirmed?: boolean;
  insuranceConfirmed?: boolean;
  skipContribution?: boolean;
  paymentDate?: string | null;
}

export interface TaxRenewalUpdateInput {
  inspectionConfirmed?: boolean;
  insuranceConfirmed?: boolean;
  skipContribution?: boolean;
  paymentDate?: string | null;
  receivedDate?: string | null;
  deliveredDate?: string | null;
}

export interface TaxRenewal {
  id: string;
  vehicleId: string | null;
  customerId: string | null;
  submitDate: string;
  chassis: string;
  engine: string | null;
  plateCategory: string;
  plateNumber: string;
  vehicleType: string;
  fuel: string;
  firstRegistrationDate: string;
  taxExpiryDate: string;
  ownerName: string | null;
  inspectionRequired: boolean;
  inspectionConfirmed: boolean;
  insuranceConfirmed: boolean;
  paymentDate: string | null;
  receivedDate: string | null;
  deliveredDate: string | null;
  skipContribution: boolean;
  billTotal: string | null;
  noBillTotal: string | null;
  customer?: { id: string; name: string; company: string | null } | null;
}

export const api = {
  listCustomers: () => request<{ customers: Customer[] }>('/api/customers'),
  createCustomer: (data: NewCustomerInput) =>
    request<{ id: string }>('/api/customers', { method: 'POST', body: JSON.stringify(data) }),

  listBrands: () => request<{ brands: Brand[] }>('/api/brands'),
  createBrand: (name: string) =>
    request<{ brand: Brand }>('/api/brands', { method: 'POST', body: JSON.stringify({ name }) }),

  listFinanceCompanies: () => request<{ financeCompanies: FinanceCompany[] }>('/api/finance-companies'),
  createFinanceCompany: (name: string) =>
    request<{ financeCompany: FinanceCompany }>('/api/finance-companies', { method: 'POST', body: JSON.stringify({ name }) }),

  // หน้าค้นหารถ: ค้นทั้งฐานข้อมูล + สถานะขั้นที่ค้าง (ทีละ 100 คัน) - ดู backend/src/vehicle-search
  searchVehicles: (params: VehicleSearchParams, offset = 0) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
    if (offset) search.set('offset', String(offset));
    const qs = search.toString();
    return request<VehicleSearchResult>(`/api/vehicle-search${qs ? `?${qs}` : ''}`);
  },
  // ทีละ 100 คัน - q ค้นจากเลขตัวถัง/เลขเครื่อง/ทะเบียน/ชื่อลูกค้า/เจ้าของ, from/to กรองวันที่ (ค.ศ. YYYY-MM-DD)
  listVehicles: (params: { q?: string; from?: string; to?: string; offset?: number; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.from) search.set('from', params.from);
    if (params.to) search.set('to', params.to);
    if (params.offset) search.set('offset', String(params.offset));
    if (params.limit) search.set('limit', String(params.limit));
    const qs = search.toString();
    return request<{ vehicles: Vehicle[]; hasMore: boolean }>(`/api/vehicles${qs ? `?${qs}` : ''}`);
  },
  createVehicles: (vehicles: Record<string, string>[]) =>
    request<{ count: number }>('/api/vehicles', { method: 'POST', body: JSON.stringify({ vehicles }) }),
  updateVehicle: (id: string, data: Record<string, string>) =>
    request<{ id: string }>(`/api/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  // ลบข้อมูลรถ (ซ่อน ไม่ลบจริง) / กู้คืน / รายการที่ลบไว้ - ADMIN เท่านั้น ต้องระบุเหตุผลที่ลบทุกครั้ง
  deleteVehicle: (id: string, remark: string) =>
    request<{ id: string; deleted: boolean }>(`/api/vehicles/${id}`, { method: 'DELETE', body: JSON.stringify({ remark }) }),
  restoreVehicle: (id: string) => request<{ id: string; deleted: boolean }>(`/api/vehicles/${id}/restore`, { method: 'POST' }),
  listDeletedVehicles: () => request<{ vehicles: DeletedVehicle[] }>('/api/vehicles/deleted'),

  // Step 4: คิวรถที่ยื่นเอกสารได้ ณ วันที่ยื่น (เรียงจากตรวจผ่านเก่าสุด = ใกล้หมดอายุสุด ก่อน)
  listSubmissionQueue: (submitDate: string) =>
    request<{ vehicles: SubmitCandidate[] }>(`/api/vehicles/submission-queue?submitDate=${submitDate}`),
  searchVehiclesByChassis: (chassis: string, submitDate: string) =>
    request<{ vehicles: SubmitCandidate[] }>(`/api/vehicles/search?chassis=${encodeURIComponent(chassis)}&submitDate=${submitDate}`),
  // blocked = พบในระบบแต่ยื่นไม่ได้ ณ วันที่ยื่น พร้อมเหตุผล
  lookupVehiclesByChassis: (chassisList: string[], submitDate: string) =>
    request<{ found: SubmitCandidate[]; notFound: string[]; blocked: Array<{ chassis: string; reason: string }> }>(
      '/api/vehicles/lookup-by-chassis',
      { method: 'POST', body: JSON.stringify({ chassisList, submitDate }) },
    ),

  previewDocumentSubmissionFee: (vehicleId: string, options: DocumentSubmissionOptionsInput) =>
    request<FeePreview>(`/api/vehicles/${vehicleId}/document-submission/preview`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  // ค่าธรรมเนียม + ภาษีหลายคันในคำขอเดียว (สูงสุด 1,000 คัน) - ownerType undefined = ใช้เจ้าของรถเดิม
  previewDocumentSubmissionBulk: (
    entries: Array<DocumentSubmissionOptionsInput & { vehicleId: string; ownerType?: OwnerType }>,
  ) =>
    request<{ results: DocumentSubmissionPreviewResult[] }>('/api/vehicles/document-submission/preview-bulk', {
      method: 'POST',
      body: JSON.stringify({ entries }),
    }),
  createDocumentSubmission: (vehicleId: string, input: CreateDocumentSubmissionInput) =>
    request<{ submission: DocumentSubmission; taxCalculation: TaxCalculation }>(`/api/vehicles/${vehicleId}/document-submission`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  createDocumentSubmissionBulk: (entries: BulkDocumentSubmissionEntry[]) =>
    request<{ succeeded: Array<{ vehicleId: string; submission: DocumentSubmission }>; failed: Array<{ vehicleId: string; error: string }> }>(
      '/api/vehicles/document-submission/bulk',
      { method: 'POST', body: JSON.stringify({ entries }) },
    ),
  listDocumentSubmissions: (date?: string, status?: DocumentSubmissionStatus) => {
    const query = [date ? `date=${date}` : '', status ? `status=${status}` : ''].filter(Boolean).join('&');
    return request<{ submissions: DocumentSubmission[] }>(`/api/vehicles/document-submission${query ? `?${query}` : ''}`);
  },
  // RECEIPT_RECEIVED ต้องมีเลขทะเบียน (ส่งมา หรือรถมีอยู่แล้ว) - FAILED ไม่ต้อง แต่ต้องมี failRemark (เหตุผล)
  updateDocumentSubmissionStatus: (
    submissionId: string,
    status: Exclude<DocumentSubmissionStatus, "PENDING">,
    options: { receivedDate?: string; plateCategory?: string; plateNumber?: string; receiptAmount?: string; failRemark?: string } = {},
  ) =>
    request<DocumentSubmission>(`/api/vehicles/document-submission/${submissionId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...options }),
    }),

  listReceivingPending: (step: ReceivingStep) => request<{ vehicles: ReceivingRow[] }>(`/api/vehicles/receiving/${step}/pending`),
  listReceivingCompleted: (step: ReceivingStep) => request<{ vehicles: ReceivingRow[] }>(`/api/vehicles/receiving/${step}/completed`),
  markReceivingDone: (id: string, step: ReceivingStep, data: { date: string; recipient?: string; note?: string }) =>
    request<{ vehicle: ReceivingRow }>(`/api/vehicles/${id}/receiving/${step}`, { method: 'PATCH', body: JSON.stringify(data) }),

  listPendingTransferNotice: () => request<{ vehicles: TransferNoticeVehicle[] }>('/api/vehicles/transfer-notice/pending'),
  listRecentlyCompletedTransferNotice: () =>
    request<{ vehicles: TransferNoticeVehicle[] }>('/api/vehicles/transfer-notice/completed'),
  updateTransferNotice: (id: string, data: { done: boolean; completedDate: string | null; cost: string | null }) =>
    request<{ vehicle: Pick<TransferNoticeVehicle, 'id' | 'transferDone' | 'transferCompletedDate' | 'transferCost'> }>(
      `/api/vehicles/${id}/transfer-notice`,
      { method: 'PATCH', body: JSON.stringify(data) },
    ),

  listPendingInspectionSend: () => request<{ vehicles: InspectionVehicle[] }>('/api/vehicles/inspection/pending-send'),
  listPendingInspectionResult: () => request<{ vehicles: InspectionVehicle[] }>('/api/vehicles/inspection/pending-result'),
  listRecentlyCompletedInspection: () => request<{ vehicles: InspectionVehicle[] }>('/api/vehicles/inspection/completed'),
  updateInspectionSent: (
    id: string,
    data: { sentType: string; sentDate: string | null }, // ค่าใช้จ่าย backend คำนวณเอง (คงที่)
  ) =>
    request<{
      vehicle: Pick<
        InspectionVehicle,
        'id' | 'inspectionRound' | 'inspectionSentType' | 'inspectionSentDate' | 'inspectionSentCost' | 'inspectionSentBillCost'
      >;
    }>(`/api/vehicles/${id}/inspection-sent`, { method: 'PATCH', body: JSON.stringify(data) }),
  updateInspectionResult: (
    id: string,
    data: { result: string; resultDate: string | null; remark: string | null }, // ค่าใช้จ่าย backend คำนวณเอง (คงที่)
  ) =>
    request<{
      vehicle: Pick<
        InspectionVehicle,
        'id' | 'inspectionResult' | 'inspectionResultDate' | 'inspectionResultCost' | 'inspectionResultBillCost' | 'inspectionFailRemark'
      >;
    }>(`/api/vehicles/${id}/inspection-result`, { method: 'PATCH', body: JSON.stringify(data) }),

  // แก้ไขผลตรวจที่บันทึกไปแล้ว - remark = เหตุผลที่แก้ (บังคับ, เก็บลงประวัติการแก้ไข), failRemark = เหตุผลที่ตรวจไม่ผ่าน
  correctInspectionResult: (
    id: string,
    data: { result: string; resultDate: string; failRemark: string | null; remark: string },
  ) =>
    request<{
      vehicle: Pick<
        InspectionVehicle,
        'id' | 'inspectionResult' | 'inspectionResultDate' | 'inspectionResultCost' | 'inspectionResultBillCost' | 'inspectionFailRemark'
      >;
    }>(`/api/vehicles/${id}/inspection-result-correction`, { method: 'PATCH', body: JSON.stringify(data) }),

  // แก้วันที่ในใบเสร็จของรายการที่ได้ใบเสร็จแล้ว (ค.ศ. YYYY-MM-DD)
  // ยกเลิกรายการที่ยังรอใบเสร็จ (รถยนต์/จักรยานยนต์, รูปใบเสร็จที่แนบถูกถอดไปรอจับคู่) - รถกลับไปอยู่ในคิวรอยื่นเอกสาร ยื่นใหม่ได้, ต้องมีเหตุผล
  cancelDocumentSubmission: (submissionId: string, remark: string) =>
    request<{ id: string; cancelled: true }>(`/api/vehicles/document-submission/${submissionId}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ remark }),
    }),

  // แก้ย้อนหลังต้องมีเหตุผล (เก็บลง VehicleEditLog) และวันที่ต้องอยู่ระหว่างวันที่ยื่นกับวันที่รับใบเสร็จ
  updateReceiptDate: (submissionId: string, receiptDate: string, remark: string) =>
    request<DocumentSubmission>(`/api/vehicles/document-submission/${submissionId}/receipt-date`, {
      method: 'PATCH',
      body: JSON.stringify({ receiptDate, remark }),
    }),

  // หน้ารับใบเสร็จ: บันทึกทั้งใบยื่นทีเดียว (best-effort) - RECEIVED ต้องแนบรูปแล้ว, FAILED ต้องมี failRemark,
  // CARRY = ค้างไว้ในใบยื่นเดิม ("ยังขาด")
  saveReceiptCheck: (receivedDate: string, entries: ReceiptCheckEntry[]) =>
    request<{ succeeded: string[]; failed: Array<{ submissionId: string; error: string }> }>('/api/vehicles/document-submission/receipt-check', {
      method: 'POST',
      body: JSON.stringify({ receivedDate, entries }),
    }),

  // background = เก็บรูปแล้วตอบทันที AI อ่านทีหลัง (ใช้กับการเลือกหลายรูปที่ไม่ระบุรถ)
  uploadReceipt: (image: Blob, fileName: string, submissionId?: string, background = false) => {
    const form = new FormData();
    form.append('file', image, fileName);
    if (submissionId) form.append('submissionId', submissionId);
    if (background) form.append('background', '1');
    return request<{ receipt: ReceiptImage }>('/api/receipts', { method: 'POST', body: form });
  },
  getReceipts: (ids: string[]) => request<{ receipts: ReceiptImage[] }>(`/api/receipts?ids=${ids.map(encodeURIComponent).join(',')}`),
  listUnassignedReceipts: () => request<{ receipts: ReceiptImage[] }>('/api/receipts/unassigned'),
  assignReceipt: (id: string, submissionId: string) =>
    request<{ receipt: ReceiptImage }>(`/api/receipts/${id}`, { method: 'PATCH', body: JSON.stringify({ submissionId }) }),
  deleteReceipt: (id: string) => request<{ id: string }>(`/api/receipts/${id}`, { method: 'DELETE' }),

  attachPlatePhoto: (vehicleId: string, image: Blob, fileName: string, date: string) => {
    const form = new FormData();
    form.append('file', image, fileName);
    form.append('vehicleId', vehicleId);
    form.append('date', date);
    return request<{ vehicleId: string }>('/api/plate-photos/attach', { method: 'POST', body: form });
  },
  attachBookPhoto: (vehicleId: string, image: Blob, fileName: string, date: string) => {
    const form = new FormData();
    form.append('file', image, fileName);
    form.append('vehicleId', vehicleId);
    form.append('date', date);
    return request<{ vehicleId: string }>('/api/book-photos/attach', { method: 'POST', body: form });
  },

  listVehicleOwners: () => request<{ owners: VehicleOwner[] }>('/api/vehicle-owners'),
  createVehicleOwner: (data: VehicleOwnerInput) =>
    request<{ id: string }>('/api/vehicle-owners', { method: 'POST', body: JSON.stringify(data) }),

  previewTax: (data: {
    body: string | null;
    fuel: string | null;
    cc: string | null;
    weight: string | null;
    firstRegistrationDate: string | null;
    owner: VehicleOwnerInput | null;
  }) => request<TaxBreakdown>('/api/tax-calculations/preview', { method: 'POST', body: JSON.stringify(data) }),

  updateVehicleTaxInput: (
    id: string,
    data: { ownerId: string | null; isFactoryNew: boolean | null; firstRegistrationDate: string | null },
  ) => request<{ taxCalculation: TaxCalculation }>(`/api/vehicles/${id}/tax-input`, { method: 'PATCH', body: JSON.stringify(data) }),

  listVehicleTaxCalculations: (id: string) =>
    request<{ taxCalculations: TaxCalculation[] }>(`/api/vehicles/${id}/tax-calculations`),

  listYamahaRelocation: (size: YamahaRelocationSize, month: string) =>
    request<{ entries: YamahaRelocationEntry[]; summary: YamahaRelocationSummary }>(
      `/api/yamaha-relocation?size=${size}&month=${month}`,
    ),
  // multipart: date, size, count + ไฟล์ receipt (ใบเสร็จ) และ report (Report) - backend บังคับทั้ง 2 ไฟล์
  createYamahaRelocation: (data: { date: string; size: YamahaRelocationSize; count: number; receipt: File; report: File }) => {
    const form = new FormData();
    form.append('date', data.date);
    form.append('size', data.size);
    form.append('count', String(data.count));
    form.append('receipt', data.receipt, data.receipt.name);
    form.append('report', data.report, data.report.name);
    return request<{ entry: YamahaRelocationEntry }>('/api/yamaha-relocation', { method: 'POST', body: form });
  },

  // ต่อภาษี - preview คิดยอดสดให้ฟอร์ม (ไม่บันทึก), PATCH ใช้เติมวันที่/ติ๊กทีหลังจากหน้ารายการ
  listTaxRenewals: () => request<TaxRenewal[]>('/api/tax-renewals'),
  searchTaxRenewalVehicles: (q: string) =>
    request<{ vehicles: TaxRenewalVehicleHit[] }>(`/api/tax-renewals/vehicle-search?q=${encodeURIComponent(q)}`),
  previewTaxRenewal: (data: TaxRenewalInput) =>
    request<TaxRenewalPreview>('/api/tax-renewals/preview', { method: 'POST', body: JSON.stringify(data) }),
  createTaxRenewal: (data: TaxRenewalInput) =>
    request<TaxRenewal>('/api/tax-renewals', { method: 'POST', body: JSON.stringify(data) }),
  updateTaxRenewal: (id: string, data: TaxRenewalUpdateInput) =>
    request<TaxRenewal>(`/api/tax-renewals/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
};
