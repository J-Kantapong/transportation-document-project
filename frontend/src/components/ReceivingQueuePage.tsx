"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

// หน้าคิวของขั้นตอนหลังยื่นเอกสาร (รับใบเสร็จ / รับป้ายทะเบียน / รับเล่มทะเบียน / Delivery) - ใช้โครงเดียวกัน:
// ติ๊กว่ารับแล้ว + วันที่ แล้วกดบันทึก รายการที่ทำแล้วย้ายไปตารางด้านล่าง
export interface QueueRow {
  id: string;
  date: string; // ISO - วันที่ยื่นเอกสาร (รับใบเสร็จ) หรือวันที่รับงาน (ขั้นอื่น)
  customerName: string;
  chassis: string;
  body: string | null;
  plate: string; // หมวด+เลขทะเบียน หรือ "—"
  doneDate: string | null; // ISO
  recipient?: string | null;
  note?: string | null;
}

interface Props {
  title: string;
  dateColumnLabel: string;
  doneLabel: string; // หัวคอลัมน์ checkbox เช่น "ได้รับใบเสร็จแล้ว"
  doneDateLabel: string; // เช่น "วันที่รับใบเสร็จ"
  showDeliveryFields?: boolean;
  emptyText: string;
  loadPending: () => Promise<QueueRow[]>;
  loadCompleted: () => Promise<QueueRow[]>;
  markDone: (id: string, data: { date: string; recipient: string; note: string }) => Promise<void>;
  // เฉพาะหน้ารับใบเสร็จ: ปุ่ม "ยื่นไม่สำเร็จ" (ปลดล็อกให้ยื่นใหม่ได้)
  markFailed?: (id: string) => Promise<void>;
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

export function ReceivingQueuePage({
  title,
  dateColumnLabel,
  doneLabel,
  doneDateLabel,
  showDeliveryFields,
  emptyText,
  loadPending,
  loadCompleted,
  markDone,
  markFailed,
}: Props) {
  const [pending, setPending] = useState<QueueRow[]>([]);
  const [completed, setCompleted] = useState<QueueRow[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [p, c] = await Promise.all([loadPending(), loadCompleted()]);
      setPending(p);
      setCompleted(c);
      setRows(Object.fromEntries(p.map((r) => [r.id, newRowState()])));
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
  }, []);

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleSave(id: string) {
    const row = rows[id];
    if (!row) return;
    if (!row.checked) {
      patchRow(id, { message: { text: `ติ๊ก "${doneLabel}" ก่อนบันทึก`, error: true } });
      return;
    }
    const dateIso = displayDateToIso(row.dateText.replace(/\D/g, ""));
    if (!dateIso) {
      patchRow(id, { message: { text: `${doneDateLabel}ไม่ถูกต้อง`, error: true } });
      return;
    }
    patchRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await markDone(id, { date: dateIso, recipient: row.recipient, note: row.note });
      await loadAll();
    } catch (err) {
      patchRow(id, { saving: false, message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true } });
    }
  }

  async function handleFail(id: string) {
    if (!markFailed) return;
    patchRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await markFailed(id);
      await loadAll();
    } catch (err) {
      patchRow(id, { saving: false, message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true } });
    }
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>{title}</h1>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>รอดำเนินการ ({pending.length})</h2>
        </div>
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
                  <th>{doneLabel}</th>
                  <th>{doneDateLabel}</th>
                  {showDeliveryFields && <th>ผู้รับ</th>}
                  {showDeliveryFields && <th>หมายเหตุ</th>}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pending.map((r) => {
                  const row = rows[r.id];
                  if (!row) return null;
                  return (
                    <tr key={r.id}>
                      <td>{isoToDisplayDate(r.date) || r.date}</td>
                      <td>{r.customerName}</td>
                      <td>{r.chassis}</td>
                      <td>{r.body || "—"}</td>
                      <td>{r.plate}</td>
                      <td>
                        <input type="checkbox" checked={row.checked} onChange={(e) => patchRow(r.id, { checked: e.target.checked })} aria-label={doneLabel} />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="วว/ดด/ปปปป"
                          value={row.dateText}
                          onChange={(e) => patchRow(r.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })}
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
                        {markFailed && (
                          <button className="text-button" style={{ color: "#c0392b" }} disabled={row.saving} onClick={() => handleFail(r.id)}>
                            ยื่นไม่สำเร็จ
                          </button>
                        )}
                        {row.message.text && (
                          <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11 }} role="status">
                            {row.message.text}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
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
                    <td>{r.plate}</td>
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
