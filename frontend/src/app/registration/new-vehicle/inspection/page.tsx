"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type InspectionVehicle } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

type SentType = "ตรวจนอก" | "เอารถมาตรวจเอง";
type ResultType = "ผ่าน" | "ไม่ผ่าน";

interface SendRowState {
  selectedType: SentType | null;
  dateText: string;
  costText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

interface ResultRowState {
  selectedResult: ResultType | null;
  dateText: string;
  costText: string;
  remarkText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

function toSendRowState(vehicle: InspectionVehicle): SendRowState {
  return {
    selectedType: null,
    dateText: "",
    costText: vehicle.suggestedCost ?? "",
    saving: false,
    message: { text: "" },
  };
}

function toResultRowState(vehicle: InspectionVehicle): ResultRowState {
  return {
    selectedResult: null,
    dateText: "",
    costText: vehicle.inspectionSentCost ?? vehicle.suggestedCost ?? "",
    remarkText: "",
    saving: false,
    message: { text: "" },
  };
}

function validateSendRow(row: SendRowState): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0");
  return { dateIso };
}

function validateResultRow(row: ResultRowState, panelResult: ResultType): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0");
  if (panelResult === "ไม่ผ่าน" && !row.remarkText.trim()) throw new Error("กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน");
  return { dateIso };
}

const COMPLETED_DETAIL_FIELDS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
  ["ประเภทการตรวจ", (v) => v.inspectionSentType ?? ""],
  ["วันที่ส่งตรวจ", (v) => (v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "")],
  ["ค่าใช้จ่าย (ส่งตรวจ)", (v) => (v.inspectionSentCost ? `${v.inspectionSentCost} บาท` : "")],
  ["ผลตรวจ", (v) => v.inspectionResult ?? ""],
  ["วันที่ตรวจเสร็จ", (v) => (v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "")],
  ["ค่าใช้จ่าย (ผลตรวจ)", (v) => (v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "")],
  ["Remark (ตรวจไม่ผ่าน)", (v) => v.inspectionFailRemark ?? ""],
];

// Tab 1 - ส่งตรวจ: ตรวจนอก/เอารถมาตรวจเอง แบ่งเป็น 2 panel ที่อ่าน pool เดียวกัน (pendingSendVehicles)
// row.selectedType เป็น field เดียวที่ใช้ร่วมกันทั้ง 2 panel เพื่อไม่ให้คันเดียวถูกเลือกซ้ำ 2 ประเภท
function SendPanel({
  title,
  panelType,
  vehicles,
  rows,
  patchRow,
  onSelectAll,
  onSave,
  onSaveAll,
  bulkSaving,
  bulkMessage,
}: {
  title: string;
  panelType: SentType;
  vehicles: InspectionVehicle[];
  rows: Record<string, SendRowState>;
  patchRow: (id: string, patch: Partial<SendRowState>) => void;
  onSelectAll: (checked: boolean) => void;
  onSave: (id: string) => void;
  onSaveAll: () => void;
  bulkSaving: boolean;
  bulkMessage: { text: string; error?: boolean };
}) {
  const selectedCount = vehicles.filter((v) => rows[v.id]?.selectedType === panelType).length;
  const allSelected = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedType === panelType);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {bulkMessage.text && (
            <span className={`customer-message${bulkMessage.error ? " error" : " success"}`} role="status">
              {bulkMessage.text}
            </span>
          )}
          <button className="primary" disabled={bulkSaving || !selectedCount} onClick={onSaveAll}>
            บันทึกทั้งหมด
          </button>
        </div>
      </div>

      {!vehicles.length ? (
        <div className="empty-customers">ไม่มีรถที่ยังไม่ได้ตรวจ</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>วันที่รับงาน</th>
                <th>ชื่อลูกค้า</th>
                <th>เลขตัวถัง</th>
                <th>ยี่ห้อ</th>
                <th>ประเภทรถ</th>
                <th>จังหวัดที่จดทะเบียน</th>
                <th>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "inherit" }}>
                    <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
                    {panelType}
                  </label>
                </th>
                <th>วันที่</th>
                <th>ค่าใช้จ่าย</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const row = rows[v.id];
                if (!row) return null;
                const checked = row.selectedType === panelType;
                return (
                  <tr key={v.id}>
                    <td>{isoToDisplayDate(v.date) || v.date}</td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.body || "—"}</td>
                    <td>{v.registrationProvince || "—"}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const isChecked = e.target.checked;
                          patchRow(v.id, {
                            selectedType: isChecked ? panelType : null,
                            dateText: isChecked && !row.dateText ? isoToDisplayDate(todayIso()) : row.dateText,
                          });
                        }}
                        aria-label={panelType}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="วว/ดด/ปปปป"
                        value={row.dateText}
                        onChange={(e) =>
                          patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                        }
                        style={{ width: 110 }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={row.costText}
                        onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                        style={{ width: 90 }}
                      />
                      {v.suggestedCost && <div style={{ fontSize: 11, color: "var(--muted, #738197)" }}>แนะนำ {v.suggestedCost} บาท</div>}
                    </td>
                    <td>
                      <button className="text-button" disabled={!checked || row.saving || bulkSaving} onClick={() => onSave(v.id)}>
                        บันทึก
                      </button>
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
    </div>
  );
}

