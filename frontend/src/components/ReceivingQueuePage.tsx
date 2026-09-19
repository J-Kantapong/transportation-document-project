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
  plateCategory: string | null;
  plateNumber: string | null;
  doneDate: string | null; // ISO
  recipient?: string | null;
  note?: string | null;
  // เฉพาะหน้ารับใบเสร็จ (receiptCheck): ยอด Bill ที่คำนวณไว้ตอนยื่น = billFees + taxAmount (taxAmount null = คำนวณภาษีไม่ได้)
  billFees?: number;
  taxAmount?: number | null;
  receiptAmount?: number | null;
}

export interface QueueMarkData {
  date: string;
  recipient: string;
  note: string;
  plateCategory: string;
  plateNumber: string;
  receiptAmount: string;
}

interface Props {
  title: string;
  dateColumnLabel: string;
  doneLabel: string; // หัวคอลัมน์ checkbox เช่น "ได้รับใบเสร็จแล้ว"
  doneDateLabel: string; // เช่น "วันที่รับใบเสร็จ"
  showDeliveryFields?: boolean;
  // หน้ารับใบเสร็จ: ต้องกรอกเลขทะเบียน (ยกเว้นยื่นไม่สำเร็จ) + กรอกยอดใบเสร็จเพื่อเทียบกับ Bill (เตือนถ้าไม่ตรงแต่บันทึกได้)
  receiptCheck?: boolean;
  emptyText: string;
  loadPending: () => Promise<QueueRow[]>;
  loadCompleted: () => Promise<QueueRow[]>;
  markDone: (id: string, data: QueueMarkData) => Promise<void>;
  // เฉพาะหน้ารับใบเสร็จ: ปุ่ม "ยื่นไม่สำเร็จ" (ปลดล็อกให้ยื่นใหม่ได้)
  markFailed?: (id: string) => Promise<void>;
}

