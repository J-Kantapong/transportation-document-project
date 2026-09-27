"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, type DocumentSubmission, type ReceivedAttachResult, type ReceivedDetachResult, api } from "@/lib/api";
import { slipNoText } from "@/lib/billing-api";
import { AuthedImage } from "@/components/AuthedImage";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";
import { customerDisplayNames, jobSheetGroup, jobSheetKey } from "@/lib/job-sheet";
import { focusChassis, focusHref, sameChassis } from "@/lib/vehicle-focus";
import { printReceivingList } from "@/lib/receiving-print";
import { comparePlate } from "@/lib/plate-order";

// หน้าคิวของขั้นตอนหลังได้รับใบเสร็จ (รับป้ายทะเบียน / รับเล่มทะเบียน) - ใช้โครงเดียวกัน:
// แนบรูปหลักฐานทีละคันพร้อมวันที่รับ รายการที่ทำแล้วย้ายไปตารางด้านล่าง (แก้วันที่/ถอดรูปได้ก่อนส่งของให้ลูกค้า)
// (หน้ารับใบเสร็จแยกไปเป็น ReceiptCheckPage - ตรวจทั้งใบยื่นพร้อมรูปใบเสร็จ, Delivery แยกไปเป็น DeliveryPage)
export interface QueueRow {
  id: string;
  date: string; // ISO - วันที่รับงาน
  // กุญแจใบยื่น + ตัวกรองเจ้าของงาน (ผู้ใช้ 2026-09-27: รหัสลูกค้าทุกหน้า) - ชื่อ/บริษัท/สาขาใช้แสดงเท่านั้น
  customerId: string;
  customerName: string;
  customerCompany?: string | null;
  customerBranch?: string | null;
  chassis: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  receiptNo?: string | null; // เลขที่ใบเสร็จ - แสดงเมื่อ showReceiptNo (รับป้ายทะเบียน)
  photoUrl?: string | null; // รูปหลักฐาน (รูปป้าย/รูปเล่ม) ที่ใช้ยืนยัน - แสดงเมื่อส่ง photoColumnLabel
  doneDate: string | null; // ISO
  submitDate?: string | null; // วันที่ยื่นของใบยื่นล่าสุด - ใช้จัดกลุ่มเมื่อ groupBySheet
  receiptDate?: string | null; // วันที่ในใบเสร็จ - วันที่รับต้องไม่ก่อนวันนี้ (ไม่มี = วันที่ยื่น)
  urgent?: boolean;
  submittedAt?: string | null; // เวลาที่บันทึกยื่น - ลำดับเริ่มต้นเมื่อ groupBySheet
  itemDeliveredDate?: string | null; // ส่งของชิ้นนี้ให้ลูกค้าแล้ว - แก้วันที่รับ/ถอดรูปไม่ได้
  // รับป้าย: ส่งเล่มให้ลูกค้าไปก่อนแล้ว - ถ้าป้ายไปพร้อมเล่ม (แนบรูปช้า) วันที่รับป้ายต้องไม่หลังวันนี้ (พบ 2026-09-27)
  bookDeliveredDate?: string | null;
}

interface Props {
  title: string;
  dateColumnLabel: string;
  doneLabel: string; // เช่น "รับป้ายแล้ว"
  doneDateLabel: string; // เช่น "วันที่รับป้าย"
  showReceiptNo?: boolean;
  photoColumnLabel?: string; // ตาราง "ดำเนินการแล้ว" แสดงรูปหลักฐาน (รับป้าย: "รูปป้าย" / รับเล่ม: "รูปเล่ม")
  emptyText: string;
  loadPending: () => Promise<QueueRow[]>;
  // ตาราง "ดำเนินการแล้ว" ทีละหน้า (100 คัน ล่าสุดที่แนบก่อน) - q = ค้นเลขตัวถัง/ทะเบียน/ลูกค้า/เลขที่ใบเสร็จ
  // limit = โหลดใหม่ด้วยจำนวนที่เปิดอยู่ (ไม่ส่ง = 100)
  loadCompleted: (options: { q: string; offset: number; limit?: number }) => Promise<{ rows: QueueRow[]; hasMore: boolean }>;
  headerSlot?: ReactNode; // แสดงใต้หัวข้อ
  reloadSignal?: number; // เปลี่ยนค่า = โหลดคิวใหม่ (หลังยืนยันจากส่วนอื่นของหน้า)
  back?: { href: string; label: string }; // ลิงก์ย้อนกลับด้านบน - ไม่ส่ง = กลับไปเมนูจดทะเบียนรถใหม่
  // แนบรูปหลักฐานทีละคันแล้วบันทึกรับทันที (รับป้าย/รับเล่ม ผู้ใช้ 2026-09-26 - แทน AI จับคู่รูป) - ใช้วันที่ในแถวนั้น
  // ไม่ส่ง = ดูได้อย่างเดียว (ACCOUNTANT / รถนอกขอบเขตการแก้ของผู้ใช้ - พบ 2026-09-27)
  attachPhoto?: { label: string; upload: (id: string, file: File, date: string) => Promise<ReceivedAttachResult> };
  // แก้วันที่รับ / ถอดรูปที่แนบผิดในตาราง "ดำเนินการแล้ว" (ผู้ใช้ 2026-09-27) - ก่อนส่งของให้ลูกค้าเท่านั้น, ต้องมีเหตุผล
  fixReceived?: {
    itemLabel: string; // "ป้าย" / "เล่ม"
    updateDate: (id: string, date: string, remark: string) => Promise<{ date: string }>;
    detach: (id: string, remark: string) => Promise<Pick<ReceivedDetachResult, "photo">>;
  };
  // จัดคิวรอดำเนินการตามวันที่ยื่นและใบยื่น (ผู้ใช้ 2026-09-26: รับป้าย/รับเล่ม) - ซ่อนคอลัมน์วันที่รับงาน/ลูกค้า เพราะอยู่ในหัวกลุ่มแล้ว
  groupBySheet?: boolean;
  // มีค่า = แสดงแถบกรอง (วันที่ยื่น / เลขที่ใบเสร็จ) และปุ่มปริ้นรายการที่กรองแล้ว เรียงตามหมวด+เลขทะเบียน ไว้ยื่นขนส่ง
  printTitle?: string;
}

interface RowState {
  dateText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

const newRowState = (): RowState => ({
  dateText: isoToDisplayDate(todayIso()),
  saving: false,
  message: { text: "" },
});

const errorText = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);