// Tab 2 - ผลตรวจ: ตรวจรถเรียบร้อย/ตรวจไม่ผ่าน แบ่งเป็น 2 panel ที่อ่าน pool เดียวกัน (pendingResultVehicles)
// showRemark = true เฉพาะ panel "ตรวจไม่ผ่าน" - บังคับกรอกก่อนบันทึกได้
function ResultPanel({
  title,
  panelResult,
  showRemark,
  vehicles,
  rows,
  patchRow,
  onSelectAll,
  onSave,
  onSaveAll,
  bulkSaving,
  bulkMessage,
}: {
  title: string;
  panelResult: ResultType;
  showRemark: boolean;
  vehicles: InspectionVehicle[];
  rows: Record<string, ResultRowState>;
  patchRow: (id: string, patch: Partial<ResultRowState>) => void;
  onSelectAll: (checked: boolean) => void;
  onSave: (id: string) => void;
  onSaveAll: () => void;
  bulkSaving: boolean;
  bulkMessage: { text: string; error?: boolean };
}) {
  const selectedCount = vehicles.filter((v) => rows[v.id]?.selectedResult === panelResult).length;
  const allSelected = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedResult === panelResult);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>{title}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {bulkMessage.text && (
            <span className={`customer-message${bulkMessage.error ? " error" : " success"}`} role="status">
              {bulkMessage.text}
            </span>
          )}
          <button className="primary" disabled={bulkSaving || !selectedCount} onClick={onSaveAll}>
            บันทึกทั้งหมด
          </button>
        </div>
      </div>

      {!vehicles.length ? (
        <div className="empty-customers">ไม่มีรถที่ส่งตรวจรอผล</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>วันที่รับงาน</th>
                <th>ชื่อลูกค้า</th>
                <th>เลขตัวถัง</th>
                <th>ยี่ห้อ</th>
                <th>ประเภทการตรวจ</th>
                <th>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "inherit" }}>
                    <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
                    {panelResult}
                  </label>
                </th>
                <th>วันที่</th>
                <th>ค่าใช้จ่าย</th>
                {showRemark && <th>Remark</th>}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const row = rows[v.id];
                if (!row) return null;
                const checked = row.selectedResult === panelResult;
                return (
                  <tr key={v.id}>
                    <td>{isoToDisplayDate(v.date) || v.date}</td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.inspectionSentType || "—"}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const isChecked = e.target.checked;
                          patchRow(v.id, {
                            selectedResult: isChecked ? panelResult : null,
                            dateText: isChecked && !row.dateText ? isoToDisplayDate(todayIso()) : row.dateText,
                          });
                        }}
                        aria-label={panelResult}
                      />
                    </td>
                    <td>
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="วว/ดด/ปปปป"
                        value={row.dateText}
                        onChange={(e) =>
                          patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                        }
                        style={{ width: 110 }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={0}
                        step="any"
                        value={row.costText}
                        onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                        style={{ width: 90 }}
                      />
                      {v.suggestedCost && <div style={{ fontSize: 11, color: "var(--muted, #738197)" }}>แนะนำ {v.suggestedCost} บาท</div>}
                    </td>
                    {showRemark && (
                      <td>
                        <input
                          type="text"
                          placeholder="เหตุผลที่ตรวจไม่ผ่าน"
                          value={row.remarkText}
                          onChange={(e) => patchRow(v.id, { remarkText: e.target.value })}
                          style={{ width: 160 }}
                        />
                      </td>
                    )}
                    <td>
                      <button className="text-button" disabled={!checked || row.saving || bulkSaving} onClick={() => onSave(v.id)}>
                        บันทึก
                      </button>
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
    </div>
  );
}