interface RowState {
  checked: boolean;
  dateText: string;
  recipient: string;
  note: string;
  plateCategory: string;
  plateNumber: string;
  amountText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

const newRowState = (r: QueueRow): RowState => ({
  checked: false,
  dateText: isoToDisplayDate(todayIso()),
  recipient: "",
  note: "",
  plateCategory: r.plateCategory ?? "",
  plateNumber: r.plateNumber ?? "",
  amountText: "",
  saving: false,
  message: { text: "" },
});

const plateText = (r: QueueRow) => (r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—");
const money = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

function billExpected(r: QueueRow): number | null {
  if (r.billFees === undefined || r.taxAmount === undefined || r.taxAmount === null) return null;
  return r.billFees + r.taxAmount;
}

type BillCompare = { kind: "none" } | { kind: "unknown" } | { kind: "match" } | { kind: "mismatch"; diff: number };

// เทียบยอดใบเสร็จกับ Bill (ค่าธรรมเนียม + ภาษี ไม่รวม No bill) - ภาษีคำนวณไม่ได้ = เทียบไม่ได้ ไม่เดา
function compareBill(r: QueueRow, amount: number | null): BillCompare {
  if (amount === null) return { kind: "none" };
  const expected = billExpected(r);
  if (expected === null) return { kind: "unknown" };
  const diff = Math.round((amount - expected) * 100) / 100;
  return diff === 0 ? { kind: "match" } : { kind: "mismatch", diff };
}

function CompareBadge({ result }: { result: BillCompare }) {
  if (result.kind === "match") return <span className="badge done">ตรง Bill</span>;
  if (result.kind === "mismatch")
    return (
      <span className="badge warn">
        ไม่ตรง Bill ({result.diff > 0 ? "+" : ""}
        {money(result.diff)} บาท)
      </span>
    );
  if (result.kind === "unknown") return <span className="badge">เทียบไม่ได้ (ยังคำนวณภาษีไม่ได้)</span>;
  return <span className="muted">ยังไม่ได้กรอกยอด</span>;
}

function BillCell({ r }: { r: QueueRow }) {
  const expected = billExpected(r);
  return (
    <>
      <div>{expected === null ? "—" : `${money(expected)} บาท`}</div>
      <div style={{ fontSize: 11, color: "#8a94a6" }}>
        ค่าธรรมเนียม {money(r.billFees ?? 0)} + ภาษี {r.taxAmount === null || r.taxAmount === undefined ? "ยังคำนวณไม่ได้" : money(r.taxAmount)}
      </div>
    </>
  );
}

export function ReceivingQueuePage({
  title,
  dateColumnLabel,
  doneLabel,
  doneDateLabel,
  showDeliveryFields,
  receiptCheck,
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
      setRows(Object.fromEntries(p.map((r) => [r.id, newRowState(r)])));
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
    const fail = (text: string) => patchRow(id, { message: { text, error: true } });
    if (!row.checked) return fail(`ติ๊ก "${doneLabel}" ก่อนบันทึก`);
    const dateIso = displayDateToIso(row.dateText.replace(/\D/g, ""));
    if (!dateIso) return fail(`${doneDateLabel}ไม่ถูกต้อง`);
    if (receiptCheck) {
      if (!row.plateCategory.trim() || !row.plateNumber.trim()) return fail("กรุณากรอกหมวดทะเบียนและเลขทะเบียนก่อนบันทึก");
      if (row.amountText.trim() && !/^\d+(\.\d{1,2})?$/.test(row.amountText.trim())) return fail("ยอดใบเสร็จต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง");
    }

    patchRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await markDone(id, {
        date: dateIso,
        recipient: row.recipient,
        note: row.note,
        plateCategory: row.plateCategory.trim(),
        plateNumber: row.plateNumber.trim(),
        receiptAmount: row.amountText.trim(),
      });
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
                  <th>{receiptCheck ? "เลขทะเบียน (หมวด / เลข) *" : "ทะเบียน"}</th>
                  {receiptCheck && <th>ยอด Bill</th>}
                  {receiptCheck && <th>ยอดใบเสร็จ (เทียบ Bill)</th>}
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
                  const amountNumber = /^\d+(\.\d{1,2})?$/.test(row.amountText.trim()) ? Number(row.amountText.trim()) : null;
                  return (
                    <tr key={r.id}>
                      <td>{isoToDisplayDate(r.date) || r.date}</td>
                      <td>{r.customerName}</td>
                      <td>{r.chassis}</td>
                      <td>{r.body || "—"}</td>
                      <td>
                        {receiptCheck ? (
                          <div style={{ display: "flex", gap: 6 }}>
                            <input
                              type="text"
                              placeholder="4กข"
                              maxLength={3}
                              value={row.plateCategory}
                              onChange={(e) => patchRow(r.id, { plateCategory: e.target.value.slice(0, 3) })}
                              aria-label="หมวดทะเบียน"
                              style={{ width: 62 }}
                            />
                            <input
                              type="text"
                              inputMode="numeric"
                              placeholder="4444"
                              maxLength={4}
                              value={row.plateNumber}
                              onChange={(e) => patchRow(r.id, { plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                              aria-label="เลขทะเบียน"
                              style={{ width: 66 }}
                            />
                          </div>
                        ) : (
                          plateText(r)
                        )}
                      </td>
                      {receiptCheck && (
                        <td>
                          <BillCell r={r} />
                        </td>
                      )}
                      {receiptCheck && (
                        <td>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="ยอดบนใบเสร็จ"
                            value={row.amountText}
                            onChange={(e) => patchRow(r.id, { amountText: e.target.value })}
                            aria-label="ยอดใบเสร็จ"
                            style={{ width: 110 }}
                          />
                          <div style={{ marginTop: 4 }}>
                            <CompareBadge result={compareBill(r, amountNumber)} />
                          </div>
                        </td>
                      )}
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
                  {receiptCheck && <th>ยอด Bill</th>}
                  {receiptCheck && <th>ยอดใบเสร็จ</th>}
                  {receiptCheck && <th>ผลเทียบ Bill</th>}
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
                    <td>{r.doneDate ? isoToDisplayDate(r.doneDate) : "—"}</td>
                    {receiptCheck && (
                      <td>
                        <BillCell r={r} />
                      </td>
                    )}
                    {receiptCheck && <td>{r.receiptAmount === null || r.receiptAmount === undefined ? "—" : `${money(r.receiptAmount)} บาท`}</td>}
                    {receiptCheck && (
                      <td>
                        <CompareBadge result={compareBill(r, r.receiptAmount ?? null)} />
                      </td>
                    )}
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
