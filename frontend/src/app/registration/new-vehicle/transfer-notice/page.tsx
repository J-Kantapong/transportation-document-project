"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type TransferNoticeVehicle } from "@/lib/api";
import { canEditTransferNotice, getCachedUser, type UserRole } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

interface RowState {
  done: boolean;
  completedDateText: string;
  costText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

function toRowState(vehicle: TransferNoticeVehicle): RowState {
  return {
    done: vehicle.transferDone,
    completedDateText: isoToDisplayDate(vehicle.transferCompletedDate ?? ""),
    costText: vehicle.transferCost ?? vehicle.suggestedCost ?? "",
    saving: false,
    message: { text: "" },
  };
}

// แถวที่ผู้ใช้แก้จริงเทียบกับตอนโหลด - "บันทึกทั้งหมด" ส่งเฉพาะแถวเหล่านี้ (พบ 2026-09-27: เดิมส่งทุกแถวบนจอ
// หน้าที่เปิดค้างไว้จึงบันทึกทับคันที่คนอื่นเพิ่งทำเสร็จให้กลับเป็นยังไม่เสร็จ)
function isRowChanged(row: RowState, loaded: RowState | undefined): boolean {
  return !loaded || row.done !== loaded.done || row.completedDateText !== loaded.completedDateText || row.costText !== loaded.costText;
}

const COMPLETED_DETAIL_FIELDS: Array<[string, (v: TransferNoticeVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
  ["สถานะ", (v) => v.status ?? ""],
  ["วันที่เสร็จ", (v) => (v.transferCompletedDate ? isoToDisplayDate(v.transferCompletedDate) : "")],
  ["ค่าใช้จ่าย", (v) => (v.transferCost ? `${v.transferCost} บาท` : "")],
];

// Validates one row's completed-date/cost text and returns the parsed ISO date, or throws
// with a Thai error message. Shared by the single-row and bulk save paths.
function validateRow(row: RowState): { completedDateIso: string } {
  const completedDateDigits = row.completedDateText.replace(/\D/g, "");
  const completedDateIso = completedDateDigits ? displayDateToIso(completedDateDigits) : "";
  if (completedDateDigits && !completedDateIso) throw new Error("วันที่เสร็จไม่ถูกต้อง");
  // วันที่เสร็จในอนาคต = พิมพ์ผิด ส่งตรวจด้วยวันจริงไม่ได้ และคันที่ดำเนินการแล้วแก้จากหน้านี้ไม่ได้ (backend บังคับเหมือนกัน - พบ 2026-09-27)
  if (completedDateIso && completedDateIso > todayIso()) throw new Error("วันที่เสร็จต้องไม่เกินวันนี้");
  // ดำเนินการแล้วต้องมีวันที่เสร็จ (backend บังคับเหมือนกัน - พบ 2026-09-27)
  if (row.done && !completedDateIso) throw new Error("กรุณาระบุวันที่เสร็จ");
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0");
  return { completedDateIso };
}

// Shared table for both "ทั้งหมด" and "ตามวันที่" sections - vehicles is whichever subset the
// caller already filtered; highlightDate (if given) marks rows whose date differs as backlog.
function PendingVehicleTable({
  vehicles,
  rows,
  patchRow,
  onDoneChange,
  onSave,
  onSelectAll,
  bulkSaving,
  highlightDate,
  canEdit,
}: {
  vehicles: TransferNoticeVehicle[];
  rows: Record<string, RowState>;
  patchRow: (id: string, patch: Partial<RowState>) => void;
  onDoneChange: (id: string, done: boolean) => void;
  onSave: (vehicle: TransferNoticeVehicle) => void;
  onSelectAll: (done: boolean) => void;
  bulkSaving: boolean;
  highlightDate?: string;
  canEdit: (v: TransferNoticeVehicle) => boolean;
}) {
  const editable = vehicles.filter(canEdit);
  const allSelected = editable.length > 0 && editable.every((v) => rows[v.id]?.done);

  return (
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
            <th>สถานะ</th>
            <th>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: "inherit" }}>
                <input type="checkbox" checked={allSelected} disabled={!editable.length} onChange={(e) => onSelectAll(e.target.checked)} />
                ดำเนินการแล้ว
              </label>
            </th>
            <th>วันที่เสร็จ</th>
            <th>ค่าใช้จ่าย</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {vehicles.map((v) => {
            const row = rows[v.id];
            if (!row) return null;
            const isBacklog = highlightDate !== undefined && v.date !== highlightDate;
            const readOnly = !canEdit(v);
            return (
              <tr key={v.id} className={isBacklog ? "row-backlog" : undefined} title={isBacklog ? "งานค้าง: ไม่ใช่วันที่รับงานที่เลือก" : undefined}>
                <td>{isoToDisplayDate(v.date) || v.date}</td>
                <td>{v.customerName}</td>
                <td>{v.chassis}</td>
                <td>{v.brandName}</td>
                <td>{v.body || "—"}</td>
                <td>{v.registrationProvince || "—"}</td>
                <td>{v.status || "—"}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={row.done}
                    disabled={readOnly}
                    onChange={(e) => onDoneChange(v.id, e.target.checked)}
                    aria-label="ดำเนินการแล้ว"
                  />
                </td>
                <td>
                  <DateInput
                    value={row.completedDateText}
                    disabled={readOnly}
                    onChange={(value) =>
                      patchRow(v.id, { completedDateText: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)) })
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
                    disabled={readOnly}
                    onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                    style={{ width: 90 }}
                  />
                  {v.suggestedCost && <div style={{ fontSize: 11, color: "var(--muted, #738197)" }}>แนะนำ {v.suggestedCost} บาท</div>}
                </td>
                <td>
                  {readOnly ? (
                    <span className="muted" style={{ fontSize: 11 }}>ดูอย่างเดียว</span>
                  ) : (
                    <button className="text-button" disabled={row.saving || bulkSaving} onClick={() => onSave(v)}>
                      บันทึก
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
  );
}

export default function TransferNoticePage() {
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const dateIso = useMemo(() => displayDateToIso(dateText.replace(/\D/g, "")), [dateText]);

  // ต้องดำเนินการ: ทุกคันที่ยังไม่ตัดบัญชี ไม่จำกัดวันที่รับงาน
  const [pendingVehicles, setPendingVehicles] = useState<TransferNoticeVehicle[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // ค่าแต่ละแถวตอนโหลด - ใช้หาแถวที่ผู้ใช้แก้จริง (isRowChanged)
  const [loadedRows, setLoadedRows] = useState<Record<string, RowState>>({});
  const [pendingLoading, setPendingLoading] = useState(true);
  const [pendingError, setPendingError] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // ตัดบัญชีแล้ว: เรียงตามทำเสร็จล่าสุด ไม่กรองตามวันที่รับงาน
  const [completedVehicles, setCompletedVehicles] = useState<TransferNoticeVehicle[]>([]);
  const [completedLoading, setCompletedLoading] = useState(true);
  const [completedError, setCompletedError] = useState("");

  // บันทึกได้ทุกคัน = ADMIN/STAFF_ENTRY, STAFF_MOTO เฉพาะจักรยานยนต์, บทบาทอื่นดูอย่างเดียว (backend กันอีกชั้น)
  const [roles, setRoles] = useState<UserRole[]>([]);
  const canEdit = (v: TransferNoticeVehicle) => canEditTransferNotice(roles, v.body);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<TransferNoticeVehicle | null>(null);

  async function loadPending() {
    setPendingLoading(true);
    setPendingError("");
    try {
      const data = await api.listPendingTransferNotice();
      const loaded = Object.fromEntries(data.vehicles.map((v) => [v.id, toRowState(v)]));
      setPendingVehicles(data.vehicles);
      setRows(loaded);
      setLoadedRows(loaded);
    } catch (err) {
      setPendingError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setPendingVehicles([]);
      setRows({});
      setLoadedRows({});
    } finally {
      setPendingLoading(false);
    }
  }

  async function loadCompleted() {
    setCompletedLoading(true);
    setCompletedError("");
    try {
      const data = await api.listRecentlyCompletedTransferNotice();
      setCompletedVehicles(data.vehicles);
    } catch (err) {
      setCompletedError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setCompletedVehicles([]);
    } finally {
      setCompletedLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadPending()/loadCompleted() set the loading flag before their first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPending();
    loadCompleted();
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  function handleDateTextChange(raw: string) {
    setDateText(formatDateDigitsCe(raw.replace(/\D/g, "").slice(0, 8)));
  }

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function handleDoneChange(id: string, done: boolean) {
    const row = rows[id];
    patchRow(id, {
      done,
      completedDateText: done && !row.completedDateText ? isoToDisplayDate(todayIso()) : row.completedDateText,
    });
  }

  function handleSelectAll(vehicles: TransferNoticeVehicle[], done: boolean) {
    const today = isoToDisplayDate(todayIso());
    setRows((prev) => {
      const next = { ...prev };
      for (const v of vehicles.filter(canEdit)) {
        const row = next[v.id];
        next[v.id] = { ...row, done, completedDateText: done && !row.completedDateText ? today : row.completedDateText };
      }
      return next;
    });
  }

  async function handleSave(vehicle: TransferNoticeVehicle) {
    const id = vehicle.id;
    const row = rows[id];
    if (!row) return;
    let completedDateIso: string;
    try {
      ({ completedDateIso } = validateRow(row));
    } catch (err) {
      patchRow(id, { message: { text: (err as Error).message, error: true } });
      return;
    }

    patchRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateTransferNotice(id, {
        done: row.done,
        completedDate: completedDateIso || null,
        cost: row.costText || null,
        expectedTransferDone: vehicle.transferDone,
      });
      // Reload so a completed row moves out of "ต้องดำเนินการ" into "ตัดบัญชีแล้ว" below.
      await Promise.all([loadPending(), loadCompleted()]);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ";
      if (err instanceof ApiError && err.status === 409) {
        // มีคนบันทึกคันนี้ไปก่อนแล้ว - โหลดรายการใหม่ (แสดงข้อความที่หัวตาราง เพราะแถวนี้อาจหายไปจากรายการแล้ว)
        setBulkMessage({ text: `เลขตัวถัง ${vehicle.chassis}: ${message}`, error: true });
        await Promise.all([loadPending(), loadCompleted()]);
        return;
      }
      patchRow(id, { saving: false, message: { text: message, error: true } });
    }
  }

  async function handleSaveAll(shown: TransferNoticeVehicle[]) {
    const vehicles = shown.filter(canEdit);
    if (bulkSaving || !vehicles.length) return;
    const parsed: Array<{ vehicle: TransferNoticeVehicle; done: boolean; completedDateIso: string; cost: string }> = [];
    for (const v of vehicles) {
      const row = rows[v.id];
      // ส่งเฉพาะแถวที่แก้จริง - แถวที่ไม่ได้แตะไม่ถูกบันทึกทับ
      if (!row || !isRowChanged(row, loadedRows[v.id])) continue;
      try {
        const { completedDateIso } = validateRow(row);
        parsed.push({ vehicle: v, done: row.done, completedDateIso, cost: row.costText });
      } catch (err) {
        setBulkMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }
    if (!parsed.length) {
      setBulkMessage({ text: "ไม่มีรายการที่เปลี่ยนแปลง" });
      return;
    }

    setBulkSaving(true);
    setBulkMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) =>
          api.updateTransferNotice(p.vehicle.id, {
            done: p.done,
            completedDate: p.completedDateIso || null,
            cost: p.cost || null,
            expectedTransferDone: p.vehicle.transferDone,
          }),
        ),
      );
      // บอกเหตุผลของแถวที่ไม่สำเร็จด้วย (เช่น มีคนบันทึกไปก่อน) - แสดงไม่เกิน 3 แถว
      const failures = results.flatMap((r, i) =>
        r.status === "rejected"
          ? [`${parsed[i].vehicle.chassis}: ${r.reason instanceof ApiError ? r.reason.message : "บันทึกไม่สำเร็จ"}`]
          : [],
      );
      setBulkMessage(
        failures.length
          ? {
              text: `บันทึกสำเร็จ ${parsed.length - failures.length} จาก ${parsed.length} รายการ · ล้มเหลว ${failures.length} รายการ (${failures.slice(0, 3).join(" / ")}${failures.length > 3 ? " …" : ""})`,
              error: true,
            }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      await Promise.all([loadPending(), loadCompleted()]);
    } finally {
      setBulkSaving(false);
    }
  }

  function openDetail(vehicle: TransferNoticeVehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
  }

  const byDateVehicles = useMemo(() => pendingVehicles.filter((v) => v.date === dateIso), [pendingVehicles, dateIso]);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>แจ้งย้าย/ตัดบัญชี</h1>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-head">
          <div>
            <h2>รายการรถที่ต้องดำเนินการทั้งหมด</h2>
            <span className="muted">แถวสีเหลือง = งานค้างที่ไม่ใช่วันที่รับงานที่เลือกไว้ด้านล่าง</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {bulkMessage.text && (
              <span className={`customer-message${bulkMessage.error ? " error" : " success"}`} role="status">
                {bulkMessage.text}
              </span>
            )}
            <button className="primary" disabled={bulkSaving || !pendingVehicles.some(canEdit)} onClick={() => handleSaveAll(pendingVehicles)}>
              บันทึกทั้งหมด
            </button>
            <button className="text-button" onClick={loadPending}>
              โหลดรายการใหม่
            </button>
          </div>
        </div>

        {pendingLoading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : pendingError ? (
          <div className="empty-customers" role="alert">
            {pendingError}
          </div>
        ) : !pendingVehicles.length ? (
          <div className="empty-customers">ไม่มีรายการที่ต้องดำเนินการ</div>
        ) : (
          <PendingVehicleTable
            vehicles={pendingVehicles}
            rows={rows}
            patchRow={patchRow}
            onDoneChange={handleDoneChange}
            onSave={handleSave}
            onSelectAll={(done) => handleSelectAll(pendingVehicles, done)}
            bulkSaving={bulkSaving}
            highlightDate={dateIso}
            canEdit={canEdit}
          />
        )}
      </div>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-head">
          <h2>รายการรถที่ต้องดำเนินการตามวันที่</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {bulkMessage.text && (
              <span className={`customer-message${bulkMessage.error ? " error" : " success"}`} role="status">
                {bulkMessage.text}
              </span>
            )}
            <button className="primary" disabled={bulkSaving || !byDateVehicles.some(canEdit)} onClick={() => handleSaveAll(byDateVehicles)}>
              บันทึกทั้งหมด
            </button>
            <button className="text-button" onClick={loadPending}>
              โหลดรายการใหม่
            </button>
          </div>
        </div>
        <div className="panel-head" style={{ paddingTop: 0 }}>
          <label className="field" style={{ margin: 0 }}>
            วันที่รับงาน
            <DateInput
              value={dateText}
              onChange={(value) => handleDateTextChange(value)}
              style={{ width: 130 }}
            />
          </label>
        </div>

        {pendingLoading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : pendingError ? (
          <div className="empty-customers" role="alert">
            {pendingError}
          </div>
        ) : !byDateVehicles.length ? (
          <div className="empty-customers">ไม่มีรถที่ต้องดำเนินการในวันที่เลือก</div>
        ) : (
          <PendingVehicleTable
            vehicles={byDateVehicles}
            rows={rows}
            patchRow={patchRow}
            onDoneChange={handleDoneChange}
            onSave={handleSave}
            onSelectAll={(done) => handleSelectAll(byDateVehicles, done)}
            bulkSaving={bulkSaving}
            canEdit={canEdit}
          />
        )}
      </div>

      <section className="panel customer-list">
        <div className="panel-head">
          <h2>รายการที่ตัดบัญชีแล้วล่าสุด</h2>
          <button className="text-button" onClick={loadCompleted}>
            โหลดรายการใหม่
          </button>
        </div>
        {!completedLoading && !completedError && (
          <p style={{ padding: "0 24px 12px", fontSize: 12 }}>แสดง {completedVehicles.length} รายการล่าสุด</p>
        )}
        {completedLoading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : completedError ? (
          <div className="empty-customers" role="alert">
            {completedError}
          </div>
        ) : !completedVehicles.length ? (
          <div className="empty-customers">ยังไม่มีรายการที่ดำเนินการเสร็จ</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่รับงาน</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>สถานะ</th>
                  <th>วันที่เสร็จ</th>
                  <th>ค่าใช้จ่าย</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {completedVehicles.map((v) => (
                  <tr key={v.id}>
                    <td>{isoToDisplayDate(v.date) || v.date}</td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.status || "—"}</td>
                    <td>{v.transferCompletedDate ? isoToDisplayDate(v.transferCompletedDate) : "—"}</td>
                    <td>{v.transferCost ? `${v.transferCost} บาท` : "—"}</td>
                    <td>
                      <button className="text-button" onClick={() => openDetail(v)}>
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
            <h2>รายการที่ตัดบัญชีแล้ว</h2>
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
