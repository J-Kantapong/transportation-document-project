"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getCachedUser, submitWriteScopeFor } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { DEFAULT_INSPECTION_PRINT_HEADER, printInspectionSheet } from "@/lib/inspection-print";
import {
  OLD_VEHICLE_HOME,
  OLD_VEHICLE_INSPECTION,
  customerLabel,
  defaultInspectionCost,
  nextStepHref,
  oldVehicleJobsApi,
  plateOf,
  type HubJob,
  type HubVehicle,
} from "@/lib/old-vehicle-jobs-api";
import { PageTabs } from "@/components/PageTabs";
import { DateTextInput, ReasonDialog, errorText, textToIso } from "@/components/PlateSwapPages";

// ตรวจรถของงานรถเก่า (ผู้ใช้ 2026-11-18): ตรวจก่อนยื่น คิวแยกจากตรวจรถของงานจดใหม่ ใบส่งตรวจแบบเดียวกัน
// รอส่งตรวจ: ติ๊กรถ -> เลือกแบบการตรวจ (ส่งตรวจนอก / นำรถมาตรวจ) + วันที่ -> บันทึก / ปริ้นใบส่งตรวจ
// รอผลตรวจ: บันทึกผ่าน / ไม่ผ่าน (ไม่ผ่านกลับไปรอส่งตรวจ) · ตรวจผ่านแล้ว: รอยื่นในหน้าของงานนั้น

export type InspectionTab = "to-send" | "to-result" | "passed";
interface Row {
  vehicle: HubVehicle;
  job: HubJob;
}

const moneyOnly = (text: string) => text.replace(/[^0-9.]/g, "");
const sentTypeLabel = (job: HubJob) => (job.inspectionSentType === "BRING_IN" ? "นำรถมาตรวจ" : "ส่งตรวจนอก");

