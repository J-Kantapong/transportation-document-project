import { request } from "@/lib/api";

// ส่งงานลูกค้า (พนักงาน) - ดู backend/src/delivery/delivery.service.ts
export type DeliveryKind = "FULL" | "NO_PLATE" | "PLATE_ONLY" | "WAITING_PLATE";

export interface DeliveryRow {
  id: string; // vehicleId
  customerId: string;
  customerName: string;
  chassis: string;
  brandName: string;
  body: string | null;
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
}

// ใบส่งงาน Delivery: บันทึกส่ง 1 ครั้ง = 1 ใบ บอกแยกรายคันว่ารอบนี้ส่งใบเสร็จ / เล่ม / ป้าย (ไม่มีราคา)
export interface DeliverySlipItem {
  vehicleId: string;
  chassis: string;
  brandName: string;
  body: string | null;
  plateText: string; // "8ขง 363" หรือ "" ถ้ายังไม่มีทะเบียน
  receiptNo: string | null;
  receipt: boolean;
  book: boolean;
  plate: boolean;
}

export interface DeliverySlip {
  id: string;
  slipNo: number;
  date: string; // YYYY-MM-DD
  recipient: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  customer: { id: string; name: string; company: string | null; branch: string | null; address: string | null; phone: string | null; displayName: string };
  items: DeliverySlipItem[];
}

export const slipNoText = (slipNo: number) => `DL-${String(slipNo).padStart(5, "0")}`;

// วางบิลในนามบริษัท (บัญชี) - ดู backend/src/billing/billing.service.ts
export interface BillingTerms {
  vat: boolean;
  whtRate: number;
  whtSpecialRate: number | null;
  whtSpecialUntil: string | null; // ISO
}

export type RateVehicleKind = "CAR" | "MOTO" | "ANY";

export interface ServiceFeeRate {
  id: string;
  label: string;
  vehicleKind: RateVehicleKind;
  ccMin: number | null;
  ccMax: number | null;
  amount: number;
  vatInclusive: boolean;
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
  plateCategory: string | null;
  plateNumber: string | null;
  deliveredDate: string;
  recipient: string | null;
  plateDelivered: boolean;
  receiptNo: string | null;
  receiptAmount: number | null;
  receiptAmountSource: "RECEIPT" | "BILL_ESTIMATE" | "NONE"; // BILL_ESTIMATE = พนักงานไม่ได้กรอกยอดใบเสร็จ ใช้ยอด Bill ที่ระบบคำนวณแทน
  requestedPlateNumber: boolean;
  suggestedRateId: string | null;
  suggestedServiceFee: number | null;
}

export interface BillingCustomer {
  id: string;
  name: string;
  company: string | null;
  branch: string | null;
  address: string | null;
  taxId: string | null;
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
  vatAmount: number;
  whtAmount: number;
  netTotal: number;
  status: "ISSUED" | "PAID" | "VOID";
  paidDate: string | null;
  taxInvoiceNo: string | null;
  voidReason: string | null;
  lines: InvoiceLine[];
}

export interface CreateInvoiceInput {
  customerId: string;
  invoiceNo: string;
  issueDate: string;
  jobLabel: string;
  lines: Array<{ vehicleId: string; receiptAmount: number; serviceFee: number; serviceLabel: string | null; deduction: number; deductionNote: string | null }>;
  extras: Array<{ label: string; amount: number }>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const billingApi = {
  deliveryQueue: () => request<{ vehicles: DeliveryRow[] }>("/api/delivery/queue"),
  deliveryRecent: () => request<{ vehicles: DeliveryRow[] }>("/api/delivery/recent"),
  submitDelivery: (data: { vehicleIds: string[]; date: string; recipient: string; note: string }) =>
    request<{ slipId: string; slipNo: number; delivered: number; plateOnly: number; platePending: number }>("/api/delivery", json("POST", data)),
  deliverySlips: (params: { from?: string; to?: string; customerId?: string }) =>
    request<{ slips: DeliverySlip[] }>(`/api/delivery/slips?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as string[][])}`),
  deliverySlip: (id: string) => request<DeliverySlip>(`/api/delivery/slips/${encodeURIComponent(id)}`),

  billingQueue: () => request<{ suggestedInvoiceNo: string; customers: BillingCustomer[] }>("/api/billing/queue"),
  updateTerms: (customerId: string, terms: BillingTerms) =>
    request<{ terms: BillingTerms }>(`/api/billing/customers/${customerId}/terms`, json("PATCH", terms)),
  replaceRates: (customerId: string, rates: ServiceFeeRateInput[]) =>
    request<{ rates: ServiceFeeRate[] }>(`/api/billing/customers/${customerId}/rates`, json("PUT", { rates })),
  listInvoices: () => request<{ invoices: Invoice[] }>("/api/billing/invoices"),
  createInvoice: (data: CreateInvoiceInput) => request<{ invoice: Invoice }>("/api/billing/invoices", json("POST", data)),
  markInvoicePaid: (id: string, data: { paidDate: string; taxInvoiceNo: string }) =>
    request<{ invoice: Invoice }>(`/api/billing/invoices/${id}/paid`, json("PATCH", data)),
  voidInvoice: (id: string, reason: string) => request<{ invoice: Invoice }>(`/api/billing/invoices/${id}/void`, json("PATCH", { reason })),
};
