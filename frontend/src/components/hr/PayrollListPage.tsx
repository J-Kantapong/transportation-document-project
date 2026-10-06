"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "@/components/hr/HrDialog";
import { SignaturePanel } from "@/components/hr/SignaturePanel";
import { hrApi, monthLabel, STATUS_LABEL, thaiMonthName, type PayrollRunSummary, type PayrollStatus } from "@/lib/hr-api";
import { formatMoney } from "@/lib/invoice";
import { isoToDisplayDate } from "@/lib/date";

// เงินเดือน (ผู้ใช้ 2026-10-05) - รายการรอบรายเดือน + สร้างรอบใหม่ (ADMIN เท่านั้น)
const BADGE: Record<PayrollStatus, string> = { DRAFT: "badge", APPROVED: "badge warn", PAID: "badge done", CANCELLED: "badge" };

export function PayrollListPage() {
  const router = useRouter();
  const [runs, setRuns] = useState<PayrollRunSummary[] | null>(null);
  const [error, setError] = useState("");
  const now = new Date();
  const [monthIndex, setMonthIndex] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRuns((await hrApi.listRuns()).runs);
    } catch (err) {
      setError(errorText(err, "โหลดรอบเงินเดือนไม่สำเร็จ"));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function create() {
    setError("");
    setBusy(true);
    try {
      const { run } = await hrApi.createRun(`${year}-${String(monthIndex + 1).padStart(2, "0")}`);
      router.push(`/hr/payroll/view?id=${encodeURIComponent(run.id)}`);
    } catch (err) {
      setError(errorText(err, "สร้างรอบเงินเดือนไม่สำเร็จ"));
      setBusy(false);
    }
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>เงินเดือน</h1>
      <p>สร้างรอบเงินเดือนรายเดือนจากทะเบียนพนักงาน ตรวจและแก้รายคน อนุมัติ แล้วบันทึกว่าจ่ายแล้ว พิมพ์สลิปให้พนักงานได้</p>

      <section className="panel" style={{ marginTop: 20, padding: "20px 23px", overflow: "visible" }}>
        <h2 style={{ marginBottom: 14 }}>สร้างรอบเงินเดือนใหม่</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end" }}>
          <label className="field" style={{ minWidth: 160 }}>
            เดือน
            <select value={monthIndex} onChange={(e) => setMonthIndex(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i} value={i}>
                  {thaiMonthName(i)}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ width: 130 }}>
            ปี (พ.ศ.)
            <input type="number" value={year + 543} onChange={(e) => setYear(Number(e.target.value) - 543)} min={2500} max={2700} />
          </label>
          <button type="button" className="primary" disabled={busy} onClick={create}>
            {busy ? "กำลังสร้าง…" : "สร้างรอบเดือนนี้"}
          </button>
        </div>
        <p className="muted" style={{ marginTop: 10, fontSize: 13 }}>
          ระบบดึงพนักงานที่ทำงานอยู่ (และที่ลาออกในเดือนนั้นหรือหลังจากนั้น) พร้อมคำนวณประกันสังคมและภาษีหัก ณ ที่จ่ายให้ แล้วแก้ได้ก่อนอนุมัติ
        </p>
        {error && (
          <p className="customer-message error" role="alert">
            {error}
          </p>
        )}
      </section>

      <SignaturePanel />

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>รอบเงินเดือน</h2>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เดือน</th>
                <th>สถานะ</th>
                <th style={{ textAlign: "right" }}>คน</th>
                <th style={{ textAlign: "right" }}>รายได้รวม</th>
                <th style={{ textAlign: "right" }}>ประกันสังคม</th>
                <th style={{ textAlign: "right" }}>ภาษี</th>
                <th style={{ textAlign: "right" }}>จ่ายสุทธิ</th>
                <th>วันที่จ่าย</th>
              </tr>
            </thead>
            <tbody>
              {runs === null && (
                <tr>
                  <td colSpan={8} className="muted">
                    กำลังโหลด…
                  </td>
                </tr>
              )}
              {runs !== null && runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="muted">
                    ยังไม่มีรอบเงินเดือน
                  </td>
                </tr>
              )}
              {runs?.map((r) => (
                <tr key={r.id} style={r.status === "CANCELLED" ? { opacity: 0.55, textDecoration: "line-through" } : undefined}>
                  <td>
                    <Link href={`/hr/payroll/view?id=${encodeURIComponent(r.id)}`}>{monthLabel(r.month)}</Link>
                  </td>
                  <td>
                    <span className={BADGE[r.status]}>{STATUS_LABEL[r.status]}</span>
                  </td>
                  <td style={{ textAlign: "right" }}>{r.employeeCount}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(r.totals.gross)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(r.totals.sso)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(r.totals.tax)}</td>
                  <td style={{ textAlign: "right" }}>
                    <b>{formatMoney(r.totals.net)}</b>
                  </td>
                  <td>{r.payDate ? isoToDisplayDate(r.payDate) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