// ตรวจวันที่รับแบบเดียวกับ backend (receiving/received-date.ts) ก่อนอัปโหลด: ไม่ก่อนวันที่ในใบเสร็จ (ไม่มี = วันที่ยื่น)
// และไม่เกินวันนี้ (พบ 2026-09-27: เดิมพิมพ์ปีผิด/วันในอนาคตก็บันทึกได้) - คืน "" = ใช้ได้
function receivedDateError(label: string, iso: string, r: QueueRow): string {
  const earliest = r.receiptDate || r.submitDate || "";
  if (earliest && iso < earliest) {
    return `${label}ต้องไม่ก่อน${r.receiptDate ? "วันที่ในใบเสร็จ" : "วันที่ยื่นเอกสาร"} (${isoToDisplayDate(earliest)})`;
  }
  if (iso > todayIso()) return `${label}ต้องไม่เกินวันนี้`;
  return "";
}

// จัดคิวตามวันที่ยื่น (เก่าสุดก่อน) แล้วแยกเป็นใบยื่น = กลุ่ม (รย.1 ธรรมดา/ด่วน ...) + เจ้าของงาน ตรงกับใบส่งงานที่ปริ้น
// ลำดับรถในแต่ละใบคงตามที่ loadPending เรียงมา (รับป้าย: หมวด+เลขทะเบียน)
// เจ้าของงาน = รหัสลูกค้า ไม่ใช่ชื่อ (ผู้ใช้ 2026-09-27 - ลูกค้าชื่อซ้ำกันเคยถูกรวมเป็นใบเดียว แต่หน้า Delivery แยก)
const sheetKeyOf = (r: QueueRow) => jobSheetKey(r.submitDate ?? "", jobSheetGroup(r.body, r.urgent ?? false).label, r.customerId);

// ยอดของทั้งใบยื่น (ทุกคันที่ยื่นไปในใบนั้น ไม่ใช่แค่คันที่อยู่ในคิวนี้) - ใช้บอก "ยื่นกี่คัน" และเตือนใบที่ยังไม่ครบ
interface SheetStats {
  submitted: number;
  receiptReceived: number; // ได้ใบเสร็จแล้ว = อยู่ในคิวนี้หรือทำขั้นนี้เสร็จแล้ว
  waitingReceipt: number; // ยังไม่ได้ใบเสร็จ (PENDING) - ยังมาไม่ถึงขั้นนี้
  failed: number; // ยื่นไม่สำเร็จ
}

function sheetStatsOf(submissions: DocumentSubmission[]): Record<string, SheetStats> {
  // นับรถแต่ละคันครั้งเดียวต่อใบ จากแถวยื่นล่าสุด (พบ 2026-09-27: ยื่นไม่สำเร็จแล้วยื่นใหม่ในใบเดียวกัน เดิมนับเป็น 2 คัน
  // และใบค้างเตือน "ยื่นไม่สำเร็จ" ทั้งที่รถยื่นใหม่ไปแล้ว)
  const latest = new Map<string, { key: string; s: DocumentSubmission }>();
  for (const s of submissions) {
    const key = jobSheetKey(s.submitDate.slice(0, 10), jobSheetGroup(s.vehicle.body, s.urgent).label, s.vehicle.customer.id);
    const id = `${key}|${s.vehicleId}`;
    const prev = latest.get(id);
    if (!prev || s.createdAt > prev.s.createdAt) latest.set(id, { key, s });
  }
  const stats: Record<string, SheetStats> = {};
  for (const { key, s } of latest.values()) {
    const st = (stats[key] ??= { submitted: 0, receiptReceived: 0, waitingReceipt: 0, failed: 0 });
    st.submitted++;
    if (s.status === "RECEIPT_RECEIVED") st.receiptReceived++;
    else if (s.status === "FAILED") st.failed++;
    else st.waitingReceipt++;
  }
  return stats;
}

// ownerNames = ชื่อเจ้าของงานที่แสดงตามรหัสลูกค้า (customerDisplayNames - ชื่อซ้ำต่อบริษัท/สาขา)
function groupByDateAndSheet(list: QueueRow[], ownerNames: Map<string, string>) {
  const days = new Map<string, Map<string, { key: string; label: string; owner: string; rows: QueueRow[] }>>();
  for (const r of list) {
    const date = r.submitDate ?? "";
    const { label } = jobSheetGroup(r.body, r.urgent ?? false);
    const key = sheetKeyOf(r);
    if (!days.has(date)) days.set(date, new Map());
    const sheets = days.get(date)!;
    if (!sheets.has(key)) sheets.set(key, { key, label, owner: ownerNames.get(r.customerId) ?? r.customerName, rows: [] });
    sheets.get(key)!.rows.push(r);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a || "9999").localeCompare(b || "9999"))
    .map(([date, sheets]) => {
      const list = [...sheets.values()].sort((a, b) => a.label.localeCompare(b.label, "th") || a.owner.localeCompare(b.owner, "th"));
      return { date, sheets: list, count: list.reduce((n, s) => n + s.rows.length, 0) };
    });
}

