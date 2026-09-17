"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type TransferNoticeVehicle } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

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

export default function TransferNoticePage() {
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const dateIso = useMemo(() => displayDateToIso(dateText.replace(/\D/g, "")), [dateText]);

  const [vehicles, setVehicles] = useState<TransferNoticeVehicle[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(forDate: string) {
    if (!forDate) return;
    setLoading(true);
    setError("");
    try {
      const data = await api.listTransferNotice(forDate);
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
      await api.updateTransferNotice(id, {
        done: row.done,
        completedDate: completedDateIso || null,
        cost: row.costText || null,
      });
      patchRow(id, { saving: false, message: { text: "บันทึกแล้ว" } });
    } catch (err) {
      patchRow(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>แจ้งย้าย/ตัดบัญชี</h1>

      <div className="panel">
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
        ) : !vehicles.length ? (
          <div className="empty-customers">ไม่มีรถที่รับงานในวันที่เลือก</div>
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
                  <th>สถานะ</th>
                  <th>ดำเนินการแล้ว</th>
                  <th>วันที่เสร็จ</th>
                  <th>ค่าใช้จ่าย</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => {
                  const row = rows[v.id];
                  if (!row) return null;
                  return (
                    <tr key={v.id}>
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
    </section>
  );
}
