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
      headers: { 'Content-Type': 'application/json', ...init?.headers },
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

export interface DocumentSubmission {
  id: string;
  vehicleId: string;
  submitDate: string;
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
  vehicle: {
    chassis: string;
    body: string | null;
    plateCategory: string | null;
    plateNumber: string | null;
    customer: { name: string };
    owner: { name: string | null; ownerType: OwnerType } | null;
  };
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
  suggestedCost: string | null;
  inspectionSentType: 'ส่งตรวจนอก' | 'เอารถมาตรวจเอง' | null;
  inspectionSentDate: string | null;
  inspectionSentCost: string | null;
  inspectionResult: 'ผ่าน' | 'ไม่ผ่าน' | null;
  inspectionResultDate: string | null;
  inspectionResultCost: string | null;
  inspectionFailRemark: string | null;
}

export interface Round2Vehicle {
  id: string;
  date: string;
  customerName: string;
  chassis: string;
  brandName: string;
  body: string | null;
  registrationProvince: string | null;
  inspectionResultDate: string | null;
  suggestedRound2Cost: string | null;
  inspectionRound2Done: boolean;
  inspectionRound2Date: string | null;
  inspectionRound2Cost: string | null;
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

  searchVehiclesByChassis: (chassis: string) =>
    request<{ vehicles: Vehicle[] }>(`/api/vehicles/search?chassis=${encodeURIComponent(chassis)}`),
  lookupVehiclesByChassis: (chassisList: string[]) =>
    request<{ found: Vehicle[]; notFound: string[] }>('/api/vehicles/lookup-by-chassis', {
      method: 'POST',
      body: JSON.stringify({ chassisList }),
    }),

  previewDocumentSubmissionFee: (vehicleId: string, options: DocumentSubmissionOptionsInput) =>
    request<FeePreview>(`/api/vehicles/${vehicleId}/document-submission/preview`, {
      method: 'POST',
      body: JSON.stringify(options),
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
  listDocumentSubmissions: (date?: string) =>
    request<{ submissions: DocumentSubmission[] }>(`/api/vehicles/document-submission${date ? `?date=${date}` : ''}`),

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
  updateInspectionSent: (id: string, data: { sentType: string; sentDate: string | null; cost: string | null }) =>
    request<{ vehicle: Pick<InspectionVehicle, 'id' | 'inspectionSentType' | 'inspectionSentDate' | 'inspectionSentCost'> }>(
      `/api/vehicles/${id}/inspection-sent`,
      { method: 'PATCH', body: JSON.stringify(data) },
    ),
  updateInspectionResult: (
    id: string,
    data: { result: string; resultDate: string | null; cost: string | null; remark: string | null },
  ) =>
    request<{
      vehicle: Pick<
        InspectionVehicle,
        'id' | 'inspectionResult' | 'inspectionResultDate' | 'inspectionResultCost' | 'inspectionFailRemark'
      >;
    }>(`/api/vehicles/${id}/inspection-result`, { method: 'PATCH', body: JSON.stringify(data) }),

  listPendingInspectionRound2: () => request<{ vehicles: Round2Vehicle[] }>('/api/vehicles/inspection/round2-pending'),
  listRecentlyCompletedInspectionRound2: () =>
    request<{ vehicles: Round2Vehicle[] }>('/api/vehicles/inspection/round2-completed'),
  updateInspectionRound2: (id: string, data: { done: boolean; date: string | null; cost: string | null }) =>
    request<{ vehicle: Pick<Round2Vehicle, 'id' | 'inspectionRound2Done' | 'inspectionRound2Date' | 'inspectionRound2Cost'> }>(
      `/api/vehicles/${id}/inspection-round2`,
      { method: 'PATCH', body: JSON.stringify(data) },
    ),

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