// อ้างอิงอย่างเดียว (ไม่มี action) - ใช้แสดง "รถที่ยังไม่ได้ส่งตรวจ" ใน Tab 2 และ "รถที่เพิ่งส่งตรวจ" ใน Tab 1
function ReferencePanel({
  title,
  vehicles,
  loading,
  error,
  columns,
}: {
  title: string;
  vehicles: InspectionVehicle[];
  loading: boolean;
  error: string;
  columns: Array<[string, (v: InspectionVehicle) => string]>;
}) {
  return (
    <section className="panel customer-list" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>{title}</h2>
      </div>
      {loading ? (
        <div className="empty-customers">กำลังโหลดรายการ…</div>
      ) : error ? (
        <div className="empty-customers" role="alert">
          {error}
        </div>
      ) : !vehicles.length ? (
        <div className="empty-customers">ไม่มีรายการ</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map(([label]) => (
                  <th key={label}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id}>
                  {columns.map(([label, getValue]) => (
                    <td key={label}>{getValue(v) || "—"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const PENDING_SEND_COLUMNS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
];

const PENDING_RESULT_COLUMNS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทการตรวจ", (v) => v.inspectionSentType ?? ""],
  ["วันที่ส่งตรวจ", (v) => (v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "")],
  ["ค่าใช้จ่าย", (v) => (v.inspectionSentCost ? `${v.inspectionSentCost} บาท` : "")],
];

// ใช้ร่วมกันท้าย Tab 1 และ Tab 2 - โครงเดียวกับ panel "ตัดบัญชีแล้วล่าสุด" ของหน้าแจ้งย้าย/ตัดบัญชี
function CompletedInspectionPanel({
  vehicles,
  loading,
  error,
  onOpenDetail,
}: {
  vehicles: InspectionVehicle[];
  loading: boolean;
  error: string;
  onOpenDetail: (v: InspectionVehicle) => void;
}) {
  return (
    <section className="panel customer-list">
      <div className="panel-head">
        <h2>รายการที่ตรวจเสร็จล่าสุด</h2>
      </div>
      {!loading && !error && <p style={{ padding: "0 24px 12px", fontSize: 12 }}>แสดง {vehicles.length} รายการล่าสุด</p>}
      {loading ? (
        <div className="empty-customers">กำลังโหลดรายการ…</div>
      ) : error ? (
        <div className="empty-customers" role="alert">
          {error}
        </div>
      ) : !vehicles.length ? (
        <div className="empty-customers">ยังไม่มีรายการที่ตรวจเสร็จ</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>วันที่รับงาน</th>
                <th>ชื่อลูกค้า</th>
                <th>เลขตัวถัง</th>
                <th>ยี่ห้อ</th>
                <th>ผลตรวจ</th>
                <th>วันที่เสร็จ</th>
                <th>ค่าใช้จ่าย</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id} className={v.inspectionResult === "ไม่ผ่าน" ? "row-failed" : undefined}>
                  <td>{isoToDisplayDate(v.date) || v.date}</td>
                  <td>{v.customerName}</td>
                  <td>{v.chassis}</td>
                  <td>{v.brandName}</td>
                  <td>{v.inspectionResult || "—"}</td>
                  <td>{v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}</td>
                  <td>{v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "—"}</td>
                  <td>
                    <button className="text-button" onClick={() => onOpenDetail(v)}>
                      ดูข้อมูล
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function InspectionPage() {
  const [activeTab, setActiveTab] = useState<"send" | "result">("send");

  // Tab 1: ผ่าน Step 2 แล้ว แต่ยังไม่ได้ส่งตรวจ
  const [pendingSendVehicles, setPendingSendVehicles] = useState<InspectionVehicle[]>([]);
  const [sendRows, setSendRows] = useState<Record<string, SendRowState>>({});
  const [sendLoading, setSendLoading] = useState(true);
  const [sendError, setSendError] = useState("");
  const [outSaving, setOutSaving] = useState(false);
  const [outMessage, setOutMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [selfSaving, setSelfSaving] = useState(false);
  const [selfMessage, setSelfMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // Tab 2: ส่งตรวจแล้ว รอผล
  const [pendingResultVehicles, setPendingResultVehicles] = useState<InspectionVehicle[]>([]);
  const [resultRows, setResultRows] = useState<Record<string, ResultRowState>>({});
  const [resultLoading, setResultLoading] = useState(true);
  const [resultError, setResultError] = useState("");
  const [passSaving, setPassSaving] = useState(false);
  const [passMessage, setPassMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [failSaving, setFailSaving] = useState(false);
  const [failMessage, setFailMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // ทราบผลแล้ว - แสดงท้ายทั้ง 2 tab
  const [completedVehicles, setCompletedVehicles] = useState<InspectionVehicle[]>([]);
  const [completedLoading, setCompletedLoading] = useState(true);
  const [completedError, setCompletedError] = useState("");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<InspectionVehicle | null>(null);

  async function loadPendingSend() {
    setSendLoading(true);
    setSendError("");
    try {
      const data = await api.listPendingInspectionSend();
      setPendingSendVehicles(data.vehicles);
      setSendRows(Object.fromEntries(data.vehicles.map((v) => [v.id, toSendRowState(v)])));
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setPendingSendVehicles([]);
      setSendRows({});
    } finally {
      setSendLoading(false);
    }
  }

  async function loadPendingResult() {
    setResultLoading(true);
    setResultError("");
    try {
      const data = await api.listPendingInspectionResult();
      setPendingResultVehicles(data.vehicles);
      setResultRows(Object.fromEntries(data.vehicles.map((v) => [v.id, toResultRowState(v)])));
    } catch (err) {
      setResultError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setPendingResultVehicles([]);
      setResultRows({});
    } finally {
      setResultLoading(false);
    }
  }

  async function loadCompleted() {
    setCompletedLoading(true);
    setCompletedError("");
    try {
      const data = await api.listRecentlyCompletedInspection();
      setCompletedVehicles(data.vehicles);
    } catch (err) {
      setCompletedError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setCompletedVehicles([]);
    } finally {
      setCompletedLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; load*() set their own loading flag before the first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPendingSend();
    loadPendingResult();
    loadCompleted();
  }, []);

  function patchSendRow(id: string, patch: Partial<SendRowState>) {
    setSendRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function patchResultRow(id: string, patch: Partial<ResultRowState>) {
    setResultRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function handleSelectAllSend(panelType: SentType, checked: boolean) {
    const today = isoToDisplayDate(todayIso());
    setSendRows((prev) => {
      const next = { ...prev };
      for (const v of pendingSendVehicles) {
        const row = next[v.id];
        if (!row) continue;
        if (checked) {
          next[v.id] = { ...row, selectedType: panelType, dateText: row.dateText || today };
        } else if (row.selectedType === panelType) {
          next[v.id] = { ...row, selectedType: null };
        }
      }
      return next;
    });
  }

  async function handleSaveSend(id: string) {
    const row = sendRows[id];
    if (!row || !row.selectedType) return;
    let dateIso: string;
    try {
      ({ dateIso } = validateSendRow(row));
    } catch (err) {
      patchSendRow(id, { message: { text: (err as Error).message, error: true } });
      return;
    }

    patchSendRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateInspectionSent(id, { sentType: row.selectedType, sentDate: dateIso || null, cost: row.costText || null });
      await Promise.all([loadPendingSend(), loadPendingResult()]);
    } catch (err) {
      patchSendRow(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  async function handleSaveAllSend(
    panelType: SentType,
    setSaving: (v: boolean) => void,
    setMessage: (m: { text: string; error?: boolean }) => void,
  ) {
    const selected = pendingSendVehicles.filter((v) => sendRows[v.id]?.selectedType === panelType);
    if (!selected.length) return;

    const parsed: Array<{ id: string; chassis: string; dateIso: string; cost: string }> = [];
    for (const v of selected) {
      const row = sendRows[v.id];
      if (!row) continue;
      try {
        const { dateIso } = validateSendRow(row);
        parsed.push({ id: v.id, chassis: v.chassis, dateIso, cost: row.costText });
      } catch (err) {
        setMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setSaving(true);
    setMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) => api.updateInspectionSent(p.id, { sentType: panelType, sentDate: p.dateIso || null, cost: p.cost || null })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      setMessage(
        failed
          ? { text: `บันทึกสำเร็จ ${parsed.length - failed} จาก ${parsed.length} รายการ · ล้มเหลว ${failed} รายการ`, error: true }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      await Promise.all([loadPendingSend(), loadPendingResult()]);
    } finally {
      setSaving(false);
    }
  }

  function handleSelectAllResult(panelResult: ResultType, checked: boolean) {
    const today = isoToDisplayDate(todayIso());
    setResultRows((prev) => {
      const next = { ...prev };
      for (const v of pendingResultVehicles) {
        const row = next[v.id];
        if (!row) continue;
        if (checked) {
          next[v.id] = { ...row, selectedResult: panelResult, dateText: row.dateText || today };
        } else if (row.selectedResult === panelResult) {
          next[v.id] = { ...row, selectedResult: null };
        }
      }
      return next;
    });
  }

  async function handleSaveResult(id: string) {
    const row = resultRows[id];
    if (!row || !row.selectedResult) return;
    let dateIso: string;
    try {
      ({ dateIso } = validateResultRow(row, row.selectedResult));
    } catch (err) {
      patchResultRow(id, { message: { text: (err as Error).message, error: true } });
      return;
    }

    patchResultRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateInspectionResult(id, {
        result: row.selectedResult,
        resultDate: dateIso || null,
        cost: row.costText || null,
        remark: row.selectedResult === "ไม่ผ่าน" ? row.remarkText : null,
      });
      await Promise.all([loadPendingResult(), loadCompleted()]);
    } catch (err) {
      patchResultRow(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  async function handleSaveAllResult(
    panelResult: ResultType,
    setSaving: (v: boolean) => void,
    setMessage: (m: { text: string; error?: boolean }) => void,
  ) {
    const selected = pendingResultVehicles.filter((v) => resultRows[v.id]?.selectedResult === panelResult);
    if (!selected.length) return;

    const parsed: Array<{ id: string; dateIso: string; cost: string; remark: string }> = [];
    for (const v of selected) {
      const row = resultRows[v.id];
      if (!row) continue;
      try {
        const { dateIso } = validateResultRow(row, panelResult);
        parsed.push({ id: v.id, dateIso, cost: row.costText, remark: row.remarkText });
      } catch (err) {
        setMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setSaving(true);
    setMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) =>
          api.updateInspectionResult(p.id, {
            result: panelResult,
            resultDate: p.dateIso || null,
            cost: p.cost || null,
            remark: panelResult === "ไม่ผ่าน" ? p.remark : null,
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      setMessage(
        failed
          ? { text: `บันทึกสำเร็จ ${parsed.length - failed} จาก ${parsed.length} รายการ · ล้มเหลว ${failed} รายการ`, error: true }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      await Promise.all([loadPendingResult(), loadCompleted()]);
    } finally {
      setSaving(false);
    }
  }

  function openDetail(vehicle: InspectionVehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ตรวจรถ</h1>

      <div className="vehicle-tabs" role="tablist" aria-label="ขั้นตอนตรวจรถ">
        <button
          className={`vehicle-tab${activeTab === "send" ? " selected" : ""}`}
          role="tab"
          aria-selected={activeTab === "send"}
          onClick={() => setActiveTab("send")}
        >
          1. ตรวจรถ
        </button>
        <button
          className={`vehicle-tab${activeTab === "result" ? " selected" : ""}`}
          role="tab"
          aria-selected={activeTab === "result"}
          onClick={() => setActiveTab("result")}
        >
          2. ตรวจรถเรียบร้อย / ตรวจไม่ผ่าน
        </button>
      </div>

      {activeTab === "send" ? (
        <>
          {sendLoading ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers">กำลังโหลดรายการ…</div>
            </div>
          ) : sendError ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers" role="alert">
                {sendError}
              </div>
            </div>
          ) : (
            <>
              <SendPanel
                title="ตรวจนอก"
                panelType="ตรวจนอก"
                vehicles={pendingSendVehicles}
                rows={sendRows}
                patchRow={patchSendRow}
                onSelectAll={(checked) => handleSelectAllSend("ตรวจนอก", checked)}
                onSave={handleSaveSend}
                onSaveAll={() => handleSaveAllSend("ตรวจนอก", setOutSaving, setOutMessage)}
                bulkSaving={outSaving}
                bulkMessage={outMessage}
              />
              <SendPanel
                title="เอารถมาตรวจเอง"
                panelType="เอารถมาตรวจเอง"
                vehicles={pendingSendVehicles}
                rows={sendRows}
                patchRow={patchSendRow}
                onSelectAll={(checked) => handleSelectAllSend("เอารถมาตรวจเอง", checked)}
                onSave={handleSaveSend}
                onSaveAll={() => handleSaveAllSend("เอารถมาตรวจเอง", setSelfSaving, setSelfMessage)}
                bulkSaving={selfSaving}
                bulkMessage={selfMessage}
              />
            </>
          )}

          <ReferencePanel
            title="รถที่เพิ่งส่งตรวจ (รอผลตรวจ)"
            vehicles={pendingResultVehicles}
            loading={resultLoading}
            error={resultError}
            columns={PENDING_RESULT_COLUMNS}
          />

          <CompletedInspectionPanel vehicles={completedVehicles} loading={completedLoading} error={completedError} onOpenDetail={openDetail} />
        </>
      ) : (
        <>
          <ReferencePanel
            title="รถที่ยังไม่ได้ส่งตรวจ"
            vehicles={pendingSendVehicles}
            loading={sendLoading}
            error={sendError}
            columns={PENDING_SEND_COLUMNS}
          />

          {resultLoading ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers">กำลังโหลดรายการ…</div>
            </div>
          ) : resultError ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers" role="alert">
                {resultError}
              </div>
            </div>
          ) : (
            <>
              <ResultPanel
                title="ตรวจรถเรียบร้อย"
                panelResult="ผ่าน"
                showRemark={false}
                vehicles={pendingResultVehicles}
                rows={resultRows}
                patchRow={patchResultRow}
                onSelectAll={(checked) => handleSelectAllResult("ผ่าน", checked)}
                onSave={handleSaveResult}
                onSaveAll={() => handleSaveAllResult("ผ่าน", setPassSaving, setPassMessage)}
                bulkSaving={passSaving}
                bulkMessage={passMessage}
              />
              <ResultPanel
                title="ตรวจไม่ผ่าน"
                panelResult="ไม่ผ่าน"
                showRemark
                vehicles={pendingResultVehicles}
                rows={resultRows}
                patchRow={patchResultRow}
                onSelectAll={(checked) => handleSelectAllResult("ไม่ผ่าน", checked)}
                onSave={handleSaveResult}
                onSaveAll={() => handleSaveAllResult("ไม่ผ่าน", setFailSaving, setFailMessage)}
                bulkSaving={failSaving}
                bulkMessage={failMessage}
              />
            </>
          )}

          <CompletedInspectionPanel vehicles={completedVehicles} loading={completedLoading} error={completedError} onOpenDetail={openDetail} />
        </>
      )}

      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        {detail && (
          <>
            <h2>รายการที่ตรวจเสร็จ</h2>
            <dl className="customer-detail">
              {COMPLETED_DETAIL_FIELDS.map(([label, getValue]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{getValue(detail) || "—"}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </dialog>
    </section>
  );
}
