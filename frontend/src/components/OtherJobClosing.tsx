"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type ClosedBillingJob, type OtherJob } from "@/lib/billing-api";
import { isoToDisplayDate, timestampToDisplayDate } from "@/lib/date";

// ปิดงาน - วางบิลนอกระบบ ของงานอื่นๆ (ผู้ใช้ 2026-10-13, เหมือนของรถในหน้า /accounting/billing)
// งานที่ส่งงานลูกค้าแล้วแต่วางบิลที่อื่น (บัญชีส่วนตัว / Google Sheet / เหมาจ่าย): ADMIN / ACCOUNTANT ปิดพร้อมหมายเหตุ -> ออกจากคิวรอวางบิล
// เปิดกลับได้เฉพาะ ADMIN พร้อมเหตุผล

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
// เซิร์ฟเวอร์ตอบกลับมาแล้ว (ไม่ใช่เน็ตหลุด) = ข้อมูลอาจเปลี่ยนไปแล้ว ให้โหลดคิวใหม่
const refusedByServer = (err: unknown) => err instanceof ApiError && err.status !== undefined;

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return ref;
}

export function CloseJobDialog({ job, customerName, onClose, onClosed, onRefused }: { job: OtherJob; customerName: string; onClose: () => void; onClosed: () => void; onRefused: () => void }) {
  const dialogRef = useModal();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setError("");
    if (!note.trim()) return setError("ต้องใส่หมายเหตุ เช่น วางบิลที่ไหน เลขที่อะไร");
    setSaving(true);
    try {
      await billingApi.closeJobBilling(job.type, job.id, note.trim());
      onClosed();
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "ปิดงานไม่สำเร็จ"));
      if (refusedByServer(err)) onRefused();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ปิดงาน - วางบิลนอกระบบ</h2>
      <p className="muted">
        {job.typeLabel} · {job.plateText || "ยังไม่มีทะเบียน"} · {job.chassis}
        <br />
        {customerName} · ส่งงานเมื่อ {isoToDisplayDate(job.deliveredDate)}
      </p>
      <p style={{ fontSize: 13, marginTop: 8 }}>ใช้กับงานที่วางบิลที่อื่นแล้ว (บัญชีส่วนตัว / Google Sheet / เหมาจ่าย) หรือไม่ต้องวางบิล - งานจะออกจากคิวรอวางบิล เปิดงานกลับได้เฉพาะ ADMIN</p>
      <label className="field" style={{ marginTop: 12 }}>
        หมายเหตุ *
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น วางบิลใน Google Sheet IV2026-130" />
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
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "ปิดงาน"}
        </button>
      </div>
    </dialog>
  );
}

function ReopenJobDialog({ job, onClose, onReopened, onRefused }: { job: ClosedBillingJob; onClose: () => void; onReopened: () => void; onRefused: () => void }) {
  const dialogRef = useModal();
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setError("");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่เปิดงานกลับ");
    setSaving(true);
    try {
      await billingApi.reopenJobBilling(job.type, job.id, remark.trim());
      onReopened();
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "เปิดงานกลับไม่สำเร็จ"));
      if (refusedByServer(err)) onRefused();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>เปิดงานกลับ</h2>
      <p className="muted">
        {job.typeLabel} · {job.plateText || "ยังไม่มีทะเบียน"} · {job.chassis ?? "—"} · {job.customerName ?? "—"}
        <br />
        ปิดไว้เมื่อ {timestampToDisplayDate(job.closedAt)}: {job.note || "—"}
      </p>
      <p style={{ fontSize: 13, marginTop: 8 }}>งานจะกลับเข้าคิวรอวางบิลงานอื่นๆ (ถ้ายังส่งงานลูกค้าแล้วและไม่ถูกยกเลิก)</p>
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่เปิดงานกลับ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ปิดผิดงาน ต้องวางบิลในระบบ" />
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
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "เปิดงานกลับ"}
        </button>
      </div>
    </dialog>
  );
}

