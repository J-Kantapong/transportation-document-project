"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, receiptImageUrl } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { canEditEntrySteps, getCachedUser } from "@/lib/auth";
import {
  ACCOUNT_LABEL,
  billingApi,
  type BillingAccount,
  type BillingCustomer,
  type BillingVehicle,
  type ClosedBillingVehicle,
  type InvoiceItem,
  type OtherJob,
  type OtherJobsCustomer,
  type ServiceFeeRate,
} from "@/lib/billing-api";
import { BillingInvoiceList } from "@/components/BillingInvoiceList";
import { BillingAccountEditor, BillingRatesEditor, BillingTermsEditor } from "@/components/BillingCustomerSettings";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, timestampToDisplayDate, todayIso } from "@/lib/date";
import { computeTotals, effectiveWhtRate, formatMoney, rateAmountExVat, round2, serviceFeeFromRate, termsSummary } from "@/lib/invoice";
import { WhtRatePicker, whtOverrideOf, whtProblem } from "@/components/WhtRatePicker";
import { InvoiceItemsEditor, itemRowsProblem, itemRowsToItems, type ItemRow } from "@/components/InvoiceItemsEditor";
import { buildInvoiceHtml, printInvoice, type PrintableInvoice } from "@/lib/invoice-print";
import { comparePlate } from "@/lib/plate-order";
import { focusChassis, focusHref, sameChassis } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";
import { AwaitingDeliveryPanel } from "@/components/AwaitingDeliveryPanel";

// พื้นที่ทำงานบัญชี: วางบิลในนามบริษัท - รถที่พนักงานบันทึกส่งงานแล้วมารอที่นี่ บัญชีเลือกคัน ตรวจค่าดำเนินการ แล้วออกใบวางบิล
// (ผู้ใช้ 2026-09-21) ทุกรายการที่ไม่ใช่ค่าใบเสร็จกรมขนส่งคิด VAT + หัก ณ ที่จ่าย, เลขที่ IV พิมพ์เองเพราะยังรันเลขร่วมกับ Google Sheet
// ค่าขอใช้เลข 500 บาทที่ลูกค้าชำระเองแล้ว ยังอยู่ในใบเสร็จที่เรียกเก็บเต็ม จึงหักคืนจากค่าดำเนินการของคันนั้น
const PLATE_REQUEST_DEDUCTION = 500;
const PLATE_REQUEST_NOTE = "ลูกค้าชำระค่าขอใช้เลขเอง";

// ค่าดำเนินการรายคัน (ผู้ใช้ 2026-09-28: จับคู่อัตโนมัติจากข้อมูลรถ ให้ผิดพลาดน้อยที่สุด): เลือกแถวราคาหลักจาก dropdown
// (ระบบเลือกให้ตามชนิดรถ/CC) + ติ๊กค่าเพิ่ม (ระบบติ๊กให้ตามการยื่น: ขอใช้เลข / ด่วน) แล้วคิดยอดให้เอง - พิมพ์ยอดเองได้เฉพาะ "กำหนดเอง"
const CUSTOM_RATE = "";

interface RowState {
  checked: boolean;
  receiptText: string;
  rateId: string; // CUSTOM_RATE = พิมพ์ยอดเอง (customText)
  addOnIds: string[];
  customText: string;
  label: string;
  deduct: boolean;
  receiptChecked: boolean; // บัญชีตรวจใบเสร็จแล้วว่ายอดที่ไม่ตรงกับที่ระบบคำนวณนั้นถูกต้อง (ปลดคำเตือน)
  // ค่าที่ระบบเสนอตอนสร้างแถว - ใช้ดูว่าบัญชีแก้เองหรือยังตอนโหลดคิวใหม่ (mergeRow) และแสดงว่า "แก้จากที่ระบบเลือก"
  receiptBase: string;
  rateBase: string;
  addOnBase: string[];
}


const money = (text: string): number | null => {
  const n = Number.parseFloat(text.replace(/,/g, ""));
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

const plateText = (v: BillingVehicle) => (v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : "");

// คอลัมน์ของรายการรถรอวางบิล (หัวตาราง + ทุกแถวใช้ชุดเดียวกัน) - แคบพอไม่ต้องเลื่อนซ้ายขวา
const ROW_GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "20px minmax(150px,1.8fr) minmax(64px,1fr) minmax(40px,0.5fr) minmax(56px,0.7fr) minmax(64px,0.9fr) minmax(84px,1.2fr) 28px",
  gap: 10,
  alignItems: "center",
};

const sameIds =(a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));
// งานอื่นๆ ระบุด้วย "ประเภท:id" (id ของแต่ละตารางงานซ้ำกันข้ามประเภทได้ในทางทฤษฎี)
const jobKey = (j: Pick<OtherJob, "type" | "id">) => `${j.type}:${j.id}`;

const newRow = (v: BillingVehicle): RowState => {
  const receiptText = v.receiptAmount === null ? "" : formatMoney(v.receiptAmount);
  const rateId = v.suggestedRateId ?? CUSTOM_RATE;
  return {
    checked: false,
    receiptText,
    rateId,
    addOnIds: v.suggestedAddOnIds,
    customText: "",
    label: "",
    deduct: false,
    receiptChecked: false,
    receiptBase: receiptText,
    rateBase: rateId,
    addOnBase: v.suggestedAddOnIds,
  };
};

// โหลดคิวใหม่ระหว่างเตรียมบิล: คันที่ยังอยู่ในคิวเก็บที่ติ๊ก/กรอกไว้ ช่องที่บัญชียังไม่ได้แก้เองใช้ค่าใหม่จากระบบ
// (เช่น ราคาใหม่หลังแก้ตารางค่าดำเนินการ) ช่องที่แก้เองแล้วคงไว้
function mergeRow(prev: RowState | undefined, v: BillingVehicle): RowState {
  const fresh = newRow(v);
  if (!prev) return fresh;
  const untouchedRate = prev.rateId === prev.rateBase && sameIds(prev.addOnIds, prev.addOnBase);
  return {
    ...prev,
    receiptText: prev.receiptText === prev.receiptBase ? fresh.receiptText : prev.receiptText,
    rateId: untouchedRate ? fresh.rateId : prev.rateId,
    addOnIds: untouchedRate ? fresh.addOnIds : prev.addOnIds,
    receiptBase: fresh.receiptBase,
    rateBase: fresh.rateBase,
    addOnBase: fresh.addOnBase,
  };
}

// ข้อความต่อท้ายบนบิลเมื่อไม่ได้พิมพ์เอง (ผู้ใช้ 2026-09-28: บรรทัดราคาต่างกันแต่ชื่อเหมือนกันอ่านไม่ออก)
// = ส่วนที่ต่างของชื่อราคาหลัก (ถ้าบิลนี้มีราคาหลักมากกว่า 1 แบบ เช่น "300-799 cc") + ชื่อค่าเพิ่ม -> "(300-799 cc + ขอใช้)"
// ชื่อราคาหลักที่ขึ้นต้นด้วยชื่องานบนบิลตัดส่วนนั้นออก ("จดทะเบียนรถจักรยานยนต์ 300-799 cc" -> "300-799 cc")
function autoServiceLabel(base: ServiceFeeRate | undefined, addOns: ServiceFeeRate[], jobLabel: string, showBase: boolean): string {
  const baseText = showBase && base ? (base.label.startsWith(jobLabel) ? base.label.slice(jobLabel.length).trim() : base.label) : "";
  // ชื่อที่ใส่วงเล็บมาเองแล้ว เช่น "(รถใหญ่)" ตัดวงเล็บนอกออกก่อน กันบนบิลเป็น "((รถใหญ่))" (ผู้ใช้ 2026-10-07)
  const unwrap = (s: string) => s.trim().replace(/^\((.*)\)$/, "$1").trim();
  const parts = [baseText, ...addOns.map((a) => a.label)].map(unwrap).filter(Boolean);
  return parts.length ? `(${parts.join(" + ")})` : "";
}


function defaultJobLabel(vehicles: BillingVehicle[]): string {
  if (vehicles.length > 0 && vehicles.every((v) => v.isMoto)) return "จดทะเบียนรถจักรยานยนต์";
  if (vehicles.length > 0 && vehicles.every((v) => !v.isMoto)) return "จดทะเบียนรถยนต์";
  return "จดทะเบียนรถ";
}

