"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { api, ApiError, type BulkDocumentSubmissionEntry, type SubmitCandidate } from "@/lib/api";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { ChecksNote } from "@/components/submit-flow/ChecksNote";
import { DONE_HREF, dutyAmount, formatMoney, ownerTypeForApi, PICK_HREF, SETTINGS_HREF } from "@/components/submit-flow/shared";

// ขั้น 3 ตรวจทาน (ผู้ใช้ 2026-09-25): ดูง่ายๆ คันละแถว - ข้อมูลรถ + Bill / No bill / อากร / รวม และแถวรวมทั้งชุด
// ค่าใช้จ่ายรายบรรทัดและการแก้ไขอยู่ขั้นตั้งค่า ถ้าโอเคกดยืนยันยื่น
// Bill = ค่าธรรมเนียม (Bill) + ภาษี, No bill = No bill ไม่รวมค่าอากร, รวม = Bill + No bill (ไม่รวมค่าอากร ตามแบบเดิม)
export default function SubmitReviewPage() {
  const router = useRouter();
  const { submitDate, selected, settings, unselect, setResult, rowState, checks } = useSubmitFlow();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const confirmRef = useRef<HTMLDialogElement>(null);

  if (selected.length === 0) {
    return (
      <section className="panel empty-page">
        <p style={{ margin: "0 0 12px" }}>ยังไม่ได้เลือกรถที่จะยื่น</p>
        <Link href={PICK_HREF} className="primary" style={{ display: "inline-flex" }}>
          ← ไปเลือกรถ
        </Link>
      </section>
    );
  }

  async function handleSubmit() {
    if (!checks.ready || !submitDate) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const entries: BulkDocumentSubmissionEntry[] = selected.map((v) => {
        const s = settings[v.id];
        return {
          vehicleId: v.id,
          submitDate,
          plateCategory: s.plateCategory.trim() || null,
          plateNumber: s.plateNumber.trim() || null,
          ownerType: ownerTypeForApi(v, s),
          ...s.options,
        };
      });
      const result = await api.createDocumentSubmissionBulk(entries);
      const byId = new Map(selected.map((v) => [v.id, v]));
      const succeeded = result.succeeded.map((s) => byId.get(s.vehicleId)).filter((v): v is SubmitCandidate => !!v);
      const failed = result.failed.map((f) => ({ vehicle: byId.get(f.vehicleId)!, error: f.error })).filter((f) => !!f.vehicle);
      setResult({ submitDate, succeeded, failed });
      // คันที่ยื่นสำเร็จออกจากที่เลือก คันที่ไม่สำเร็จยังอยู่พร้อมการตั้งค่าเดิม ให้กลับไปแก้แล้วยื่นใหม่ได้
      unselect(succeeded.map((v) => v.id));
      confirmRef.current?.close();
      router.push(DONE_HREF);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : "ยื่นเอกสารไม่สำเร็จ");
      confirmRef.current?.close();
    } finally {
      setSubmitting(false);
    }
  }

  // ยอดของแต่ละคัน (คันที่ยังคำนวณไม่เสร็จ/คำนวณไม่ได้ = null)
  const lines = selected.map((v) => {
    const state = rowState(v);
    if (state.kind !== "ok") return { vehicle: v, amounts: null, taxMissing: false };
    const duty = dutyAmount(state.fee);
    return {
      vehicle: v,
      amounts: { bill: state.fee.billTotal + (state.taxAmount ?? 0), noBill: state.fee.noBillTotal - duty, duty, total: state.total },
      taxMissing: state.taxAmount === null,
    };
  });
  const sum = (key: "bill" | "noBill" | "duty" | "total") => lines.reduce((acc, l) => acc + (l.amounts?.[key] ?? 0), 0);

  return (
    <>
      <p className="muted" style={{ marginBottom: 16 }}>
        ตรวจยอดของแต่ละคัน ถ้าถูกต้องกด &quot;ยืนยันยื่น&quot; ถ้าต้องแก้กด &quot;← กลับไปแก้ตั้งค่า&quot;
      </p>

      {submitError && (
        <p className="customer-message error" role="alert" style={{ marginBottom: 12 }}>
          ยื่นเอกสารไม่สำเร็จ: {submitError}
        </p>
      )}

      <section className="panel">
        <div className="table-wrap">
          <table className="review-summary">
            <thead>
              <tr>
                <th>#</th>
                <th>เลขตัวถัง</th>
                <th>เจ้าของงาน</th>
                <th>ยี่ห้อ · ประเภทรถ</th>
                <th className="amt">Bill</th>
                <th className="amt">No bill</th>
                <th className="amt">อากร</th>
                <th className="amt">รวม (ไม่รวมอากร)</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(({ vehicle: v, amounts, taxMissing }, index) => (
                <tr key={v.id} className={checks.problemIds.has(v.id) ? "row-failed" : undefined}>
                  <td>{index + 1}</td>
                  <td>{v.chassis}</td>
                  <td>{v.customerName}</td>
                  <td>
                    {v.brandName} · {v.body || "—"}
                  </td>
                  {amounts ? (
                    <>
                      <td className="amt">
                        {formatMoney(amounts.bill)}
                        {taxMissing && <div className="field-error">ยังไม่รวมภาษี</div>}
                      </td>
                      <td className="amt">{formatMoney(amounts.noBill)}</td>
                      <td className="amt">{formatMoney(amounts.duty)}</td>
                      <td className="amt">
                        <strong>{formatMoney(amounts.total)}</strong>
                      </td>
                    </>
                  ) : (
                    <td className="amt muted" colSpan={4}>
                      กำลังคำนวณ…
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>รวม {selected.length} คัน</td>
                <td className="amt">{formatMoney(sum("bill"))}</td>
                <td className="amt">{formatMoney(sum("noBill"))}</td>
                <td className="amt">{formatMoney(sum("duty"))}</td>
                <td className="amt" style={{ color: "#2854d9" }}>
                  {formatMoney(sum("total"))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <div className="submit-footer">
        <ChecksNote checks={checks} count={selected.length} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Link href={SETTINGS_HREF} className="text-button">
            ← กลับไปแก้ตั้งค่า
          </Link>
          <button type="button" className="primary" disabled={!checks.ready || !submitDate} onClick={() => confirmRef.current?.showModal()}>
            ยืนยันยื่น {selected.length} คัน
          </button>
        </div>
      </div>

      <dialog ref={confirmRef} onClick={(event) => event.target === event.currentTarget && confirmRef.current?.close()}>
        <button className="close" aria-label="ปิด" onClick={() => confirmRef.current?.close()}>
          ×
        </button>
        <h2>ยืนยันการยื่นเอกสาร</h2>
        <p>
          ยื่นเอกสารจดทะเบียน <strong>{selected.length} คัน</strong> ยอดรวม (ยังไม่รวมค่าอากร){" "}
          <strong>{formatMoney(checks.grandTotal)} บาท</strong>
          {checks.taxPendingCount > 0 ? ` (${checks.taxPendingCount} คันยังไม่รวมภาษี)` : ""}
        </p>
        <div className="form-actions">
          <button type="button" className="text-button" onClick={() => confirmRef.current?.close()}>
            ยกเลิก
          </button>
          <button type="button" className="primary" disabled={submitting} onClick={handleSubmit}>
            {submitting ? "กำลังยื่น…" : "ยืนยันยื่นเอกสาร"}
          </button>
        </div>
      </dialog>
    </>
  );
}
