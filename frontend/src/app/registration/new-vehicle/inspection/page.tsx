"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type InspectionVehicle } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

interface RowState {
  done: boolean;
  completedDateText: string;
  costText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

function toRowState(vehicle: InspectionVehicle): RowState {
  return {
    done: vehicle.inspectionDone,
    completedDateText: isoToDisplayDate(vehicle.inspectionCompletedDate ?? ""),
    costText: vehicle.inspectionCost ?? vehicle.suggestedCost ?? "",
    saving: false,
    message: { text: "" },
  };
}

const COMPLETED_DETAIL_FIELDS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
  ["วันที่เสร็จ", (v) => (v.inspectionCompletedDate ? isoToDisplayDate(v.inspectionCompletedDate) : "")],
  ["ค่าใช้จ่าย", (v) => (v.inspectionCost ? `${v.inspectionCost} บาท` : "")],
];

export default function InspectionPage() {
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const dateIso = useMemo(() => displayDateToIso(dateText.replace(/\D/g, "")), [dateText]);

  const [vehicles, setVehicles] = useState<InspectionVehicle[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<InspectionVehicle | null>(null);

  async function load(forDate: string) {
    if (!forDate) return;
    setLoading(true);
    setError("");
    try {
      const data = await api.listInspection(forDate);
      setVehicles(data.vehicles);
      setRows(Object.fromEntries(data.vehicles.map((v) => [v.id, toRowState(v)])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setVehicles([]);
      setRows({});
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-date-change; load() sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(dateIso);
  }, [dateIso]);

  function handleDateTextChange(raw: string) {
    setDateText(formatDateDigits(raw.replace(/\D/g, "").slice(0, 8)));
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

  async function handleSave(id: string) {
    const row = rows[id];
    if (!row) return;
    const completedDateDigits = row.completedDateText.replace(/\D/g, "");
    const completedDateIso = completedDateDigits ? displayDateToIso(completedDateDigits) : "";
    if (completedDateDigits && !completedDateIso) {
      patchRow(id, { message: { text: "วันที่เสร็จไม่ถูกต้อง", error: true } });
      return;
    }
    if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) {
      patchRow(id, { message: { text: "ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0", error: true } });
      return;
    }

    patchRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateInspection(id, {
        done: row.done,
        completedDate: completedDateIso || null,
        cost: row.costText || null,
      });
      // Reload so a completed row moves out of "ต้องดำเนินการ" into "ตรวจแล้ว" below.
      await load(dateIso);
    } catch (err) {
      patchRow(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  function openDetail(vehicle: InspectionVehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
  }

  const pendingVehicles = vehicles.filter((v) => !v.inspectionDone);
  const completedVehicles = vehicles.filter((v) => v.inspectionDone);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ตรวจรถ</h1>

      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-head">
          <h2>รายการรถที่ต้องดำเนินการ</h2>
          <label className="field" style={{ margin: 0 }}>
            วันที่รับงาน
            <input
              type="text"
              inputMode="numeric"
              placeholder="วว/ดด/ปปปป"
              value={dateText}
              onChange={(e) => handleDateTextChange(e.target.value)}
              style={{ width: 130 }}
            />
          </label>
        </div>

        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : error ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : !pendingVehicles.length ? (
          <div className="empty-customers">
            {vehicles.length ? "ดำเนินการครบทุกคันแล้ว" : "ไม่มีรถที่พร้อมตรวจในวันที่เลือก (ต้องแจ้งย้าย/ตัดบัญชีเสร็จก่อน)"}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>ประเภทรถ</th>
                  <th>จังหวัดที่จดทะเบียน</th>
                  <th>ดำเนินการแล้ว</th>
                  <th>วันที่เสร็จ</th>
                  <th>ค่าใช้จ่าย</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pendingVehicles.map((v) => {
                  const row = rows[v.id];
                  if (!row) return null;
                  return (
                    <tr key={v.id}>
                      <td>{v.customerName}</td>
                      <td>{v.chassis}</td>
                      <td>{v.brandName}</td>
                      <td>{v.body || "—"}</td>
                      <td>{v.registrationProvince || "—"}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.done}
                          onChange={(e) => handleDoneChange(v.id, e.target.checked)}
                          aria-label="ดำเนินการแล้ว"
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="วว/ดด/ปปปป"
                          value={row.completedDateText}
                          onChange={(e) =>
                            patchRow(v.id, { completedDateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
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
                        {v.suggestedCost && (
                          <div style={{ fontSize: 11, color: "var(--muted, #738197)" }}>แนะนำ {v.suggestedCost} บาท</div>
                        )}
                      </td>
                      <td>
                        <button className="text-button" disabled={row.saving} onClick={() => handleSave(v.id)}>
                          บันทึก
                        </button>
                        {row.message.text && (
                          <div
                            className={`customer-message${row.message.error ? " error" : " success"}`}
                            style={{ fontSize: 11 }}
                            role="status"
                          >
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

      <section className="panel customer-list">
        <div className="panel-head">
          <h2>รายการที่ตรวจแล้ว</h2>
          <button className="text-button" onClick={() => load(dateIso)}>
            โหลดรายการใหม่
          </button>
        </div>
        {!loading && !error && (
          <p style={{ padding: "0 24px 12px", fontSize: 12 }}>ในวันที่เลือก แสดง {completedVehicles.length} รายการ</p>
        )}
        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : error ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : !completedVehicles.length ? (
          <div className="empty-customers">ยังไม่มีรายการที่ตรวจเสร็จในวันที่เลือก</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>วันที่เสร็จ</th>
                  <th>ค่าใช้จ่าย</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {completedVehicles.map((v) => (
                  <tr key={v.id}>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.inspectionCompletedDate ? isoToDisplayDate(v.inspectionCompletedDate) : "—"}</td>
                    <td>{v.inspectionCost ? `${v.inspectionCost} บาท` : "—"}</td>
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
            <h2>รายการที่ตรวจแล้ว</h2>
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
