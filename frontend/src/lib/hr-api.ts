import { request } from "@/lib/api";

// ฝ่ายบุคคล / เงินเดือน (ผู้ใช้ 2026-10-05) - ดู backend/src/hr  ADMIN เท่านั้น (backend: /api/hr)

export type EmployeeIdType = "CITIZEN" | "OTHER";
export type EmployeeStatus = "ACTIVE" | "RESIGNED";

export interface Employee {
  id: string;
  code: string;
  prefix: string | null;
  firstName: string;
  lastName: string | null;
  fullName: string;
  position: string | null;
  idType: EmployeeIdType;
  idNumber: string;
  birthDate: string | null; // ค.ศ. YYYY-MM-DD
  startDate: string | null;
  baseSalary: number;
  socialSecurity: boolean;
  withholdTax: boolean;
  otherAllowance: number;
  status: EmployeeStatus;
  resignedDate: string | null;
  userId: string | null;
  userLabel: string | null;
  note: string | null;
  updatedAt: string;
}

export interface EmployeeInput {
  code: string;
  prefix: string | null;
  firstName: string;
  lastName: string | null;
  position: string | null;
  idType: EmployeeIdType;
  idNumber: string;
  birthDate: string | null;
  startDate: string | null;
  baseSalary: number;
  socialSecurity: boolean;
  withholdTax: boolean;
  otherAllowance: number;
  note: string | null;
}

export type PayrollStatus = "DRAFT" | "APPROVED" | "PAID" | "CANCELLED";

export interface PayrollTotals {
  salary: number;
  otherIncome: number;
  gross: number;
  sso: number;
  ssoRemit: number; // ยอดนำส่ง สปส. (ส่วนพนักงาน + ส่วนนายจ้าง)
  tax: number; // ยอดนำส่ง ภ.ง.ด.1
  otherDeduction: number;
  net: number;
}

export interface PayrollItem {
  id: string;
  employeeId: string;
  code: string;
  fullName: string;
  position: string | null;
  salary: number;
  otherIncome: number;
  otherIncomeNote: string | null;
  ssoAmount: number;
  taxAmount: number;
  otherDeduction: number;
  deductionNote: string | null;
  netPay: number;
  ssoManual: boolean;
  taxManual: boolean;
  // ยอดสะสมตั้งแต่ต้นปี ค.ศ. ถึงเดือนของรอบนี้ (รวมรอบนี้) - มีเฉพาะตอนเปิดรอบ (GET /payroll/runs/:id) ไว้พิมพ์บนสลิป
  ytd?: { income: number; sso: number; tax: number };
}

export interface PayrollRunSummary {
  id: string;
  month: string; // YYYY-MM (ค.ศ.)
  status: PayrollStatus;
  payDate: string | null;
  createdAt: string;
  approvedAt: string | null;
  approvedByName: string | null;
  paidAt: string | null;
  paidByName: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelledByName: string | null;
  ssoRate: number;
  ssoWageCap: number;
  totals: PayrollTotals;
  employeeCount: number;
}

export interface PayrollRun extends Omit<PayrollRunSummary, "employeeCount"> {
  createdByName: string | null;
  updatedAt: string;
  items: PayrollItem[];
}

export interface PayrollItemInput {
  salary?: number;
  otherIncome?: number;
  otherIncomeNote?: string | null;
  otherDeduction?: number;
  deductionNote?: string | null;
  sso?: number | null; // ตัวเลข = พิมพ์ทับ, null = ให้ระบบคำนวณ, ไม่ส่ง = คงเดิม
  tax?: number | null;
}

