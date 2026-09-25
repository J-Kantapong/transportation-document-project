"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, api, type DocumentSubmission } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";
import { jobSheetGroup } from "@/lib/job-sheet";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { printReceivingList } from "@/lib/receiving-print";
import { comparePlate } from "@/lib/plate-order";

// หน้าคิวของขั้นตอนหลังได้รับใบเสร็จ (รับป้ายทะเบียน / รับเล่มทะเบียน / Delivery) - ใช้โครงเดียวกัน:
// ติ๊กว่ารับแล้ว + วันที่ แล้วกดบันทึก รายการที่ทำแล้วย้ายไปตารางด้านล่าง
// (หน้ารับใบเสร็จแยกไปเป็น ReceiptCheckPage - ตรวจทั้งใบยื่นพร้อมรูปใบเสร็จ)
export interface QueueRow {
  id: string;
  date: string; // ISO - วันที่รับงาน
  customerName: string;
  chassis: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  receiptNo?: string | null; // เลขที่ใบเสร็จ - แสดงเมื่อ showReceiptNo (รับป้ายทะเบียน)
  photoUrl?: string | null; // รูปหลักฐาน (รูปป้าย/รูปเล่ม) ที่ใช้ยืนยัน - แสดงเมื่อส่ง photoColumnLabel
  doneDate: string | null; // ISO
  recipient?: string | null;
  note?: string | null;
  submitDate?: string | null; // วันที่ยื่นของใบยื่นล่าสุด - ใช้จัดกลุ่มเมื่อ groupBySheet
  urgent?: boolean;
  submittedAt?: string | null; // เวลาที่บันทึกยื่น - ลำดับเริ่มต้นเมื่อ groupBySheet
}

export interface QueueMarkData {
  date: string;
  recipient: string;
  note: string;
}

interface Props {
  title: string;
  dateColumnLabel: string;
  doneLabel: string; // หัวคอลัมน์ checkbox เช่น "ได้รับป้ายทะเบียนแล้ว"
  doneDateLabel: string; // เช่น "วันที่รับป้ายทะเบียน"
  showDeliveryFields?: boolean;
  showReceiptNo?: boolean;
  photoColumnLabel?: string; // ตาราง "ดำเนินการแล้ว" แสดงรูปหลักฐาน (รับป้าย: "รูปป้าย" / รับเล่ม: "รูปเล่ม")
  emptyText: string;
  loadPending: () => Promise<QueueRow[]>;
  loadCompleted: () => Promise<QueueRow[]>;
  // ไม่ส่ง = ติ๊กในตารางไม่ได้ (รับป้าย/รับเล่ม: ต้องแนบรูปผ่าน attachPhoto เท่านั้น)
  markDone?: (id: string, data: QueueMarkData) => Promise<void>;
  headerSlot?: ReactNode; // แสดงใต้หัวข้อ
  reloadSignal?: number; // เปลี่ยนค่า = โหลดคิวใหม่ (หลังยืนยันจากส่วนอื่นของหน้า)
  back?: { href: string; label: string }; // ลิงก์ย้อนกลับด้านบน - ไม่ส่ง = กลับไปเมนูจดทะเบียนรถใหม่
  // แนบรูปหลักฐานทีละคันแล้วบันทึกรับทันที (รับป้าย/รับเล่ม ผู้ใช้ 2026-09-26 - แทน AI จับคู่รูป) - ใช้วันที่ในแถวนั้น
  attachPhoto?: { label: string; upload: (id: string, file: File, date: string) => Promise<void> };
  // จัดคิวรอดำเนินการตามวันที่ยื่นและใบยื่น (ผู้ใช้ 2026-09-26: รับป้าย/รับเล่ม) - ซ่อนคอลัมน์วันที่รับงาน/ลูกค้า เพราะอยู่ในหัวกลุ่มแล้ว
  groupBySheet?: boolean;
  // มีค่า = แสดงแถบกรอง (วันที่ยื่น / เลขที่ใบเสร็จ) และปุ่มปริ้นรายการที่กรองแล้ว เรียงตามหมวด+เลขทะเบียน ไว้ยื่นขนส่ง
  printTitle?: string;
}

