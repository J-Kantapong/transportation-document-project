import { request } from "@/lib/api";
import type { BillingAccount } from "@/lib/billing-api";

// บันทึกการจ่ายของลูกค้า + ตารางล้อ (ผู้ใช้ 2026-09-27) - ดู backend/src/customer-payments
// ADMIN / ACCOUNTANT / STAFF_CAR (STAFF_CAR เห็นและจับคู่ได้เฉพาะรถยนต์)

export interface CustomerPaymentLine {
  id: string;
  vehicleId: string | null; // null = หาเลขตัวถังนี้ในรถของลูกค้าไม่เจอ
  chassis: string; // ตามที่ลูกค้าแจ้ง
  amount: number;
  note: string | null;
  plateText: string;
  brandName: string | null;
}

export interface CustomerPayment {
  id: string;
  customerId: string;
  account: BillingAccount;
  paidDate: string;
  amount: number; // ยอดที่โอนเข้าจริง
  whtAmount: number;
  reference: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledBy: string | null;
  linesTotal: number;
  lines: CustomerPaymentLine[];
}

// แถวตารางล้อ: รถที่ส่งงานแล้ว + ยอดที่ลูกค้าจ่ายมาแล้ว (ไม่นับการจ่ายที่ยกเลิก)
export interface PaymentVehicleRow {
  id: string;
  chassis: string;
  brandName: string;
  body: string | null;
  plateText: string;
  deliveredDate: string | null;
  receiptNo: string | null;
  receiptAmount: number | null;
  invoiceNo: string | null;
  billingClosed: boolean;
  paidTotal: number;
  paymentCount: number;
  lastPaidDate: string | null;
}

export interface MatchRow {
  chassis: string;
  vehicle: { id: string; chassis: string; plateText: string; brandName: string; deliveredDate: string | null; paidTotal: number } | null;
}

export interface CreatePaymentInput {
  customerId: string;
  paidDate: string;
  amount: number;
  whtAmount: number;
  reference: string | null;
  note: string | null;
  lines: Array<{ chassis: string; amount: number; note?: string | null }>;
}

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const customerPaymentsApi = {
  list: (customerId: string, offset = 0) => request<{ payments: CustomerPayment[]; hasMore: boolean }>(`/api/customer-payments?${qs({ customerId, offset })}`),
  vehicles: (params: { customerId: string; from?: string; to?: string; status?: "paid" | "unpaid" }) =>
    request<{ vehicles: PaymentVehicleRow[]; truncated: boolean }>(`/api/customer-payments/vehicles?${qs(params)}`),
  match: (customerId: string, chassis: string[]) => request<{ rows: MatchRow[] }>("/api/customer-payments/match", json("POST", { customerId, chassis })),
  create: (data: CreatePaymentInput) => request<{ payment: CustomerPayment }>("/api/customer-payments", json("POST", data)),
  cancel: (id: string, remark: string) => request<{ payment: CustomerPayment }>(`/api/customer-payments/${encodeURIComponent(id)}/cancel`, json("POST", { remark })),
};

// วางรายการจาก Excel / ข้อความ: หนึ่งบรรทัด = เลขตัวถัง แล้วตามด้วยยอด (คั่นด้วย Tab, จุลภาค หรือช่องว่าง) - ยอดมีจุลภาคหลักพันได้
// บรรทัดว่างข้าม, บรรทัดที่อ่านยอดไม่ได้ส่งกลับเป็น error ของบรรทัดนั้น (หัวตาราง เช่น "เลขตัวถัง ยอด" ก็ขึ้น error ให้ลบเอง)
export function parsePastedLines(text: string): Array<{ line: number; chassis: string; amount: number | null; raw: string }> {
  return text
    .split(/\r?\n/)
    .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
    .filter((r) => r.raw)
    .map(({ raw, line }) => {
      const cells = raw.split(/\t|;|\s{2,}/).map((c) => c.trim()).filter(Boolean);
      // ช่องว่างเดียวคั่นก็ได้ ("ABC123 1,500") - จุลภาคใช้คั่นเฉพาะแบบ CSV ที่มีจุลภาคตัวเดียว ("ABC123,1500") ไม่งั้นชนจุลภาคหลักพัน
      // คั่นด้วยช่องว่าง = ทุกอย่างก่อนยอดคือเลขตัวถัง (เลขตัวถังที่มีช่องว่างข้างใน เช่น "MR0AB 12G3 1,500") - Tab/Excel = ช่องแรก
      const bySpace = cells.length < 2;
      let parts = bySpace ? raw.split(/\s+/).filter(Boolean) : cells;
      if (parts.length < 2 && (raw.match(/,/g) ?? []).length === 1) parts = raw.split(",").map((c) => c.trim()).filter(Boolean);
      const chassis = (bySpace && parts.length > 2 ? parts.slice(0, -1).join("") : parts[0]) ?? "";
      const amountText = (parts[parts.length - 1] ?? "").replace(/,/g, "");
      const amount = parts.length >= 2 && /^\d+(\.\d{1,2})?$/.test(amountText) ? Number(amountText) : null;
      return { line, chassis, amount, raw };
    });
}
