"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { canEditEntrySteps, canEditSubmitSteps, canIntakeOldJobs, getCachedUser, submitWriteScopeFor } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { WEEKEND_WARNING, isWeekend } from "@/lib/date-check";
import {
  BLOCKED_ALERT_DAYS,
  BLOCK_REASONS,
  OLD_JOB_COLUMNS,
  OLD_JOB_STATUS_LABEL,
  OLD_JOB_TYPES,
  OLD_JOB_TYPE_LABEL,
  OLD_VEHICLE_INSPECTION,
  OLD_VEHICLE_TYPE_GROUPS,
  OPEN_STATUSES,
  isSwapKind,
  SWAP_KIND_LABEL,
  classOfVehicleType,
  customerLabel,
  isClosedStatus,
  nextStepHref,
  oldVehicleJobsApi,
  plateOf,
  type HubJob,
  type HubVehicle,
  type IntakeVehicleInput,
  type OldJobStatus,
  type OldJobType,
  type OldVehicleClass,
  type SwapKind,
} from "@/lib/old-vehicle-jobs-api";
import { plateSwapApi, type PlateSwapVehicleHit } from "@/lib/plate-swap-api";
import { isTransportType } from "@/lib/vehicle-reference-data";
import { DateTextInput, ReasonDialog, errorText, textToIso } from "@/components/PlateSwapPages";

// หน้ารวม "งานรถเก่า" (ผู้ใช้ 2026-11-18): ทุกงานรถเก่าเริ่มจากรับงานที่นี่ แล้วเลือกประเภทงานต่อคัน
// จอใหญ่ = ตารางช่อง (หนึ่งแถวต่อคัน หนึ่งคอลัมน์ต่อกลุ่มงาน) / จอเล็ก = รายการ + ป้ายสถานะ (ผู้ใช้เลือก "แบบ 2 บนคอม แบบ 1 บนมือถือ")
// รอบที่ 1: รับงาน เลือกประเภทงาน ตรวจรถก่อนยื่น ติดขัด ทำที่นี่ - ขั้นยื่นและหลังจากนั้นกดแล้วไปหน้าเดิมของงานนั้น

type WriteScope = "ALL" | "CAR" | "MOTO" | "NONE";
type Option = { id: string; label: string };

function useWriteScope(): WriteScope | null {
  const [scope, setScope] = useState<WriteScope | null>(null);
  useEffect(() => {
    // แก้ / จัดการงานที่รับแล้ว: ADMIN ทุกคัน / กลุ่มยื่นเอกสารตามประเภทรถ / คนรับงานอย่างเดียว (STAFF_ENTRY / DELIVERY) = ไม่ได้
    // (ผู้ใช้ 2026-11-19: "คนรับงานเพิ่มได้เฉพาะเพิ่มงานรถเก่า อันอื่นกดไม่ได้") - ปุ่มรับงานใช้ useCanIntake แยกต่างหาก
    const roles = getCachedUser()?.roles ?? [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setScope(submitWriteScopeFor(roles));
  }, []);
  return scope;
}

// รับงานใหม่ได้เฉพาะ ADMIN / STAFF_ENTRY / DELIVERY (ผู้ใช้ 2026-11-18)
function useCanIntake(): boolean {
  const [can, setCan] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCan(canIntakeOldJobs(getCachedUser()?.roles ?? []));
  }, []);
  return can;
}
const canWriteClass = (scope: WriteScope | null, vehicleClass: OldVehicleClass) => scope === "ALL" || scope === vehicleClass;