// รายการงานที่ปิดงานไว้ ใหม่สุดก่อนทีละ 100 งาน - ไม่มีเลยไม่แสดง / ADMIN กด "เปิดงานกลับ" แล้วงานกลับเข้าคิวรอวางบิล
export function ClosedJobsPanel({ reloadKey, canReopen, onReopened }: { reloadKey: number; canReopen: boolean; onReopened: () => void }) {
  const [jobs, setJobs] = useState<ClosedBillingJob[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [reopening, setReopening] = useState<ClosedBillingJob | null>(null);
  const [notice, setNotice] = useState("");

  async function reload() {
    try {
      const next = await billingApi.closedJobs(0);
      setJobs(next.jobs);
      setHasMore(next.hasMore);
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดรายการงานที่ปิดงานไม่สำเร็จ"));
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount / on reloadKey change; state is only set after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reloadKey]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await billingApi.closedJobs(jobs?.length ?? 0);
      setJobs((prev) => {
        const known = new Set((prev ?? []).map((j) => `${j.type}:${j.id}`));
        return [...(prev ?? []), ...next.jobs.filter((j) => !known.has(`${j.type}:${j.id}`))];
      });
      setHasMore(next.hasMore);
    } catch (err) {
      setError(errorText(err, "โหลดรายการงานที่ปิดงานไม่สำเร็จ"));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!error && (!jobs || jobs.length === 0) && !notice) return null;
  const list = jobs ?? [];

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>
          ปิดงานแล้ว - วางบิลนอกระบบ ({list.length}
          {hasMore ? "+" : ""})
        </h2>
        <button className="text-button" onClick={() => setExpanded((x) => !x)}>
          {expanded ? "ซ่อน" : "แสดงรายการ"}
        </button>
      </div>
      {error && (
        <div className="customer-message error" role="alert" style={{ padding: "0 23px 12px" }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="customer-message success" role="status" style={{ padding: "0 23px 12px" }}>
          {notice}
        </div>
      )}
      {expanded && list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ปิดเมื่อ</th>
                <th>ลูกค้า</th>
                <th>งาน</th>
                <th>ทะเบียน / เลขตัวถัง</th>
                <th>ส่งงานเมื่อ</th>
                <th>หมายเหตุ</th>
                <th>ผู้ปิด</th>
                {canReopen && <th></th>}
              </tr>
            </thead>
            <tbody>
              {list.map((j) => (
                <tr key={`${j.type}:${j.id}`}>
                  <td>{timestampToDisplayDate(j.closedAt)}</td>
                  <td>{j.customerName ?? "—"}</td>
                  <td>{j.typeLabel}</td>
                  <td>
                    {j.plateText || "—"}
                    <div className="muted">{j.chassis ?? "งานนี้ไม่พร้อมวางบิลแล้ว (ถูกยกเลิกหรือแก้ไข)"}</div>
                  </td>
                  <td>{j.deliveredDate ? isoToDisplayDate(j.deliveredDate) : "—"}</td>
                  <td>{j.note || "—"}</td>
                  <td>{j.closedBy || "—"}</td>
                  {canReopen && (
                    <td>
                      <button className="text-button" onClick={() => setReopening(j)}>
                        เปิดงานกลับ
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {expanded && hasMore && (
        <div className="inspect-pagination">
          <button className="text-button" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "กำลังโหลด..." : "โหลดเพิ่มอีก 100 งาน"}
          </button>
        </div>
      )}
      {reopening && (
        <ReopenJobDialog
          job={reopening}
          onClose={() => setReopening(null)}
          onReopened={() => {
            setNotice(`เปิดงาน ${reopening.typeLabel} ${reopening.plateText || reopening.chassis || ""} กลับแล้ว - งานกลับเข้าคิวรอวางบิล`);
            void reload();
            onReopened();
          }}
          onRefused={() => void reload()}
        />
      )}
    </section>
  );
}
