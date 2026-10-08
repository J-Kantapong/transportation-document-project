import { request } from "@/lib/api";
import type { PersonalPayee } from "@/lib/company-profile";
import type { BillingAccount, Invoice, InvoiceItemKind, RateKind, RateVehicleKind } from "@/lib/billing-api";

// ใบเสนอราคา (ผู้ใช้ 2026-10-01) - ดู backend/src/billing/quotation.service.ts
// JOB = ยอดงาน (อนุมัติแล้วออกใบวางบิลจากใบนี้) · RATE = ราคาต่อคัน (อนุมัติแล้วตั้งเป็นราคาลูกค้า)
export type QuotationKind = "JOB" | "RATE";
export const QUOTATION_KIND_LABEL: Record<QuotationKind, string> = { JOB: "ยอดงาน", RATE: "ราคาต่อคัน" };

// ขั้นที่หน้าจอใช้แบ่งกลุ่ม (backend คิดให้): หมดอายุ = ออกแล้วยังไม่มีคำตอบและเลยวันยืนราคา · DONE = ออกบิล / ตั้งราคาแล้ว
export type QuotationStage = "DRAFT" | "WAITING" | "EXPIRED" | "APPROVED" | "DONE" | "REJECTED" | "CANCELLED" | "SUPERSEDED";
export const QUOTATION_STAGE_LABEL: Record<QuotationStage, string> = {
  DRAFT: "ร่าง",
  WAITING: "รอลูกค้าตอบ",
  EXPIRED: "เลยวันยืนราคา",
  APPROVED: "อนุมัติแล้ว",
  DONE: "เสร็จแล้ว",
  REJECTED: "ไม่อนุมัติ",
  CANCELLED: "ยกเลิก",
  SUPERSEDED: "มีฉบับแก้ไขแทน",
};

export interface QuotationCustomer {
  name: string;
  branch: string | null;
  address: string | null;
  taxId: string | null;
  payee?: PersonalPayee; // ผู้รับเงินบัญชีบุคคล ณ วันออก (ว่าง = ผู้รับเงินตั้งต้น)
}

export interface QuotationItem {
  id?: string;
  kind: InvoiceItemKind;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  cost: number | null;
  // เฉพาะใบแบบราคาต่อคัน
  rateKind: RateKind | null;
  vehicleKind: RateVehicleKind | null;
  ccMin: number | null;
  ccMax: number | null;
  chassisPrefix: string | null;
  vatInclusive: boolean;
  includesReceipt: boolean;
}

export type YamahaSize = "SMALL" | "LARGE";

export interface YamahaCounts {
  SMALL: number;
  LARGE: number;
}

export interface Quotation {
  id: string;
  quotationNo: string | null; // null = ร่าง
  revision: number;
  kind: QuotationKind;
  status: string;
  stage: QuotationStage;
  customerId: string | null; // null = ลูกค้าใหม่ที่ยังไม่อยู่ในระบบ
  customer: QuotationCustomer;
  issueDate: string;
  validDays: number;
  validUntil: string;
  title: string;
  conditions: string | null;
  account: BillingAccount;
  vatRate: number;
  whtRate: number;
  feeTotal: number;
  serviceTotal: number;
  goodsTotal: number;
  vatAmount: number;
  whtAmount: number;
  netTotal: number;
  yamahaMonth: string | null;
  yamahaSize: YamahaSize | null; // รถเล็ก / รถใหญ่ ออกคนละใบ · null = ใบเดิมที่รวมทั้งสอง
  yamahaCounts: YamahaCounts | null;
  approvedDate: string | null;
  poNumber: string | null;
  hasFile: boolean;
  rejectReason: string | null;
  cancelReason: string | null;
  ratesAppliedAt: string | null;
  invoice: { id: string; invoiceNo: string } | null;
  replaces: { id: string; quotationNo: string | null } | null;
  replacedBy: { id: string; quotationNo: string | null; status: string } | null;
  updatedAt: string;
  items: QuotationItem[];
}

// ยอดก่อนหัก ณ ที่จ่าย = ยอดที่พิมพ์บนใบเสนอราคา (หัก ณ ที่จ่ายเป็นเรื่องตอนจ่ายเงิน แสดงเป็นหมายเหตุเท่านั้น)
export const quotationGrandTotal = (q: Pick<Quotation, "feeTotal" | "serviceTotal" | "goodsTotal" | "vatAmount">) =>
  Math.round((q.feeTotal + q.serviceTotal + q.goodsTotal + q.vatAmount + Number.EPSILON) * 100) / 100;