const plateText = (r: QueueRow) => (r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—");

// รถที่แนบรูปป้ายแล้วแต่ส่งเล่มให้ลูกค้าไปก่อนแล้ว (ผู้ใช้ 2026-09-27) - ป้ายไปพร้อมเล่มจริงแต่แนบรูปช้า = ติ๊ก
// "ป้ายไปพร้อมเล่มแล้ว" ในใบส่งเล่มเดิมที่หน้ารายงานส่งงาน, ยังไม่ได้ส่ง = ส่งป้ายอย่างเดียวที่หน้า Delivery
// (พบ 2026-09-27: เดิมบอกแค่หน้า Delivery พนักงานจึงออกใบส่งป้ายซ้ำทั้งที่ป้ายไปกับเล่มแล้ว)
interface DeliveryReminder {
  id: string;
  chassis: string;
  customerName: string;
  receivedDate: string; // วันที่รับป้ายที่บันทึก (ISO) - ต้องไม่หลังวันที่ส่งเล่มถ้าป้ายไปพร้อมเล่ม
  bookDeliveredDate: string | null;
  bookSlipNo: number | null;
  row: QueueRow; // เปิดหน้าต่างแก้วันที่รับจากข้อความนี้ได้เลย
}

const DELIVERY_PAGE = "/registration/new-vehicle/delivery";
const DELIVERY_REPORT_PAGE = "/registration/new-vehicle/delivery/report";
const COMPLETED_PAGE_SIZE = 100; // ตรงกับ backend (receiving.service.ts)
const COMPLETED_MAX_LIMIT = 1000;

export function ReceivingQueuePage({
  title,
  dateColumnLabel,
  doneLabel,
  doneDateLabel,
  showReceiptNo,
  photoColumnLabel,
  emptyText,
  loadPending,
  loadCompleted,
  headerSlot,
  reloadSignal,
  back = { href: "/registration/new-vehicle", label: "← จดทะเบียนรถใหม่" },
  attachPhoto,
  fixReceived,
  groupBySheet,
  printTitle,
}: Props) {
  const [pending, setPending] = useState<QueueRow[]>([]);
  // คิวล่าสุดที่ตั้งไว้ (ไม่รอ render) - แนบหลายแถวติดกันแล้วเอาแถวออกจากคิวต่อจากรายการล่าสุดเสมอ
  const pendingRef = useRef<QueueRow[]>([]);
  const [completed, setCompleted] = useState<QueueRow[]>([]);
  const [completedHasMore, setCompletedHasMore] = useState(false);
  const [completedLoading, setCompletedLoading] = useState(true);
  const [completedError, setCompletedError] = useState("");
  const [completedQuery, setCompletedQuery] = useState("");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // ผลการบันทึกล่าสุด (แถวที่แนบแล้วหายไปจากคิว จึงบอกที่แถบล่างแทน) + รถที่ต้องไปบันทึกส่งป้ายที่หน้า Delivery
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [deliveryReminders, setDeliveryReminders] = useState<DeliveryReminder[]>([]);
  const [lastSavedId, setLastSavedId] = useState("");
  const [fixing, setFixing] = useState<{ row: QueueRow; mode: "date" | "detach" } | null>(null);
  // คำขอโหลดล่าสุด - คำตอบของคำขอเก่าที่มาถึงทีหลังต้องไม่ทับข้อมูลใหม่ (แนบหลายแถวติดกัน)
  const pendingSeq = useRef(0);
  const completedSeq = useRef(0);
  const focusApplied = useRef(false);
  const queryTouched = useRef(false);
  // คำค้นล่าสุดที่พิมพ์ - โหลดใหม่หลังอัปโหลดรูปเสร็จต้องใช้คำค้นตอนนี้ ไม่ใช่คำค้นตอนเริ่มอัปโหลด
  // (พบ 2026-09-27: พิมพ์ค้นระหว่างอัปโหลดแล้วผลของคำเก่ามาทับ ตารางไม่ตรงกับช่องค้น)
  const completedQueryRef = useRef("");
  // คำค้น + จำนวนคันของรายการที่แสดงอยู่ - "โหลดเพิ่ม" ต่อจากรายการนี้ และโหลดใหม่ด้วยจำนวนเดิม
  const shownCompleted = useRef({ q: "", count: 0 });
  // groupBySheet: การ์ดใบยื่นพับไว้ก่อน (ผู้ใช้ 2026-09-26 - คิวยาวเกะกะ) กดการ์ดเพื่อกางตารางรถของใบนั้น
  const [openSheets, setOpenSheets] = useState<Set<string>>(new Set());
  const [sheetStats, setSheetStats] = useState<Record<string, SheetStats>>({});
  // กรองคิว (ผู้ใช้ 2026-09-26): วันที่ยื่น ตั้งแต่-ถึง (วว/ดด/ปปปป) + เลขที่ใบเสร็จ (มีคำที่พิมพ์อยู่ในเลขที่)
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [receiptQuery, setReceiptQuery] = useState("");
  const [chassisQuery, setChassisQuery] = useState("");
  const [plateQuery, setPlateQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState(""); // เจ้าของงาน = รหัสลูกค้า - "" = ทุกราย
  const [sortMode, setSortMode] = useState<"submit" | "plate">("submit");
  // ใบยื่น (ชุดงาน) ที่ติ๊กไว้จะปริ้น - key = sheetKeyOf(...)
  const [selectedSheets, setSelectedSheets] = useState<Set<string>>(new Set());
  const toggle = (set: (fn: (prev: Set<string>) => Set<string>) => void, key: string) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ตาราง "ดำเนินการแล้ว": offset 0 = โหลดหน้าแรกใหม่, มากกว่านั้น = "โหลดเพิ่ม" ต่อท้าย
  // โหลดใหม่ด้วยคำค้นเดิม = คงจำนวนที่เปิดอยู่ (กด "โหลดเพิ่ม" ไว้แล้ว แนบ/แก้แล้วไม่หดกลับเหลือ 100 - พบ 2026-09-27)
  async function loadCompletedPage(offset: number, q: string = completedQueryRef.current) {
    const seq = ++completedSeq.current;
    const keep = offset === 0 && q === shownCompleted.current.q ? shownCompleted.current.count : 0;
    const limit = keep > COMPLETED_PAGE_SIZE ? Math.min(keep, COMPLETED_MAX_LIMIT) : undefined;
    setCompletedLoading(true);
    try {
      const res = await loadCompleted({ q, offset, limit });
      if (seq !== completedSeq.current) return;
      setCompleted((prev) => (offset === 0 ? res.rows : [...prev, ...res.rows.filter((r) => !prev.some((p) => p.id === r.id))]));
      shownCompleted.current = { q, count: offset + res.rows.length };
      setCompletedHasMore(res.hasMore);
      setCompletedError("");
    } catch (err) {
      if (seq === completedSeq.current) setCompletedError(errorText(err, "โหลดรายการที่ดำเนินการแล้วไม่สำเร็จ"));
    } finally {
      if (seq === completedSeq.current) setCompletedLoading(false);
    }
  }

  // ตั้งคิวใหม่ทุกครั้งผ่านตรงนี้: ลูกค้าที่เลือกกรองไว้ไม่เหลือรถในคิวแล้ว (แนบคันสุดท้ายไปแล้ว) = ล้างตัวกรองเป็นทุกราย
  // ที่ state เลย ไม่ใช่แค่ซ่อนตอนแสดง (พบ 2026-09-27: ตัวกรองที่ค้างอยู่กลับมากรองเองเงียบๆ เมื่อโหลดใหม่แล้วมีรถของลูกค้านั้นเข้าคิวอีก
  // ทั้งที่ช่องเจ้าของงานขึ้นทุกราย)
  function showPending(next: QueueRow[]) {
    pendingRef.current = next;
    setPending(next);
    setOwnerFilter((prev) => (prev && !next.some((r) => r.customerId === prev) ? "" : prev));
  }

  // คิวรอดำเนินการ + ยอดใบยื่น
  // background = โหลดใหม่หลังบันทึก: ไม่ขึ้น "กำลังโหลด..." ทั้งคิว และคงวันที่/สถานะที่พิมพ์ไว้ในแถวอื่น
  // (พบ 2026-09-27: เดิมทุกแถวกลับเป็นวันนี้หลังแนบแต่ละคัน แถวถัดไปจึงถูกบันทึกเป็นวันนี้โดยไม่รู้ตัว)
  async function loadQueue(background = false) {
    const seq = ++pendingSeq.current;
    if (!background) {
      setLoading(true);
      setError("");
    }
    try {
      const p = await loadPending();
      if (seq !== pendingSeq.current) return;
      showPending(p);
      setRows((prev) => Object.fromEntries(p.map((r) => [r.id, prev[r.id] ?? newRowState()])));
      setError("");
      // มาจากหน้าค้นหารถ (?focus=เลขตัวถัง): เปิดใบยื่นของรถคันนั้นให้ FocusVehicleRow หาแถวเจอ - ครั้งแรกที่โหลดเท่านั้น
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const target = chassis ? p.find((r) => sameChassis(r.chassis, chassis)) : undefined;
        if (target) setOpenSheets((prev) => new Set(prev).add(sheetKeyOf(target)));
      }
      if (groupBySheet) {
        // ยอดทั้งใบยื่นของวันที่ที่มีรถรออยู่ - โหลดไม่ได้ก็แค่ไม่แสดงยอด/คำเตือน คิวยังใช้ได้
        const dates = [...new Set(p.map((r) => r.submitDate).filter((d): d is string => !!d))];
        Promise.all(dates.map((d) => api.listDocumentSubmissions(d)))
          .then((res) => seq === pendingSeq.current && setSheetStats(sheetStatsOf(res.flatMap((r) => r.submissions))))
          .catch(() => seq === pendingSeq.current && setSheetStats({}));
      }
    } catch (err) {
      // โหลดใหม่เบื้องหลังไม่สำเร็จ = คงรายการเดิมไว้ (สิ่งที่เพิ่งบันทึกสำเร็จแล้ว)
      if (seq === pendingSeq.current && !background) setError(errorText(err, "โหลดรายการไม่สำเร็จ"));
    } finally {
      if (seq === pendingSeq.current) setLoading(false);
    }
  }

  function loadAll(background = false) {
    loadCompletedPage(0);
    return loadQueue(background);
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadAll sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  // ค้นในตาราง "ดำเนินการแล้ว" (ค้นทั้งฐานข้อมูล ไม่ใช่แค่ 100 คันที่แสดง) - รอพิมพ์เสร็จ 300 ms
  useEffect(() => {
    if (!queryTouched.current) return;
    const timer = setTimeout(() => loadCompletedPage(0, completedQuery), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedQuery]);

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }

  async function handleAttach(r: QueueRow, file: File) {
    const row = rows[r.id];
    if (!row || !attachPhoto) return;
    const dateIso = displayDateToIso(row.dateText.replace(/\D/g, ""));
    if (!dateIso) return patchRow(r.id, { message: { text: `${doneDateLabel}ไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป`, error: true } });
    const rangeError = receivedDateError(doneDateLabel, dateIso, r);
    if (rangeError) return patchRow(r.id, { message: { text: rangeError, error: true } });
    patchRow(r.id, { saving: true, message: { text: "กำลังอัปโหลดรูป…" } });
    try {
      const res = await attachPhoto.upload(r.id, file, dateIso);
      // เอาเฉพาะแถวนี้ออกจากคิวทันที แถวอื่นคงวันที่/สถานะเดิม แล้วค่อยโหลดใหม่เบื้องหลัง (ตาราง "ดำเนินการแล้ว" + ยอดใบยื่น)
      showPending(pendingRef.current.filter((p) => p.id !== r.id));
      setRows((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== r.id)));
      setLastSavedId(r.id);
      setNotice({ text: `✓ บันทึก${doneLabel.replace(/แล้ว$/, "")} ${res.chassis} วันที่ ${isoToDisplayDate(res.date)} แล้ว` });
      if (res.alreadyDelivered) {
        const reminder: DeliveryReminder = {
          id: r.id,
          chassis: res.chassis,
          customerName: res.customerName ?? r.customerName,
          receivedDate: res.date,
          bookDeliveredDate: res.bookDeliveredDate ?? r.bookDeliveredDate ?? null,
          bookSlipNo: res.bookSlipNo ?? null,
          row: r,
        };
        setDeliveryReminders((prev) => [...prev.filter((d) => d.id !== r.id), reminder]);
      }
      loadAll(true);
    } catch (err) {
      // ข้อความจริงของ error (เช่น เปิดไฟล์ HEIC ไม่ได้ / รูปซ้ำของรถคันไหน) - พบ 2026-09-27: เดิมขึ้นแค่ "อัปโหลดรูปไม่สำเร็จ"
      patchRow(r.id, { saving: false, message: { text: errorText(err, "อัปโหลดรูปไม่สำเร็จ"), error: true } });
    }
  }

  // "รับป้ายแล้ว" -> "รอรับป้าย"
  const waitingLabel = `รอ${doneLabel.replace(/แล้ว$/, "")}`;

  // ช่องวันที่ที่ยังพิมพ์ไม่ครบ = ยังไม่กรอง
  const fromIso = displayDateToIso(fromText.replace(/\D/g, ""));
  const toIso = displayDateToIso(toText.replace(/\D/g, ""));
  const receiptNeedle = receiptQuery.replace(/\s/g, "");
  // เลขตัวรถ: ไม่สนตัวพิมพ์เล็ก/ใหญ่ · ทะเบียน: ไม่สนช่องว่าง ("9กข 1148" / "9กข1148" / "1148")
  const chassisNeedle = chassisQuery.replace(/\s/g, "").toUpperCase();
  const plateNeedle = plateQuery.replace(/\s/g, "");
  const searching = !!(receiptNeedle || chassisNeedle || plateNeedle);
  // เจ้าของงานเลือกตามรหัสลูกค้า (ผู้ใช้ 2026-09-27) แสดงชื่อ - ชื่อซ้ำกันต่อบริษัท/สาขาให้แยกออก
  // ลูกค้าที่ไม่เหลือรถในคิวแล้วถูกล้างเป็นทุกรายที่ showPending ตัวกรองจึงเป็นลูกค้าที่อยู่ในตัวเลือกเสมอ
  const ownerNames = customerDisplayNames(
    pending.map((r) => ({ id: r.customerId, name: r.customerName, company: r.customerCompany, branch: r.customerBranch })),
  );
  const owners = [...ownerNames].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "th"));
  const owner = ownerFilter;
  const filtering = !!(fromIso || toIso || searching || owner);
  const shown = pending.filter(
    (r) =>
      (!fromIso || (r.submitDate ?? "") >= fromIso) &&
      (!toIso || (r.submitDate ?? "") <= toIso) &&
      (!owner || r.customerId === owner) &&
      (!receiptNeedle || (r.receiptNo ?? "").includes(receiptNeedle)) &&
      (!chassisNeedle || r.chassis.toUpperCase().includes(chassisNeedle)) &&
      (!plateNeedle || `${r.plateCategory ?? ""}${r.plateNumber ?? ""}`.replace(/\s/g, "").includes(plateNeedle)),
  );
  // จำนวนรถในคิวของแต่ละใบก่อนกรอง - ใช้คำนวณ "รับแล้ว" ให้ถูกแม้กำลังกรองอยู่
  const pendingPerSheet: Record<string, number> = {};
  for (const r of pending) {
    const key = sheetKeyOf(r);
    pendingPerSheet[key] = (pendingPerSheet[key] ?? 0) + 1;
  }
  // ลำดับรถในแต่ละใบ: ตามที่บันทึกยื่น (ลำดับในใบส่งงาน) เป็นค่าเริ่มต้น หรือเรียงตามหมวด+เลขทะเบียน (ผู้ใช้ 2026-09-26)
  const ordered = [...shown].sort(
    sortMode === "plate" ? comparePlate : (a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.chassis.localeCompare(b.chassis),
  );
  const days = groupBySheet ? groupByDateAndSheet(ordered, ownerNames) : [];
  const orderText = sortMode === "plate" ? "เรียงตามหมวดและเลขทะเบียน" : "เรียงตามลำดับที่ยื่น";
  // การ์ดใบยื่นเรียงตามวันที่ยื่น (เก่าสุดก่อน) แล้วตามกลุ่ม/ลูกค้า
  const sheetList = days.flatMap((day) => day.sheets.map((sheet) => ({ ...sheet, date: day.date })));
  const printSheets = sheetList.filter((sheet) => selectedSheets.has(sheet.key));
  const printCount = printSheets.reduce((n, s) => n + s.rows.length, 0);
  const toggleSheets = (keys: string[], on: boolean) =>
    setSelectedSheets((prev) => {
      const next = new Set(prev);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  const tableHead = (
    <thead>
      <tr>
        {!groupBySheet && <th>{dateColumnLabel}</th>}
        {!groupBySheet && <th>ชื่อลูกค้า</th>}
        {groupBySheet && <th style={{ width: 40 }}>ลำดับ</th>}
        <th>เลขตัวถัง</th>
        {!groupBySheet && <th>ประเภทรถ</th>}
        <th>ทะเบียน</th>
        {showReceiptNo && <th>เลขที่ใบเสร็จ</th>}
        {attachPhoto && <th>{doneDateLabel}</th>}
        {attachPhoto && <th>{attachPhoto.label}</th>}
        {groupBySheet && <th>ประเภทรถ</th>}
      </tr>
    </thead>
  );

  function renderPendingRow(r: QueueRow, order?: number) {
    const row = rows[r.id];
    if (!row) return null;
    const message = row.message.text && (
      <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11 }} role="status">
        {row.message.text}
      </div>
    );
    return (
      <tr key={r.id}>
        {!groupBySheet && <td>{isoToDisplayDate(r.date) || r.date}</td>}
        {!groupBySheet && <td>{r.customerName}</td>}
        {groupBySheet && <td>{order}</td>}
        <td>{r.chassis}</td>
        {!groupBySheet && <td>{r.body || "—"}</td>}
        <td>{plateText(r)}</td>
        {showReceiptNo && <td>{r.receiptNo || "—"}</td>}
        {attachPhoto && (
          <>
            <td>
              {/* พิมพ์ปี พ.ศ. ได้ แปลงเป็น ค.ศ. ให้ (พบ 2026-09-27) */}
              <DateInput
                value={row.dateText}
                onChange={(value) => patchRow(r.id, { dateText: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)), message: { text: "" } })}
                style={{ width: 110 }}
                aria-label={doneDateLabel}
                disabled={row.saving}
              />
              {/* ส่งเล่มไปก่อนแล้ว - ป้ายนี้ต้องบันทึกส่งตามที่หน้า Delivery หรือกด "ป้ายไปพร้อมเล่มแล้ว" ในรายงานส่งงาน (พบ 2026-09-27) */}
              {r.bookDeliveredDate && (
                <div className="muted" style={{ fontSize: 11, maxWidth: 170 }}>
                  ส่งเล่มให้ลูกค้าไปแล้ว {isoToDisplayDate(r.bookDeliveredDate)}
                </div>
              )}
            </td>
            <td>
              {/* มือถือ: เลือกได้ทั้งถ่ายจากกล้องและรูปในเครื่อง - เลือกแล้วอัปโหลดและบันทึกรับทันที */}
              <label
                className="primary"
                style={{ display: "inline-flex", padding: "8px 14px", fontSize: 13, cursor: row.saving ? "wait" : "pointer", opacity: row.saving ? 0.6 : 1 }}
              >
                📷 {attachPhoto.label}
                <input
                  type="file"
                  accept="image/*"
                  hidden
                  disabled={row.saving}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) handleAttach(r, file);
                  }}
                />
              </label>
              {message}
            </td>
          </>
        )}
        {groupBySheet && <td>{r.body || "—"}</td>}
      </tr>
    );
  }

  const noticeBar = (notice || deliveryReminders.length > 0) && (
    // ติดขอบล่างจอ (อยู่นอก .panel เพราะ overflow:hidden ทำให้ sticky ไม่ทำงาน) - แถวที่แนบแล้วหายไปจากคิว
    // พนักงานจึงเห็นผลการบันทึกตรงนี้แม้เลื่อนอยู่กลางคิว
    <div style={{ position: "sticky", bottom: 12, zIndex: 5, display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
      {deliveryReminders.map((d) => {
        return (
          <div
            key={d.id}
            role="alert"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: "#fff6e7", border: "1px solid #f0d9ae", color: "#7a5412", fontSize: 14 }}
          >
            <span style={{ flex: "1 1 260px" }}>
              ⚠ รถ {d.chassis} ({d.customerName}) ส่งเล่มให้ลูกค้าไปแล้ว
              {d.bookSlipNo ? ` ในใบ ${slipNoText(d.bookSlipNo)}` : ""}
              {d.bookDeliveredDate ? ` วันที่ ${isoToDisplayDate(d.bookDeliveredDate)}` : ""} แต่ยังไม่ได้บันทึกส่งป้าย
              {/* backend ปรับวันที่รับป้ายเป็นวันส่งเล่มให้เองถ้าบันทึกไว้หลังวันนั้น (ป้ายไปพร้อมเล่ม = ได้ป้ายมาก่อนแล้ว) */}
              <br />• ถ้าป้ายไปพร้อมเล่มแล้ว: กด &quot;ป้ายไปพร้อมเล่มแล้ว&quot; ในตารางป้ายค้างส่ง ที่หน้ารายงานส่งงาน
              <br />• ถ้ายังไม่ได้ส่งป้าย: ไปหน้า Delivery (ส่งป้ายอย่างเดียว)
            </span>
            <Link href={focusHref(DELIVERY_REPORT_PAGE, d.chassis)} className="text-button">
              รายงานส่งงาน →
            </Link>
            <Link href={focusHref(DELIVERY_PAGE, d.chassis)} className="text-button">
              ไปหน้า Delivery →
            </Link>
            <button type="button" className="text-button" aria-label="ปิดข้อความ" onClick={() => setDeliveryReminders((prev) => prev.filter((x) => x.id !== d.id))}>
              ×
            </button>
          </div>
        );
      })}
      {notice && (
        <div
          role="status"
          className={`customer-message${notice.error ? " error" : " success"}`}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 8, background: "#fff", border: "1px solid #dfe5f0", boxShadow: "0 6px 16px #18243c1a" }}
        >
          <span style={{ flex: 1 }}>{notice.text}</span>
          <button type="button" className="text-button" aria-label="ปิดข้อความ" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      )}
    </div>
  );

  return (
    <section className="content">
      <Link href={back.href} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        {back.label}
      </Link>
      <h1 tabIndex={-1}>{title}</h1>
      {headerSlot}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>รอดำเนินการ ({filtering ? `${shown.length} จาก ${pending.length}` : pending.length})</h2>
          {filtering && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setFromText("");
                setToText("");
                setOwnerFilter("");
                setReceiptQuery("");
                setChassisQuery("");
                setPlateQuery("");
              }}
            >
              ล้างตัวกรอง
            </button>
          )}
        </div>
        {/* แถวบน = ตัวกรอง (ช่องกว้างเท่ากันเต็มแถว) · แถวล่าง = ลำดับ/พับ ทางซ้าย, เลือก/ปริ้น ทางขวา (ผู้ใช้ 2026-09-26) */}
        {printTitle && !loading && !error && pending.length > 0 && (
          <div className="queue-filter">
            <label className="field">
              <span>วันที่ยื่น ตั้งแต่</span>
              <DateInput value={fromText} onChange={(v) => setFromText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} />
            </label>
            <label className="field">
              <span>ถึง</span>
              <DateInput value={toText} onChange={(v) => setToText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} />
            </label>
            <label className="field">
              <span>เจ้าของงาน</span>
              <select value={owner} onChange={(e) => setOwnerFilter(e.target.value)}>
                <option value="">ทุกราย</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>เลขที่ใบเสร็จ</span>
              <input
                type="text"
                inputMode="numeric"
                value={receiptQuery}
                onChange={(e) => setReceiptQuery(e.target.value.replace(/[^\d/]/g, ""))}
                placeholder="เช่น 0035"
              />
            </label>
            <label className="field">
              <span>เลขตัวรถ</span>
              <input type="text" value={chassisQuery} onChange={(e) => setChassisQuery(e.target.value)} placeholder="บางส่วนก็ได้" />
            </label>
            <label className="field">
              <span>ทะเบียน</span>
              <input type="text" value={plateQuery} onChange={(e) => setPlateQuery(e.target.value)} placeholder="เช่น 9กข 1148" />
            </label>
          </div>
        )}
        {groupBySheet && !loading && !error && pending.length > 0 && (
          <div className="queue-toolbar">
            <span className="queue-toolbar-group">
              <span className="queue-sort" role="group" aria-label="ลำดับรถ">
                <button type="button" className={sortMode === "submit" ? "active" : undefined} aria-pressed={sortMode === "submit"} onClick={() => setSortMode("submit")}>
                  ลำดับที่ยื่น
                </button>
                <button type="button" className={sortMode === "plate" ? "active" : undefined} aria-pressed={sortMode === "plate"} onClick={() => setSortMode("plate")}>
                  เรียงตามหมวด
                </button>
              </span>
              <button type="button" className="text-button" onClick={() => setOpenSheets(new Set(sheetList.map((sheet) => sheet.key)))}>
                ขยายทั้งหมด
              </button>
              <button type="button" className="text-button" onClick={() => setOpenSheets(new Set())}>
                พับทั้งหมด
              </button>
            </span>
            {printTitle && (
              <span className="queue-toolbar-group">
                {printSheets.length === 0 ? (
                  <button type="button" className="text-button" onClick={() => toggleSheets(sheetList.map((sheet) => sheet.key), true)}>
                    เลือกทุกใบ
                  </button>
                ) : (
                  <button type="button" className="text-button" onClick={() => setSelectedSheets(new Set())}>
                    ล้างที่เลือก
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={printSheets.length === 0}
                  title={printSheets.length === 0 ? "ติ๊ก ☐ ที่การ์ดใบยื่นที่จะปริ้น" : undefined}
                  onClick={() => printReceivingList(printTitle, orderText, printSheets)}
                >
                  🖨 ปริ้นชุดที่เลือก ({printSheets.length} ใบ · {printCount} คัน)
                </button>
              </span>
            )}
          </div>
        )}
        {loading ? (
          <div className="customer-message" role="status" style={{ padding: "0 23px 20px" }}>
            กำลังโหลด...
          </div>
        ) : error ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : pending.length === 0 ? (
          <div className="empty-customers">{emptyText}</div>
        ) : groupBySheet ? (
          // แสดงเป็นการ์ดใบยื่นแบบหน้ารับใบเสร็จ (ผู้ใช้ 2026-09-26): ซ้าย = วันที่ · กลุ่ม · ลูกค้า, ขวา = ยอด - กดเพื่อกางตารางรถ
          <div className="queue-sheets">
            {sheetList.length === 0 && <div className="empty-customers">ไม่มีรถที่ตรงกับตัวกรอง</div>}
            {sheetList.map((sheet) => {
              const open = searching || openSheets.has(sheet.key);
              const st = sheetStats[sheet.key];
              const done = st ? Math.max(0, st.receiptReceived - (pendingPerSheet[sheet.key] ?? sheet.rows.length)) : 0;
              const incomplete = !!st && st.waitingReceipt + st.failed > 0;
              return (
                <div key={sheet.key} className={`queue-sheet${incomplete ? " warn" : ""}${open ? " open" : ""}`}>
                  <div
                    className="queue-sheet-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => toggle(setOpenSheets, sheet.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggle(setOpenSheets, sheet.key);
                      }
                    }}
                  >
                    <span className="queue-sheet-title">
                      {printTitle && (
                        <input
                          type="checkbox"
                          className="queue-check"
                          checked={selectedSheets.has(sheet.key)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                          onChange={(e) => toggleSheets([sheet.key], e.target.checked)}
                          aria-label="เลือกใบยื่นนี้เพื่อปริ้น"
                        />
                      )}
                      <span className="queue-caret">{open ? "▾" : "▸"}</span>
                      {sheet.date ? isoToDisplayDate(sheet.date) : "ไม่ทราบวันที่ยื่น"} · {sheet.label} · {sheet.owner}
                    </span>
                    <span className="queue-sheet-counts">
                      {st ? `${st.submitted} คัน` : `${sheet.rows.length} คัน`}
                      {done > 0 && ` · ${doneLabel} ${done}`} · {waitingLabel} {sheet.rows.length}
                      {incomplete && (
                        <span className="badge warn queue-warn">
                          ⚠ ยื่นไม่ครบ:
                          {st.waitingReceipt > 0 && ` ยังไม่ได้ใบเสร็จ ${st.waitingReceipt}`}
                          {st.waitingReceipt > 0 && st.failed > 0 && " ·"}
                          {st.failed > 0 && ` ยื่นไม่สำเร็จ ${st.failed}`}
                        </span>
                      )}
                    </span>
                  </div>
                  {open && (
                    <div className="table-wrap">
                      <table>
                        {tableHead}
                        <tbody>{sheet.rows.map((r, i) => renderPendingRow(r, i + 1))}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              {tableHead}
              <tbody>{ordered.map((r) => renderPendingRow(r))}</tbody>
            </table>
          </div>
        )}
      </section>
      {noticeBar}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head" style={{ flexWrap: "wrap", gap: 12 }}>
          <h2>
            ดำเนินการแล้ว ({completedQuery.trim() ? `ผลค้นหา ${completed.length}${completedHasMore ? "+" : ""}` : `ล่าสุด ${completed.length}${completedHasMore ? "+" : ""}`} คัน)
          </h2>
          <input
            type="search"
            value={completedQuery}
            onChange={(e) => {
              queryTouched.current = true;
              completedQueryRef.current = e.target.value;
              setCompletedQuery(e.target.value);
            }}
            placeholder="ค้นเลขตัวถัง / ทะเบียน / ลูกค้า / เลขที่ใบเสร็จ"
            aria-label="ค้นรายการที่ดำเนินการแล้ว"
            style={{ flex: "0 1 320px", minWidth: 0 }}
          />
        </div>
        <p className="muted" style={{ margin: "0 23px 10px" }}>
          เรียงตามเวลาที่บันทึก (ล่าสุดก่อน) {fixReceived && `· แก้วันที่รับ/ถอดรูปได้จนกว่าจะส่ง${fixReceived.itemLabel}ให้ลูกค้า`}
        </p>
        {completedError ? (
          <div className="empty-customers" role="alert">
            {completedError}
          </div>
        ) : completed.length === 0 ? (
          <div className="empty-customers">{completedLoading ? "กำลังโหลด..." : completedQuery.trim() ? "ไม่พบรายการที่ตรงกับคำค้น" : "ยังไม่มีรายการที่ดำเนินการแล้ว"}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{dateColumnLabel}</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ประเภทรถ</th>
                  <th>ทะเบียน</th>
                  {showReceiptNo && <th>เลขที่ใบเสร็จ</th>}
                  {photoColumnLabel && <th>{photoColumnLabel}</th>}
                  <th>{doneDateLabel}</th>
                  {fixReceived && <th>แก้ไข</th>}
                </tr>
              </thead>
              <tbody>
                {completed.map((r) => (
                  <tr key={r.id} style={r.id === lastSavedId ? { background: "#eaf7f2" } : undefined}>
                    <td>{isoToDisplayDate(r.date) || r.date}</td>
                    <td>{r.customerName}</td>
                    <td>{r.chassis}</td>
                    <td>{r.body || "—"}</td>
                    <td>{plateText(r)}</td>
                    {showReceiptNo && <td>{r.receiptNo || "—"}</td>}
                    {photoColumnLabel && (
                      <td>
                        {r.photoUrl ? (
                          <AuthedImage
                            src={r.photoUrl}
                            alt={photoColumnLabel}
                            style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 4, display: "block" }}
                            linkTitle={`เปิด${photoColumnLabel}ขนาดเต็ม`}
                          />
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                    <td>{r.doneDate ? isoToDisplayDate(r.doneDate) : "—"}</td>
                    {fixReceived && (
                      <td style={{ whiteSpace: "nowrap" }}>
                        {r.itemDeliveredDate ? (
                          <span className="muted" title="ยกเลิกใบส่งงานก่อน (หน้ารายงานส่งงาน) แล้วจึงแก้ได้">
                            ส่ง{fixReceived.itemLabel}แล้ว {isoToDisplayDate(r.itemDeliveredDate)}
                          </span>
                        ) : (
                          <span style={{ display: "inline-flex", gap: 10 }}>
                            <button type="button" className="text-button" style={{ fontSize: 12, padding: 0 }} onClick={() => setFixing({ row: r, mode: "date" })}>
                              ✎ แก้วันที่
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              style={{ fontSize: 12, padding: 0, color: "#b43434" }}
                              onClick={() => setFixing({ row: r, mode: "detach" })}
                            >
                              ถอดรูป
                            </button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {completedHasMore && !completedError && (
          <div style={{ padding: "12px 23px 18px" }}>
            <button
              type="button"
              className="text-button"
              disabled={completedLoading}
              // ต่อจากรายการที่แสดงอยู่ด้วยคำค้นของรายการนั้น (คำที่เพิ่งพิมพ์ยังไม่ได้ค้น = รอ 300 ms แล้วโหลดใหม่เอง)
              onClick={() => loadCompletedPage(completed.length, shownCompleted.current.q)}
            >
              {completedLoading ? "กำลังโหลด..." : "โหลดเพิ่มอีก 100 คัน"}
            </button>
          </div>
        )}
      </section>

      {fixing && fixReceived && (
        <ReceivedFixDialog
          row={fixing.row}
          mode={fixing.mode}
          itemLabel={fixReceived.itemLabel}
          doneDateLabel={doneDateLabel}
          fix={fixReceived}
          onClose={() => setFixing(null)}
          // แก้วันที่ = แก้แถวเดิมในตาราง ไม่โหลดตารางใหม่ (พบ 2026-09-27: เดิมกลับไปหน้าแรก แถวที่เปิดจาก "โหลดเพิ่ม" หายไป)
          onDateFixed={(id, date, text) => {
            setNotice({ text });
            setLastSavedId(id);
            setCompleted((prev) => prev.map((r) => (r.id === id ? { ...r, doneDate: date } : r)));
            setDeliveryReminders((prev) => prev.map((d) => (d.id === id ? { ...d, receivedDate: date } : d)));
          }}
          // ถอดรูป = เอาแถวออกจากตาราง แล้วโหลดคิวใหม่ (รถกลับไปรอรับ)
          onDetached={(id, text) => {
            setNotice({ text });
            setLastSavedId("");
            setCompleted((prev) => prev.filter((r) => r.id !== id));
            shownCompleted.current = { ...shownCompleted.current, count: Math.max(0, shownCompleted.current.count - 1) };
            setDeliveryReminders((prev) => prev.filter((d) => d.id !== id));
            loadQueue(true);
          }}
          // ข้อมูลเปลี่ยนจากเครื่องอื่น / ส่งของไปแล้ว = โหลดรายการใหม่ให้เห็นสถานะจริง โดยไม่ต้องโหลดทั้งหน้า (วันที่ที่พิมพ์ในคิวไม่หาย)
          onStale={() => loadAll(true)}
        />
      )}
    </section>
  );
}

// แก้วันที่รับ / ถอดรูปที่แนบผิด (ผู้ใช้ 2026-09-27) - ต้องใส่เหตุผลเสมอ (เก็บในประวัติการแก้ไขของรถ)
// ถอดรูปแล้วรถกลับไปอยู่ในคิวรอรับ และรูปถูกลบ (แนบไฟล์เดิมให้คันที่ถูกได้) ยกเว้นรูปเก่าที่ยังเป็นรูปของรถคันอื่น
function ReceivedFixDialog({
  row,
  mode,
  itemLabel,
  doneDateLabel,
  fix,
  onClose,
  onDateFixed,
  onDetached,
  onStale,
}: {
  row: QueueRow;
  mode: "date" | "detach";
  itemLabel: string;
  doneDateLabel: string;
  fix: NonNullable<Props["fixReceived"]>;
  onClose: () => void;
  onDateFixed: (id: string, date: string, text: string) => void;
  onDetached: (id: string, text: string) => void;
  onStale: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dateText, setDateText] = useState(row.doneDate ? isoToDisplayDate(row.doneDate) : "");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const earliest = row.receiptDate || row.submitDate || "";

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleSave() {
    setError("");
    let date = "";
    if (mode === "date") {
      date = displayDateToIso(dateText.replace(/\D/g, ""));
      if (!date) return setError(`${doneDateLabel}ไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป`);
      const rangeError = receivedDateError(doneDateLabel, date, row);
      if (rangeError) return setError(rangeError);
      if (date === row.doneDate) return setError("วันที่ไม่ได้เปลี่ยน");
    }
    if (!remark.trim()) return setError(mode === "date" ? "ต้องใส่เหตุผลที่แก้" : "ต้องใส่เหตุผลที่ถอดรูป");
    setSaving(true);
    try {
      if (mode === "date") {
        const res = await fix.updateDate(row.id, date, remark.trim());
        onDateFixed(row.id, res.date, `✓ แก้${doneDateLabel} ${row.chassis} เป็น ${isoToDisplayDate(res.date)} แล้ว`);
      } else {
        const { photo } = await fix.detach(row.id, remark.trim());
        // รูปเก่าจากถาด AI ที่ยังเป็นรูปของรถคันอื่นไม่ถูกลบ - ไฟล์เดิมแนบให้คันอื่นไม่ได้ (ขึ้นว่ารูปซ้ำ) ต้องถ่ายใหม่ (พบ 2026-09-27)
        const photoText =
          photo === "deleted"
            ? ` · รูปถูกลบแล้ว แนบรูปเดิมให้คันที่ถูกได้`
            : photo === "shared"
              ? ` · รูปนี้ยังเป็นรูป${itemLabel}ของรถคันอื่นอยู่ จึงไม่ได้ลบ - แนบให้คันที่ถูกต้องใช้รูปที่ถ่ายใหม่`
              : "";
        onDetached(row.id, `✓ ถอดรูป${itemLabel}ของ ${row.chassis} แล้ว - รถกลับไปอยู่ในคิวรอรับ${itemLabel}${photoText}`);
      }
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, mode === "date" ? "แก้วันที่ไม่สำเร็จ" : "ถอดรูปไม่สำเร็จ"));
      // 409 = เพิ่งถูกแก้จากเครื่องอื่น, 400/404 = ส่งของไปแล้ว / ถอดรูปไปแล้ว / รถถูกลบ -> โหลดรายการใหม่ให้เห็นสถานะจริง
      // (พบ 2026-09-27: เดิมตารางยังแสดงแถวเก่าพร้อมปุ่มแก้ และข้อความบอกให้โหลดทั้งหน้า วันที่ที่พิมพ์ในคิวจึงหาย)
      if (err instanceof ApiError && (err.status === 400 || err.status === 404 || err.status === 409)) onStale();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(480px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>{mode === "date" ? `แก้${doneDateLabel}` : `ถอดรูป${itemLabel}`}</h2>
      <p className="muted">
        {row.chassis} · {row.customerName} · {plateText(row)}
        {row.doneDate && ` · รับ${itemLabel}เมื่อ ${isoToDisplayDate(row.doneDate)}`}
      </p>
      {mode === "date" ? (
        <label className="field" style={{ marginTop: 12 }}>
          {doneDateLabel} *
          <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} autoFocus />
          <span className="muted">
            ใส่ได้ {earliest ? `${isoToDisplayDate(earliest)} - ` : "ไม่เกิน "}
            {isoToDisplayDate(todayIso())} ({earliest ? `${row.receiptDate ? "วันที่ในใบเสร็จ" : "วันที่ยื่น"} ถึงวันนี้` : "วันนี้"})
          </span>
          {/* ส่งเล่มไปก่อนแล้วและป้ายยังไม่ได้ส่ง (พบ 2026-09-27) */}
          {row.bookDeliveredDate && !row.itemDeliveredDate && (
            <span className="muted">
              ส่งเล่มให้ลูกค้าไปแล้ว {isoToDisplayDate(row.bookDeliveredDate)}
            </span>
          )}
        </label>
      ) : (
        <p style={{ marginTop: 12 }}>
          รถคันนี้จะกลับไปอยู่ในคิวรอรับ{itemLabel} และรูป{itemLabel}นี้จะถูกลบ (ยกเว้นรูปเก่าที่ยังใช้กับรถคันอื่น) - ถ้ารูปเป็นของรถคันอื่น
          แนบรูปเดิมให้คันนั้นได้เลย
        </p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        {mode === "date" ? "เหตุผลที่แก้ *" : "เหตุผลที่ถอดรูป *"}
        <input
          type="text"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          placeholder={mode === "date" ? "เช่น พิมพ์วันที่ผิด" : "เช่น แนบรูปผิดคัน"}
          maxLength={200}
        />
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
        <button type="button" className="primary" onClick={handleSave} disabled={saving}>
          {saving ? "กำลังบันทึก..." : mode === "date" ? "บันทึกการแก้" : "ถอดรูป"}
        </button>
      </div>
    </dialog>
  );
}
