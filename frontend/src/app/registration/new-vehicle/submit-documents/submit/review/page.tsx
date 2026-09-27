"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { ChecksNote } from "@/components/submit-flow/ChecksNote";
import { DONE_HREF, dutyAmount, formatMoney, PICK_HREF, SETTINGS_HREF } from "@/components/submit-flow/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

// ขั้น 3 ตรวจทาน (ผู้ใช้ 2026-09-25): ดูง่ายๆ คันละแถว - ข้อมูลรถ + Bill / No bill / อากร / รวม และแถวรวมทั้งชุด
// ค่าใช้จ่ายรายบรรทัดและการแก้ไขอยู่ขั้นตั้งค่า ถ้าโอเคกดยืนยันยื่น
// Bill = ค่าธรรมเนียม (Bill) + ภาษี, No bill = No bill ไม่รวมค่าอากร, รวม = Bill + No bill (ไม่รวมค่าอากร ตามแบบเดิม)
export default function SubmitReviewPage() {
  const router = useRouter();
  const { submitDate, today, selected, rowState, checks, verifyPrices, submitting, submitProgress, submitSelected } = useSubmitFlow();
  const [verifying, setVerifying] = useState(false);
  const [submitError, setSubmitError] = useState("");
  // คันที่ยอดเปลี่ยนตอนคำนวณใหม่ก่อนยืนยัน (ข้อมูลรถถูกแก้ระหว่างนี้) - ไฮไลต์ให้ตรวจแล้วกดยืนยันอีกครั้ง
  const [changedIds, setChangedIds] = useState<Set<string>>(new Set());
  const confirmRef = useRef<HTMLDialogElement>(null);
  // ยื่นเสร็จหลังออกจากหน้านี้ไปแล้ว ไม่พาไปหน้าผลการยื่นเอง (ผลยังเก็บไว้ที่ขั้น 4)
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  // ก่อนเปิดหน้าต่างยืนยัน: คำนวณทุกคันใหม่จากข้อมูลรถล่าสุด (พบ 2026-09-27: ข้อมูลรถถูกแก้ระหว่างนี้ ยอดที่ยืนยันไม่ตรงกับที่บันทึก)
  // ยอดเปลี่ยน = ไม่เปิดหน้าต่าง ไฮไลต์คันนั้นให้ตรวจก่อน แล้วกดยืนยันอีกครั้ง
  async function openConfirm() {
    setVerifying(true);
    setSubmitError("");
    try {
      const changed = await verifyPrices();
      setChangedIds(new Set(changed));
      if (changed.length === 0) confirmRef.current?.showModal();
    } catch (err) {
      setSubmitError(`คำนวณยอดล่าสุดไม่สำเร็จ - ${err instanceof ApiError ? err.message : "ลองใหม่อีกครั้ง"}`);
    } finally {
      setVerifying(false);
    }
  }

  async function handleSubmit() {
    if (!checks.ready || !submitDate || submitting) return;
    setSubmitError("");
    const outcome = await submitSelected();
    confirmRef.current?.close();
    if (!outcome.ok) {
      setSubmitError(outcome.error);
      return;
    }
    if (mounted.current) router.push(DONE_HREF);
  }

  // ยอดของแต่ละคัน (คันที่ยังคำนวณไม่เสร็จ/คำนวณไม่ได้ = null)
  const lines = selected.map((v) => {
    const state = rowState(v);
    if (state.kind !== "ok") return { vehicle: v, amounts: null, taxMissing: false, error: state.kind === "error" ? state.message : null };
    const duty = dutyAmount(state.fee);
    return {
      vehicle: v,
      amounts: { bill: state.fee.billTotal + (state.taxAmount ?? 0), noBill: state.fee.noBillTotal - duty, duty, total: state.total },
      taxMissing: state.taxAmount === null,
      error: null,
    };
  });
  const sum = (key: "bill" | "noBill" | "duty" | "total") => lines.reduce((acc, l) => acc + (l.amounts?.[key] ?? 0), 0);
  // วันที่ยื่นไม่ใช่วันนี้ (กรอกล่วงหน้า/ย้อนหลัง) - เตือนสีส้มในหน้าต่างยืนยันแบบเดียวกับหน้า Delivery
  const dayDiff = submitDate && today ? Math.round((Date.parse(submitDate) - Date.parse(today)) / DAY_MS) : 0;
  const changedCount = selected.filter((v) => changedIds.has(v.id)).length;
  // ส่งทีละชุด (50 คัน) - บอกความคืบหน้าระหว่างชุด ไม่ให้ดูเหมือนค้าง
  const submittingLabel = submitProgress ? `กำลังยื่น… ${submitProgress.done}/${submitProgress.total} คัน` : "กำลังยื่น…";

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
      {changedCount > 0 && (
        <p className="customer-message error" role="alert" style={{ marginBottom: 12 }}>
          ยอดเปลี่ยน {changedCount} คัน เพราะข้อมูลรถถูกแก้ระหว่างนี้ (แถวสีส้ม) - ตรวจยอดใหม่แล้วกด &quot;ยืนยันยื่น&quot; อีกครั้ง
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
              {lines.map(({ vehicle: v, amounts, taxMissing, error }, index) => (
                <tr
                  key={v.id}
                  className={checks.problemIds.has(v.id) ? "row-failed" : undefined}
                  style={changedIds.has(v.id) && !checks.problemIds.has(v.id) ? { background: "#fff4e5" } : undefined}
                >
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
                        {changedIds.has(v.id) && <div style={{ color: "#c2410c", fontSize: 12 }}>ยอดเปลี่ยน</div>}
                      </td>
                    </>
                  ) : error ? (
                    <td className="amt field-error" colSpan={4} style={{ whiteSpace: "normal" }}>
                      คำนวณไม่ได้: {error} ·{" "}
                      <Link href={SETTINGS_HREF} className="text-button">
                        ไปแก้ที่ขั้นตั้งค่า
                      </Link>
                    </td>
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
          <button type="button" className="primary" disabled={!checks.ready || !submitDate || verifying || submitting} onClick={openConfirm}>
            {submitting ? submittingLabel : verifying ? "กำลังตรวจยอดล่าสุด…" : `ยืนยันยื่น ${selected.length} คัน`}
          </button>
        </div>
      </div>

      <dialog
        ref={confirmRef}
        onClick={(event) => event.target === event.currentTarget && !submitting && confirmRef.current?.close()}
        onCancel={(event) => submitting && event.preventDefault()}
      >
        <button className="close" aria-label="ปิด" disabled={submitting} onClick={() => confirmRef.current?.close()}>
          ×
        </button>
        <h2>ยืนยันการยื่นเอกสาร</h2>
        <p>
          ยื่นเอกสารจดทะเบียน <strong>{selected.length} คัน</strong> ยอดรวม (ยังไม่รวมค่าอากร){" "}
          <strong>{formatMoney(checks.grandTotal)} บาท</strong>
          {checks.taxPendingCount > 0 ? ` (${checks.taxPendingCount} คันยังไม่รวมภาษี)` : ""}
        </p>
        {/* วันที่ยื่นอยู่ในหน้าต่างยืนยันด้วย - ไม่ใช่วันนี้ขึ้นสีส้มพร้อมจำนวนวัน (พบ 2026-09-27: เปิดค้างข้ามคืนแล้วยื่นด้วยวันเมื่อวาน) */}
        <p style={dayDiff !== 0 ? { color: "#c2410c", fontWeight: 600 } : undefined}>
          วันที่ยื่นเอกสาร {isoToDisplayDate(submitDate) || "—"}
          {dayDiff !== 0 ? ` (ไม่ใช่วันนี้ – ${dayDiff > 0 ? `อีก ${dayDiff} วัน` : `ย้อนหลัง ${-dayDiff} วัน`})` : " (วันนี้)"}
        </p>
        {submitProgress && (
          <p className="muted" role="status">
            ส่งไปยื่นแล้ว {submitProgress.done} จาก {submitProgress.total} คัน - อย่ารีเฟรชหรือปิดหน้านี้จนกว่าจะเสร็จ
          </p>
        )}
        <div className="form-actions">
          <button type="button" className="text-button" disabled={submitting} onClick={() => confirmRef.current?.close()}>
            ยกเลิก
          </button>
          <button type="button" className="primary" disabled={submitting || !checks.ready} onClick={handleSubmit}>
            {submitting ? submittingLabel : "ยืนยันยื่นเอกสาร"}
          </button>
        </div>
      </dialog>
    </>
  );
}