function useChoices() {
  const [brandNames, setBrandNames] = useState<string[]>([]);
  const [customerOptions, setCustomerOptions] = useState<Option[]>([]);
  useEffect(() => {
    api
      .listBrands()
      .then((data) => setBrandNames(data.brands.map((b) => b.name)))
      .catch(() => undefined);
    api
      .listCustomers()
      .then((data) => setCustomerOptions(data.customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") }))))
      .catch(() => undefined);
  }, []);
  return { brandNames, customerOptions };
}

const daysSince = (iso: string) => Math.max(0, Math.round((Date.parse(todayIso()) - Date.parse(iso)) / 86_400_000));

function statusClass(job: HubJob): string {
  if (job.blockedAt) return "badge alert";
  if (job.status === "DONE") return "badge done";
  if (job.status === "CANCELLED") return "badge ov-cancelled";
  if (job.status === "NEW") return "badge warn";
  return "badge";
}

// ป้ายสถานะของงาน 1 งาน - กดเพื่อเปิดรายละเอียด/ทำขั้นถัดไป
function JobBadge({ job, withType, onClick }: { job: HubJob; withType: boolean; onClick: () => void }) {
  const text = `${withType && job.jobTypeLabel ? `${job.jobTypeLabel}: ` : ""}${OLD_JOB_STATUS_LABEL[job.status]}`;
  return (
    <>
      <button type="button" className={`${statusClass(job)} ov-badge`} onClick={onClick} title={job.blockedAt ? `ติดขัด: ${job.blockedReasonLabel ?? ""}` : undefined}>
        {job.blockedAt ? `ติดขัด · ${text}` : text}
      </button>
      {job.jobType === "PLATE_SWAP" && job.variant === "CHANGE" && <span className="sub ov-pair">เปลี่ยนเลขทะเบียน</span>}
      {job.pair && <span className="sub ov-pair">คู่กับ {job.pair.plate}</span>}
      {job.newVehicle && <span className="sub ov-pair">รถใหม่ {job.newVehicle.chassis}</span>}
    </>
  );
}

// ตัวเลขสรุปด้านบน - กดเพื่อกรอง
const SUMMARY: { key: string; label: string; statuses: OldJobStatus[] }[] = [
  { key: "NEW", label: "รอทำ", statuses: ["NEW"] },
  { key: "INSPECT", label: "รอตรวจรถ", statuses: ["TO_INSPECT", "TO_RESULT"] },
  { key: "TO_SUBMIT", label: "รอยื่น", statuses: ["TO_SUBMIT"] },
  { key: "RECEIPT", label: "รอใบเสร็จ", statuses: ["TO_PAY", "TO_RECEIPT"] },
  { key: "PLATE_BOOK", label: "รอป้าย / เล่ม", statuses: ["TO_PLATE", "TO_BOOK"] },
  { key: "TO_DELIVER", label: "รอส่งงาน", statuses: ["TO_DELIVER"] },
];

export function OldVehicleJobsPage() {
  const writeScope = useWriteScope();
  const canIntake = useCanIntake();
  const { brandNames, customerOptions } = useChoices();

  const [scope, setScope] = useState<"open" | "done" | "all">("open");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<"" | OldJobType>("");
  const [statusFilter, setStatusFilter] = useState(""); // สถานะเดียว, รหัสกลุ่มใน SUMMARY หรือ BLOCKED
  const [classFilter, setClassFilter] = useState<"" | OldVehicleClass>("");
  const [customerFilter, setCustomerFilter] = useState("");

  const [vehicles, setVehicles] = useState<HubVehicle[]>([]);
  const [truncated, setTruncated] = useState(false);
  // จำนวนรถงานค้าง / งานเสร็จแล้ว (ผู้ใช้ 2026-11-19: หน้าแรกเปิดที่งานค้าง แต่บอกว่ามีงานเสร็จแล้วกี่คัน กดดูได้)
  const [scopeCounts, setScopeCounts] = useState<{ open: number; done: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showIntake, setShowIntake] = useState(false);
  const [dialog, setDialog] = useState<
    | { kind: "job"; vehicleId: string; jobId: string }
    | { kind: "add"; vehicleId: string; jobType?: OldJobType }
    | { kind: "edit"; vehicleId: string }
    | null
  >(null);

  // หน่วงการค้นหาระหว่างพิมพ์
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 350);
    return () => clearTimeout(timer);
  }, [search]);

  // คำขอที่ช้ากว่า (เช่น โหลดตอน focus ก่อนพิมพ์ค้นหา) ต้องไม่ทับผลของคำขอล่าสุด
  const loadSeq = useRef(0);
  const load = useCallback(
    async (quiet = false) => {
      const seq = ++loadSeq.current;
      if (!quiet) setLoading(true);
      setError("");
      try {
        const data = await oldVehicleJobsApi.list(scope, query);
        if (seq !== loadSeq.current) return;
        setVehicles(data.vehicles);
        setTruncated(data.truncated);
        setScopeCounts(data.counts);
      } catch (err) {
        if (seq === loadSeq.current) setError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      } finally {
        if (seq === loadSeq.current) setLoading(false);
      }
    },
    [scope, query],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการเมื่อเปลี่ยนตัวกรองฝั่งเซิร์ฟเวอร์
    load();
  }, [load]);

  // กลับมาที่หน้านี้หลังไปทำขั้นอื่นในหน้าเดิมของงาน -> โหลดใหม่ให้สถานะตรง (หน้าคิวโหลดใหม่เมื่อ focus)
  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const replace = (updated: HubVehicle[]) =>
    setVehicles((prev) => {
      const map = new Map(updated.map((v) => [v.id, v]));
      const merged = prev.map((v) => map.get(v.id) ?? v);
      const added = updated.filter((v) => !prev.some((p) => p.id === v.id));
      return [...added, ...merged];
    });

  const jobMatches = useCallback(
    (job: HubJob) => {
      if (typeFilter && job.jobType !== typeFilter) return false;
      if (customerFilter && job.customer?.id !== customerFilter) return false;
      if (!statusFilter) return true;
      if (statusFilter === "BLOCKED") return !!job.blockedAt;
      const group = SUMMARY.find((s) => s.key === statusFilter);
      return group ? group.statuses.includes(job.status) : job.status === statusFilter;
    },
    [typeFilter, statusFilter, customerFilter],
  );
  const filtering = !!(typeFilter || statusFilter || customerFilter);

  const shown = useMemo(
    () => vehicles.filter((v) => (!classFilter || v.vehicleClass === classFilter) && (!filtering || v.jobs.some(jobMatches))),
    [vehicles, classFilter, filtering, jobMatches],
  );

  const counts = useMemo(() => {
    const jobs = vehicles.flatMap((v) => v.jobs);
    const out: Record<string, number> = { BLOCKED: jobs.filter((j) => j.blockedAt && !isClosedStatus(j.status)).length };
    for (const s of SUMMARY) out[s.key] = jobs.filter((j) => s.statuses.includes(j.status)).length;
    return out;
  }, [vehicles]);

  const customersInList = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of vehicles) for (const j of v.jobs) if (j.customer) map.set(j.customer.id, customerLabel(j.customer));
    return [...map].sort((a, b) => a[1].localeCompare(b[1], "th"));
  }, [vehicles]);

  const dialogVehicle = dialog ? vehicles.find((v) => v.id === dialog.vehicleId) : undefined;
  const dialogJob = dialog?.kind === "job" ? dialogVehicle?.jobs.find((j) => j.id === dialog.jobId) : undefined;

  // งานของกลุ่มงานในช่อง: ทุกงานที่ยังไม่เสร็จ (มีได้มากกว่า 1 เช่น งานโอนสองแบบ) - ไม่มีงานค้างจึงแสดงงานล่าสุดที่เสร็จแล้ว
  const cellJobs = (vehicle: HubVehicle, types: OldJobType[]) => {
    const jobs = vehicle.jobs.filter((j) => j.jobType && types.includes(j.jobType));
    const open = jobs.filter((j) => !isClosedStatus(j.status));
    return open.length ? open : jobs.slice(0, 1);
  };

  return (
    <section className="content">
      <div className="heading">
        <div>
          <h1>งานรถเก่า</h1>
          <p>รับงาน แล้วเลือกว่าจะทำงานอะไรต่อ - สลับเลข / งานโอน / ต่อภาษี / ยกเลิกการใช้รถ / ย้ายออก / คัดแผ่นป้าย</p>
          {/* เมนูเดิม 4 หมวดถูกซ่อนจากแถบข้างแล้ว (ผู้ใช้ 2026-11-18) - หน้าเดิมยังใช้ดูรายการที่ยื่น / รับใบเสร็จ / ตารางลงขัน */}
          <p className="muted" style={{ fontSize: 13 }}>
            หน้างานเดิม: <Link href="/registration/plate-swap">สลับเลข</Link> · <Link href="/registration/transfer">งานโอน</Link> ·{" "}
            <Link href="/registration/tax-renewal">ต่อภาษี</Link> · <Link href="/registration/other">อื่นๆ</Link>
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link href={OLD_VEHICLE_INSPECTION} className="text-button" style={{ alignSelf: "center" }}>
            ตรวจรถ ({counts.INSPECT ?? 0})
          </Link>
          {canIntake && (
            <button type="button" className="primary" onClick={() => setShowIntake((open) => !open)}>
              {showIntake ? "ปิดฟอร์มรับงาน" : "+ รับงาน"}
            </button>
          )}
        </div>
      </div>

      {showIntake && canIntake && (
        <IntakePanel
          writeScope={writeScope}
          brandNames={brandNames}
          customerOptions={customerOptions}
          onSaved={(saved) => {
            replace(saved);
            setShowIntake(false);
          }}
        />
      )}

      <div className="ov-summary" role="group" aria-label="สรุปงานที่ค้าง">
        {SUMMARY.map((s) => (
          <button key={s.key} type="button" className={`ov-tile${statusFilter === s.key ? " selected" : ""}`} onClick={() => setStatusFilter(statusFilter === s.key ? "" : s.key)}>
            <span>{s.label}</span>
            <strong>{counts[s.key] ?? 0}</strong>
          </button>
        ))}
        <button type="button" className={`ov-tile danger${statusFilter === "BLOCKED" ? " selected" : ""}`} onClick={() => setStatusFilter(statusFilter === "BLOCKED" ? "" : "BLOCKED")}>
          <span>ติดขัด</span>
          <strong>{counts.BLOCKED ?? 0}</strong>
        </button>
      </div>

      <div className="panel">
        <div className="ov-filters">
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ทะเบียน / เลขตัวถัง / เจ้าของรถ / ลูกค้า" aria-label="ค้นหา" />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as "" | OldJobType)} aria-label="ประเภทงาน">
            <option value="">ทุกประเภทงาน</option>
            {OLD_JOB_TYPES.map((t) => (
              <option key={t} value={t}>
                {OLD_JOB_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="สถานะ">
            <option value="">ทุกสถานะ</option>
            {OPEN_STATUSES.map((s) => (
              <option key={s} value={s}>
                {OLD_JOB_STATUS_LABEL[s]}
              </option>
            ))}
            <option value="DONE">เสร็จ</option>
            <option value="BLOCKED">ติดขัด</option>
            {SUMMARY.filter((s) => s.statuses.length > 1).map((s) => (
              <option key={s.key} value={s.key}>
                {s.label} (รวม)
              </option>
            ))}
          </select>
          <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} aria-label="ลูกค้า">
            <option value="">ทุกลูกค้า</option>
            {customersInList.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          {writeScope !== "CAR" && writeScope !== "MOTO" && (
            <select value={classFilter} onChange={(e) => setClassFilter(e.target.value as "" | OldVehicleClass)} aria-label="ประเภทรถ">
              <option value="">รถยนต์ + มอเตอร์ไซค์</option>
              <option value="CAR">รถยนต์</option>
              <option value="MOTO">มอเตอร์ไซค์</option>
            </select>
          )}
          <select value={scope} onChange={(e) => setScope(e.target.value as "open" | "done" | "all")} aria-label="ช่วงงาน">
            <option value="open">รถที่ยังมีงานค้าง{scopeCounts ? ` (${scopeCounts.open})` : ""}</option>
            <option value="done">รถที่งานเสร็จหมดแล้ว{scopeCounts ? ` (${scopeCounts.done})` : ""}</option>
            <option value="all">ทั้งหมด{scopeCounts ? ` (${scopeCounts.open + scopeCounts.done})` : ""}</option>
          </select>
          {scope === "open" && scopeCounts && scopeCounts.done > 0 && (
            <button type="button" className="text-button" onClick={() => setScope("done")}>
              งานเสร็จแล้ว {scopeCounts.done} คัน (ดู)
            </button>
          )}
          {scope !== "open" && (
            <button type="button" className="text-button" onClick={() => setScope("open")}>
              ← กลับไปดูงานค้าง
            </button>
          )}
        </div>

        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : error ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : shown.length === 0 ? (
          <div className="empty-customers">{vehicles.length === 0 ? "ยังไม่มีรถในรายการ - กด + รับงาน เพื่อเริ่ม" : "ไม่พบรถที่ตรงกับตัวกรอง"}</div>
        ) : (
          <>
            {/* จอใหญ่: ตารางช่อง */}
            <div className="table-wrap ov-grid">
              <table>
                <thead>
                  <tr>
                    <th scope="col">รถ</th>
                    <th scope="col">ลูกค้า / วันที่รับ</th>
                    {OLD_JOB_COLUMNS.map((c) => (
                      <th key={c.key} scope="col" style={{ textAlign: "center" }}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((vehicle) => {
                    const writable = canWriteClass(writeScope, vehicle.vehicleClass);
                    const untyped = vehicle.jobs.filter((j) => !j.jobType);
                    const latest = vehicle.jobs.find((j) => !isClosedStatus(j.status)) ?? vehicle.jobs[0];
                    return (
                      <tr key={vehicle.id}>
                        <td>
                          <button type="button" className="ov-vehicle" onClick={() => setDialog({ kind: "edit", vehicleId: vehicle.id })}>
                            <span className="job">{plateOf(vehicle)}</span>
                            <span className="sub">
                              {[vehicle.brand, vehicle.vehicleType ?? (vehicle.vehicleClass === "MOTO" ? "มอเตอร์ไซค์" : "รถยนต์")].filter(Boolean).join(" · ")}
                            </span>
                            <span className="sub">{vehicle.chassis}</span>
                          </button>
                          {untyped.map((job) => (
                            <div key={job.id} style={{ marginTop: 6 }}>
                              <JobBadge job={job} withType={false} onClick={() => setDialog({ kind: "job", vehicleId: vehicle.id, jobId: job.id })} />
                            </div>
                          ))}
                        </td>
                        <td style={{ whiteSpace: "normal", minWidth: 130 }}>
                          {latest && (
                            <>
                              <div className="job">{customerLabel(latest.customer)}</div>
                              <div className="sub">
                                รับ {isoToDisplayDate(latest.receivedDate)}
                                {latest.receivedIsBackfill ? " (วันที่คีย์งาน)" : ""}
                                {!isClosedStatus(latest.status) ? ` · ${daysSince(latest.receivedDate)} วัน` : ""}
                              </div>
                            </>
                          )}
                        </td>
                        {OLD_JOB_COLUMNS.map((c) => {
                          const jobs = cellJobs(vehicle, c.types);
                          return (
                            <td key={c.key} style={{ textAlign: "center" }}>
                              {jobs.length ? (
                                jobs.map((job) => (
                                  <div key={job.id} className="ov-cell-job">
                                    <JobBadge job={job} withType={c.types.length > 1} onClick={() => setDialog({ kind: "job", vehicleId: vehicle.id, jobId: job.id })} />
                                  </div>
                                ))
                              ) : writable ? (
                                <button
                                  type="button"
                                  className="ov-add"
                                  aria-label={`รับงาน${c.label} ให้ ${plateOf(vehicle)}`}
                                  onClick={() => setDialog({ kind: "add", vehicleId: vehicle.id, jobType: c.types.length === 1 ? c.types[0] : undefined })}
                                >
                                  +
                                </button>
                              ) : null}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* จอเล็ก: รายการ + ป้ายสถานะ */}
            <ul className="ov-list">
              {shown.map((vehicle) => {
                const latest = vehicle.jobs.find((j) => !isClosedStatus(j.status)) ?? vehicle.jobs[0];
                return (
                  <li key={vehicle.id}>
                    <button type="button" className="ov-vehicle" onClick={() => setDialog({ kind: "edit", vehicleId: vehicle.id })}>
                      <span className="job">{plateOf(vehicle)}</span>
                      <span className="sub">
                        {[vehicle.brand, latest ? customerLabel(latest.customer) : null, latest ? `รับ ${isoToDisplayDate(latest.receivedDate)}` : null].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                    <div className="ov-pills">
                      {vehicle.jobs.map((job) => (
                        <JobBadge key={job.id} job={job} withType onClick={() => setDialog({ kind: "job", vehicleId: vehicle.id, jobId: job.id })} />
                      ))}
                      {canIntake && (
                        <button type="button" className="text-button" onClick={() => setDialog({ kind: "add", vehicleId: vehicle.id })}>
                          + รับงานเพิ่ม
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {truncated && <p className="muted" style={{ padding: "12px 22px" }}>แสดง 500 คันแรก - ใช้ช่องค้นหาเพื่อหาคันอื่น</p>}
          </>
        )}
      </div>

      {dialog?.kind === "job" && dialogVehicle && dialogJob && (
        <JobDialog
          vehicle={dialogVehicle}
          job={dialogJob}
          canWrite={canWriteClass(writeScope, dialogVehicle.vehicleClass)}
          onClose={() => setDialog(null)}
          onUpdated={(v) => replace([v])}
          onCancelled={() => {
            setDialog(null);
            load(true);
          }}
        />
      )}
      {dialog?.kind === "add" && dialogVehicle && (
        <AddJobDialog
          vehicle={dialogVehicle}
          presetType={dialog.jobType}
          customerOptions={customerOptions}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            replace(saved);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "edit" && dialogVehicle && (
        <VehicleDialog
          vehicle={dialogVehicle}
          canWrite={canWriteClass(writeScope, dialogVehicle.vehicleClass)}
          brandNames={brandNames}
          onClose={() => setDialog(null)}
          onSaved={(v) => {
            replace([v]);
            setDialog(null);
          }}
          onOpenJob={(jobId) => setDialog({ kind: "job", vehicleId: dialogVehicle.id, jobId })}
          onAddJob={() => setDialog({ kind: "add", vehicleId: dialogVehicle.id })}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// ช่องเลือกประเภทงาน (+ วันที่ที่ต่อภาษีต้องใช้ตัดสินเรื่องตรวจรถ)
// ---------------------------------------------------------------------------------------------

interface JobTypeState {
  jobType: "" | OldJobType;
  swapKind: "" | SwapKind; // สลับเลขเท่านั้น
  newVehicle: { id: string; label: string } | null; // สลับเลข รถเก่า กับ รถใหม่: รถใหม่ที่จะรับเลข (ไม่บังคับ)
  firstRegText: string;
  taxExpiryText: string;
}
const EMPTY_TYPE: JobTypeState = { jobType: "", swapKind: "", newVehicle: null, firstRegText: "", taxExpiryText: "" };

const NEW_VEHICLE_ENTRY = "/registration/new-vehicle/entry";

// ช่องเลือกรถใหม่ที่จะรับเลข (สลับเลข รถเก่า กับ รถใหม่, ผู้ใช้ 2026-11-18): ค้นจากเลขตัวถังในฐานข้อมูลรถจดใหม่ ไม่บังคับ
// ไม่เจอ = ลิงก์ไปหน้าเพิ่มข้อมูลรถจดใหม่ในแท็บใหม่ (ข้อมูลที่กรอกค้างในฟอร์มนี้ไม่หาย) แล้วกลับมาค้นอีกครั้ง
function NewVehiclePicker({
  value,
  onChange,
  vehicleClass,
}: {
  value: { id: string; label: string } | null;
  onChange: (next: { id: string; label: string } | null) => void;
  vehicleClass: OldVehicleClass;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PlateSwapVehicleHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [canAddNew, setCanAddNew] = useState(false);
  // ค้นรถใหม่ใช้ API ของงานสลับเลข (กลุ่มยื่นเอกสาร) - คนคีย์รับงานที่ไม่ได้ถือ STAFF_CAR / STAFF_MOTO ค้นไม่ได้ ให้พนักงานยื่นเลือกทีหลัง
  const [canSearch, setCanSearch] = useState(true);
  useEffect(() => {
    const roles = getCachedUser()?.roles ?? [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCanAddNew(canEditEntrySteps(roles));
    setCanSearch(canEditSubmitSteps(roles));
  }, []);

  async function search() {
    const text = query.trim();
    if (text.length < 2) return setError("พิมพ์เลขตัวถังอย่างน้อย 2 ตัวอักษร");
    setError("");
    setSearching(true);
    try {
      setHits((await plateSwapApi.searchNewVehicles(text, undefined, vehicleClass)).vehicles);
    } catch (err) {
      setError(errorText(err, "ค้นหาไม่สำเร็จ"));
    } finally {
      setSearching(false);
    }
  }

  if (value) {
    return (
      <div className="field wide">
        รถใหม่ที่จะรับเลข
        <div className="ov-existing">
          {value.label}{" "}
          <button type="button" className="text-button" onClick={() => onChange(null)}>
            เปลี่ยน / เอาออก
          </button>
        </div>
      </div>
    );
  }
  if (!canSearch) {
    return (
      <div className="field wide">
        รถใหม่ที่จะรับเลข
        <span className="muted">พนักงานยื่นเอกสารเป็นคนเลือกรถใหม่ภายหลัง (บัญชีนี้ค้นฐานข้อมูลรถจดใหม่ของงานสลับเลขไม่ได้)</span>
      </div>
    );
  }
  return (
    <div className="field wide">
      รถใหม่ที่จะรับเลข (ยังไม่รู้เว้นว่างได้ ใส่ทีหลังได้)
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
          placeholder="เลขตัวถังรถใหม่"
          aria-label="เลขตัวถังรถใหม่"
        />
        <button type="button" onClick={search} disabled={searching}>
          {searching ? "กำลังค้น..." : "ค้นหา"}
        </button>
      </div>
      {error && <span className="customer-message error">{error}</span>}
      {hits && hits.length === 0 && (
        <span className="customer-message">
          ไม่พบรถใหม่เลขตัวถังนี้ในระบบ -{" "}
          {canAddNew ? (
            <a href={NEW_VEHICLE_ENTRY} target="_blank" rel="noreferrer">
              ไปเพิ่มข้อมูลรถจดใหม่ (เปิดแท็บใหม่)
            </a>
          ) : (
            "แจ้งพนักงานคีย์ข้อมูลให้เพิ่มรถคันนี้ในหน้าเพิ่มข้อมูลรถจดใหม่"
          )}{" "}
          แล้วกลับมากดค้นหาอีกครั้ง
        </span>
      )}
      {hits && hits.length > 0 && (
        <ul className="ov-history">
          {hits.map((hit) => {
            const label = [hit.chassis, hit.brandName, hit.customerName].filter(Boolean).join(" · ");
            return (
              <li key={hit.id}>
                <span>
                  {label}
                  {hit.linkBlockedReason && <span className="sub">{hit.linkBlockedReason}</span>}
                </span>
                <button type="button" disabled={!!hit.linkBlockedReason} onClick={() => onChange({ id: hit.id, label })}>
                  เลือก
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function jobTypeChoices(vehicleType: string | null | undefined): OldJobType[] {
  if (isTransportType(vehicleType)) return ["TAX_RENEWAL"]; // รถ ขส. ทำได้เฉพาะต่อภาษี
  return [...OLD_JOB_TYPES]; // โอนย้ายเข้าเปิดรถยนต์แล้ว (ผู้ใช้ 2026-11-18: Bill 330)
}

function JobTypeFields({
  value,
  onChange,
  vehicleType,
  vehicleClass,
  allowEmpty,
  allowPair,
  locked,
}: {
  value: JobTypeState;
  onChange: (next: JobTypeState) => void;
  vehicleType: string | null | undefined;
  vehicleClass: OldVehicleClass;
  allowEmpty: boolean;
  allowPair?: boolean; // ฟอร์มรับงานเท่านั้น: เลือก รถเก่า กับ รถเก่า ได้ (ต้องรับ 2 คันพร้อมกัน)
  locked?: boolean; // คันคู่ของงานสลับเลข - ประเภทงานตามคันแรก แก้ไม่ได้
}) {
  const needsDates = value.jobType === "TAX_RENEWAL" && !isTransportType(vehicleType);
  return (
    <>
      <label className="field">
        ประเภทงาน{allowEmpty ? "" : " *"}
        <select value={value.jobType} disabled={locked} onChange={(e) => onChange({ ...value, jobType: e.target.value as "" | OldJobType, swapKind: "", newVehicle: null })}>
          <option value="">{allowEmpty ? "ยังไม่เลือก (รอทำ)" : "เลือกประเภทงาน"}</option>
          {jobTypeChoices(vehicleType).map((t) => (
            <option key={t} value={t}>
              {OLD_JOB_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      {value.jobType === "PLATE_SWAP" && (
        <label className="field">
          แบบ (สลับเลข / เปลี่ยนเลขทะเบียน) *
          <select value={value.swapKind} disabled={locked} onChange={(e) => onChange({ ...value, swapKind: e.target.value as "" | SwapKind, newVehicle: null })}>
            <option value="">เลือกแบบ</option>
            <option value="OLD_NEW">สลับเลข {SWAP_KIND_LABEL.OLD_NEW} (รับคันเดียว)</option>
            <option value="CHANGE">{SWAP_KIND_LABEL.CHANGE} (คันเดียว รับเลขที่จองไว้)</option>
            {(allowPair || value.swapKind === "OLD_OLD") && <option value="OLD_OLD">สลับเลข {SWAP_KIND_LABEL.OLD_OLD} (รับ 2 คันพร้อมกัน)</option>}
          </select>
          {!allowPair && <span className="muted">รถเก่า กับ รถเก่า ต้องรับ 2 คันพร้อมกันจากปุ่ม + รับงาน</span>}
        </label>
      )}
      {value.jobType === "PLATE_SWAP" && value.swapKind === "OLD_NEW" && (
        <NewVehiclePicker value={value.newVehicle} onChange={(newVehicle) => onChange({ ...value, newVehicle })} vehicleClass={vehicleClass} />
      )}
      {value.jobType === "TAX_RENEWAL" && (
        <>
          <label className="field">
            วันจดทะเบียนครั้งแรก *
            <DateTextInput value={value.firstRegText} onChange={(firstRegText) => onChange({ ...value, firstRegText })} label="วันจดทะเบียนครั้งแรก" />
          </label>
          <label className="field">
            วันครบกำหนดภาษี *
            <DateTextInput value={value.taxExpiryText} onChange={(taxExpiryText) => onChange({ ...value, taxExpiryText })} label="วันครบกำหนดภาษี" />
          </label>
          <p className="muted wide">
            {needsDates
              ? "ระบบใช้สองวันนี้ตัดสินว่าต้องตรวจรถก่อนต่อภาษีไหม (รถยนต์ครบ 7 ปี / มอเตอร์ไซค์ครบ 5 ปี / ค้างภาษีเกิน 1 ปี)"
              : "รถตาม พ.ร.บ.ขนส่ง ต้องตรวจรถทุกครั้งก่อนต่อภาษี"}
          </p>
        </>
      )}
      {(value.jobType === "TRANSFER_INSPECTION" || value.jobType === "TRANSFER_MOVE_IN") && <p className="muted wide">งานนี้ต้องตรวจรถก่อนยื่น - ระบบจะส่งเข้าคิวตรวจรถให้</p>}
    </>
  );
}

function typePayload(state: JobTypeState): {
  jobType?: OldJobType;
  swapKind?: SwapKind;
  newVehicleId?: string;
  firstRegistrationDate?: string;
  taxExpiryDate?: string;
  error?: string;
} {
  if (!state.jobType) return {};
  if (state.jobType === "PLATE_SWAP") {
    if (!state.swapKind) return { error: "กรุณาเลือกแบบ (สลับเลข / เปลี่ยนเลขทะเบียน)" };
    return { jobType: state.jobType, swapKind: state.swapKind, newVehicleId: state.swapKind === "OLD_NEW" ? (state.newVehicle?.id ?? "") : undefined };
  }
  if (state.jobType !== "TAX_RENEWAL") return { jobType: state.jobType };
  const firstRegistrationDate = textToIso(state.firstRegText);
  const taxExpiryDate = textToIso(state.taxExpiryText);
  if (!firstRegistrationDate) return { error: "กรุณากรอกวันจดทะเบียนครั้งแรกให้ถูกต้อง" };
  if (!taxExpiryDate) return { error: "กรุณากรอกวันครบกำหนดภาษีให้ถูกต้อง" };
  return { jobType: state.jobType, firstRegistrationDate, taxExpiryDate };
}

// ---------------------------------------------------------------------------------------------
// ฟอร์มรับงาน: ลูกค้า + วันที่รับ ใช้ร่วมกัน รับได้หลายคัน
// ---------------------------------------------------------------------------------------------

interface IntakeRow {
  key: number;
  existing: HubVehicle | null; // รถที่มีอยู่แล้ว - ข้อมูลรถล็อก รับงานเพิ่มให้คันเดิม
  vehicleType: string;
  chassis: string;
  plateCategory: string;
  plateNumber: string;
  brand: string;
  ownerName: string;
  engine: string;
  note: string;
  type: JobTypeState;
  duplicateReason: string;
  needsReason: boolean;
  warnings: string[];
  pairOf: number | null; // คันคู่ของงานสลับเลข รถเก่า กับ รถเก่า - key ของคันแรก (ประเภทงานตามคันแรก)
}
let rowSeq = 1;
const newRow = (pairOf: number | null = null): IntakeRow => ({
  pairOf,
  key: rowSeq++,
  existing: null,
  vehicleType: "",
  chassis: "",
  plateCategory: "",
  plateNumber: "",
  brand: "",
  ownerName: "",
  engine: "",
  note: "",
  type: EMPTY_TYPE,
  duplicateReason: "",
  needsReason: false,
  warnings: [],
});

function IntakePanel({
  writeScope,
  brandNames,
  customerOptions,
  onSaved,
}: {
  writeScope: WriteScope | null;
  brandNames: string[];
  customerOptions: Option[];
  onSaved: (vehicles: HubVehicle[]) => void;
}) {
  const [customerId, setCustomerId] = useState("");
  const [receivedText, setReceivedText] = useState(() => isoToDisplayDate(todayIso()));
  const receivedDate = textToIso(receivedText);
  const [rows, setRows] = useState<IntakeRow[]>(() => [newRow()]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // แก้แถว แล้วจัดคันคู่ของงานสลับเลขให้ตรง: คันแรกเลือก "รถเก่า กับ รถเก่า" = มีคันคู่ต่อท้าย 1 แถวเสมอ (ประเภทงานตามคันแรก)
  // เปลี่ยนเป็นงานอื่น / เอาคันแรกออก = คันคู่หายไปด้วย
  const withPartners = (list: IntakeRow[]): IntakeRow[] => {
    const out: IntakeRow[] = [];
    for (const row of list) {
      if (row.pairOf !== null) continue;
      out.push(row);
      const wantsPair = row.type.jobType === "PLATE_SWAP" && row.type.swapKind === "OLD_OLD";
      if (!wantsPair) continue;
      const partner = list.find((r) => r.pairOf === row.key) ?? newRow(row.key);
      out.push({ ...partner, type: { ...EMPTY_TYPE, jobType: "PLATE_SWAP", swapKind: "OLD_OLD" } });
    }
    return out;
  };
  const patch = (key: number, change: Partial<IntakeRow>) => setRows((prev) => withPartners(prev.map((r) => (r.key === key ? { ...r, ...change } : r))));

  // พิมพ์เลขตัวถัง/ทะเบียนเสร็จ -> ถามระบบว่ามีคันนี้อยู่แล้วไหม + คำเตือนกันพิมพ์ผิด
  async function check(row: IntakeRow) {
    if (row.existing || (!row.chassis.trim() && !(row.plateCategory && row.plateNumber))) return;
    try {
      const found = await oldVehicleJobsApi.lookup(row.chassis.trim(), row.plateCategory.trim(), row.plateNumber.trim());
      const warnings = [...found.warnings];
      for (const other of found.plateMatches) warnings.push(`ทะเบียน ${plateOf(other)} มีในระบบแล้วแต่เลขตัวถังคือ ${other.chassis} - ตรวจว่าเป็นคันเดียวกันหรือไม่`);
      // คำตอบมาช้าหลังผู้ใช้แก้เลขตัวถัง/ทะเบียนไปแล้ว - ไม่เอาผลของค่าที่พิมพ์ก่อนหน้ามาใช้
      setRows((prev) =>
        prev.map((r) => {
          if (r.key !== row.key || r.existing) return r;
          if (r.chassis !== row.chassis || r.plateCategory !== row.plateCategory || r.plateNumber !== row.plateNumber) return r;
          // เจอรถเดิม: ล้างประเภทงานที่เลือกไว้ (ตัวเลือกขึ้นกับประเภทรถของคันเดิม) ยกเว้นคันคู่สลับเลขที่ประเภทงานตามคันแรก
          return found.vehicle ? { ...r, existing: found.vehicle, warnings, type: r.pairOf !== null ? r.type : EMPTY_TYPE } : { ...r, warnings };
        }),
      );
    } catch {
      // ตรวจไม่ได้ไม่ขวางการกรอก - backend ตรวจซ้ำตอนบันทึก
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!customerId) return setMessage({ text: "กรุณาเลือกเจ้าของงาน (ลูกค้า)", error: true });
    if (!receivedDate) return setMessage({ text: "กรุณากรอกวันที่รับงานให้ถูกต้อง", error: true });
    if (receivedDate > todayIso()) return setMessage({ text: "วันที่รับงานต้องไม่เกินวันนี้", error: true });
    const vehicles: IntakeVehicleInput[] = [];
    for (const [index, row] of rows.entries()) {
      const label = rows.length > 1 ? `คันที่ ${index + 1}: ` : "";
      const type = typePayload(row.type);
      if (type.error) return setMessage({ text: label + type.error, error: true });
      // คู่สลับเลข: สองคันส่งรหัสคู่เดียวกัน (key ของคันแรก) ให้ระบบจับคู่
      const pairKey = type.swapKind === "OLD_OLD" ? String(row.pairOf ?? row.key) : undefined;
      const shared = { ...type, pairKey, note: row.note.trim() || undefined, duplicateReason: row.duplicateReason.trim() || undefined };
      if (row.existing) {
        vehicles.push({ vehicleId: row.existing.id, ...shared });
        continue;
      }
      const missing = !row.vehicleType
        ? "ประเภทรถ"
        : !row.chassis.trim()
          ? "เลขตัวถัง"
          : !row.plateCategory.trim() || !row.plateNumber.trim()
            ? "ทะเบียน"
            : !row.brand
              ? "ยี่ห้อ"
              : !row.ownerName.trim()
                ? "ชื่อเจ้าของรถ"
                : "";
      if (missing) return setMessage({ text: `${label}กรุณากรอก${missing}`, error: true });
      vehicles.push({
        vehicleType: row.vehicleType,
        chassis: row.chassis,
        plateCategory: row.plateCategory,
        plateNumber: row.plateNumber,
        brand: row.brand,
        ownerName: row.ownerName,
        engine: row.engine,
        ...shared,
      });
    }
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const saved = await oldVehicleJobsApi.intake({ customerId, receivedDate, vehicles });
      onSaved(saved.vehicles);
    } catch (err) {
      const details = (err as { details?: { needsDuplicateReason?: boolean; vehicleIndex?: number | null } }).details;
      if (details?.needsDuplicateReason && typeof details.vehicleIndex === "number") {
        const target = rows[details.vehicleIndex];
        if (target) patch(target.key, { needsReason: true });
      }
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setSaving(false);
    }
  }

  const typeAllowed = (vehicleType: string) => writeScope === "ALL" || writeScope === classOfVehicleType(vehicleType);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <form className="customer-form" onSubmit={handleSubmit}>
        <h2>รับงาน</h2>
        <div className="customer-grid">
          <label className="field">
            เจ้าของงาน (ลูกค้าที่ส่งงานมา) *
            <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">เลือกลูกค้า</option>
              {customerOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            วันที่รับงาน *
            <DateTextInput value={receivedText} onChange={setReceivedText} label="วันที่รับงาน" />
            {receivedDate && isWeekend(receivedDate) && <span className="customer-message error">{WEEKEND_WARNING}</span>}
          </label>
        </div>

        {rows.map((row, index) => {
          const vehicleClass = row.existing ? row.existing.vehicleClass : classOfVehicleType(row.vehicleType);
          const vehicleType = row.existing ? row.existing.vehicleType : row.vehicleType;
          return (
            <fieldset key={row.key} className="ov-intake-row">
              <legend>
                คันที่ {index + 1}
                {row.pairOf !== null && " · คันคู่สลับเลข"}
                {rows.length > 1 && row.pairOf === null && (
                  <button type="button" className="text-button danger" onClick={() => setRows((prev) => withPartners(prev.filter((r) => r.key !== row.key)))}>
                    เอาออก
                  </button>
                )}
              </legend>
              {row.existing ? (
                <div className="ov-existing">
                  <strong>คันนี้มีอยู่ในระบบแล้ว - รับงานเพิ่มให้คันเดิม</strong>
                  <div>
                    {plateOf(row.existing)} · {[row.existing.brand, row.existing.vehicleType, row.existing.ownerName].filter(Boolean).join(" · ")} · ตัวถัง {row.existing.chassis}
                  </div>
                  {row.existing.jobs.length > 0 && (
                    <div className="sub">
                      งานที่มีอยู่:{" "}
                      {row.existing.jobs
                        .map((j) => `${j.jobTypeLabel ?? "ยังไม่เลือกงาน"} (รับ ${isoToDisplayDate(j.receivedDate)}) ${OLD_JOB_STATUS_LABEL[j.status]}`)
                        .join(" / ")}
                    </div>
                  )}
                  <button type="button" className="text-button" onClick={() => patch(row.key, { existing: null, chassis: "", warnings: [], type: row.pairOf !== null ? row.type : EMPTY_TYPE })}>
                    ไม่ใช่คันนี้ - พิมพ์เลขตัวถังใหม่
                  </button>
                </div>
              ) : (
                <div className="customer-grid">
                  <label className="field">
                    เลขตัวถัง *
                    <input
                      value={row.chassis}
                      onChange={(e) => patch(row.key, { chassis: e.target.value.toUpperCase().replace(/\s+/g, "") })}
                      onBlur={() => check(row)}
                    />
                  </label>
                  <label className="field">
                    เลขเครื่อง
                    <input value={row.engine} onChange={(e) => patch(row.key, { engine: e.target.value })} placeholder="ใส่ทีหลังได้" />
                  </label>
                  <div className="field">
                    ทะเบียน *
                    <div style={{ display: "flex", gap: 8 }}>
                      <input value={row.plateCategory} onChange={(e) => patch(row.key, { plateCategory: e.target.value })} onBlur={() => check(row)} maxLength={3} placeholder="หมวด เช่น 4กข" aria-label="หมวดทะเบียน" />
                      <input
                        value={row.plateNumber}
                        onChange={(e) => patch(row.key, { plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                        onBlur={() => check(row)}
                        maxLength={4}
                        inputMode="numeric"
                        placeholder="เลข เช่น 4444"
                        aria-label="เลขทะเบียน"
                      />
                    </div>
                  </div>
                  <label className="field">
                    ประเภทรถ (รย. / ขส.) *
                    <select value={row.vehicleType} onChange={(e) => patch(row.key, { vehicleType: e.target.value, type: row.pairOf !== null ? row.type : EMPTY_TYPE })}>
                      <option value="">เลือกประเภทรถ</option>
                      {OLD_VEHICLE_TYPE_GROUPS.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.types.filter(typeAllowed).map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    ยี่ห้อ *
                    <select value={row.brand} onChange={(e) => patch(row.key, { brand: e.target.value })}>
                      <option value="">เลือกยี่ห้อ</option>
                      {brandNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    ชื่อเจ้าของรถ *
                    <input value={row.ownerName} onChange={(e) => patch(row.key, { ownerName: e.target.value })} />
                  </label>
                </div>
              )}
              {row.warnings.map((w) => (
                <p key={w} className="customer-message error" role="alert">
                  {w}
                </p>
              ))}
              <div className="customer-grid" style={{ marginTop: 16 }}>
                <JobTypeFields value={row.type} onChange={(type) => patch(row.key, { type })} vehicleType={vehicleType} vehicleClass={vehicleClass} allowEmpty allowPair locked={row.pairOf !== null} />
                <label className="field">
                  หมายเหตุ
                  <input value={row.note} onChange={(e) => patch(row.key, { note: e.target.value })} />
                </label>
                {row.needsReason && (
                  <label className="field">
                    เหตุผลที่รับงานประเภทเดิมซ้ำ *
                    <input value={row.duplicateReason} onChange={(e) => patch(row.key, { duplicateReason: e.target.value })} />
                  </label>
                )}
              </div>
            </fieldset>
          );
        })}

        <div className="form-actions">
          <button type="button" onClick={() => setRows((prev) => [...prev, newRow()])} disabled={saving || rows.length >= 50}>
            + เพิ่มคัน
          </button>
          <button className="primary" type="submit" disabled={saving}>
            บันทึกรับงาน {rows.length > 1 ? `(${rows.length} คัน)` : ""}
          </button>
          <span className={`customer-message${message.error ? " error" : ""}`} role="status">
            {message.text}
          </span>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// ป๊อปอัป
// ---------------------------------------------------------------------------------------------

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onClose={onClose} style={{ width: wide ? "min(680px, 94vw)" : "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => ref.current?.close()}>
        ×
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

function VehicleLine({ vehicle }: { vehicle: HubVehicle }) {
  return (
    <p className="muted">
      {plateOf(vehicle)} · {[vehicle.brand, vehicle.vehicleType, vehicle.ownerName].filter(Boolean).join(" · ")} · ตัวถัง {vehicle.chassis}
    </p>
  );
}

// รับงานเพิ่มให้รถที่มีอยู่แล้ว (กด + ในช่องของงาน)
function AddJobDialog({
  vehicle,
  presetType,
  customerOptions,
  onClose,
  onSaved,
}: {
  vehicle: HubVehicle;
  presetType?: OldJobType;
  customerOptions: Option[];
  onClose: () => void;
  onSaved: (vehicles: HubVehicle[]) => void;
}) {
  const lastCustomer = vehicle.jobs.find((j) => j.customer)?.customer?.id ?? "";
  const [customerId, setCustomerId] = useState(lastCustomer);
  const [receivedText, setReceivedText] = useState(() => isoToDisplayDate(todayIso()));
  const [type, setType] = useState<JobTypeState>({ ...EMPTY_TYPE, jobType: presetType ?? "", swapKind: presetType === "PLATE_SWAP" ? "OLD_NEW" : "" });
  const [note, setNote] = useState("");
  const [duplicateReason, setDuplicateReason] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const receivedDate = textToIso(receivedText);
    if (!customerId) return setError("กรุณาเลือกเจ้าของงาน (ลูกค้า)");
    if (!receivedDate) return setError("กรุณากรอกวันที่รับงานให้ถูกต้อง");
    if (receivedDate > todayIso()) return setError("วันที่รับงานต้องไม่เกินวันนี้");
    const payload = typePayload(type);
    if (payload.error) return setError(payload.error);
    setSaving(true);
    try {
      const saved = await oldVehicleJobsApi.intake({
        customerId,
        receivedDate,
        vehicles: [{ vehicleId: vehicle.id, ...payload, note: note.trim() || undefined, duplicateReason: duplicateReason.trim() || undefined }],
      });
      onSaved(saved.vehicles);
    } catch (err) {
      if ((err as { details?: { needsDuplicateReason?: boolean } }).details?.needsDuplicateReason) setNeedsReason(true);
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="รับงานเพิ่มให้คันนี้" onClose={onClose} wide>
      <VehicleLine vehicle={vehicle} />
      <div className="customer-grid" style={{ marginTop: 12 }}>
        <label className="field">
          เจ้าของงาน (ลูกค้า) *
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">เลือกลูกค้า</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          วันที่รับงาน *
          <DateTextInput value={receivedText} onChange={setReceivedText} label="วันที่รับงาน" />
          {isWeekend(textToIso(receivedText)) && <span className="customer-message error">{WEEKEND_WARNING}</span>}
        </label>
        <JobTypeFields value={type} onChange={setType} vehicleType={vehicle.vehicleType} vehicleClass={vehicle.vehicleClass} allowEmpty />
        <label className="field">
          หมายเหตุ
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        {needsReason && (
          <label className="field wide">
            เหตุผลที่รับงานประเภทเดิมซ้ำ *
            <input value={duplicateReason} onChange={(e) => setDuplicateReason(e.target.value)} />
          </label>
        )}
      </div>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "บันทึกรับงาน"}
        </button>
      </div>
    </Modal>
  );
}

// รายละเอียดงาน 1 งาน: เลือกประเภทงาน / ไปขั้นถัดไป / ติดขัด / ยกเลิกการรับงาน
const baht = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

// ยอดเงินของงาน (ผู้ใช้ 2026-11-19: "รอรับเอกสาร / ยื่น กดไปทำไมไม่มีค่า Bill / No Bill") - ยื่นแล้วแสดง snapshot ของงานจริง
// ยังไม่ยื่น = ยอดคิดตอนยื่น (ขึ้นกับตัวเลือกในฟอร์มยื่น เช่น ด่วน / ขอใช้ / จังหวัด) · บัญชีที่ไม่เห็นราคาไม่แสดงกล่องนี้
function JobFeesBox({ job }: { job: HubJob }) {
  if (!job.jobType || job.status === "CANCELLED") return null;
  if (!job.jobId) {
    return (
      <p className="muted">
        ค่าใช้จ่าย: ระบบคิดตอนกดยื่น (ขึ้นกับงานด่วน / ประเภทที่เลือกในฟอร์มยื่น)
        {job.inspectionCost && Number(job.inspectionCost) > 0 ? ` · ค่าตรวจรถ ${baht(Number(job.inspectionCost))} บาท` : ""}
      </p>
    );
  }
  const f = job.fees;
  if (!f) return null;
  const total = (f.bill ?? 0) + (f.noBill ?? 0);
  return (
    <div className="customer-grid" style={{ margin: "8px 0 12px", padding: "10px 14px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
      <div>
        <strong>Bill</strong>
        <div>{f.bill === null ? "ยังไม่คิด (ยังไม่ชำระ)" : `${baht(f.bill)} บาท`}</div>
        {f.receiptAmount !== null && <div className="sub">ยอดบนใบเสร็จ {baht(f.receiptAmount)} บาท</div>}
      </div>
      <div>
        <strong>No Bill</strong>
        <div>{f.noBill === null ? "-" : `${baht(f.noBill)} บาท`}</div>
        {f.inspectionCost > 0 && <div className="sub">+ ค่าตรวจรถ {baht(f.inspectionCost)} บาท</div>}
      </div>
      <div>
        <strong>ค่าอากร</strong>
        <div>{baht(f.duty)} บาท (แยกต่างหาก)</div>
      </div>
      <div>
        <strong>รวม Bill + No Bill</strong>
        <div>{baht(total)} บาท</div>
      </div>
    </div>
  );
}

function JobDialog({
  vehicle,
  job,
  canWrite,
  onClose,
  onUpdated,
  onCancelled,
}: {
  vehicle: HubVehicle;
  job: HubJob;
  canWrite: boolean;
  onClose: () => void;
  onUpdated: (vehicle: HubVehicle) => void;
  onCancelled: () => void;
}) {
  const [type, setType] = useState<JobTypeState>({
    jobType: job.jobType ?? "",
    swapKind: job.jobType === "PLATE_SWAP" && isSwapKind(job.variant) ? job.variant : "",
    newVehicle: job.newVehicle ? { id: job.newVehicle.id, label: [job.newVehicle.chassis, job.newVehicle.brandName].join(" · ") } : null,
    firstRegText: job.firstRegistrationDate ? isoToDisplayDate(job.firstRegistrationDate) : "",
    taxExpiryText: job.taxExpiryDate ? isoToDisplayDate(job.taxExpiryDate) : "",
  });
  const [duplicateReason, setDuplicateReason] = useState("");
  const [needsReason, setNeedsReason] = useState(false);
  const [blockReason, setBlockReason] = useState("");
  const [blockNote, setBlockNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);

  const submitted = !!job.jobId;
  const closed = isClosedStatus(job.status);
  // คู่สลับเลขรับเป็นคู่ - เปลี่ยนประเภทงานของคันเดียวไม่ได้ (ยกเลิกการรับงานแล้วรับใหม่)
  const canChangeType = canWrite && !submitted && !job.inspectionSentDate && !job.pair;
  // คนรับงานอย่างเดียวไม่ได้ทำขั้นถัดไป - ไม่แสดงปุ่มไปหน้ายื่น / ใบเสร็จ
  const next = canWrite ? nextStepHref(vehicle, job) : null;

  async function run(action: () => Promise<{ vehicle: HubVehicle }>) {
    setError("");
    setSaving(true);
    try {
      onUpdated((await action()).vehicle);
      return true;
    } catch (err) {
      if ((err as { details?: { needsDuplicateReason?: boolean } }).details?.needsDuplicateReason) setNeedsReason(true);
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function saveType() {
    const payload = typePayload(type);
    if (payload.error) return setError(payload.error);
    if (!payload.jobType) return setError("กรุณาเลือกประเภทงาน");
    const { jobType, swapKind, newVehicleId, firstRegistrationDate, taxExpiryDate } = payload;
    void run(() =>
      oldVehicleJobsApi.chooseType(job.id, { jobType, swapKind, newVehicleId, firstRegistrationDate, taxExpiryDate, duplicateReason: duplicateReason.trim() || undefined }),
    );
  }

  if (cancelling) {
    return (
      <ReasonDialog
        title="ยกเลิกการรับงาน"
        confirmLabel="ยืนยันยกเลิก"
        placeholder="เช่น รับซ้ำ / ลูกค้ายกเลิก"
        onClose={() => setCancelling(false)}
        onConfirm={async (remark) => {
          await oldVehicleJobsApi.cancel(job.id, remark);
          onCancelled();
        }}
      >
        <VehicleLine vehicle={vehicle} />
        {job.pair && <p>งานนี้เป็นคู่สลับเลขกับ {job.pair.plate} - การรับงานของคันคู่จะถูกยกเลิกไปด้วย</p>}
      </ReasonDialog>
    );
  }

  return (
    <Modal title={job.jobTypeLabel ?? "ยังไม่ได้เลือกประเภทงาน"} onClose={onClose} wide>
      <VehicleLine vehicle={vehicle} />
      <p>
        <span className={statusClass(job)}>{OLD_JOB_STATUS_LABEL[job.status]}</span> · {customerLabel(job.customer)} · รับงาน {isoToDisplayDate(job.receivedDate)}
        {job.receivedIsBackfill ? " (งานที่คีย์ไว้ก่อนมีหน้ารับงาน - ใช้วันที่คีย์งานแทน)" : ""}
        {!closed ? ` · ${daysSince(job.receivedDate)} วันแล้ว` : ""}
      </p>
      {job.jobType === "PLATE_SWAP" && isSwapKind(job.variant) && (
        <p className="muted">
          แบบ: {SWAP_KIND_LABEL[job.variant]}
          {job.pair ? ` · คู่กับ ${job.pair.plate}` : ""}
          {job.newVehicle ? ` · รถใหม่ที่รับเลข ${job.newVehicle.chassis} (${job.newVehicle.brandName})` : job.variant === "OLD_NEW" ? " · ยังไม่ได้เลือกรถใหม่" : ""}
        </p>
      )}
      {job.note && <p className="muted">หมายเหตุ: {job.note}</p>}
      <JobFeesBox job={job} />
      {job.inspectionRequired && !submitted && (
        <p className="muted">
          ตรวจรถก่อนยื่น:{" "}
          {job.inspectionSentDate
            ? `${job.inspectionSentType === "BRING_IN" ? "นำรถมาตรวจ" : "ส่งตรวจนอก"} ${isoToDisplayDate(job.inspectionSentDate)}${
                job.inspectionResult ? ` · ผล${job.inspectionResult === "PASS" ? "ผ่าน" : "ไม่ผ่าน"} ${job.inspectionResultDate ? isoToDisplayDate(job.inspectionResultDate) : ""}` : " · รอผล"
              }`
            : "ยังไม่ได้ส่งตรวจ"}
        </p>
      )}

      {canChangeType && (
        <div className="customer-grid" style={{ marginTop: 12 }}>
          <JobTypeFields value={type} onChange={setType} vehicleType={vehicle.vehicleType} vehicleClass={vehicle.vehicleClass} allowEmpty={false} />
          {needsReason && (
            <label className="field wide">
              เหตุผลที่รับงานประเภทเดิมซ้ำ *
              <input value={duplicateReason} onChange={(e) => setDuplicateReason(e.target.value)} />
            </label>
          )}
          <div className="wide">
            <button type="button" className="primary" onClick={saveType} disabled={saving}>
              {job.jobType ? "บันทึกการเปลี่ยน" : "บันทึกประเภทงาน"}
            </button>
          </div>
        </div>
      )}

      {next && (
        <p style={{ marginTop: 14 }}>
          <Link href={next} className="primary" style={{ display: "inline-flex", textDecoration: "none" }}>
            {job.status === "TO_SUBMIT" ? "ไปหน้ายื่นงาน" : job.status === "TO_DELIVER" ? "ไปหน้า Delivery" : `ไปทำขั้น${OLD_JOB_STATUS_LABEL[job.status].replace("รอ", "")}`} →
          </Link>
          {job.status === "TO_SUBMIT" && (
            <span className="muted" style={{ display: "block", marginTop: 6 }}>
              ยื่นในหน้าเดิมของงานนี้ด้วยเลขตัวถัง {vehicle.chassis} - ระบบจะผูกงานที่ยื่นกลับมาที่แถวนี้เอง
            </span>
          )}
        </p>
      )}

      {canWrite && !closed && (
        <div className="ov-block">
          {job.blockedAt ? (
            <>
              <strong>
                ติดขัด {job.blockedDays ?? 0} วัน: {job.blockedReasonLabel}
              </strong>
              {job.blockedNote && <div className="sub">{job.blockedNote}</div>}
              {(job.blockedDays ?? 0) > BLOCKED_ALERT_DAYS && <div className="sub">เกิน {BLOCKED_ALERT_DAYS} วันทำการ - ขึ้นเตือนในภาพรวมผู้บริหาร</div>}
              <button type="button" onClick={() => run(() => oldVehicleJobsApi.unblock(job.id))} disabled={saving} style={{ marginTop: 8 }}>
                ปลดติดขัด
              </button>
            </>
          ) : (
            <>
              <strong>ติดขัด (เช่น เอกสารไม่ครบ)</strong>
              <div className="customer-grid" style={{ marginTop: 8 }}>
                <label className="field">
                  เหตุผล
                  <select value={blockReason} onChange={(e) => setBlockReason(e.target.value)}>
                    <option value="">เลือกเหตุผล</option>
                    {BLOCK_REASONS.map(([code, label]) => (
                      <option key={code} value={code}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  รายละเอียด{blockReason === "OTHER" ? " *" : ""}
                  <input value={blockNote} onChange={(e) => setBlockNote(e.target.value)} />
                </label>
              </div>
              <button
                type="button"
                style={{ marginTop: 8 }}
                disabled={saving || !blockReason || (blockReason === "OTHER" && !blockNote.trim())}
                onClick={async () => {
                  if (await run(() => oldVehicleJobsApi.block(job.id, blockReason, blockNote.trim()))) {
                    setBlockReason("");
                    setBlockNote("");
                  }
                }}
              >
                ติดธงติดขัด
              </button>
            </>
          )}
        </div>
      )}

      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      {canWrite && !submitted && (
        <div className="form-actions">
          <button type="button" className="text-button danger" onClick={() => setCancelling(true)}>
            ยกเลิกการรับงานนี้
          </button>
        </div>
      )}
    </Modal>
  );
}

// ข้อมูลรถ + ประวัติงานของคันนั้น + แก้ข้อมูลรถ (ต้องมีเหตุผล)
function VehicleDialog({
  vehicle,
  canWrite,
  brandNames,
  onClose,
  onSaved,
  onOpenJob,
  onAddJob,
}: {
  vehicle: HubVehicle;
  canWrite: boolean;
  brandNames: string[];
  onClose: () => void;
  onSaved: (vehicle: HubVehicle) => void;
  onOpenJob: (jobId: string) => void;
  onAddJob: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    vehicleType: vehicle.vehicleType ?? "",
    plateCategory: vehicle.plateCategory,
    plateNumber: vehicle.plateNumber,
    chassis: vehicle.chassis,
    engine: vehicle.engine ?? "",
    brand: vehicle.brand ?? "",
    ownerName: vehicle.ownerName ?? "",
    remark: "",
  });
  // เวลาแก้ล่าสุดที่ผู้ใช้เห็นตอนเปิดฟอร์ม - เก็บคู่กับค่าในฟอร์ม ไม่อ่านจาก vehicle ที่ถูกโหลดใหม่ตอน focus
  // (ไม่งั้นคนอื่นแก้ระหว่างเปิดฟอร์มค้างไว้แล้วบันทึกทับได้โดยไม่ขึ้น 409)
  const [seenUpdatedAt] = useState(vehicle.updatedAt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const brands = useMemo(() => Array.from(new Set([...(vehicle.brand ? [vehicle.brand] : []), ...brandNames])), [vehicle.brand, brandNames]);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function save() {
    setError("");
    if (!form.vehicleType) return setError("กรุณาเลือกประเภทรถ");
    if (!form.remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้ข้อมูลรถ");
    setSaving(true);
    try {
      onSaved((await oldVehicleJobsApi.updateVehicle(vehicle.id, { ...form, remark: form.remark.trim(), expectedUpdatedAt: seenUpdatedAt })).vehicle);
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`รถ ${plateOf(vehicle)}`} onClose={onClose} wide>
      {!editing ? (
        <>
          <VehicleLine vehicle={vehicle} />
          {vehicle.engine && <p className="muted">เลขเครื่อง {vehicle.engine}</p>}
          <h3 style={{ margin: "14px 0 8px", fontSize: 15 }}>งานของคันนี้</h3>
          <ul className="ov-history">
            {vehicle.jobs.map((job) => (
              <li key={job.id}>
                <span>
                  รับ {isoToDisplayDate(job.receivedDate)} · {customerLabel(job.customer)}
                </span>
                <JobBadge job={job} withType onClick={() => onOpenJob(job.id)} />
              </li>
            ))}
          </ul>
          {canWrite && (
            <div className="form-actions">
              <button type="button" className="primary" onClick={onAddJob}>
                + รับงานเพิ่มให้คันนี้
              </button>
              <button type="button" onClick={() => setEditing(true)}>
                แก้ข้อมูลรถ
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="customer-grid">
            <label className="field">
              เลขตัวถัง *
              <input value={form.chassis} onChange={(e) => setForm((prev) => ({ ...prev, chassis: e.target.value.toUpperCase().replace(/\s+/g, "") }))} />
            </label>
            <label className="field">
              เลขเครื่อง
              <input value={form.engine} onChange={set("engine")} />
            </label>
            <div className="field">
              ทะเบียน *
              <div style={{ display: "flex", gap: 8 }}>
                <input value={form.plateCategory} onChange={set("plateCategory")} maxLength={3} aria-label="หมวดทะเบียน" />
                <input value={form.plateNumber} onChange={(e) => setForm((prev) => ({ ...prev, plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) }))} maxLength={4} inputMode="numeric" aria-label="เลขทะเบียน" />
              </div>
            </div>
            <label className="field">
              ประเภทรถ (รย. / ขส.) *
              <select value={form.vehicleType} onChange={set("vehicleType")}>
                <option value="">เลือกประเภทรถ</option>
                {OLD_VEHICLE_TYPE_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.types.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field">
              ยี่ห้อ *
              <select value={form.brand} onChange={set("brand")}>
                <option value="">เลือกยี่ห้อ</option>
                {brands.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              ชื่อเจ้าของรถ *
              <input value={form.ownerName} onChange={set("ownerName")} />
            </label>
            <label className="field wide">
              เหตุผลที่แก้ *
              <input value={form.remark} onChange={set("remark")} placeholder="เช่น พิมพ์เลขตัวถังผิด" />
            </label>
          </div>
          <p className="muted" style={{ marginTop: 10 }}>
            ข้อมูลรถในงานที่ยื่นไปแล้วไม่ถูกแก้ตาม - แก้ที่หน้าของงานนั้นถ้าต้องการ
          </p>
          {error && (
            <p className="customer-message error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" onClick={() => setEditing(false)} disabled={saving}>
              ย้อนกลับ
            </button>
            <button type="button" className="primary" onClick={save} disabled={saving}>
              {saving ? "กำลังบันทึก..." : "บันทึกการแก้"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