export function BillingPage() {
  const [customers, setCustomers] = useState<BillingCustomer[]>([]);
  const [invoiceReload, setInvoiceReload] = useState(0); // เพิ่มค่า = ให้รายการบิลที่ออกแล้วโหลดใหม่
  const [customerId, setCustomerId] = useState("");
  const focusApplied = useRef(false);
  const returnState = useRef<BillingReturnState | null | undefined>(undefined); // งานที่เตรียมไว้ก่อนไปแก้ข้อมูลรถ (undefined = ยังไม่อ่าน)
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // บรรทัดกำหนดเองในบิลเดียวกับรถ (ผู้ใช้ 2026-09-29: งานเก่า / ขายสินค้า / ค่าใช้จ่ายอื่น) แทนช่อง "ค่าใช้จ่ายอื่นๆ" เดิม
  const [itemRows, setItemRows] = useState<ItemRow[]>([]);
  // เลขที่บิลแยกตามบัญชี (ผู้ใช้ 2026-09-27): บัญชีบริษัท IV… / บัญชีบุคคลรันชุดของตัวเอง - ช่องเลขที่บิลแสดงของบัญชีที่รถที่เลือกอยู่
  const [invoiceNos, setInvoiceNos] = useState<Record<BillingAccount, string>>({ COMPANY: "", PERSONAL: "" });
  const [lastInvoiceNos, setLastInvoiceNos] = useState<Record<BillingAccount, string | null>>({ COMPANY: null, PERSONAL: null });
  const [issueDateText, setIssueDateText] = useState(isoToDisplayDate(todayIso()));
  const [jobLabelEdit, setJobLabelEdit] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<"" | "terms" | "rates" | "account">("");
  const [loading, setLoading] = useState(true); // โหลดคิวครั้งแรก
  const [refreshing, setRefreshing] = useState(false); // โหลดคิวใหม่ - ตารางยังแสดงอยู่ แต่ยังออกบิลไม่ได้จนกว่าจะเสร็จ
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  // ปิดงาน - วางบิลนอกระบบ (ผู้ใช้ 2026-09-27): คันที่กำลังจะปิด / เพิ่มค่า = รายการรถที่ปิดไว้โหลดใหม่ / เปิดงานกลับได้เฉพาะ ADMIN
  const [closing, setClosing] = useState<BillingVehicle | null>(null);
  const [closedReload, setClosedReload] = useState(0);
  const [isAdmin, setIsAdmin] = useState(false);
  const [canEditVehicle, setCanEditVehicle] = useState(false); // ADMIN / STAFF_ENTRY - ปุ่มแก้ข้อมูลรถ
  const [expanded, setExpanded] = useState<string | null>(null); // คันที่เปิด "แก้" อยู่
  const [fixedIds, setFixedIds] = useState<Set<string>>(new Set()); // คันที่เพิ่งแก้ข้อมูลรถเสร็จ (ป้าย "แก้ไขเรียบร้อย")
  const [confirmOpen, setConfirmOpen] = useState(false); // หน้ายืนยันออกบิล
  // อัตราหัก ณ ที่จ่ายของบิลนี้ (ผู้ใช้ 2026-09-29) null = ตามลูกค้า · checked = ยืนยันอัตราที่ไม่ตรงกับลูกค้าแล้ว
  const [whtValue, setWhtValue] = useState<number | null>(null);
  const [whtChecked, setWhtChecked] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // งานอื่นๆ (โอน / ต่อภาษี / ยกเลิกใช้รถ / คัดป้าย / ย้ายออก) ของลูกค้าที่รอวางบิล พ่วงในบิลเดียวกับรถได้ (ผู้ใช้ 2026-10-07)
  // jobPicked = "ประเภท:id" ที่ติ๊ก · jobPrices = ค่าบริการที่บัญชีพิมพ์แก้เอง (ไม่มี = ราคาจากตารางของลูกค้า)
  const [otherJobs, setOtherJobs] = useState<OtherJobsCustomer[]>([]);
  const [jobPicked, setJobPicked] = useState<Set<string>>(new Set());
  const [jobPrices, setJobPrices] = useState<Record<string, string>>({});

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setIsAdmin((getCachedUser()?.roles ?? []).includes("ADMIN"));
    setCanEditVehicle(canEditEntrySteps(getCachedUser()?.roles ?? []));
  }, []);


  // reset = เริ่มบิลใหม่ (เปิดหน้า / หลังออกบิล): ทุกแถวกลับเป็นค่าจากระบบ ล้างค่าใช้จ่ายอื่นๆ/ชื่องาน และใช้เลขที่ IV ที่ระบบเสนอใหม่
  // ไม่ reset = โหลดคิวใหม่ระหว่างเตรียมบิล (หลังแก้ตารางค่าดำเนินการ / ยกเลิกบิล): เก็บงานที่กำลังเตรียมไว้และอยู่ที่ลูกค้าเดิม (shownId)
  // (พบ 2026-09-27: เดิมโหลดใหม่ทุกครั้งแล้วคันที่ติ๊ก ราคาที่แก้ ข้อความต่อท้าย ค่าใช้จ่ายอื่นๆ หายหมดโดยไม่เตือน)
  async function loadQueue(reset: boolean, shownId = "") {
    setRefreshing(true);
    try {
      // คิวงานอื่นๆ โหลดคู่กัน - โหลดไม่ได้ก็ออกบิลรถได้ตามปกติ แค่ไม่มีงานอื่นให้พ่วง
      const [q, jobsQueue] = await Promise.all([billingApi.billingQueue(), billingApi.otherJobsQueue().catch(() => null)]);
      setCustomers(q.customers);
      if (jobsQueue) {
        setOtherJobs(jobsQueue.customers);
        // งานที่ออกบิลไปแล้ว / ถูกยกเลิก หายจากคิว - เอาออกจากที่ติ๊กไว้ด้วย
        const live = new Set(jobsQueue.customers.flatMap((c) => c.jobs.map(jobKey)));
        setJobPicked((prev) => new Set([...prev].filter((k) => live.has(k))));
      }
      // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): เลือกลูกค้าของรถคันนั้นให้ - ครั้งแรกที่โหลดเท่านั้น (lib/vehicle-focus.ts)
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const owner = chassis ? q.customers.find((c) => c.vehicles.some((v) => sameChassis(v.chassis, chassis))) : undefined;
        if (owner) setCustomerId(owner.id);
      }
      if (reset) {
        const fresh: Record<string, RowState> = Object.fromEntries(q.customers.flatMap((c) => c.vehicles.map((v) => [v.id, newRow(v)])));
        // กลับมาจากแก้ข้อมูลรถ: ติ๊กคันเดิมไว้ให้ + เปิดช่อง "แก้" ของคันที่เพิ่งแก้ ทำงานต่อได้เลย (ราคาคิดใหม่จากข้อมูลที่แก้แล้ว)
        // อ่านครั้งเดียวแล้วเก็บใน ref: ตอนเปิดหน้าอาจโหลดคิวซ้ำ (React dev) - ทุกรอบของการเปิดหน้าใช้ค่าเดียวกัน, ออกบิลแล้วล้างทิ้ง
        if (returnState.current === undefined) returnState.current = takeBillingReturnState();
        const saved = returnState.current;
        if (saved) {
          for (const id of saved.checked) if (fresh[id]) fresh[id] = { ...fresh[id], checked: true };
          if (q.customers.some((c) => c.id === saved.customerId)) setCustomerId(saved.customerId);
          // แก้ข้อมูลรถแล้วถูกต้อง = ถือว่าเสร็จ ไม่ต้องเปิดช่อง "แก้"/รูปใบเสร็จค้างไว้ (ผู้ใช้ 2026-09-28) - ยังมีปัญหาค่อยเปิดให้ดูต่อ
          const edited = q.customers.flatMap((c) => c.vehicles).find((x) => x.id === saved.expanded);
          const stillWrong =
            !!edited &&
            (edited.receiptAmount === null || edited.suggestedRateId === null || (edited.receiptEstimate !== null && edited.receiptAmount !== edited.receiptEstimate));
          setExpanded(stillWrong ? edited.id : null);
          // คันที่แก้เสร็จแล้วติ๊กให้ด้วย พร้อมลงบิลต่อ
          if (edited && !stillWrong && fresh[edited.id]) {
            fresh[edited.id] = { ...fresh[edited.id], checked: true };
            setFixedIds((prev) => new Set(prev).add(edited.id)); // ป้าย "แก้ไขเรียบร้อย" ข้างเลขตัวถัง (ผู้ใช้ 2026-09-28)
          }
        }
        setRows(fresh);
        setItemRows([]);
        setJobPicked(new Set());
        setJobPrices({});
        setJobLabelEdit(null);
        setInvoiceNos({ COMPANY: q.suggestedInvoiceNo, PERSONAL: q.suggestedPersonalInvoiceNo });
        setLastInvoiceNos({ COMPANY: q.lastInvoiceNo, PERSONAL: q.lastPersonalInvoiceNo });
      } else {
        // คันที่ออกจากคิวแล้วหายไป คันใหม่ (เช่น รถจากบิลที่เพิ่งยกเลิก) ได้แถวใหม่ที่ยังไม่ติ๊ก
        setRows((prev) => Object.fromEntries(q.customers.flatMap((c) => c.vehicles.map((v) => [v.id, mergeRow(prev[v.id], v)]))));
        if (q.customers.some((c) => c.id === shownId)) {
          setCustomerId(shownId); // ลูกค้าอื่นเพิ่งเข้าคิวก็ยังอยู่ที่ลูกค้าเดิม
        } else {
          // ลูกค้าที่เปิดอยู่ไม่มีรถรอวางบิลแล้ว - ค่าใช้จ่ายอื่นๆ/ชื่องาน/งานอื่นของลูกค้านั้นใช้กับลูกค้าอื่นไม่ได้
          setItemRows([]);
          setJobPicked(new Set());
          setJobPrices({});
          setJobLabelEdit(null);
        }
      }
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ", error: true });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadQueue sets the refreshing flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadQueue(true);
  }, []);

  const customer = customers.find((c) => c.id === customerId) ?? customers[0] ?? null;
  const vehicles = useMemo(
    () => (customer ? [...customer.vehicles].sort((a, b) => a.deliveredDate.localeCompare(b.deliveredDate) || comparePlate(a, b)) : []),
    [customer],
  );
  const selected = vehicles.filter((v) => rows[v.id]?.checked);
  // บัญชีของบิล = บัญชีของรถที่เลือก (ตามวันส่งงาน) - เลือกปนกัน 2 บัญชี = ออกบิลไม่ได้ ต้องแยกบิล
  const selectedAccounts = [...new Set(selected.map((v) => v.account))];
  const mixedAccounts = selectedAccounts.length > 1;
  const account: BillingAccount = selectedAccounts.length === 1 ? selectedAccounts[0] : (customer?.account ?? "COMPANY");
  const invoiceNo = invoiceNos[account];
  const issueDateIso = displayDateToIso(issueDateText.replace(/\D/g, ""));
  const jobLabel = jobLabelEdit ?? defaultJobLabel(selected.length ? selected : vehicles);

  const rates = customer?.rates ?? [];
  const rateById = new Map(rates.map((r) => [r.id, r]));
  // แถวราคาที่ใช้กับรถคันนี้ได้ (ชนิดรถตรงหรือทุกชนิด) - ราคาหลักไว้ใน dropdown, ค่าเพิ่มเป็นช่องติ๊ก
  const ratesFor = (v: BillingVehicle, kind: "BASE" | "ADD_ON") =>
    rates.filter((r) => (kind === "BASE" ? r.kind === "BASE" : r.kind !== "BASE") && (r.vehicleKind === "ANY" || r.vehicleKind === (v.isMoto ? "MOTO" : "CAR")));
  const addOnsOf = (row: RowState) => row.addOnIds.map((id) => rateById.get(id)).filter((r): r is ServiceFeeRate => !!r);

  // ค่าดำเนินการก่อนหักยอด (เหมือน serviceFeeFromRate + ค่าเพิ่ม ฝั่ง backend) - null = ยังไม่มีราคา / ใบเสร็จแพงกว่าราคาเหมารวม
  const baseFeeOf = (v: BillingVehicle): number | null => {
    const row = rows[v.id];
    if (!row) return null;
    if (row.rateId === CUSTOM_RATE) return money(row.customText);
    const rate = rateById.get(row.rateId);
    if (!rate) return null;
    const base = serviceFeeFromRate(rate, money(row.receiptText));
    return base === null ? null : round2(base + addOnsOf(row).reduce((s, a) => s + rateAmountExVat(a), 0));
  };

  const serviceFeeOf = (v: BillingVehicle): number | null => {
    const row = rows[v.id];
    const base = baseFeeOf(v);
    if (!row || base === null) return null;
    const fee = round2(base - (row.deduct ? PLATE_REQUEST_DEDUCTION : 0));
    return fee >= 0 ? fee : null;
  };

  // เหตุผลที่คันนี้ยังออกบิลไม่ได้ (ติ๊กไม่ได้จนกว่าจะแก้) - null = พร้อม
  // ยอดใบเสร็จไม่ตรงกับที่ระบบคำนวณจากข้อมูลรถตอนยื่น - มักแปลว่าข้อมูลรถผิด (เช่น จังหวัด -> ขอใช้ผิด ค่าบริการผิด 100)
  const receiptMismatchOf = (v: BillingVehicle): string | null => {
    const row = rows[v.id];
    const receipt = row ? money(row.receiptText) : null;
    if (!row || row.receiptChecked || receipt === null || v.receiptEstimate === null || receipt === v.receiptEstimate) return null;
    const diff = round2(receipt - v.receiptEstimate);
    const hint =
      diff > 0 && !v.otherProvince
        ? " - ใบเสร็จแพงกว่า อาจเป็นรถขอใช้แต่ข้อมูลรถไม่ใช่"
        : diff < 0 && v.otherProvince
          ? " - ใบเสร็จถูกกว่า อาจไม่ใช่รถขอใช้แต่ข้อมูลรถบอกว่าใช่"
          : "";
    return `ใบเสร็จ ${formatMoney(receipt)} ไม่ตรงกับที่ระบบคำนวณ ${formatMoney(v.receiptEstimate)} (ต่าง ${diff > 0 ? "+" : ""}${formatMoney(diff)})${hint}`;
  };

  // ใบเสร็จถูกเสมอ (ผู้ใช้ 2026-10-09): ยอดใบเสร็จไม่ตรงกับที่คำนวณจากข้อมูลรถ แต่ตรงพอดีกับยอดถ้าเรื่องขอใช้เป็นตรงข้าม
  // = ใบเสร็จบอกว่าคันนี้ขอใช้ / ไม่ขอใช้ต่างจากข้อมูลรถ -> เสนอปุ่ม "ใช้ตามใบเสร็จ" ที่ติ๊ก/เอาติ๊กค่าเพิ่มขอใช้ให้ และปลดคำเตือน
  // บัญชีต้องกดเอง (ยอดใบเสร็จในระบบมาจาก AI อ่าน/คนพิมพ์ ผิดได้) · มีผลกับบิลนี้เท่านั้น ไม่แก้จังหวัดในข้อมูลรถ
  const receiptSaysOf = (v: BillingVehicle): { otherProvince: boolean; addOnIds: string[] } | null => {
    const row = rows[v.id];
    const receipt = row ? money(row.receiptText) : null;
    const flipped = v.receiptEstimateFlipped ?? null;
    if (!row || receipt === null || flipped === null || v.receiptEstimate === null || receipt === v.receiptEstimate || receipt !== flipped) return null;
    const otherProvince = !v.otherProvince;
    const provinceAddOns = ratesFor(v, "ADD_ON").filter((r) => r.kind === "OTHER_PROVINCE").map((r) => r.id);
    const rest = row.addOnIds.filter((id) => !provinceAddOns.includes(id));
    return { otherProvince, addOnIds: otherProvince ? [...rest, ...provinceAddOns] : rest };
  };

  // งานสลับเลขของรถคันนี้ (ผู้ใช้ 2026-09-28): เก็บค่าใบเสร็จกรมฯ ของรถเก่าเพิ่มอีกยอด ยังไม่กรอก = วางบิลไม่ได้
  const swapProblemOf = (v: BillingVehicle): string | null => {
    if (!v.plateSwap) return null;
    if (v.plateSwap.receiptAmount === null) return `งานสลับเลข (รถเก่า ${v.plateSwap.oldChassis}) ยังไม่มียอดใบเสร็จ - ไปกรอกที่หน้ารับใบเสร็จของงานสลับเลขก่อน`;
    const est = v.plateSwap.receiptEstimate;
    if (est === null || est === v.plateSwap.receiptAmount || rows[v.id]?.receiptChecked) return null;
    const diff = round2(v.plateSwap.receiptAmount - est);
    return `ใบเสร็จงานสลับเลข ${formatMoney(v.plateSwap.receiptAmount)} ไม่ตรงกับที่ระบบคำนวณ ${formatMoney(est)} (ต่าง ${diff > 0 ? "+" : ""}${formatMoney(diff)})`;
  };

  const problemOf = (v: BillingVehicle): string | null => {
    const row = rows[v.id];
    if (!row) return null;
    if (money(row.receiptText) === null) return "ไม่มียอดใบเสร็จ - กด แก้ แล้วใส่ค่าใบเสร็จ";
    const swapProblem = swapProblemOf(v);
    if (swapProblem) return swapProblem;
    const mismatch = receiptMismatchOf(v);
    if (mismatch) return `${mismatch} - กด แก้ ${receiptSaysOf(v) ? 'แล้วกด "ใช้ตามใบเสร็จ"' : "ตรวจกับใบเสร็จจริง"}`;
    if (serviceFeeOf(v) !== null) return null;
    if (row.rateId === CUSTOM_RATE) return `ไม่มีราคาที่ตรงกับรถคันนี้${v.cc === null ? " (ไม่มีข้อมูล cc)" : ""} - กด แก้ แล้วเลือกราคา`;
    return "ราคาไม่ถูกต้อง (ใบเสร็จแพงกว่าราคาเหมารวม?) - กด แก้ แล้วตรวจ";
  };
  const readyIds = (list: BillingVehicle[]) => list.filter((v) => !problemOf(v)).map((v) => v.id);
  const problemCount = vehicles.filter((v) => problemOf(v)).length;

  // คันที่เลือกใช้ราคาหลักกี่แบบ - มากกว่า 1 แบบ ใส่ขนาด/ชนิดในวงเล็บให้บรรทัดบนบิลแยกออกจากกัน
  const multipleBaseRates = new Set(selected.map((v) => rows[v.id]?.rateId).filter((id) => id && id !== CUSTOM_RATE)).size > 1;
  const labelOf = (v: BillingVehicle) => {
    const row = rows[v.id];
    if (!row || row.rateId === CUSTOM_RATE) return "";
    return autoServiceLabel(rateById.get(row.rateId), addOnsOf(row), jobLabel, multipleBaseRates);
  };

  const draftLines = selected.map((v) => ({
    vehicle: v,
    receiptAmount: money(rows[v.id].receiptText),
    serviceFee: serviceFeeOf(v),
    serviceLabel: rows[v.id].label.trim() || labelOf(v) || null,
    deduction: rows[v.id].deduct ? PLATE_REQUEST_DEDUCTION : 0,
    // ค่าใบเสร็จกรมฯ ของรถเก่าในงานสลับเลข - เก็บแยกในบรรทัดเดียวกัน (ผู้ใช้ 2026-09-28)
    plateSwapId: v.plateSwap?.id ?? null,
    swapReceiptAmount: v.plateSwap?.receiptAmount ?? null,
    // ใบเสร็จแจ้งย้ายของคันนี้ (ขั้น 2) - ใช้แสดงยอดก่อนออกบิลเท่านั้น backend อ่านจากข้อมูลรถเองตอนออกบิล (ผู้ใช้ 2026-10-08)
    transferReceiptAmount: v.transferReceiptAmount ?? null,
  }));
  // สรุปคันที่เลือกตามราคาที่ใช้ เช่น "ต่ำกว่า 300 cc + ขอใช้ = 620.00 · 3 คัน" - เห็นคันที่ราคาแปลกได้ทันที
  const priceBreakdown = [
    ...selected
      .reduce((m, v) => {
        const row = rows[v.id];
        const fee = serviceFeeOf(v);
        const rate = rateById.get(row.rateId);
        const name = row.rateId === CUSTOM_RATE ? "กำหนดเอง" : [rate?.label || "(ไม่มีชื่อ)", ...addOnsOf(row).map((a) => a.label)].join(" + ");
        const text = `${name}${row.deduct ? ` − ${PLATE_REQUEST_DEDUCTION}` : ""} = ${fee === null ? "—" : formatMoney(fee)}`;
        return m.set(text, (m.get(text) ?? 0) + 1);
      }, new Map<string, number>())
      .entries(),
  ];
  const draftItems = itemRowsToItems(itemRows);
  // งานอื่นๆ ของลูกค้ารายนี้ที่รอวางบิล + ที่ติ๊กพ่วงในบิลนี้ (ผู้ใช้ 2026-10-07) - ค่าบริการตามตารางของลูกค้า แก้ได้รายงาน
  const customerJobs = useMemo(() => otherJobs.find((c) => c.id === customer?.id)?.jobs ?? [], [otherJobs, customer?.id]);
  const jobPriceText = (j: OtherJob) => jobPrices[jobKey(j)] ?? (j.suggestedServiceFee === null ? "" : formatMoney(j.suggestedServiceFee));
  const jobPrice = (j: OtherJob) => money(jobPriceText(j));
  const selectedJobs = customerJobs.filter((j) => jobPicked.has(jobKey(j)));
  // บรรทัดที่งานจะกลายเป็นบนบิล (เหมือน backend jobItems) ไว้คิดยอดและตัวอย่างเอกสาร - server สร้างของจริงเองตอนบันทึก
  const jobDraftItems: InvoiceItem[] = selectedJobs.flatMap((j) => {
    const snap = { chassis: j.chassis, plateText: j.plateText, brand: j.brand, ownerName: j.ownerName, receiptNo: j.receiptNo, doneDate: j.doneDate, vehicleClass: j.vehicleClass, variant: j.variant, serviceLabel: j.suggestedServiceLabel };
    const target = j.plateText || j.chassis;
    const price = jobPrice(j) ?? 0;
    const out: InvoiceItem[] = [];
    if (j.fee > 0) out.push({ kind: "FEE", description: `ค่าธรรมเนียม${j.typeLabel} ${target}`, quantity: 1, unitPrice: j.fee, amount: j.fee, cost: null, sourceType: j.type, sourceId: j.id, sourceSnapshot: snap });
    if (price > 0) out.push({ kind: "SERVICE", description: `ค่าบริการ${j.typeLabel} ${target}`, quantity: 1, unitPrice: price, amount: price, cost: null, sourceType: j.type, sourceId: j.id, sourceSnapshot: snap });
    return out;
  });
  const allDraftItems = [...jobDraftItems, ...draftItems];
  // งานอื่นยึดบัญชีของลูกค้า ณ วันออกบิล (ไม่มีวันส่งงาน) - ต้องเป็นบัญชีเดียวกับรถในบิล (backend ตรวจอีกชั้นด้วยวันเดียวกัน)
  // คิวส่งแค่บัญชี ณ วันนี้ จึงเทียบได้เมื่อออกบิลวันนี้ ถ้าย้อนวันออกบิล backend เป็นคนตัดสิน
  const jobAccountMismatch = selectedJobs.length > 0 && !!customer && (issueDateIso || todayIso()) === todayIso() && customer.account !== account;
  const customerWht = customer ? effectiveWhtRate(customer.terms, issueDateIso || todayIso()) : 0;
  const totals = customer
    ? computeTotals(
        draftLines.map((l) => ({
          receiptAmount: l.receiptAmount ?? 0,
          serviceFee: l.serviceFee ?? 0,
          swapReceiptAmount: l.swapReceiptAmount,
          transferReceiptAmount: l.transferReceiptAmount,
        })),
        [],
        account === "PERSONAL" ? { ...customer.terms, vat: false } : customer.terms, // บัญชีบุคคลไม่มี VAT (เหมือน backend)
        issueDateIso || todayIso(),
        allDraftItems,
        whtOverrideOf(whtValue),
      )
    : null;

  const preview: PrintableInvoice | null =
    customer && totals && selected.length > 0
      ? {
          invoiceNo,
          account,
          issueDate: issueDateIso || todayIso(),
          customer: { name: customer.company || customer.name, branch: customer.branch, address: customer.address, taxId: customer.taxId },
          jobLabel,
          extras: [],
          vatRate: totals.vatRate,
          whtRate: totals.whtRate,
          feeTotal: totals.feeTotal,
          serviceTotal: totals.serviceTotal,
          goodsTotal: totals.goodsTotal,
          vatAmount: totals.vatAmount,
          whtAmount: totals.whtAmount,
          netTotal: totals.netTotal,
          items: allDraftItems,
          lines: draftLines.map((l) => ({
            id: l.vehicle.id,
            vehicleId: l.vehicle.id,
            chassis: l.vehicle.chassis,
            brandName: l.vehicle.brandName,
            body: l.vehicle.body,
            plateText: plateText(l.vehicle),
            receiptNo: l.vehicle.receiptNo,
            deliveredDate: l.vehicle.deliveredDate,
            receiptAmount: l.receiptAmount ?? 0,
            serviceFee: l.serviceFee ?? 0,
            serviceLabel: l.serviceLabel,
            deduction: l.deduction,
            deductionNote: l.deduction ? PLATE_REQUEST_NOTE : null,
            plateSwapId: l.plateSwapId,
            swapReceiptAmount: l.swapReceiptAmount,
            transferReceiptAmount: l.transferReceiptAmount,
          })),
        }
      : null;

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function setChecked(ids: string[], checked: boolean) {
    setRows((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, { ...prev[id], checked }])) }));
  }

  function chooseCustomer(id: string) {
    setChecked(vehicles.map((v) => v.id), false);
    setCustomerId(id);
    setItemRows([]);
    setJobPicked(new Set());
    setJobPrices({});
    setJobLabelEdit(null);
    setSettingsOpen("");
    setMessage({ text: "" });
    setWhtValue(null);
    setWhtChecked(false);
  }

  function patchCustomer(patch: Partial<BillingCustomer>) {
    if (!customer) return;
    setCustomers((prev) => prev.map((c) => (c.id === customer.id ? { ...c, ...patch } : c)));
  }

  async function handleIssue() {
    if (!customer) return;
    const fail = (text: string) => setMessage({ text, error: true });
    if (selected.length === 0) return fail("เลือกรถอย่างน้อย 1 คัน");
    if (mixedAccounts) return fail("รถที่เลือกส่งงานคนละช่วงบัญชี (บริษัท/บุคคล) - แยกออกเป็นบิลละบัญชี");
    if (!invoiceNo.trim()) return fail("ใส่เลขที่บิล");
    if (!issueDateIso) return fail("วันที่ออกบิลไม่ถูกต้อง");
    if (!jobLabel.trim()) return fail("ใส่ชื่องานที่จะแสดงบนบิล");
    for (const l of draftLines) {
      const name = plateText(l.vehicle) || l.vehicle.chassis;
      if (l.receiptAmount === null) return fail(`ใส่ค่าใบเสร็จของ ${name}`);
      if (l.serviceFee === null) {
        const row = rows[l.vehicle.id];
        if (row.rateId === CUSTOM_RATE && !row.customText.trim()) return fail(`เลือกราคาของ ${name} (ยังไม่มีราคาที่ตรงกับรถคันนี้)`);
        return fail(`ค่าดำเนินการของ ${name} ไม่ถูกต้อง - ตรวจราคาและค่าใบเสร็จ`);
      }
    }
    const itemError = itemRowsProblem(itemRows);
    if (itemError) return fail(itemError);
    if (jobAccountMismatch) return fail("งานอื่นๆ ที่เลือกอยู่คนละบัญชี (บริษัท/บุคคล) กับรถในบิลนี้ - ออกบิลงานอื่นแยกใบ");
    for (const j of selectedJobs) {
      const name = `${j.typeLabel} ${j.plateText || j.chassis}`;
      if (jobPriceText(j).trim() === "") return fail(`ใส่ค่าบริการของ ${name} (ใส่ 0 ถ้าไม่คิดค่าบริการ)`);
      if (jobPrice(j) === null) return fail(`ค่าบริการของ ${name} ต้องเป็นตัวเลข`);
      if (j.fee <= 0 && (jobPrice(j) ?? 0) <= 0) return fail(`${name} ไม่มียอดให้วางบิล`);
    }
    const whtError = whtProblem(customerWht, whtValue, whtChecked);
    if (whtError) return fail(whtError);

    setSaving(true);
    setMessage({ text: "กำลังออกบิล…" });
    try {
      const { invoice } = await billingApi.createInvoice({
        customerId: customer.id,
        invoiceNo: invoiceNo.trim(),
        issueDate: issueDateIso,
        jobLabel: jobLabel.trim(),
        lines: draftLines.map((l) => ({
          vehicleId: l.vehicle.id,
          receiptAmount: l.receiptAmount!,
          serviceFee: l.serviceFee!,
          serviceLabel: l.serviceLabel,
          deduction: l.deduction,
          deductionNote: l.deduction ? PLATE_REQUEST_NOTE : null,
          plateSwapId: l.plateSwapId,
          swapReceiptAmount: l.swapReceiptAmount,
        })),
        extras: [],
        ...(draftItems.length ? { items: draftItems } : {}),
        ...(selectedJobs.length ? { jobs: selectedJobs.map((j) => ({ type: j.type, id: j.id, serviceFee: jobPrice(j) ?? 0, serviceLabel: j.suggestedServiceLabel })) } : {}),
        whtRate: whtOverrideOf(whtValue) ?? undefined,
      });
      returnState.current = null; // ออกบิลแล้ว - ไม่ติ๊กคันเดิมซ้ำ
      setWhtValue(null);
      setWhtChecked(false);
      await loadQueue(true);
      setConfirmOpen(false);
      setShowPreview(false);
      setExpanded(null);
      setInvoiceReload((n) => n + 1);
      const jobCount = selectedJobs.length;
      setMessage({ text: `ออก ${invoice.invoiceNo} แล้ว ${invoice.lines.length} คัน${jobCount ? ` + งานอื่น ${jobCount} งาน` : ""} ยอด ${formatMoney(invoice.netTotal)} บาท` });
      printInvoice(invoice);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "ออกบิลไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const dates = [...new Set(vehicles.map((v) => v.deliveredDate))];

  return (
    <section className="content">
      <h1 tabIndex={-1}>วางบิล</h1>
      {/* สรุปงานอื่นๆ ที่รอวางบิลของทุกลูกค้า กันลืม (ผู้ใช้ 2026-10-08) */}
      {otherJobs.some((c) => c.jobs.length > 0) && (
        <Link
          href="/accounting/billing/jobs"
          style={{ display: "block", marginTop: 8, padding: "10px 14px", borderRadius: 8, background: "#fff7e6", border: "1px solid #f5d28a", color: "#7a4b00", textDecoration: "none", fontSize: 14 }}
        >
          <b>มีงานอื่นรอวางบิล {otherJobs.reduce((n, c) => n + c.jobs.length, 0)} งาน</b>
          {" ("}
          {otherJobs
            .filter((c) => c.jobs.length > 0)
            .map((c) => `${c.company || c.name} ${c.jobs.length}`)
            .join(", ")}
          {") - กดเพื่อดูและวางบิล →"}
        </Link>
      )}
      <p>
        รถที่พนักงานบันทึกส่งงานแล้วจะมารอที่นี่ เลือกคันที่จะรวมในบิล ตรวจค่าดำเนินการ แล้วออกใบวางบิลพร้อมเอกสารแนบรายคัน - คันที่วางบิลที่อื่นแล้วหรือไม่ต้องวางบิล กด
        &quot;ปิดงาน&quot; พร้อมหมายเหตุ
      </p>
      {/* ของครบแล้ว (ใบเสร็จ+เล่ม / ใบเสร็จของงานอื่น) แต่ยังไม่ลงส่งงาน - วางบิลไม่ได้จนกว่าจะลง บัญชีลงให้ได้ตรงนี้ (ผู้ใช้ 2026-10-08) */}
      <AwaitingDeliveryPanel only="all" onRecorded={() => loadQueue(false)} />
      {/* บัญชีเปิดรายงานส่งงาน/ใบส่งงานได้แบบอ่านอย่างเดียว ไว้ตรวจก่อนวางบิล (ผู้ใช้ 2026-09-27) - หน้า Delivery ไม่มีในเมนูของบัญชี */}
      <Link href="/delivery/report" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        รายงานส่งงาน / ใบส่งงาน →
      </Link>
      {/* ลูกค้าที่ยังไม่มีรถในคิวไม่โผล่ที่นี่เลย - ตั้งราคาล่วงหน้าไว้ก่อนได้ที่หน้านี้ (ผู้ใช้ 2026-09-28) */}
      <Link href="/accounting/billing/customers" className="text-button" style={{ marginTop: 8, marginLeft: 16, display: "inline-block" }}>
        ตั้งราคาล่วงหน้าให้ลูกค้า →
      </Link>
      {/* งานโอน / ยกเลิกการใช้รถ / คัดป้าย / ย้ายออก / ต่อภาษี ที่รับใบเสร็จกลับแล้ว (ผู้ใช้ 2026-10-07) */}
      <Link href="/accounting/billing/jobs" className="text-button" style={{ marginTop: 8, marginLeft: 16, display: "inline-block" }}>
        วางบิลงานอื่นๆ (โอน / ต่อภาษี / ยกเลิกใช้รถ ...) →
      </Link>
      {/* บิลที่ไม่มีรถในระบบ: งานเก่าจากระบบเดิม / ขายสินค้า (ผู้ใช้ 2026-09-29) */}
      <Link href="/accounting/billing/custom" className="text-button" style={{ marginTop: 8, marginLeft: 16, display: "inline-block" }}>
        + บิลกำหนดเอง (งานเก่า / ขายสินค้า) →
      </Link>

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : !customer ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="empty-customers">ไม่มีรถรอวางบิล (รถจะเข้าคิวเมื่อพนักงานบันทึกส่งงานในหน้า Delivery)</div>
          {message.text && (
            <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ padding: "0 23px 20px" }}>
              {message.text}
            </div>
          )}
        </section>
      ) : (
        <>
          <div className="inspect-filter" style={{ padding: "20px 0 0" }}>
            {customers.map((c) => (
              <button key={c.id} className={`filter-chip${c.id === customer.id ? " selected" : ""}`} onClick={() => chooseCustomer(c.id)}>
                {c.company || c.name} · รอวางบิล {c.vehicles.length}
                {c.account === "PERSONAL" && ` · ${ACCOUNT_LABEL.PERSONAL}`}
              </button>
            ))}
          </div>

          <section className="panel" style={{ marginTop: 16, padding: "16px 23px", overflow: "visible" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", alignItems: "center", justifyContent: "space-between", fontSize: 14 }}>
              <div>
                <b style={{ fontWeight: 600 }}>{ACCOUNT_LABEL[customer.account]}</b>
                <span className="muted" style={{ margin: "0 10px" }}>·</span>
                <b style={{ fontWeight: 600 }}>เงื่อนไขวางบิล:</b> {termsSummary(customer.account === "PERSONAL" ? { ...customer.terms, vat: false } : customer.terms, todayIso())}
                <span className="muted" style={{ marginLeft: 12 }}>
                  ตารางค่าดำเนินการ {customer.rates.length} แถว
                </span>
              </div>
              <div>
                <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "account" ? "" : "account")}>
                  บัญชีรับเงิน
                </button>
                <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "terms" ? "" : "terms")}>
                  แก้เงื่อนไข
                </button>
                <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "rates" ? "" : "rates")}>
                  แก้ตารางค่าดำเนินการ
                </button>
              </div>
            </div>
            {settingsOpen === "account" && (
              <BillingAccountEditor
                key={customer.id}
                customerId={customer.id}
                onSaved={() => loadQueue(false, customer.id)} // บัญชีรายคันคิดตามวันส่งงานฝั่ง backend
              />
            )}
            {settingsOpen === "terms" && (
              <BillingTermsEditor
                key={customer.id}
                customerId={customer.id}
                terms={customer.terms}
                onSaved={(terms) => {
                  patchCustomer({ terms });
                  setSettingsOpen("");
                }}
              />
            )}
            {settingsOpen === "rates" && (
              <BillingRatesEditor
                key={customer.id}
                customerId={customer.id}
                rates={customer.rates}
                onSaved={() => {
                  setSettingsOpen("");
                  loadQueue(false, customer.id); // ราคาที่เสนอรายคันคำนวณฝั่ง backend - โหลดคิวใหม่ให้ราคาใหม่มีผล (คันที่แก้ราคาเองแล้วคงไว้)
                }}
              />
            )}
          </section>

          {/* วางบิลแบบติ๊กอย่างเดียว (ผู้ใช้ 2026-09-28): แต่ละคันเห็นแค่ทะเบียน/เลขตัวถัง/ราคาที่ระบบคิด ไม่ต้องเลื่อนซ้ายขวา
              รายละเอียด (ค่าใบเสร็จ, แถวราคา, ค่าเพิ่ม, ข้อความบนบิล, ปิดงาน) อยู่หลังปุ่ม "แก้" ใช้เฉพาะคันที่ต้องแก้
              คันที่มีปัญหา (ไม่มีราคา/ไม่มียอดใบเสร็จ) ติ๊กไม่ได้จนกว่าจะแก้ · ออกบิลผ่านหน้ายืนยันที่สรุปราคาและยอดรวม */}
          <section className="panel" style={{ marginTop: 16, overflow: "visible" }}>
            <div className="panel-head" style={{ flexWrap: "wrap", gap: 8 }}>
              <h2>ส่งงานแล้ว รอวางบิล ({vehicles.length})</h2>
              <span className="muted" style={{ fontSize: 12 }}>
                <span style={{ display: "inline-block", width: 12, height: 12, background: "#fff6dd", border: "1px solid #f5d27a", borderRadius: 3, verticalAlign: "middle", marginRight: 4 }} />
                แถวสีเหลือง = ไม่ใช่จดปกติ (ขอใช้ / ด่วน / กำหนดเอง)
              </span>
            </div>
            {problemCount > 0 && (
              <div style={{ margin: "0 23px 12px", padding: "10px 14px", borderRadius: 10, background: "#fff4e5", color: "#8a4b00", fontSize: 13 }}>
                ⚠ ต้องตรวจ {problemCount} คัน - ติ๊กไม่ได้จนกว่าจะกด &quot;แก้&quot; แล้วใส่ข้อมูลที่ขาด (ดูเหตุผลที่แต่ละคัน)
              </div>
            )}
            {dates.map((date) => {
              const group = vehicles.filter((v) => v.deliveredDate === date);
              return (
                <div key={date}>
                  <div style={{ background: "#f5f7fb", padding: "8px 23px", fontSize: 12, color: "#576781", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <span>
                      ส่งเมื่อ <b>{isoToDisplayDate(date)}</b> · {group.length} คัน · ผู้รับ {group[0].recipient || "—"}
                    </span>
                  </div>
                  <div style={{ ...ROW_GRID, padding: "6px 23px", fontSize: 12, color: "#576781", borderTop: "1px solid #f0f2f6" }}>
                    {/* ติ๊กเลือกทั้งหมด (ผู้ใช้ 2026-09-28) - เฉพาะคันที่พร้อม คันที่ต้องตรวจไม่ถูกเลือก · ติ๊กออก = ไม่เลือกทั้งกลุ่ม */}
                    <SelectAllBox
                      checkedCount={group.filter((v) => rows[v.id]?.checked).length}
                      readyCount={readyIds(group).length}
                      onChange={(checked) => setChecked(checked ? readyIds(group) : group.map((v) => v.id), checked)}
                    />
                    <span>เลขตัวถัง</span>
                    <span>ทะเบียน</span>
                    <span>cc</span>
                    <span>น้ำหนัก (กก.)</span>
                    <span style={{ textAlign: "right" }}>ราคาใบเสร็จ</span>
                    <span style={{ textAlign: "right" }}>ค่าบริการ</span>
                    <span />
                  </div>
                  {group.map((v) => {
                    const row = rows[v.id];
                    if (!row) return null;
                    const fee = serviceFeeOf(v);
                    const receipt = money(row.receiptText);
                    const problem = problemOf(v);
                    const changed = row.rateId !== row.rateBase || !sameIds(row.addOnIds, row.addOnBase) || row.receiptText !== row.receiptBase;
                    const open = expanded === v.id;
                    const name = plateText(v) || v.chassis;
                    const notNormal = addOnsOf(row).length > 0 || row.rateId === CUSTOM_RATE || row.deduct;
                    return (
                      <div key={v.id} data-focus-row style={{ borderTop: "1px solid #f0f2f6" }}>
                        {/* หนึ่งคันหนึ่งแถว (ผู้ใช้ 2026-09-28): เลขตัวถัง · ทะเบียน · cc · ราคาใบเสร็จ · ค่าบริการ */}
                        {/* ไม่ใช่จดปกติ (มีค่าเพิ่ม ขอใช้/ด่วน, ราคากำหนดเอง, หักยอด) = แถวสีเหลือง ให้เห็นทันที (ผู้ใช้ 2026-09-28) */}
                        <div style={{ ...ROW_GRID, padding: "8px 23px", fontSize: 13, background: notNormal ? "#fff6dd" : undefined }}>
                          <input
                            type="checkbox"
                            checked={row.checked}
                            disabled={!!problem && !row.checked}
                            onChange={(e) => patchRow(v.id, { checked: e.target.checked })}
                            aria-label={`ลงบิล ${name}`}
                            style={{ width: 18, height: 18 }}
                          />
                          <span style={{ wordBreak: "break-all" }}>
                            {v.chassis}
                            {fixedIds.has(v.id) && (
                              <span style={{ marginLeft: 6, fontSize: 11, background: "#e3f5e9", color: "#1e6b3a", borderRadius: 6, padding: "1px 6px", whiteSpace: "nowrap" }}>
                                ✓ แก้ไขเรียบร้อย
                              </span>
                            )}
                          </span>
                          <span>{plateText(v) || "—"}</span>
                          <span>{v.cc === null ? "—" : v.cc}</span>
                          <span>{v.weight === null ? "—" : v.weight.toLocaleString("en-US")}</span>
                          <span style={{ textAlign: "right" }}>
                            {receipt === null ? "—" : formatMoney(receipt)}
                            {/* ใบเสร็จแจ้งย้าย (ขั้น 2) ของคันนี้ - รวมเข้าค่าธรรมเนียมของบิลตอนออกบิล (ผู้ใช้ 2026-10-08) */}
                            {v.transferReceiptAmount != null ? (
                              <span style={{ display: "block", fontSize: 11, color: "#576781" }} title="ใบเสร็จแจ้งย้าย รวมอยู่ในค่าธรรมเนียมของบิล">
                                + แจ้งย้าย {formatMoney(v.transferReceiptAmount)}
                              </span>
                            ) : v.transferNotice ? (
                              <span style={{ display: "block", fontSize: 11, color: "#bb8527" }} title="รถจดต่างจังหวัดคันนี้ไม่มีใบเสร็จแจ้งย้ายในระบบ - แนบได้ที่หน้าแจ้งย้าย/ตัดบัญชี ก่อนออกบิล">
                                ไม่มีใบเสร็จแจ้งย้าย
                              </span>
                            ) : null}
                          </span>
                          <span style={{ textAlign: "right" }}>
                            {/* ป้ายขอใช้/ด่วนอยู่หน้าตัวเลข */}
                            {addOnsOf(row).map((a) => (
                              <span key={a.id} style={{ fontSize: 11, background: "#f5b400", color: "#3d2b00", borderRadius: 6, padding: "1px 6px", marginRight: 6 }}>
                                {a.label}
                              </span>
                            ))}
                            {row.rateId === CUSTOM_RATE && !problem && (
                              <span style={{ fontSize: 11, background: "#f5b400", color: "#3d2b00", borderRadius: 6, padding: "1px 6px", marginRight: 6 }}>กำหนดเอง</span>
                            )}
                            {problem ? (
                              <span className="customer-message error" title={problem}>
                                ⚠ ต้องตรวจ
                              </span>
                            ) : (
                              <b style={{ fontWeight: 600, color: changed ? "#b43434" : undefined }} title={changed ? "แก้จากที่ระบบเลือก" : undefined}>
                                {formatMoney(fee ?? 0)}
                              </b>
                            )}
                          </span>
                          <button className="text-button" onClick={() => setExpanded(open ? null : v.id)} aria-expanded={open} aria-label={`แก้ ${name}`}>
                            {open ? "ปิด" : "แก้"}
                          </button>
                        </div>
                        {problem && !open && (
                          <div className="customer-message error" style={{ padding: "0 23px 8px 53px", fontSize: 12 }}>
                            {problem}
                          </div>
                        )}
                        {open && (
                          <div style={{ padding: "4px 23px 16px 53px", display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", fontSize: 13 }}>
                            <div className="muted" style={{ gridColumn: "1 / -1" }}>
                              {v.brandName} · {v.body || "—"}
                              {v.cc !== null ? ` · ${v.cc} cc` : " · ไม่มีข้อมูล cc"} · ใบเสร็จเลขที่ {v.receiptNo || "—"}
                            </div>
                            {/* รูปใบเสร็จจริงไว้เทียบยอด (ผู้ใช้ 2026-09-28) - กดรูปเพื่อเปิดเต็มในแท็บใหม่ */}
                            <div style={{ gridColumn: "1 / -1" }}>
                              {v.receiptImageIds.length ? (
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  {v.receiptImageIds.map((id) => (
                                    <AuthedImage
                                      key={id}
                                      src={receiptImageUrl(id)}
                                      alt={`ใบเสร็จ ${name}`}
                                      style={{ maxWidth: "100%", maxHeight: 420, objectFit: "contain", border: "1px solid #e4e9f1", borderRadius: 8, background: "#f7f8fb" }}
                                      linkTitle="เปิดรูปใบเสร็จเต็มในแท็บใหม่"
                                    />
                                  ))}
                                </div>
                              ) : (
                                <span className="muted">ยังไม่มีรูปใบเสร็จในระบบ</span>
                              )}
                            </div>
                            <label className="field">
                              ค่าใบเสร็จ
                              <input
                                type="text"
                                inputMode="decimal"
                                value={row.receiptText}
                                onChange={(e) => patchRow(v.id, { receiptText: e.target.value })}
                                style={{ textAlign: "right" }}
                                aria-label={`ค่าใบเสร็จ ${name}`}
                              />
                            </label>
                            {v.receiptEstimate !== null && receipt !== null && receipt !== v.receiptEstimate && (
                              <div
                                style={{
                                  gridColumn: "1 / -1",
                                  padding: "8px 12px",
                                  borderRadius: 8,
                                  background: row.receiptChecked ? "#eaf7ee" : "#fff4e5",
                                  color: row.receiptChecked ? "#1e6b3a" : "#8a4b00",
                                }}
                              >
                                {receiptMismatchOf(v) ?? `ใบเสร็จ ${formatMoney(receipt)} ไม่ตรงกับที่ระบบคำนวณ ${formatMoney(v.receiptEstimate)}`}
                                {(() => {
                                  const says = receiptSaysOf(v);
                                  if (!says || row.rateId === CUSTOM_RATE) return null;
                                  const applied = row.receiptChecked && sameIds(row.addOnIds, says.addOnIds);
                                  const hasAddOn = ratesFor(v, "ADD_ON").some((r) => r.kind === "OTHER_PROVINCE");
                                  return (
                                    <div style={{ marginTop: 6 }}>
                                      <b>
                                        ยอดใบเสร็จตรงกับแบบ{says.otherProvince ? "ขอใช้" : "ไม่ขอใช้"}พอดี ({formatMoney(v.receiptEstimateFlipped ?? 0)}) แต่ข้อมูลรถเป็น
                                        {v.otherProvince ? "ขอใช้" : "ไม่ขอใช้"}
                                      </b>
                                      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                                        <button
                                          type="button"
                                          className="primary"
                                          disabled={applied}
                                          onClick={() => patchRow(v.id, { addOnIds: says.addOnIds, receiptChecked: true })}
                                        >
                                          {applied ? "✓ ใช้ตามใบเสร็จแล้ว" : `ใช้ตามใบเสร็จ (${says.otherProvince ? "คิดค่าขอใช้" : "ไม่คิดค่าขอใช้"})`}
                                        </button>
                                        <span style={{ fontSize: 12 }}>
                                          {hasAddOn ? "มีผลกับค่าบริการของบิลนี้เท่านั้น ไม่แก้จังหวัดในข้อมูลรถ" : "ลูกค้านี้ไม่มีค่าเพิ่มขอใช้ในตารางราคา ค่าบริการจึงไม่เปลี่ยน"}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })()}
                                <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                                  <input type="checkbox" checked={row.receiptChecked} onChange={(e) => patchRow(v.id, { receiptChecked: e.target.checked })} />
                                  ตรวจกับใบเสร็จจริงแล้ว ยอดถูกต้อง (และติ๊ก/เอาติ๊ก &quot;ขอใช้&quot; ให้ตรงใบเสร็จแล้ว)
                                </label>
                              </div>
                            )}
                            {v.plateSwap && (
                              <div
                                style={{
                                  gridColumn: "1 / -1",
                                  padding: "8px 12px",
                                  borderRadius: 8,
                                  background: swapProblemOf(v) ? "#fff4e5" : "#eef3ff",
                                  color: swapProblemOf(v) ? "#8a4b00" : "#243b6b",
                                }}
                              >
                                <b>งานสลับเลข</b> · รถเก่า {v.plateSwap.oldChassis}
                                {v.plateSwap.oldPlateText ? ` (${v.plateSwap.oldPlateText})` : ""}
                                {v.plateSwap.receiptNo ? ` · ใบเสร็จ ${v.plateSwap.receiptNo}` : ""}
                                <div style={{ marginTop: 4 }}>
                                  {v.plateSwap.receiptAmount === null
                                    ? "ยังไม่มียอดใบเสร็จของงานสลับเลข - ต้องไปกรอกที่หน้ารับใบเสร็จของงานสลับเลขก่อนจึงจะวางบิลได้"
                                    : `คิดค่าใบเสร็จของรถเก่าเพิ่มอีก ${formatMoney(v.plateSwap.receiptAmount)} (รวมอยู่ในยอดค่าธรรมเนียมของบิล)`}
                                </div>
                                {swapProblemOf(v) && v.plateSwap.receiptAmount !== null && (
                                  <div style={{ marginTop: 4 }}>{swapProblemOf(v)}</div>
                                )}
                                {swapProblemOf(v) && v.plateSwap.receiptAmount !== null && (
                                  <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6 }}>
                                    <input type="checkbox" checked={row.receiptChecked} onChange={(e) => patchRow(v.id, { receiptChecked: e.target.checked })} />
                                    ตรวจกับใบเสร็จจริงแล้ว ยอดถูกต้อง
                                  </label>
                                )}
                              </div>
                            )}
                            <label className="field">
                              ราคา
                              <select value={row.rateId} onChange={(e) => patchRow(v.id, { rateId: e.target.value })} aria-label={`ราคา ${name}`}>
                                {ratesFor(v, "BASE").map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.label || "(ไม่มีชื่อ)"} · {formatMoney(r.amount)}
                                    {r.includesReceipt ? " รวมใบเสร็จ" : ""}
                                  </option>
                                ))}
                                <option value={CUSTOM_RATE}>กำหนดเอง…</option>
                              </select>
                            </label>
                            {row.rateId === CUSTOM_RATE ? (
                              <label className="field">
                                ค่าบริการ (กำหนดเอง)
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  value={row.customText}
                                  onChange={(e) => patchRow(v.id, { customText: e.target.value })}
                                  style={{ textAlign: "right" }}
                                  aria-label={`ค่าดำเนินการ ${name}`}
                                />
                              </label>
                            ) : (
                              ratesFor(v, "ADD_ON").length > 0 && (
                                <div style={{ display: "grid", gap: 4, alignContent: "start" }}>
                                  <span>ค่าเพิ่ม</span>
                                  {ratesFor(v, "ADD_ON").map((a) => (
                                    <label key={a.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                      <input
                                        type="checkbox"
                                        checked={row.addOnIds.includes(a.id)}
                                        onChange={(e) => patchRow(v.id, { addOnIds: e.target.checked ? [...row.addOnIds, a.id] : row.addOnIds.filter((id) => id !== a.id) })}
                                      />
                                      {a.label} +{formatMoney(a.amount)}
                                      {row.addOnBase.includes(a.id) && <span className="muted">(ตามข้อมูลรถ)</span>}
                                    </label>
                                  ))}
                                </div>
                              )
                            )}
                            <label className="field">
                              ข้อความต่อท้ายบนบิล
                              <input
                                type="text"
                                value={row.label}
                                onChange={(e) => patchRow(v.id, { label: e.target.value })}
                                placeholder={labelOf(v) || "เช่น (ขอใช้ต่างภูมิลำเนา)"}
                                aria-label={`ข้อความต่อท้ายบนบิล ${name}`}
                              />
                            </label>
                            {v.requestedPlateNumber && (
                              <label style={{ display: "flex", gap: 6, alignItems: "center", color: row.deduct ? "#b43434" : "#576781" }}>
                                <input type="checkbox" checked={row.deduct} onChange={(e) => patchRow(v.id, { deduct: e.target.checked })} />
                                {PLATE_REQUEST_NOTE} −{PLATE_REQUEST_DEDUCTION}
                              </label>
                            )}
                            {/* แก้ที่ต้นทาง (ผู้ใช้ 2026-09-28): ไปฟอร์มแก้ไขข้อมูลรถของคันนี้ (ต้องมีเหตุผล เก็บประวัติ) บันทึกแล้วเด้งกลับหน้านี้
                                พร้อมคันที่ติ๊กไว้และช่อง "แก้" ของคันนี้ ราคา/ขอใช้คิดใหม่จากข้อมูลที่แก้ ทำงานต่อได้เลย */}
                            <div style={{ gridColumn: "1 / -1", fontSize: 12 }}>
                              {canEditVehicle ? (
                                <Link
                                  href={focusHref("/registration/new-vehicle/entry", v.chassis, { edit: "1", returnTo: "/accounting/billing" })}
                                  className="text-button"
                                  onClick={() =>
                                    saveBillingReturnState({
                                      customerId: customer.id,
                                      checked: vehicles.filter((x) => rows[x.id]?.checked).map((x) => x.id),
                                      expanded: v.id,
                                    })
                                  }
                                >
                                  แก้ข้อมูลรถ (จังหวัด / cc ฯลฯ) →
                                </Link>
                              ) : (
                                <span className="muted">ข้อมูลรถผิด (เช่น จังหวัด) ให้ผู้ลงข้อมูลรถ (ADMIN / STAFF_ENTRY) แก้ที่หน้าเพิ่มข้อมูลรถจดใหม่</span>
                              )}
                              {canEditVehicle && <span className="muted"> - บันทึกแล้วกลับมาหน้านี้เอง พร้อมราคาที่คิดใหม่ คันที่ติ๊กไว้ยังอยู่</span>}
                            </div>
                            <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
                              <b style={{ fontWeight: 600 }}>ค่าบริการคันนี้ {fee === null ? "—" : formatMoney(fee)}</b>
                              {changed && (
                                <button
                                  className="text-button"
                                  onClick={() => patchRow(v.id, { rateId: row.rateBase, addOnIds: row.addOnBase, receiptText: row.receiptBase })}
                                >
                                  กลับไปใช้ค่าที่ระบบเลือก
                                </button>
                              )}
                              <button
                                className="text-button"
                                title="วางบิลที่อื่นแล้ว หรือไม่ต้องวางบิล - เอาออกจากคิวพร้อมหมายเหตุ"
                                onClick={() => setClosing(v)}
                                aria-label={`ปิดงาน วางบิลนอกระบบ ${name}`}
                              >
                                ปิดงาน (วางบิลนอกระบบ)
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {/* ยอดสรุปรวม (ผู้ใช้ 2026-09-28): รวมเฉพาะคันที่ติ๊ก ตรงคอลัมน์ราคาใบเสร็จ / ค่าบริการ */}
            <div style={{ ...ROW_GRID, padding: "12px 23px", fontSize: 13, borderTop: "2px solid #e3e8f2", background: "#f8f9fc", fontWeight: 600 }}>
              <span />
              <span>รวมที่เลือก {selected.length} คัน</span>
              <span />
              <span />
              <span />
              <span style={{ textAlign: "right" }}>{formatMoney(totals?.feeTotal ?? 0)}</span>
              <span style={{ textAlign: "right" }}>{formatMoney(round2(draftLines.reduce((s, l) => s + (l.serviceFee ?? 0), 0)))}</span>
              <span />
            </div>
            {/* ยอดสรุปเรียงลงมาทีละบรรทัด (ผู้ใช้ 2026-09-28) */}
            {totals && selected.length > 0 && (
              <div style={{ display: "grid", justifyContent: "end", padding: "12px 23px 18px", background: "#f8f9fc" }}>
                <div style={{ display: "grid", gap: 6, fontSize: 14, minWidth: 280 }}>
                  <SumLine label="ราคาใบเสร็จ" value={totals.feeTotal} />
                  <SumLine label="ค่าบริการ" value={totals.serviceTotal} />
                  {totals.goodsTotal > 0 && <SumLine label="ค่าสินค้า" value={totals.goodsTotal} />}
                  {totals.vatAmount > 0 && <SumLine label={`VAT ${totals.vatRate}%`} value={totals.vatAmount} />}
                  {totals.whtAmount > 0 && <SumLine label={`หัก ณ ที่จ่าย ${totals.whtRate}%`} value={-totals.whtAmount} />}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, borderTop: "1px solid #d9e0ec", paddingTop: 8, fontWeight: 600, fontSize: 16, color: "#2854d9" }}>
                    <span>ยอดบิล</span>
                    <span>{formatMoney(totals.netTotal)}</span>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* แถบล่างติดจอ: จำนวนที่ติ๊ก + ยอดรวม + ปุ่มออกบิล (เปิดหน้ายืนยัน) */}
          <div
            style={{
              position: "sticky",
              bottom: 0,
              zIndex: 5,
              marginTop: 16,
              background: "white",
              border: "1px solid #e3e8f2",
              borderRadius: 12,
              boxShadow: "0 -4px 16px rgba(20,40,80,0.08)",
              padding: "12px 18px",
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div style={{ fontSize: 14 }}>
              เลือก <b>{selected.length}</b> คัน
              {totals && selected.length > 0 && (
                <>
                  {" "}
                  · ยอดบิล <b>{formatMoney(totals.netTotal)}</b> บาท
                </>
              )}
              {mixedAccounts && <div className="customer-message error">รถที่เลือกอยู่คนละบัญชี (บริษัท/บุคคล) - แยกเป็นบิลละบัญชี</div>}
            </div>
            <button className="primary" disabled={selected.length === 0 || saving || refreshing} onClick={() => setConfirmOpen(true)}>
              ออกบิล {selected.length > 0 ? `${selected.length} คัน` : ""}
            </button>
          </div>
          {message.text && (
            <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ marginTop: 10 }}>
              {message.text}
            </div>
          )}

          {confirmOpen && (
            <IssueDialog onClose={() => setConfirmOpen(false)}>
              <h2>
                ยืนยันออกบิล {selected.length} คัน{selectedJobs.length ? ` + งานอื่น ${selectedJobs.length} งาน` : ""}
              </h2>
              <p className="muted" style={{ marginBottom: 12 }}>
                {customer.company || customer.name} · {ACCOUNT_LABEL[account]}
              </p>
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))" }}>
                  <label className="field">
                    {account === "PERSONAL" ? "เลขที่บิล (บัญชีบุคคล)" : "เลขที่ IV"}
                    <input
                      type="text"
                      value={invoiceNo}
                      onChange={(e) => setInvoiceNos((prev) => ({ ...prev, [account]: e.target.value }))}
                      placeholder={account === "PERSONAL" ? "เลขแรกของบัญชีบุคคล" : "IV2026-121"}
                    />
                    {/* ระบบเสนอเลขถัดไปให้ (แก้ได้ เพราะยังรันเลขร่วมกับ Google Sheet) + บอกเลขล่าสุดที่ออกในระบบ (ผู้ใช้ 2026-09-28) */}
                    <span className="muted" style={{ fontSize: 12 }}>
                      {lastInvoiceNos[account] ? `เลขล่าสุดในระบบ: ${lastInvoiceNos[account]} · ระบบใส่เลขถัดไปให้แล้ว แก้ได้` : "ยังไม่เคยออกบิลในระบบ - ใส่เลขแรกเอง แล้วใบต่อไประบบรันต่อให้"}
                      {invoiceNo.trim() && ` · เอกสารแนบเลขที่ ${invoiceNo.trim()}-A`}
                    </span>
                  </label>
                  <label className="field">
                    วันที่ออกบิล
                    <DateInput value={issueDateText} onChange={(value) => setIssueDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
                  </label>
                </div>
                <label className="field">
                  ชื่องานบนบิล
                  <input type="text" value={jobLabel} onChange={(e) => setJobLabelEdit(e.target.value)} />
                </label>
                {priceBreakdown.length > 0 && (
                  <div style={{ fontSize: 13, background: "#f5f7fb", borderRadius: 8, padding: "8px 12px" }}>
                    <b style={{ fontWeight: 600 }}>ราคาที่ใช้</b>
                    {priceBreakdown.map(([text, count]) => (
                      <div key={text} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span>{text}</span>
                        <span>{count} คัน</span>
                      </div>
                    ))}
                  </div>
                )}
                {/* งานอื่นๆ ของลูกค้ารายนี้ที่รอวางบิล พ่วงในบิลเดียวกัน (ผู้ใช้ 2026-10-07) - ค่าธรรมเนียมจากใบเสร็จของงาน ค่าบริการจากตารางของลูกค้า */}
                {customerJobs.length > 0 && (
                  <div style={{ display: "grid", gap: 6, fontSize: 13, background: "#f5f7fb", borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                      <b style={{ fontWeight: 600 }}>งานอื่นๆ ของลูกค้ารายนี้ที่รอวางบิล ({customerJobs.length} งาน) - ติ๊กเพื่อรวมในบิลนี้</b>
                      <Link href="/accounting/billing/jobs" className="text-button" style={{ fontSize: 12 }}>
                        ออกบิลงานอื่นแยกใบ / ตั้งราคา →
                      </Link>
                    </div>
                    {jobAccountMismatch && <div className="customer-message error">งานอื่นอยู่บัญชี{ACCOUNT_LABEL[customer.account]} ณ วันนี้ แต่รถในบิลอยู่{ACCOUNT_LABEL[account]} - ออกบิลงานอื่นแยกใบ</div>}
                    {customerJobs.map((j) => {
                      const key = jobKey(j);
                      const picked = jobPicked.has(key);
                      return (
                        <label key={key} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 8, alignItems: "center" }}>
                          <input
                            type="checkbox"
                            checked={picked}
                            onChange={(e) =>
                              setJobPicked((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(key);
                                else next.delete(key);
                                return next;
                              })
                            }
                          />
                          <span>
                            {j.typeLabel} · {j.plateText || j.chassis}
                            <span className="muted"> · {isoToDisplayDate(j.doneDate)}{j.ownerName ? ` · ${j.ownerName}` : ""}</span>
                            {j.warnings.map((w) => (
                              <div key={w} style={{ fontSize: 12, color: "#bb8527" }}>
                                ⚠ {w}
                              </div>
                            ))}
                          </span>
                          <span style={{ whiteSpace: "nowrap" }}>ค่าธรรมเนียม {formatMoney(j.fee)}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                            ค่าบริการ
                            <input
                              type="text"
                              inputMode="decimal"
                              value={jobPriceText(j)}
                              placeholder="ใส่ราคา"
                              disabled={!picked}
                              onChange={(e) => setJobPrices((prev) => ({ ...prev, [key]: e.target.value }))}
                              style={{ width: 90, textAlign: "right", height: 32, padding: "0 8px" }}
                              aria-label={`ค่าบริการ ${j.typeLabel} ${j.plateText || j.chassis}`}
                            />
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <InvoiceItemsEditor rows={itemRows} onChange={setItemRows} addLabel="+ เพิ่มบรรทัดอื่นในบิลนี้ (งานเก่า / ขายสินค้า / ค่าใช้จ่ายอื่น)" />
                <WhtRatePicker defaultRate={customerWht} value={whtValue} onChange={setWhtValue} checked={whtChecked} onCheckedChange={setWhtChecked} />
                {totals && (
                  <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
                    <SumLine label="ค่าธรรมเนียม (ตามใบเสร็จ)" value={totals.feeTotal} />
                    <SumLine label="ค่าบริการ" value={totals.serviceTotal} />
                    {totals.goodsTotal > 0 && <SumLine label="ค่าสินค้า" value={totals.goodsTotal} />}
                    <SumLine label={totals.vatRate ? `VAT ${totals.vatRate}%` : "VAT (ไม่มี)"} value={totals.vatAmount} />
                    <SumLine label={totals.whtRate ? `หัก ณ ที่จ่าย ${totals.whtRate}%` : "หัก ณ ที่จ่าย (ไม่มี)"} value={-totals.whtAmount} />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", background: "#edf2ff", color: "#2854d9", borderRadius: 10, padding: "12px 14px", fontWeight: 600 }}>
                      <span>จำนวนเงินทั้งสิ้น</span>
                      <span style={{ fontSize: 22 }}>{formatMoney(totals.netTotal)}</span>
                    </div>
                  </div>
                )}
                <button className="text-button" style={{ justifySelf: "start" }} onClick={() => setShowPreview((s) => !s)}>
                  {showPreview ? "ซ่อนตัวอย่างเอกสาร" : "ดูตัวอย่างเอกสาร"}
                </button>
                {showPreview && preview && (
                  <iframe title="ตัวอย่างใบวางบิล" srcDoc={buildInvoiceHtml(preview)} style={{ width: "100%", height: 560, border: "1px solid #f0f2f6", background: "white" }} />
                )}
                {message.text && message.error && (
                  <div className="customer-message error" role="alert">
                    {message.text}
                  </div>
                )}
                <div className="form-actions" style={{ marginTop: 0 }}>
                  <button type="button" onClick={() => setConfirmOpen(false)} disabled={saving}>
                    กลับไปแก้
                  </button>
                  <button type="button" className="primary" onClick={handleIssue} disabled={saving || refreshing}>
                    {saving ? "กำลังออกบิล…" : "ยืนยันออกบิลและพิมพ์"}
                  </button>
                </div>
              </div>
            </IssueDialog>
          )}
        </>
      )}

      {/* รับเงินแล้วไม่กระทบคิว - ยกเลิกบิล / เอารถออกจากบิลตอนแก้ รถกลับเข้าคิว จึงโหลดคิวใหม่แบบเก็บงานที่เตรียมไว้ */}
      <BillingInvoiceList reloadKey={invoiceReload} onQueueChanged={() => loadQueue(false, customer?.id)} />

      <ClosedBillingPanel reloadKey={closedReload} canReopen={isAdmin} onReopened={() => loadQueue(false, customer?.id)} />

      {closing && (
        <CloseBillingDialog
          vehicle={closing}
          customerName={customer ? customer.company || customer.name : ""}
          onClose={() => setClosing(null)}
          onClosed={(v) => {
            setMessage({ text: `ปิดงาน ${v.plateText || v.chassis} แล้ว - ออกจากคิวรอวางบิล (ดูได้ที่ "ปิดงานแล้ว - วางบิลนอกระบบ" ด้านล่าง)` });
            setClosedReload((n) => n + 1);
            loadQueue(false, customer?.id);
          }}
          onRefused={() => loadQueue(false, customer?.id)}
        />
      )}
    </section>
  );
}

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return ref;
}

// งานที่เตรียมไว้ก่อนไปแก้ข้อมูลรถ (ลูกค้า / คันที่ติ๊ก / คันที่เปิด "แก้") - sessionStorage ของแท็บนี้ อ่านครั้งเดียวตอนกลับมา
// เก็บไม่ได้ (private mode ฯลฯ) = กลับมาแล้วติ๊กใหม่เอง หน้ายังทำงานปกติ
interface BillingReturnState {
  customerId: string;
  checked: string[];
  expanded: string | null;
}
const RETURN_KEY = "billing-return-v1";

function saveBillingReturnState(state: BillingReturnState) {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(state));
  } catch {
    /* ไม่เป็นไร */
  }
}

function takeBillingReturnState(): BillingReturnState | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    const s = raw ? (JSON.parse(raw) as BillingReturnState) : null;
    return s && typeof s.customerId === "string" && Array.isArray(s.checked) ? s : null;
  } catch {
    return null;
  }
}

// ช่องติ๊กเลือกทั้งหมดบนหัวคอลัมน์: ติ๊กครบทุกคันที่พร้อม = ติ๊ก, บางคัน = ขีด (indeterminate)
function SelectAllBox({ checkedCount, readyCount, onChange }: { checkedCount: number; readyCount: number; onChange: (checked: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const all = readyCount > 0 && checkedCount >= readyCount;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checkedCount > 0 && !all;
  }, [checkedCount, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      disabled={readyCount === 0 && checkedCount === 0}
      onChange={() => onChange(!all)} // บางคัน -> เลือกทั้งหมด, ครบแล้ว -> ไม่เลือกเลย
      aria-label="เลือกทั้งหมด"
      title="เลือกทั้งหมด"
      style={{ width: 18, height: 18 }}
    />
  );
}

// หน้ายืนยันออกบิล (ผู้ใช้ 2026-09-28: วางบิลแบบติ๊กอย่างเดียว) - เนื้อหาอยู่ใน BillingPage เพราะใช้ state ของหน้าเดียวกัน
function IssueDialog({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useModal();
  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(640px, 94vw)", maxHeight: "92vh", overflowY: "auto" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      {children}
    </dialog>
  );
}

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
// backend ปฏิเสธ (มีคนปิด/ออกบิล/เปิดกลับไปก่อน) = รายการบนจอเก่าแล้ว ให้หน้าหลักโหลดใหม่
const refusedByServer = (err: unknown) => err instanceof ApiError && err.status !== undefined;

// ปิดงาน - วางบิลนอกระบบ (ผู้ใช้ 2026-09-27): รถที่ส่งงานแล้วแต่วางบิลที่อื่น (บัญชีส่วนตัว / Google Sheet / เหมาจ่าย)
// หรือไม่ต้องวางบิล - หมายเหตุบังคับ ออกจากคิวรอวางบิล ยอดส่งงานแล้วยังไม่วางบิลในภาพรวม และสถานะรอ "วางบิล" ในหน้าค้นหารถ
// เปิดกลับได้เฉพาะ ADMIN พร้อมเหตุผล - ทุกครั้งเก็บในประวัติการแก้ไขของรถ
function CloseBillingDialog({
  vehicle,
  customerName,
  onClose,
  onClosed,
  onRefused,
}: {
  vehicle: BillingVehicle;
  customerName: string;
  onClose: () => void;
  onClosed: (vehicle: ClosedBillingVehicle) => void;
  onRefused: () => void;
}) {
  const dialogRef = useModal();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setError("");
    if (!note.trim()) return setError("ต้องใส่หมายเหตุ เช่น วางบิลที่ไหน เลขที่อะไร");
    setSaving(true);
    try {
      const { vehicle: closed } = await billingApi.closeVehicleBilling(vehicle.id, note.trim());
      onClosed(closed);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "ปิดงานไม่สำเร็จ"));
      if (refusedByServer(err)) onRefused();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ปิดงาน - วางบิลนอกระบบ</h2>
      <p className="muted">
        {plateText(vehicle) || "ยังไม่มีทะเบียน"} · {vehicle.chassis} · {vehicle.brandName}
        <br />
        {customerName} · ส่งงานเมื่อ {isoToDisplayDate(vehicle.deliveredDate)}
      </p>
      <p style={{ fontSize: 13, marginTop: 8 }}>
        ใช้กับรถที่วางบิลที่อื่นแล้ว (บัญชีส่วนตัว / Google Sheet / เหมาจ่าย) หรือไม่ต้องวางบิล - รถจะออกจากคิวรอวางบิล และไม่นับเป็นยอดส่งงานแล้วยังไม่วางบิล
        เปิดงานกลับได้เฉพาะ ADMIN
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        หมายเหตุ *
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น วางบิลใน Google Sheet IV2026-130" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "ปิดงาน"}
        </button>
      </div>
    </dialog>
  );
}

// รายการรถที่ปิดงานไว้ ใหม่สุดก่อนทีละ 100 คัน - ไม่มีเลยไม่แสดง / ADMIN กด "เปิดงานกลับ" พร้อมเหตุผล แล้วรถกลับเข้าคิวรอวางบิล
function ClosedBillingPanel({ reloadKey, canReopen, onReopened }: { reloadKey: number; canReopen: boolean; onReopened: () => void }) {
  const [vehicles, setVehicles] = useState<ClosedBillingVehicle[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reopening, setReopening] = useState<ClosedBillingVehicle | null>(null);
  const [notice, setNotice] = useState("");

  async function reload() {
    try {
      const next = await billingApi.closedVehicles(0);
      setVehicles(next.vehicles);
      setHasMore(next.hasMore);
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดรายการรถที่ปิดงานไม่สำเร็จ"));
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount / on reloadKey change; state is only set after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reloadKey]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await billingApi.closedVehicles(vehicles?.length ?? 0);
      setVehicles((prev) => {
        const known = new Set((prev ?? []).map((v) => v.id));
        return [...(prev ?? []), ...next.vehicles.filter((v) => !known.has(v.id))];
      });
      setHasMore(next.hasMore);
    } catch (err) {
      setError(errorText(err, "โหลดรายการรถที่ปิดงานไม่สำเร็จ"));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!error && (!vehicles || vehicles.length === 0) && !notice) return null;
  const list = vehicles ?? [];

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>
          ปิดงานแล้ว - วางบิลนอกระบบ ({list.length}
          {hasMore ? "+" : ""})
        </h2>
        <button className="text-button" onClick={() => setExpanded((x) => !x)}>
          {expanded ? "ซ่อน" : "แสดงรายการ"}
        </button>
      </div>
      {error && (
        <div className="customer-message error" role="alert" style={{ padding: "0 23px 12px" }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="customer-message success" role="status" style={{ padding: "0 23px 12px" }}>
          {notice}
        </div>
      )}
      {expanded && list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ปิดเมื่อ</th>
                <th>ลูกค้า</th>
                <th>ทะเบียน</th>
                <th>เลขตัวถัง</th>
                <th>ส่งงานเมื่อ</th>
                <th>หมายเหตุ</th>
                <th>ผู้ปิด</th>
                {canReopen && <th></th>}
              </tr>
            </thead>
            <tbody>
              {list.map((v) => (
                <tr key={v.id}>
                  <td>{timestampToDisplayDate(v.closedAt)}</td>
                  <td>{v.customerName}</td>
                  <td>{v.plateText || "—"}</td>
                  <td>
                    {v.chassis}
                    <div className="muted">{v.brandName}</div>
                  </td>
                  <td>{v.deliveredDate ? isoToDisplayDate(v.deliveredDate) : "—"}</td>
                  <td>{v.note || "—"}</td>
                  <td>{v.closedBy || "—"}</td>
                  {canReopen && (
                    <td>
                      <button className="text-button" onClick={() => setReopening(v)}>
                        เปิดงานกลับ
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {expanded && hasMore && (
        <div className="inspect-pagination">
          <button className="text-button" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "กำลังโหลด..." : "โหลดเพิ่มอีก 100 คัน"}
          </button>
        </div>
      )}
      {reopening && (
        <ReopenBillingDialog
          vehicle={reopening}
          onClose={() => setReopening(null)}
          onReopened={() => {
            setNotice(`เปิดงาน ${reopening.plateText || reopening.chassis} กลับแล้ว - รถกลับเข้าคิวรอวางบิล`);
            reload();
            onReopened();
          }}
          onRefused={reload}
        />
      )}
    </section>
  );
}

function ReopenBillingDialog({
  vehicle,
  onClose,
  onReopened,
  onRefused,
}: {
  vehicle: ClosedBillingVehicle;
  onClose: () => void;
  onReopened: () => void;
  onRefused: () => void;
}) {
  const dialogRef = useModal();
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setError("");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่เปิดงานกลับ");
    setSaving(true);
    try {
      await billingApi.reopenVehicleBilling(vehicle.id, remark.trim());
      onReopened();
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "เปิดงานกลับไม่สำเร็จ"));
      if (refusedByServer(err)) onRefused();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>เปิดงานกลับ</h2>
      <p className="muted">
        {vehicle.plateText || "ยังไม่มีทะเบียน"} · {vehicle.chassis} · {vehicle.customerName}
        <br />
        ปิดไว้เมื่อ {timestampToDisplayDate(vehicle.closedAt)}: {vehicle.note || "—"}
      </p>
      <p style={{ fontSize: 13, marginTop: 8 }}>รถจะกลับเข้าคิวรอวางบิล และนับเป็นยอดส่งงานแล้วยังไม่วางบิลอีกครั้ง</p>
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่เปิดงานกลับ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ปิดผิดคัน ต้องวางบิลในระบบ" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "เปิดงานกลับ"}
        </button>
      </div>
    </dialog>
  );
}

function SumLine({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: value < 0 ? "#b43434" : undefined }}>
      <span style={{ color: value < 0 ? undefined : "#576781" }}>{label}</span>
      <span>{formatMoney(value || 0)}</span>
    </div>
  );
}