export function OldVehicleInspectionPage({ tab }: { tab: InspectionTab }) {
  const [canWriteScope, setCanWriteScope] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCanWriteScope(submitWriteScopeFor(getCachedUser()?.roles ?? []));
  }, []);
  const canWrite = (vehicle: HubVehicle) => canWriteScope === "ALL" || canWriteScope === vehicle.vehicleClass;

  const [vehicles, setVehicles] = useState<HubVehicle[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [saving, setSaving] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [sentText, setSentText] = useState(() => isoToDisplayDate(todayIso()));
  const [sentType, setSentType] = useState<"OUTSIDE" | "BRING_IN">("OUTSIDE");
  const [resultTexts, setResultTexts] = useState<Record<string, string>>({});
  const [undo, setUndo] = useState<Row | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const data = await oldVehicleJobsApi.list("inspection");
      setVehicles(data.vehicles);
      setTruncated(data.truncated);
    } catch (err) {
      setError(errorText(err, "โหลดรายการไม่สำเร็จ"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการครั้งแรก
    load();
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  // เฉพาะงานที่ตรวจรถก่อนยื่น (ยังไม่ยื่น) - งานโอนลำดับเดิมที่ยื่นไปแล้วตรวจในหน้าของงานโอน
  const all = useMemo<Row[]>(
    () => vehicles.flatMap((vehicle) => vehicle.jobs.filter((job) => job.inspectionRequired && !job.jobId).map((job) => ({ vehicle, job }))),
    [vehicles],
  );
  const byTab: Record<InspectionTab, Row[]> = {
    "to-send": all.filter((r) => r.job.status === "TO_INSPECT"),
    "to-result": all.filter((r) => r.job.status === "TO_RESULT"),
    passed: all.filter((r) => r.job.status === "TO_SUBMIT"),
  };
  const rows = byTab[tab];
  const costOf = (row: Row) => costs[row.job.id] ?? defaultInspectionCost(row.vehicle.vehicleType);
  const picked = rows.filter((r) => selected.has(r.job.id));

  const replace = (updated: HubVehicle[]) => setVehicles((prev) => prev.map((v) => updated.find((u) => u.id === v.id) ?? v));

  function print(list: Row[], subtitleDate: string) {
    if (!list.length) return setMessage({ text: "กรุณาติ๊กเลือกรถที่จะปริ้น", error: true });
    printInspectionSheet({
      title: "ใบส่งตรวจรถ งานรถเก่า",
      header: DEFAULT_INSPECTION_PRINT_HEADER,
      subtitle: `ส่งตรวจรถ (งานรถเก่า) วันที่ ${subtitleDate}`,
      vehicles: list.map(({ vehicle }) => ({
        body: vehicle.vehicleType ?? (vehicle.vehicleClass === "MOTO" ? "รถจักรยานยนต์" : "รถยนต์"),
        brandName: vehicle.brand ?? "",
        chassis: vehicle.chassis,
        engine: vehicle.engine,
        color: null,
      })),
    });
  }

  async function send() {
    const sentDate = textToIso(sentText);
    if (!sentDate) return setMessage({ text: "กรุณากรอกวันที่ส่งตรวจให้ถูกต้อง", error: true });
    if (!picked.length) return setMessage({ text: "กรุณาติ๊กเลือกรถที่จะส่งตรวจ", error: true });
    if (sentType === "OUTSIDE") {
      const missing = picked.find((r) => costOf(r).trim() === "");
      if (missing) return setMessage({ text: `${plateOf(missing.vehicle)}: กรุณากรอกค่าตรวจรถ (ไม่มีค่าตรวจให้ใส่ 0)`, error: true });
    }
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const saved = await oldVehicleJobsApi.sendInspection({ sentDate, sentType, items: picked.map((r) => ({ id: r.job.id, cost: costOf(r) })) });
      replace(saved.vehicles);
      setSelected(new Set());
      // ล้างค่าตรวจที่พิมพ์ไว้ของคันที่ส่งแล้ว - ถ้าตรวจไม่ผ่านและส่งใหม่ ต้องกรอกค่าตรวจของรอบใหม่เอง
      setCosts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => !picked.some((r) => r.job.id === id))));
      setMessage({ text: `บันทึกส่งตรวจ ${picked.length} คันแล้ว - ดูต่อที่แท็บรอผลตรวจ` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
      if ((err as { status?: number }).status === 409) load(true);
    } finally {
      setSaving(false);
    }
  }

  async function record(row: Row, result: "PASS" | "FAIL") {
    const resultDate = textToIso(resultTexts[row.job.id] ?? isoToDisplayDate(todayIso()));
    if (!resultDate) return setMessage({ text: `${plateOf(row.vehicle)}: กรุณากรอกวันที่ได้ผลตรวจให้ถูกต้อง`, error: true });
    setSaving(true);
    try {
      replace([(await oldVehicleJobsApi.recordInspectionResult(row.job.id, result, resultDate)).vehicle]);
      setResultTexts((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => id !== row.job.id)));
      setMessage({ text: `${plateOf(row.vehicle)}: บันทึกผล${result === "PASS" ? "ผ่าน - ไปยื่นงานได้" : "ไม่ผ่าน - กลับไปรอส่งตรวจ"}` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
      if ((err as { status?: number }).status === 409) load(true);
    } finally {
      setSaving(false);
    }
  }

  const allTicked = rows.length > 0 && rows.every((r) => selected.has(r.job.id));
  const writable = rows.some((r) => canWrite(r.vehicle));

  return (
    <section className="content">
      <Link href={OLD_VEHICLE_HOME} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← งานรถเก่า
      </Link>
      <h1>ตรวจรถ (งานรถเก่า)</h1>
      <PageTabs
        label="ขั้นตรวจรถ"
        tabs={[
          { href: OLD_VEHICLE_INSPECTION, label: `รอส่งตรวจ (${byTab["to-send"].length})`, selected: tab === "to-send" },
          { href: `${OLD_VEHICLE_INSPECTION}/result`, label: `รอผลตรวจ (${byTab["to-result"].length})`, selected: tab === "to-result" },
          { href: `${OLD_VEHICLE_INSPECTION}/passed`, label: `ตรวจผ่าน รอยื่น (${byTab.passed.length})`, selected: tab === "passed" },
        ]}
      />

      <div className="panel" style={{ marginTop: 20 }}>
        {tab === "to-send" && writable && (
          <div className="inspect-select-all">
            <div className="inspect-select-all-info">
              <label>
                <input
                  type="checkbox"
                  checked={allTicked}
                  onChange={(e) => setSelected(e.target.checked ? new Set(rows.filter((r) => canWrite(r.vehicle)).map((r) => r.job.id)) : new Set())}
                />
                เลือกทั้งหมด ({picked.length}/{rows.length})
              </label>
              <label>
                วันที่ส่งตรวจ
                <DateTextInput value={sentText} onChange={setSentText} label="วันที่ส่งตรวจ" />
              </label>
              <label>
                <input type="radio" name="sentType" checked={sentType === "OUTSIDE"} onChange={() => setSentType("OUTSIDE")} />
                ส่งตรวจนอก
              </label>
              <label>
                <input type="radio" name="sentType" checked={sentType === "BRING_IN"} onChange={() => setSentType("BRING_IN")} />
                นำรถมาตรวจ (ไม่มีค่าตรวจ)
              </label>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={() => print(picked, sentText)} disabled={saving}>
                ปริ้นใบส่งตรวจ
              </button>
              <button type="button" className="primary" onClick={send} disabled={saving}>
                บันทึกส่งตรวจ
              </button>
            </div>
          </div>
        )}
        {message.text && (
          <p className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ padding: "10px 22px 0" }}>
            {message.text}
          </p>
        )}

        {truncated && (
          <p className="customer-message error" role="alert" style={{ padding: "10px 22px 0" }}>
            รถในคิวตรวจมีมากกว่า 500 คัน - แสดงไม่ครบ
          </p>
        )}
        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : error ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-customers">ไม่มีรถในขั้นนี้</div>
        ) : (
          <div className="table-wrap">
            <table className="inspect-table">
              <thead>
                <tr>
                  {tab === "to-send" && <th />}
                  <th scope="col">รถ</th>
                  <th scope="col">งาน</th>
                  <th scope="col">ลูกค้า / วันที่รับ</th>
                  {tab === "to-send" ? <th scope="col">ค่าตรวจ (ส่งตรวจนอก)</th> : <th scope="col">ส่งตรวจ</th>}
                  {tab === "to-result" && <th scope="col">ผลตรวจ</th>}
                  {tab === "passed" && <th scope="col">ผลตรวจ</th>}
                  {tab !== "to-send" && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const { vehicle, job } = row;
                  const editable = canWrite(vehicle);
                  const submitHref = editable ? nextStepHref(vehicle, job) : null;
                  return (
                    <tr key={job.id}>
                      {tab === "to-send" && (
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`เลือก ${plateOf(vehicle)}`}
                            disabled={!editable}
                            checked={selected.has(job.id)}
                            onChange={(e) =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(job.id);
                                else next.delete(job.id);
                                return next;
                              })
                            }
                          />
                        </td>
                      )}
                      <td>
                        <div className="job">{plateOf(vehicle)}</div>
                        <div className="sub">{[vehicle.brand, vehicle.vehicleType].filter(Boolean).join(" · ")}</div>
                        <div className="sub">
                          ตัวถัง {vehicle.chassis}
                          {vehicle.engine ? ` · เครื่อง ${vehicle.engine}` : ""}
                        </div>
                      </td>
                      <td>
                        {job.jobTypeLabel}
                        {job.blockedAt && <div className="badge alert" style={{ marginTop: 4 }}>ติดขัด: {job.blockedReasonLabel}</div>}
                        {tab === "to-send" && job.inspectionResult === "FAIL" && (
                          <div className="sub">ตรวจไม่ผ่านเมื่อ {job.inspectionResultDate ? isoToDisplayDate(job.inspectionResultDate) : ""} - ส่งตรวจใหม่</div>
                        )}
                      </td>
                      <td style={{ whiteSpace: "normal" }}>
                        <div className="job">{customerLabel(job.customer)}</div>
                        <div className="sub">รับ {isoToDisplayDate(job.receivedDate)}</div>
                      </td>
                      {tab === "to-send" ? (
                        <td>
                          <input
                            className="inspect-input"
                            inputMode="decimal"
                            aria-label={`ค่าตรวจ ${plateOf(vehicle)}`}
                            disabled={!editable || sentType === "BRING_IN"}
                            value={sentType === "BRING_IN" ? "0" : costOf(row)}
                            onChange={(e) => setCosts((prev) => ({ ...prev, [job.id]: moneyOnly(e.target.value) }))}
                            placeholder="บาท"
                          />
                        </td>
                      ) : (
                        <td>
                          {sentTypeLabel(job)}
                          <div className="sub">
                            {job.inspectionSentDate ? isoToDisplayDate(job.inspectionSentDate) : ""} · ค่าตรวจ {Number(job.inspectionCost).toLocaleString("th-TH")} บาท
                          </div>
                        </td>
                      )}
                      {tab === "to-result" && (
                        <td>
                          {editable ? (
                            <div className="inspect-row-checks">
                              <DateTextInput
                                value={resultTexts[job.id] ?? isoToDisplayDate(todayIso())}
                                onChange={(text) => setResultTexts((prev) => ({ ...prev, [job.id]: text }))}
                                label={`วันที่ได้ผลตรวจ ${plateOf(vehicle)}`}
                              />
                              <button type="button" className="primary" onClick={() => record(row, "PASS")} disabled={saving}>
                                ผ่าน
                              </button>
                              <button type="button" onClick={() => record(row, "FAIL")} disabled={saving}>
                                ไม่ผ่าน
                              </button>
                            </div>
                          ) : (
                            <span className="muted">รอผล</span>
                          )}
                        </td>
                      )}
                      {tab === "passed" && (
                        <td>
                          <span className="badge done">ผ่าน {job.inspectionResultDate ? isoToDisplayDate(job.inspectionResultDate) : ""}</span>
                          {submitHref && (
                            <div style={{ marginTop: 6 }}>
                              <Link href={submitHref} className="text-button">
                                ไปหน้ายื่นงาน →
                              </Link>
                            </div>
                          )}
                        </td>
                      )}
                      {tab !== "to-send" && (
                        <td>
                          {tab === "to-result" && (
                            <button type="button" className="text-button" onClick={() => print([row], job.inspectionSentDate ? isoToDisplayDate(job.inspectionSentDate) : "")}>
                              ปริ้นใบส่งตรวจ
                            </button>
                          )}
                          {editable && (
                            <button type="button" className="text-button danger" onClick={() => setUndo(row)}>
                              {tab === "passed" ? "ยกเลิกผลตรวจ" : "ยกเลิกการส่งตรวจ"}
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {undo && (
        <ReasonDialog
          title={undo.job.inspectionResult ? "ยกเลิกผลตรวจที่บันทึกผิด" : "ยกเลิกการส่งตรวจที่บันทึกผิด"}
          confirmLabel="ยืนยันยกเลิก"
          placeholder="เช่น บันทึกผิดคัน / ลงวันที่ผิด"
          onClose={() => setUndo(null)}
          onConfirm={async (remark) => {
            replace([(await oldVehicleJobsApi.undoInspection(undo.job.id, remark)).vehicle]);
            setMessage({ text: `${plateOf(undo.vehicle)}: ยกเลิกแล้ว` });
          }}
        >
          <p className="muted">
            {plateOf(undo.vehicle)} · {undo.job.jobTypeLabel} · {undo.job.inspectionResult ? "งานจะกลับไปรอผลตรวจ" : "งานจะกลับไปรอส่งตรวจ"}
          </p>
        </ReasonDialog>
      )}
    </section>
  );
}