export interface QuotationRateInput {
  label: string;
  kind: RateKind;
  vehicleKind: RateVehicleKind;
  ccMin: number | null;
  ccMax: number | null;
  chassisPrefix: string | null;
  amount: number;
  vatInclusive: boolean;
  includesReceipt: boolean;
}

export interface QuotationInput {
  kind?: QuotationKind; // ตอนสร้างเท่านั้น
  customerId?: string | null;
  customer?: QuotationCustomer;
  issueDate: string;
  validDays: number;
  title: string;
  conditions: string;
  items: Array<Pick<QuotationItem, "kind" | "description" | "quantity" | "unitPrice" | "cost">> | QuotationRateInput[];
  whtRate?: number;
  yamahaMonth?: string | null;
  yamahaSize?: YamahaSize | null;
  expectedUpdatedAt?: string;
}

export interface QuotationList {
  quotations: Quotation[];
  hasMore: boolean;
  counts: Record<QuotationStage, number>;
}

export interface QuotationHistoryEntry {
  id: string;
  action: string;
  remark: string;
  editedBy: string | null;
  createdAt: string;
}

export interface YamahaMonthQuote {
  month: string;
  size: YamahaSize;
  counts: YamahaCounts;
  items: Array<Pick<QuotationItem, "kind" | "description" | "quantity" | "unitPrice" | "cost">>;
  quotedBy: { id: string; quotationNo: string | null } | null;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const base = "/api/billing/quotations";
const at = (id: string, action = "") => `${base}/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;
type One = { quotation: Quotation };

export const quotationFilePath = (id: string) => at(id, "po-file");

export const quotationApi = {
  list: (params: { stage?: QuotationStage | ""; q?: string; offset?: number } = {}) =>
    request<QuotationList>(
      `${base}?${new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== "")
          .map(([k, v]) => [k, String(v)]),
      )}`,
    ),
  get: (id: string) => request<One>(at(id)),
  history: (id: string) => request<{ entries: QuotationHistoryEntry[] }>(at(id, "history")),
  ready: (customerId: string) => request<{ quotations: Quotation[] }>(`${base}/ready?customerId=${encodeURIComponent(customerId)}`),
  yamahaMonth: (month: string, size: YamahaSize) => request<YamahaMonthQuote>(`${base}/yamaha-month?month=${encodeURIComponent(month)}&size=${size}`),
  create: (data: QuotationInput) => request<One>(base, json("POST", data)),
  update: (id: string, data: QuotationInput) => request<One>(at(id), json("PATCH", data)),
  remove: (id: string) => request<{ id: string }>(at(id), { method: "DELETE" }),
  issue: (id: string, expectedUpdatedAt?: string) => request<One>(at(id, "issue"), json("POST", { expectedUpdatedAt })),
  approve: (id: string, data: { approvedDate: string; poNumber: string; file: File | null; expectedUpdatedAt: string }) => {
    const form = new FormData();
    form.append("approvedDate", data.approvedDate);
    form.append("poNumber", data.poNumber);
    form.append("expectedUpdatedAt", data.expectedUpdatedAt);
    if (data.file) form.append("file", data.file, data.file.name);
    return request<One>(at(id, "approve"), { method: "POST", body: form });
  },
  unapprove: (id: string, remark: string) => request<One>(at(id, "unapprove"), json("POST", { remark })),
  reject: (id: string, remark: string) => request<One>(at(id, "reject"), json("POST", { remark })),
  cancel: (id: string, remark: string) => request<One>(at(id, "cancel"), json("POST", { remark })),
  revise: (id: string) => request<One>(at(id, "revise"), json("POST", {})),
  linkCustomer: (id: string, customerId: string) => request<One>(at(id, "link-customer"), json("POST", { customerId })),
  createInvoice: (id: string, data: { invoiceNo: string; issueDate: string }) =>
    request<{ invoice: Invoice; quotation: Quotation }>(at(id, "invoice"), json("POST", data)),
  applyRates: (id: string) => request<One>(at(id, "apply-rates"), json("POST", {})),
};
