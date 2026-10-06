"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { HistoryDialog, HrDialog, errorText, moneyOf, ReasonDialog } from "@/components/hr/HrDialog";
import { ApiError } from "@/lib/api";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { downloadCsv, hrApi, monthLabel, STATUS_LABEL, type PayrollItem, type PayrollRun, type PayrollStatus, type PayslipSignature } from "@/lib/hr-api";
import { formatMoney } from "@/lib/invoice";
import { printPayslips } from "@/lib/payslip-print";

// รายละเอียดรอบเงินเดือน (ผู้ใช้ 2026-10-05): ตรวจ/แก้รายคน (ร่างเท่านั้น) -> อนุมัติ (ล็อก) -> บันทึกว่าจ่ายแล้ว + พิมพ์สลิป / CSV
// รอบเปลี่ยนสถานะระหว่างที่เปิดหน้าไว้ = backend ตอบ 409 หน้านี้โหลดรอบใหม่ให้เห็นสถานะจริง

const BADGE: Record<PayrollStatus, string> = { DRAFT: "badge", APPROVED: "badge warn", PAID: "badge done", CANCELLED: "badge" };

type Dialog = null | "unapprove" | "pay" | "paydate" | "unpay" | "cancel" | "history" | { item: PayrollItem };

export function PayrollRunPage() {
  const id = useSearchParams().get("id") ?? "";
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [signature, setSignature] = useState<PayslipSignature | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setRun((await hrApi.getRun(id)).run);
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดรอบเงินเดือนไม่สำเร็จ"));
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // ลายเซ็นผู้จ่ายเงินที่พิมพ์บนสลิป - โหลดไม่ได้ก็ยังพิมพ์สลิปได้ (ช่องเซ็นเปล่า)
  useEffect(() => {
    hrApi
      .getSignature()
      .then(setSignature)
      .catch(() => setSignature(null));
  }, []);

  // ทำการแล้วรับรอบใหม่ที่ backend ส่งกลับ - 409 (สถานะเปลี่ยนไปแล้ว) โหลดรอบใหม่ให้เห็นสถานะจริง
  async function act(call: () => Promise<{ run: PayrollRun }>, done?: string): Promise<void> {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      setRun((await call()).run);
      if (done) setNotice(done);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) await load();
      setError(errorText(err, "ทำรายการไม่สำเร็จ"));
      throw err;
    } finally {
      setBusy(false);
    }
  }
  const quiet = (call: () => Promise<{ run: PayrollRun }>, done?: string) => act(call, done).catch(() => {});

  if (!id) return <section className="content"><p>ไม่ได้ระบุรอบเงินเดือน - <Link href="/hr/payroll">กลับรายการ</Link></p></section>;
  if (!run) {
    return (
      <section className="content">
        {error ? <p className="customer-message error">{error}</p> : <p className="muted">กำลังโหลด…</p>}
        <Link href="/hr/payroll">← กลับรายการรอบเงินเดือน</Link>
      </section>
    );
  }

  const status = run.status;
  const editable = status === "DRAFT";
  const t = run.totals;

  function exportCsv() {
    downloadCsv(`เงินเดือน ${run!.month}.csv`, [
      ["รหัส", "ชื่อ-สกุล", "ตำแหน่ง", "เงินเดือน", "รายได้อื่น", "ประกันสังคม", "ภาษีหัก ณ ที่จ่าย", "หักอื่น", "จ่ายสุทธิ"],
      ...run!.items.map((i) => [i.code, i.fullName, i.position, i.salary, i.otherIncome, i.ssoAmount, i.taxAmount, i.otherDeduction, i.netPay]),
      ["", "รวม", "", t.salary, t.otherIncome, t.sso, t.tax, t.otherDeduction, t.net],
    ]);
  }

  return (
    <section className="content">
      <p style={{ marginBottom: 8 }}>
        <Link href="/hr/payroll">← รอบเงินเดือนทั้งหมด</Link>
      </p>
      <div className="heading">
        <div>
          <h1 tabIndex={-1}>
            เงินเดือน {monthLabel(run.month)} <span className={BADGE[status]} style={{ fontSize: 13, verticalAlign: "middle" }}>{STATUS_LABEL[status]}</span>
          </h1>
          <p>
            ประกันสังคม {run.ssoRate}% เพดานฐาน {formatMoney(run.ssoWageCap)} บาท
            {run.payDate ? ` · ${status === "PAID" ? "จ่ายแล้ววันที่" : "กำหนดจ่ายวันที่"} ${isoToDisplayDate(run.payDate)}${status === "PAID" && run.paidByName ? ` โดย ${run.paidByName}` : ""}` : " · ยังไม่ระบุวันที่จ่าย"}
            {run.approvedAt && status === "APPROVED" ? ` · อนุมัติโดย ${run.approvedByName ?? "-"}` : ""}
            {status === "CANCELLED" ? ` · ยกเลิกโดย ${run.cancelledByName ?? "-"}: ${run.cancelReason ?? ""}` : ""}
          </p>
        </div>
        <div className="form-actions" style={{ flexWrap: "wrap" }}>
          {status !== "CANCELLED" && (
            <>
              <button type="button" onClick={() => printPayslips(run, run.items, { signature })}>
                🖨 พิมพ์สลิปทุกคน
              </button>
              <button type="button" onClick={exportCsv}>
                ดาวน์โหลด CSV
              </button>
            </>
          )}
          <button type="button" onClick={() => setDialog("history")}>
            ประวัติ
          </button>
        </div>
      </div>

      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="customer-message success" role="status">
          {notice}
        </p>
      )}

      <div className="stats" style={{ marginTop: 14 }}>
        <Stat label="พนักงาน" value={`${run.items.length} คน`} />
        <Stat label="รายได้รวม" value={formatMoney(t.gross)} sub={t.otherIncome ? `รวมรายได้อื่น ${formatMoney(t.otherIncome)}` : undefined} />
        <Stat label="ประกันสังคม (หักพนักงาน)" value={formatMoney(t.sso)} sub={`นำส่ง สปส. ${formatMoney(t.ssoRemit)} (รวมส่วนนายจ้าง)`} />
        <Stat label="ภาษีหัก ณ ที่จ่าย" value={formatMoney(t.tax)} sub="นำส่ง ภ.ง.ด.1" />
        <Stat label="จ่ายสุทธิ" value={formatMoney(t.net)} strong />
      </div>

      {status !== "CANCELLED" && (
        <section className="panel" style={{ marginTop: 20, padding: "16px 23px", overflow: "visible" }}>
          <div className="form-actions" style={{ flexWrap: "wrap" }}>
            {status === "DRAFT" && (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy || run.items.length === 0}
                  onClick={() => quiet(() => hrApi.approve(run.id), "อนุมัติแล้ว - แก้รายการไม่ได้อีก")}
                >
                  อนุมัติรอบนี้
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm("คำนวณใหม่จากทะเบียนพนักงาน? รายการที่แก้ไว้ในรอบนี้ทั้งหมดจะถูกแทนที่")) void quiet(() => hrApi.recalculate(run.id), "คำนวณใหม่จากทะเบียนพนักงานแล้ว");
                  }}
                >
                  คำนวณใหม่จากทะเบียนพนักงาน
                </button>
                <button type="button" disabled={busy} onClick={() => setDialog("paydate")}>
                  แก้วันที่จ่าย
                </button>
              </>
            )}
            {status === "APPROVED" && (
              <>
                <button type="button" className="primary" disabled={busy} onClick={() => setDialog("pay")}>
                  บันทึกว่าจ่ายแล้ว
                </button>
                <button type="button" disabled={busy} onClick={() => setDialog("paydate")}>
                  แก้วันที่จ่าย
                </button>
                <button type="button" disabled={busy} onClick={() => setDialog("unapprove")}>
                  ยกเลิกการอนุมัติ
                </button>
              </>
            )}
            {status === "PAID" && (
              <button type="button" disabled={busy} onClick={() => setDialog("unpay")}>
                ยกเลิกการจ่าย
              </button>
            )}
            {status !== "PAID" && (
              <button type="button" className="text-button danger" disabled={busy} onClick={() => setDialog("cancel")}>
                ยกเลิกรอบนี้
              </button>
            )}
          </div>
          {editable && <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>ตรวจยอดแต่ละคนแล้วกดปุ่มแก้เมื่อมีรายได้อื่น รายการหัก หรือต้องการแก้ประกันสังคม/ภาษีเอง จากนั้นอนุมัติเพื่อล็อกรอบ</p>}
        </section>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>รหัส</th>
                <th>ชื่อ-สกุล</th>
                <th>ตำแหน่ง</th>
                <th style={{ textAlign: "right" }}>เงินเดือน</th>
                <th style={{ textAlign: "right" }}>รายได้อื่น</th>
                <th style={{ textAlign: "right" }}>ประกันสังคม</th>
                <th style={{ textAlign: "right" }}>ภาษี</th>
                <th style={{ textAlign: "right" }}>หักอื่น</th>
                <th style={{ textAlign: "right" }}>จ่ายสุทธิ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {run.items.map((i) => (
                <tr key={i.id}>
                  <td style={{ fontFamily: "monospace" }}>{i.code}</td>
                  <td>{i.fullName}</td>
                  <td>{i.position ?? ""}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(i.salary)}</td>
                  <td style={{ textAlign: "right" }} title={i.otherIncomeNote ?? undefined}>
                    {i.otherIncome ? formatMoney(i.otherIncome) : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {i.ssoAmount ? formatMoney(i.ssoAmount) : "-"}
                    {i.ssoManual && <span title="พิมพ์ทับยอดที่ระบบคำนวณ"> ✎</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {i.taxAmount ? formatMoney(i.taxAmount) : "-"}
                    {i.taxManual && <span title="พิมพ์ทับยอดที่ระบบคำนวณ"> ✎</span>}
                  </td>
                  <td style={{ textAlign: "right" }} title={i.deductionNote ?? undefined}>
                    {i.otherDeduction ? formatMoney(i.otherDeduction) : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <b>{formatMoney(i.netPay)}</b>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editable && (
                      <button type="button" className="text-button" onClick={() => setDialog({ item: i })}>
                        แก้
                      </button>
                    )}
                    {status !== "CANCELLED" && (
                      <button type="button" className="text-button" onClick={() => printPayslips(run, [i], { signature })}>
                        สลิป
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700, background: "#f7f9fc" }}>
                <td />
                <td>รวม</td>
                <td />
                <td style={{ textAlign: "right" }}>{formatMoney(t.salary)}</td>
                <td style={{ textAlign: "right" }}>{t.otherIncome ? formatMoney(t.otherIncome) : ""}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(t.sso)}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(t.tax)}</td>
                <td style={{ textAlign: "right" }}>{t.otherDeduction ? formatMoney(t.otherDeduction) : ""}</td>
                <td style={{ textAlign: "right" }}>{formatMoney(t.net)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {dialog && typeof dialog === "object" && (
        <ItemDialog
          run={run}
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSave={(data) => act(() => hrApi.updateItem(run.id, dialog.item.id, data))}
        />
      )}
      {dialog === "pay" && (
        <ReasonDialog
          title="บันทึกว่าจ่ายแล้ว"
          description={<p className="muted">กดหลังโอนเงินเดือนให้พนักงานแล้ว ใส่วันที่จ่ายจริง (ไม่เกินวันนี้)</p>}
          withDate={{ label: "วันที่จ่ายจริง" }}
          defaultDateIso={run.payDate && run.payDate <= todayIso() ? run.payDate : todayIso()}
          noReason
          confirmLabel="บันทึกการจ่าย"
          onClose={() => setDialog(null)}
          onConfirm={(_, dateIso) => act(() => hrApi.pay(run.id, dateIso), "บันทึกการจ่ายแล้ว")}
        />
      )}
      {dialog === "paydate" && (
        <ReasonDialog
          title="แก้วันที่จ่ายเงินเดือน"
          description={<p className="muted">วันที่นี้พิมพ์ลงสลิปทุกใบ ใส่ล่วงหน้าได้ รอบที่อนุมัติแล้วต้องระบุเหตุผล</p>}
          withDate={{ label: "วันที่จ่ายเงินเดือน" }}
          defaultDateIso={run.payDate ?? undefined}
          noReason={status === "DRAFT"}
          confirmLabel="บันทึกวันที่จ่าย"
          onClose={() => setDialog(null)}
          onConfirm={(remark, dateIso) => act(() => hrApi.setPayDate(run.id, dateIso, remark || undefined), "แก้วันที่จ่ายแล้ว")}
        />
      )}
      {dialog === "unapprove" && <ReasonDialog title="ยกเลิกการอนุมัติ" confirmLabel="ยกเลิกการอนุมัติ" onClose={() => setDialog(null)} onConfirm={(remark) => act(() => hrApi.unapprove(run.id, remark))} />}
      {dialog === "unpay" && <ReasonDialog title="ยกเลิกการจ่าย" description={<p className="muted">รอบจะกลับเป็นสถานะอนุมัติแล้ว</p>} confirmLabel="ยกเลิกการจ่าย" danger onClose={() => setDialog(null)} onConfirm={(remark) => act(() => hrApi.unpay(run.id, remark))} />}
      {dialog === "cancel" && (
        <ReasonDialog
          title={`ยกเลิกรอบ ${monthLabel(run.month)}`}
          description={<p className="muted">รอบนี้จะถูกเก็บเป็นรายการที่ยกเลิก (ไม่ลบ) แล้วสร้างรอบของเดือนนี้ใหม่ได้</p>}
          confirmLabel="ยกเลิกรอบ"
          danger
          onClose={() => setDialog(null)}
          onConfirm={(remark) => act(() => hrApi.cancelRun(run.id, remark))}
        />
      )}
      {dialog === "history" && <HistoryDialog title={`ประวัติ: เงินเดือน ${monthLabel(run.month)}`} load={() => hrApi.runHistory(run.id)} onClose={() => setDialog(null)} />}
    </section>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className="stat" style={strong ? { borderColor: "#2854d9" } : undefined}>
      <div className="stat-top">{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 6 }}>{value}</div>
      {sub && <div className="muted" style={{ marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ---------- แก้รายการรายคน ----------
function ItemDialog({ run, item, onClose, onSave }: { run: PayrollRun; item: PayrollItem; onClose: () => void; onSave: (data: Parameters<typeof hrApi.updateItem>[2]) => Promise<void> }) {
  const closeRef = useRef<() => void>(() => {});
  const [salary, setSalary] = useState(String(item.salary));
  const [otherIncome, setOtherIncome] = useState(item.otherIncome ? String(item.otherIncome) : "");
  const [incomeNote, setIncomeNote] = useState(item.otherIncomeNote ?? "");
  const [deduction, setDeduction] = useState(item.otherDeduction ? String(item.otherDeduction) : "");
  const [deductionNote, setDeductionNote] = useState(item.deductionNote ?? "");
  // ว่าง = ให้ระบบคำนวณ / ใส่ตัวเลข (รวม 0) = พิมพ์ทับ
  const [sso, setSso] = useState(item.ssoManual ? String(item.ssoAmount) : "");
  const [tax, setTax] = useState(item.taxManual ? String(item.taxAmount) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setError("");
    const salaryValue = moneyOf(salary);
    if (salaryValue === null || !Number.isFinite(salaryValue) || salaryValue <= 0) return setError("เงินเดือนไม่ถูกต้อง");
    const other = moneyOf(otherIncome) ?? 0;
    const ded = moneyOf(deduction) ?? 0;
    const ssoValue = moneyOf(sso);
    const taxValue = moneyOf(tax);
    if (![other, ded].every(Number.isFinite) || Number.isNaN(ssoValue) || Number.isNaN(taxValue)) return setError("ตรวจตัวเลขอีกครั้ง (ใส่ได้เฉพาะจำนวนเงิน)");
    setBusy(true);
    try {
      await onSave({
        salary: salaryValue,
        otherIncome: other,
        otherIncomeNote: incomeNote.trim() || null,
        otherDeduction: ded,
        deductionNote: deductionNote.trim() || null,
        sso: ssoValue,
        tax: taxValue,
      });
      closeRef.current();
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HrDialog title={`แก้ ${item.fullName}`} onClose={onClose} width={620} closeRef={closeRef}>
      <p className="muted" style={{ marginBottom: 12 }}>
        {item.code} · {monthLabel(run.month)} · ยอดจ่ายสุทธิจะคำนวณใหม่ให้เมื่อบันทึก
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
        <label className="field">
          เงินเดือนเดือนนี้ (บาท)
          <input type="text" inputMode="decimal" value={salary} onChange={(e) => setSalary(e.target.value)} />
        </label>
        <label className="field">
          รายได้อื่น (บาท)
          <input type="text" inputMode="decimal" value={otherIncome} onChange={(e) => setOtherIncome(e.target.value)} placeholder="โบนัส ค่าเดินทาง ฯลฯ" />
        </label>
        <label className="field">
          หมายเหตุรายได้อื่น
          <input type="text" value={incomeNote} onChange={(e) => setIncomeNote(e.target.value)} maxLength={200} />
        </label>
        <label className="field">
          รายการหักอื่น (บาท)
          <input type="text" inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} placeholder="ขาด ลา เงินยืม ฯลฯ" />
        </label>
        <label className="field">
          หมายเหตุรายการหัก
          <input type="text" value={deductionNote} onChange={(e) => setDeductionNote(e.target.value)} maxLength={200} />
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(240px,1fr))", gap: 14, marginTop: 14 }}>
        <label className="field">
          ประกันสังคม (บาท)
          <input type="text" inputMode="decimal" value={sso} onChange={(e) => setSso(e.target.value)} placeholder="เว้นว่าง = ระบบคำนวณ" />
        </label>
        <label className="field">
          ภาษีหัก ณ ที่จ่าย (บาท)
          <input type="text" inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} placeholder="เว้นว่าง = ระบบคำนวณ" />
        </label>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
        ปัจจุบันระบบหักประกันสังคม {formatMoney(item.ssoAmount)} · ภาษี {formatMoney(item.taxAmount)} บาท ภาษีคำนวณแบบประมาณการรายปีจากเงินได้เดือนนี้ x 12
        เดือนที่มีโบนัสควรตรวจยอดอีกครั้ง
      </p>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={busy} onClick={save}>
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </HrDialog>
  );
}
