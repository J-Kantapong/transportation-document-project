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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      // FormData (อัปโหลดรูป) ให้ browser ตั้ง Content-Type multipart เอง
      headers: init?.body instanceof FormData ? init.headers : { 'Content-Type': 'application/json', ...init?.headers },
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
  ownerName: string | null;
  ownerType: OwnerType | null;
  // Step 4: เลขทะเบียนที่ขอ/ได้รับ - mutable, กรอกทีหลังได้ตอนใบเสร็จกรมขนส่งออกเลขให้
  plateCategory: string | null;
  plateNumber: string | null;
  // true = ยื่นเอกสารไปแล้วและยังรอใบเสร็จอยู่ (DocumentSubmission ล่าสุดค้างสถานะ PENDING) - ยื่นซ้ำไม่ได้
  // จนกว่าจะได้รับใบเสร็จหรือยื่นไม่สำเร็จ
  pendingDocumentSubmission: boolean;
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
  receiptReceivedDate: string | null;
  receiptAmount: string | null; // ยอดบนใบเสร็จจริงที่พนักงานกรอก - เทียบกับ billFeeTotal + taxAmount
  receiptNo: string | null; // เลขที่ใบเสร็จ (AI กรอกให้ พนักงานแก้ได้)
  failRemark: string | null; // เหตุผลที่ยื่นไม่สำเร็จ - มีเฉพาะ status FAILED
  receiptCarriedAt: string | null; // ตรวจใบยื่นแล้วยังไม่ได้ใบเสร็จ/ยังไม่รู้สาเหตุ -> อยู่ใน "ค้างจากใบก่อน"
  vehicle: {
    chassis: string;
    body: string | null;
    plateCategory: string | null;
    plateNumber: string | null;
    customer: { name: string; company: string | null };
    brand: { name: string };
    owner: { name: string | null; ownerType: OwnerType } | null;
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

export type ReceiptExtraction = (
  | {
      reading: ReceiptReading;
      checks: { chassisValid: boolean; receiptNoValid: boolean; plateValid: boolean; itemsSumMatchesTotal: boolean };
    }
  | { error: string }
) & {
  // chassis = ระบบจับคู่กับรถให้จากเลขตัวถัง / chassis-mismatch = เลขตัวถังในใบเสร็จไม่ตรงกับรถที่แนบ
  match?: "chassis" | "chassis-mismatch" | null;
};

export type ReceiptSummary = Pick<ReceiptImage, 'id' | 'extractionSource' | 'extraction' | 'createdAt'>;

export type ReceiptCheckEntry =
  | { submissionId: string; action: 'RECEIVED'; plateCategory: string; plateNumber: string; receiptAmount?: string; receiptNo?: string }
  | { submissionId: string; action: 'FAILED'; failRemark: string }
  | { submissionId: string; action: 'CARRY' };

export const receiptImageUrl = (id: string) => `${API_BASE_URL}/api/receipts/${id}/image`;

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
}

export type YamahaRelocationSize = 'SMALL' | 'LARGE';

export interface YamahaRelocationEntry {
  id: string;
  date: string;
  size: YamahaRelocationSize;
  count: number;
  billFee: string;
  noBillFee: string;
  createdAt: string;
}

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

export const api = {
  listCustomers: () => request<{ customers: Customer[] }>('/api/customers'),
  createCustomer: (data: NewCustomerInput) =>
    request<{ id: string }>('/api/customers', { method: 'POST', body: JSON.stringify(data) }),

  listBrands: () => request<{ brands: Brand[] }>('/api/brands'),
  createBrand: (name: string) =>
    request<{ brand: Brand }>('/api/brands', { method: 'POST', body: JSON.stringify({ name }) }),

  listVehicles: () => request<{ vehicles: Vehicle[] }>('/api/vehicles'),
  createVehicles: (vehicles: Record<string, string>[]) =>
    request<{ count: number }>('/api/vehicles', { method: 'POST', body: JSON.stringify({ vehicles }) }),
  updateVehicle: (id: string, data: Record<string, string>) =>
    request<{ id: string }>(`/api/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

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

  // หน้ารับใบเสร็จ: บันทึกทั้งใบยื่นทีเดียว (best-effort) - RECEIVED ต้องแนบรูปแล้ว, FAILED ต้องมี failRemark,
  // CARRY = ย้ายไป "ค้างจากใบก่อน"
  saveReceiptCheck: (receivedDate: string, entries: ReceiptCheckEntry[]) =>
    request<{ succeeded: string[]; failed: Array<{ submissionId: string; error: string }> }>('/api/vehicles/document-submission/receipt-check', {
      method: 'POST',
      body: JSON.stringify({ receivedDate, entries }),
    }),

  uploadReceipt: (image: Blob, fileName: string, submissionId?: string) => {
    const form = new FormData();
    form.append('file', image, fileName);
    if (submissionId) form.append('submissionId', submissionId);
    return request<{ receipt: ReceiptImage }>('/api/receipts', { method: 'POST', body: form });
  },
  listUnassignedReceipts: () => request<{ receipts: ReceiptImage[] }>('/api/receipts/unassigned'),
  assignReceipt: (id: string, submissionId: string) =>
    request<{ receipt: ReceiptImage }>(`/api/receipts/${id}`, { method: 'PATCH', body: JSON.stringify({ submissionId }) }),
  deleteReceipt: (id: string) => request<{ id: string }>(`/api/receipts/${id}`, { method: 'DELETE' }),

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
  createYamahaRelocation: (data: { date: string; size: YamahaRelocationSize; count: number }) =>
    request<{ entry: YamahaRelocationEntry }>('/api/yamaha-relocation', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
};