export interface HistoryEntry {
  id: string;
  action: string;
  remark: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
  by: string | null;
  at: string;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const enc = encodeURIComponent;

export const hrApi = {
  listEmployees: (params: { status?: string; q?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request<{ employees: Employee[] }>(`/api/hr/employees${qs ? `?${qs}` : ""}`);
  },
  createEmployee: (data: EmployeeInput) => request<{ employee: Employee }>("/api/hr/employees", json("POST", data)),
  importEmployees: (rows: EmployeeInput[]) => request<{ created: number; skipped: Array<{ code: string; reason: string }> }>("/api/hr/employees/import", json("POST", { rows })),
  updateEmployee: (id: string, data: Partial<EmployeeInput> & { remark: string; expectedUpdatedAt: string }) =>
    request<{ employee: Employee }>(`/api/hr/employees/${enc(id)}`, json("PATCH", data)),
  resignEmployee: (id: string, date: string, remark: string) => request<{ employee: Employee }>(`/api/hr/employees/${enc(id)}/resign`, json("POST", { date, remark })),
  reinstateEmployee: (id: string, remark: string) => request<{ employee: Employee }>(`/api/hr/employees/${enc(id)}/reinstate`, json("POST", { remark })),
  employeeHistory: (id: string) => request<{ history: HistoryEntry[] }>(`/api/hr/employees/${enc(id)}/history`),

  listRuns: () => request<{ runs: PayrollRunSummary[] }>("/api/hr/payroll/runs"),
  createRun: (month: string) => request<{ run: PayrollRun }>("/api/hr/payroll/runs", json("POST", { month })),
  getRun: (id: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}`),
  runHistory: (id: string) => request<{ history: HistoryEntry[] }>(`/api/hr/payroll/runs/${enc(id)}/history`),
  updateItem: (runId: string, itemId: string, data: PayrollItemInput) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(runId)}/items/${enc(itemId)}`, json("PATCH", data)),
  recalculate: (id: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}/recalculate`, json("POST", {})),
  approve: (id: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}/approve`, json("POST", {})),
  unapprove: (id: string, remark: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}/unapprove`, json("POST", { remark })),
  pay: (id: string, payDate: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}/pay`, json("POST", { payDate })),
  unpay: (id: string, remark: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}/unpay`, json("POST", { remark })),
  cancelRun: (id: string, remark: string) => request<{ run: PayrollRun }>(`/api/hr/payroll/runs/${enc(id)}/cancel`, json("POST", { remark })),
};

export const STATUS_LABEL: Record<PayrollStatus, string> = { DRAFT: "ร่าง", APPROVED: "อนุมัติแล้ว", PAID: "จ่ายแล้ว", CANCELLED: "ยกเลิก" };

const THAI_MONTHS = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
export const thaiMonthName = (monthIndex: number) => THAI_MONTHS[monthIndex] ?? "";

// 'YYYY-MM' (ค.ศ.) -> "ตุลาคม 2569" (หน้าจอแสดง พ.ศ.)
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  return m ? `${THAI_MONTHS[Number(m[2]) - 1]} ${Number(m[1]) + 543}` : month;
}

// เลขบัตรในรายการแสดงแค่ 4 ตัวท้าย (ข้อมูลส่วนบุคคล) - เต็มเมื่อเปิดแก้ไข
export const maskId = (id: string) => (id.length > 4 ? `${"•".repeat(id.length - 4)}${id.slice(-4)}` : id);

// ---------- วางจาก Excel ----------
// ลำดับคอลัมน์ตามตารางพนักงานของบริษัท (ผู้ใช้ 2026-10-05): รหัส, คำนำหน้า, ชื่อ-สกุล, ตำแหน่ง, เลขประจำตัว, (คอลัมน์ 6 ไม่ใช้),
// วันเกิด (วว/ดด/ปปปป พ.ศ. หรือ ค.ศ.), เงินเดือน, ประกันสังคม (ว่าง / "-" / 0 = ไม่เข้าประกันสังคม) - คอลัมน์หลังจากนั้นไม่อ่าน
export interface ParsedEmployeeRow {
  line: number;
  input: EmployeeInput | null;
  errors: string[];
  warnings: string[];
}

const PREFIX_WORD = /^(นาย|นางสาว|นาง|น\.ส\.|mr\.?|mrs\.?|ms\.?|miss)(?=\s|$)/i;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function parseBirthDate(raw: string): string | null {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw.trim());
  if (!m) return null;
  let year = Number(m[3]);
  if (year >= 2400) year -= 543;
  const iso = `${year}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function parseMoneyCell(raw: string): number | null {
  const s = raw.replace(/[,\s]/g, "");
  if (s === "" || s === "-") return 0;
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : null;
}

export function parseEmployeePaste(text: string): ParsedEmployeeRow[] {
  const rows: ParsedEmployeeRow[] = [];
  text.split(/\r?\n/).forEach((rawLine, index) => {
    if (!rawLine.trim()) return;
    const cells = rawLine.split("\t").map((c) => c.trim());
    const [code = "", prefixCell = "", nameCell = "", position = "", idCell = "", , birthCell = "", salaryCell = "", ssoCell = ""] = cells;
    const errors: string[] = [];
    const warnings: string[] = [];
    if (!code) errors.push("ไม่มีรหัสพนักงาน");
    // ตัดคำนำหน้าออกจากช่องชื่อ (ช่องชื่อมักมีคำนำหน้าติดมาด้วย: "นาย กันตพงศ์ ...", "นายวีระ ...", "Mr. Saw ...")
    let fullName = nameCell.replace(/\s+/g, " ").trim();
    if (prefixCell) fullName = fullName.replace(new RegExp(`^${escapeRegExp(prefixCell)}\\.?\\s*`, "i"), "");
    const [firstName = "", ...rest] = fullName.split(" ");
    if (!firstName) errors.push("ไม่มีชื่อ");
    if (PREFIX_WORD.test(firstName) || /^(นาย|นาง|น\.ส\.)/.test(firstName)) warnings.push(`ชื่อ "${firstName}" ขึ้นต้นเหมือนคำนำหน้า - ตรวจการสะกด`);
    const idNumber = idCell.replace(/[\s-]/g, "");
    if (!idNumber) errors.push("ไม่มีเลขประจำตัว");
    const idType: EmployeeIdType = /^\d{13}$/.test(idNumber) ? "CITIZEN" : "OTHER";
    if (idType === "OTHER" && idNumber) warnings.push("เลขประจำตัวไม่ใช่ 13 หลัก - บันทึกเป็น \"เลขอื่น\" (พนักงานต่างชาติ)");
    const birthDate = birthCell ? parseBirthDate(birthCell) : null;
    if (birthCell && !birthDate) errors.push(`วันเกิด "${birthCell}" อ่านไม่ได้`);
    const baseSalary = parseMoneyCell(salaryCell);
    if (baseSalary === null || baseSalary <= 0) errors.push(`เงินเดือน "${salaryCell}" อ่านไม่ได้`);
    const sso = parseMoneyCell(ssoCell);
    if (sso === null) errors.push(`ประกันสังคม "${ssoCell}" อ่านไม่ได้`);
    rows.push({
      line: index + 1,
      errors,
      warnings,
      input: errors.length
        ? null
        : {
            code,
            prefix: prefixCell || null,
            firstName,
            lastName: rest.join(" ") || null,
            position: position || null,
            idType,
            idNumber,
            birthDate,
            startDate: null,
            baseSalary: baseSalary!,
            socialSecurity: (sso ?? 0) > 0,
            withholdTax: true,
            otherAllowance: 0,
            note: null,
          },
    });
  });
  return rows;
}

// ---------- CSV ----------
const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// ดาวน์โหลด CSV (UTF-8 มี BOM ให้ Excel อ่านภาษาไทยถูก)
export function downloadCsv(fileName: string, rows: Array<Array<string | number | null>>): void {
  const body = `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