interface RowState {
  checked: boolean;
  dateText: string;
  recipient: string;
  note: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

const newRowState = (): RowState => ({
  checked: false,
  dateText: isoToDisplayDate(todayIso()),
  recipient: "",
  note: "",
  saving: false,
  message: { text: "" },
});

// จัดคิวตามวันที่ยื่น (เก่าสุดก่อน) แล้วแยกเป็นใบยื่น = กลุ่ม (รย.1 ธรรมดา/ด่วน ...) + เจ้าของงาน ตรงกับใบส่งงานที่ปริ้น
// ลำดับรถในแต่ละใบคงตามที่ loadPending เรียงมา (รับป้าย: หมวด+เลขทะเบียน)
const sheetKeyOf = (date: string, label: string, owner: string) => `${date}|${label}|${owner}`;

// ยอดของทั้งใบยื่น (ทุกคันที่ยื่นไปในใบนั้น ไม่ใช่แค่คันที่อยู่ในคิวนี้) - ใช้บอก "ยื่นกี่คัน" และเตือนใบที่ยังไม่ครบ
interface SheetStats {
  submitted: number;
  receiptReceived: number; // ได้ใบเสร็จแล้ว = อยู่ในคิวนี้หรือทำขั้นนี้เสร็จแล้ว
  waitingReceipt: number; // ยังไม่ได้ใบเสร็จ (PENDING) - ยังมาไม่ถึงขั้นนี้
  failed: number; // ยื่นไม่สำเร็จ
}

function sheetStatsOf(submissions: DocumentSubmission[]): Record<string, SheetStats> {
  const stats: Record<string, SheetStats> = {};
  for (const s of submissions) {
    const key = sheetKeyOf(s.submitDate.slice(0, 10), jobSheetGroup(s.vehicle.body, s.urgent).label, s.vehicle.customer.name);
    const st = (stats[key] ??= { submitted: 0, receiptReceived: 0, waitingReceipt: 0, failed: 0 });
    st.submitted++;
    if (s.status === "RECEIPT_RECEIVED") st.receiptReceived++;
    else if (s.status === "FAILED") st.failed++;
    else st.waitingReceipt++;
  }
  return stats;
}

function groupByDateAndSheet(list: QueueRow[]) {
  const days = new Map<string, Map<string, { key: string; label: string; owner: string; rows: QueueRow[] }>>();
  for (const r of list) {
    const date = r.submitDate ?? "";
    const { label } = jobSheetGroup(r.body, r.urgent ?? false);
    const key = sheetKeyOf(date, label, r.customerName);
    if (!days.has(date)) days.set(date, new Map());
    const sheets = days.get(date)!;
    if (!sheets.has(key)) sheets.set(key, { key, label, owner: r.customerName, rows: [] });
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

export function ReceivingQueuePage({
  title,
  dateColumnLabel,
  doneLabel,
  doneDateLabel,
  showDeliveryFields,
  showReceiptNo,
  photoColumnLabel,
  emptyText,
  loadPending,
  loadCompleted,
  markDone,
  headerSlot,
  reloadSignal,
  back = { href: "/registration/new-vehicle", label: "← จดทะเบียนรถใหม่" },
  attachPhoto,
  groupBySheet,
  printTitle,
}: Props) {
  const [pending, setPending] = useState<QueueRow[]>([]);
  const [completed, setCompleted] = useState<QueueRow[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // groupBySheet: การ์ดใบยื่นพับไว้ก่อน (ผู้ใช้ 2026-09-26 - คิวยาวเกะกะ) กดการ์ดเพื่อกางตารางรถของใบนั้น
  const [openSheets, setOpenSheets] = useState<Set<string>>(new Set());
  const [sheetStats, setSheetStats] = useState<Record<string, SheetStats>>({});
  // กรองคิว (ผู้ใช้ 2026-09-26): วันที่ยื่น ตั้งแต่-ถึง (วว/ดด/ปปปป) + เลขที่ใบเสร็จ (มีคำที่พิมพ์อยู่ในเลขที่)
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [receiptQuery, setReceiptQuery] = useState("");
  const [chassisQuery, setChassisQuery] = useState("");
  const [plateQuery, setPlateQuery] = useState("");
  const [ownerFilter, setOwnerFilter] = useState(""); // เจ้าของงาน (ลูกค้า) - "" = ทุกราย
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

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [p, c] = await Promise.all([loadPending(), loadCompleted()]);
      setPending(p);
      setCompleted(c);
      setRows(Object.fromEntries(p.map((r) => [r.id, newRowState()])));
      // มาจากหน้าค้นหารถ (?focus=เลขตัวถัง): เปิดวันที่ของรถคันนั้นให้ FocusVehicleRow หาแถวเจอ
      const chassis = focusChassis();
      const target = chassis ? p.find((r) => sameChassis(r.chassis, chassis)) : undefined;
      if (target) setOpenSheets((prev) => new Set(prev).add(sheetKeyOf(target.submitDate ?? "", jobSheetGroup(target.body, target.urgent ?? false).label, target.customerName)));
      if (groupBySheet) {
        // ยอดทั้งใบยื่นของวันที่ที่มีรถรออยู่ - โหลดไม่ได้ก็แค่ไม่แสดงยอด/คำเตือน คิวยังใช้ได้
        const dates = [...new Set(p.map((r) => r.submitDate).filter((d): d is string => !!d))];
        Promise.all(dates.map((d) => api.listDocumentSubmissions(d)))
          .then((res) => setSheetStats(sheetStatsOf(res.flatMap((r) => r.submissions))))
          .catch(() => setSheetStats({}));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadAll sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleSave(id: string) {
    const row = rows[id];
    if (!row || !markDone) return;
    const fail = (text: string) => patchRow(id, { message: { text, error: true } });
    if (!row.checked) return fail(`ติ๊ก "${doneLabel}" ก่อนบันทึก`);
    const dateIso = displayDateToIso(row.dateText.replace(/\D/g, ""));
    if (!dateIso) return fail(`${doneDateLabel}ไม่ถูกต้อง`);

    patchRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await markDone(id, { date: dateIso, recipient: row.recipient, note: row.note });
      await loadAll();
    } catch (err) {
      patchRow(id, { saving: false, message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true } });
    }
  }

  async function handleAttach(id: string, file: File) {
    const row = rows[id];
    if (!row || !attachPhoto) return;
    const dateIso = displayDateToIso(row.dateText.replace(/\D/g, ""));
    if (!dateIso) return patchRow(id, { message: { text: `${doneDateLabel}ไม่ถูกต้อง`, error: true } });
    patchRow(id, { saving: true, message: { text: "กำลังอัปโหลดรูป…" } });
    try {
      await attachPhoto.upload(id, file, dateIso);
      await loadAll();
    } catch (err) {
      patchRow(id, { saving: false, message: { text: err instanceof ApiError ? err.message : "อัปโหลดรูปไม่สำเร็จ", error: true } });
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
  const filtering = !!(fromIso || toIso || searching || ownerFilter);
  const owners = [...new Set(pending.map((r) => r.customerName))].sort((a, b) => a.localeCompare(b, "th"));
  const shown = pending.filter(
    (r) =>
      (!fromIso || (r.submitDate ?? "") >= fromIso) &&
      (!toIso || (r.submitDate ?? "") <= toIso) &&
      (!ownerFilter || r.customerName === ownerFilter) &&
      (!receiptNeedle || (r.receiptNo ?? "").includes(receiptNeedle)) &&
      (!chassisNeedle || r.chassis.toUpperCase().includes(chassisNeedle)) &&
      (!plateNeedle || `${r.plateCategory ?? ""}${r.plateNumber ?? ""}`.replace(/\s/g, "").includes(plateNeedle)),
  );
  // จำนวนรถในคิวของแต่ละใบก่อนกรอง - ใช้คำนวณ "รับแล้ว" ให้ถูกแม้กำลังกรองอยู่
  const pendingPerSheet: Record<string, number> = {};
  for (const r of pending) {
    const key = sheetKeyOf(r.submitDate ?? "", jobSheetGroup(r.body, r.urgent ?? false).label, r.customerName);
    pendingPerSheet[key] = (pendingPerSheet[key] ?? 0) + 1;
  }
  // ลำดับรถในแต่ละใบ: ตามที่บันทึกยื่น (ลำดับในใบส่งงาน) เป็นค่าเริ่มต้น หรือเรียงตามหมวด+เลขทะเบียน (ผู้ใช้ 2026-09-26)
  const ordered = [...shown].sort(
    sortMode === "plate" ? comparePlate : (a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.chassis.localeCompare(b.chassis),
  );
  const days = groupBySheet ? groupByDateAndSheet(ordered) : [];
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
        {markDone && <th>{doneLabel}</th>}
        {markDone && <th>{doneDateLabel}</th>}
        {showDeliveryFields && <th>ผู้รับ</th>}
        {showDeliveryFields && <th>หมายเหตุ</th>}
        {markDone && <th></th>}
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
        {markDone && (
          <>
            <td>
              <input type="checkbox" checked={row.checked} onChange={(e) => patchRow(r.id, { checked: e.target.checked })} aria-label={doneLabel} />
            </td>
            <td>
              <DateInput
                value={row.dateText}
                onChange={(value) => patchRow(r.id, { dateText: formatDateDigits(value.replace(/\D/g, "").slice(0, 8)) })}
                style={{ width: 110 }}
              />
            </td>
            {showDeliveryFields && (
              <td>
                <input type="text" value={row.recipient} onChange={(e) => patchRow(r.id, { recipient: e.target.value })} style={{ width: 130 }} />
              </td>
            )}
            {showDeliveryFields && (
              <td>
                <input type="text" value={row.note} onChange={(e) => patchRow(r.id, { note: e.target.value })} style={{ width: 160 }} />
              </td>
            )}
            <td>
              <button className="text-button" disabled={row.saving} onClick={() => handleSave(r.id)}>
                บันทึก
              </button>
              {message}
            </td>
          </>
        )}
        {attachPhoto && (
          <>
            <td>
              <DateInput
                value={row.dateText}
                onChange={(value) => patchRow(r.id, { dateText: formatDateDigits(value.replace(/\D/g, "").slice(0, 8)) })}
                style={{ width: 110 }}
                aria-label={doneDateLabel}
              />
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
                    if (file) handleAttach(r.id, file);
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
              <DateInput value={fromText} onChange={(v) => setFromText(formatDateDigits(v.replace(/\D/g, "").slice(0, 8)))} />
            </label>
            <label className="field">
              <span>ถึง</span>
              <DateInput value={toText} onChange={(v) => setToText(formatDateDigits(v.replace(/\D/g, "").slice(0, 8)))} />
            </label>
            <label className="field">
              <span>เจ้าของงาน</span>
              <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                <option value="">ทุกราย</option>
                {owners.map((name) => (
                  <option key={name} value={name}>
                    {name}
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

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>ดำเนินการแล้ว (ล่าสุด {completed.length})</h2>
        </div>
        {completed.length === 0 ? (
          <div className="empty-customers">ยังไม่มีรายการที่ดำเนินการแล้ว</div>
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
                  {showDeliveryFields && <th>ผู้รับ</th>}
                  {showDeliveryFields && <th>หมายเหตุ</th>}
                </tr>
              </thead>
              <tbody>
                {completed.map((r) => (
                  <tr key={r.id}>
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
                    {showDeliveryFields && <td>{r.recipient || "—"}</td>}
                    {showDeliveryFields && <td>{r.note || "—"}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
