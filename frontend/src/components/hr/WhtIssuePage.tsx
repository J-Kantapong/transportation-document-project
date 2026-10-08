"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DateInput } from "@/components/DateInput";
import { digits, errorText, HistoryDialog, HrDialog, moneyOf, ReasonDialog } from "@/components/hr/HrDialog";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  hrApi,
  maskId,
  WHT_FORM_LABEL,
  WHT_INCOME_LABEL,
  WHT_OTHER_INCOME_TYPES,
  WHT_PAY_METHOD_LABEL,
  type PayslipSignature,
  type Supplier,
  type WhtSeries,
  type WhtCertificate,
  type WhtEmployeeYearRow,
  type WhtIncomeType,
  type WhtPayMethod,
} from "@/lib/hr-api";
import { formatMoney } from "@/lib/invoice";
import { printWhtCertificates } from "@/lib/wht-certificate-print";

// 50 ทวิ ที่บริษัทออกให้ผู้รับเงิน (ผู้ใช้ 2026-10-06): พนักงาน (ปลายปี จากเงินเดือนที่จ่ายแล้ว) + ผู้รับเงินอื่นๆ ที่เป็นบุคคลธรรมดา (ซับ) - ADMIN เท่านั้น
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const thisYear = new Date().getFullYear();

// ---------- ฟอร์มออกให้ผู้รับเงินอื่น ----------
type RateKey = "1" | "3" | "5" | "15" | "custom";
interface LineState {
  incomeType: WhtIncomeType;
  description: string;
  dateText: string;
  amountText: string;
  rate: RateKey;
  taxText: string;
}

const emptyLine = (): LineState => ({ incomeType: "SERVICE", description: "", dateText: "", amountText: "", rate: "3", taxText: "" });

// ภาษีที่แนะนำจากอัตรา (ค่าจ้างทำของ/บริการทั่วไป 3%, ขนส่ง 1%, ลิขสิทธิ์ 5%, ดอกเบี้ย 15%) - พิมพ์ภาษีเองแล้วอัตราเป็น "กำหนดเอง"
function taxFor(amountText: string, rate: RateKey, current: string): string {
  if (rate === "custom") return current;
  const amount = moneyOf(amountText);
  return amount === null || Number.isNaN(amount) ? "" : String(round2((amount * Number(rate)) / 100));
}

function OtherDialog({ year, replaces, suppliers, onClose, onDone }: { year: number; replaces: WhtCertificate | null; suppliers: Supplier[]; onClose: () => void; onDone: (c: WhtCertificate) => void }) {
  const closeRef = useRef<() => void>(() => {});
  const [supplierId, setSupplierId] = useState(replaces?.supplierId ?? "");
  const [issueText, setIssueText] = useState(isoToDisplayDate(todayIso()));
  const [name, setName] = useState(replaces?.payeeName ?? "");
  const [taxId, setTaxId] = useState(replaces?.payeeTaxId ?? "");
  const [address, setAddress] = useState(replaces?.payeeAddress ?? "");
  const [payMethod, setPayMethod] = useState<WhtPayMethod>(replaces?.payMethod ?? "WITHHOLD");
  const [note, setNote] = useState(replaces?.note ?? "");
  const [lines, setLines] = useState<LineState[]>(
    replaces
      ? replaces.items.map((i) => ({ incomeType: i.incomeType, description: i.description ?? "", dateText: isoToDisplayDate(i.paidDate), amountText: String(i.amountPaid), rate: "custom" as RateKey, taxText: String(i.taxWithheld) }))
      : [emptyLine()],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const patch = (index: number, change: Partial<LineState>) =>
    setLines((all) =>
      all.map((l, i) => {
        if (i !== index) return l;
        const next = { ...l, ...change };
        // เปลี่ยนจำนวนเงิน/อัตราแล้วคำนวณภาษีให้ใหม่ (ยกเว้นพิมพ์ภาษีเอง)
        if ("amountText" in change || "rate" in change) next.taxText = taxFor(next.amountText, next.rate, next.taxText);
        return next;
      }),
    );

  // เลือกจากทะเบียน: เติมชื่อ/เลข/ที่อยู่ และค่าเริ่มต้นของบรรทัดแรกถ้ายังว่าง (ยังแก้ในฟอร์มได้) - ใบเก็บ snapshot ของที่กรอกตอนออก
  function pickSupplier(id: string) {
    setSupplierId(id);
    const s = suppliers.find((x) => x.id === id);
    if (!s) return;
    setName(s.name);
    setTaxId(s.taxId);
    setAddress(s.address ?? "");
    setLines((all) =>
      all.map((l, i) => {
        if (i !== 0 || l.amountText) return l;
        const rate: RateKey = (["1", "3", "5", "15"] as const).find((r) => Number(r) === s.defaultRate) ?? "custom";
        return { ...l, incomeType: s.defaultIncomeType, description: s.defaultDescription ?? "", rate, taxText: rate === "custom" ? String(s.defaultRate) : l.taxText };
      }),
    );
  }

  const totals = useMemo(() => {
    let paid = 0;
    let tax = 0;
    for (const l of lines) {
      const a = moneyOf(l.amountText);
      const t = moneyOf(l.taxText);
      if (a && !Number.isNaN(a)) paid += a;
      if (t && !Number.isNaN(t)) tax += t;
    }
    return { paid: round2(paid), tax: round2(tax) };
  }, [lines]);

  async function submit() {
    setError("");
    const issueDate = displayDateToIso(digits(issueText));
    if (!issueDate) return setError("วันที่ออกไม่ถูกต้อง");
    const items = [];
    for (const [i, l] of lines.entries()) {
      const paidDate = displayDateToIso(digits(l.dateText));
      const amount = moneyOf(l.amountText);
      const tax = moneyOf(l.taxText);
      if (!paidDate) return setError(`บรรทัดที่ ${i + 1}: วันที่จ่ายไม่ถูกต้อง`);
      if (amount === null || Number.isNaN(amount) || amount <= 0) return setError(`บรรทัดที่ ${i + 1}: จำนวนเงินที่จ่ายไม่ถูกต้อง`);
      if (tax === null || Number.isNaN(tax)) return setError(`บรรทัดที่ ${i + 1}: ภาษีที่หักไม่ถูกต้อง (ใส่ 0 ถ้าไม่หัก)`);
      items.push({ incomeType: l.incomeType, description: l.description.trim() || null, paidDate, amountPaid: amount, taxWithheld: tax });
    }
    setBusy(true);
    try {
      const { certificate } = await hrApi.issueWhtOther({
        taxYear: year,
        issueDate,
        payeeName: name.trim(),
        payeeTaxId: taxId.replace(/\D/g, ""),
        payeeAddress: address.trim() || null,
        payMethod,
        items,
        note: note.trim() || null,
        replacesId: replaces?.id ?? null,
        supplierId: supplierId || null,
      });
      onDone(certificate);
      closeRef.current();
    } catch (err) {
      setError(errorText(err, "ออก 50 ทวิ ไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HrDialog title={replaces ? `ออก 50 ทวิ แทนใบ ${replaces.certificateNo}` : "ออก 50 ทวิ ให้ผู้รับเงินอื่น (บุคคลธรรมดา)"} onClose={onClose} width={860} closeRef={closeRef}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        ปีภาษี {year + 543} · ใช้กับบุคคลธรรมดาที่เรารับจ้างช่วง (แบบ ภ.ง.ด.3) · ออกแล้วแก้ไม่ได้ ผิดให้ยกเลิกแล้วออกใหม่
      </p>
      <label className="field" style={{ marginBottom: 12 }}>
        เลือกจาก Suppliers
        <select value={supplierId} onChange={(e) => pickSupplier(e.target.value)}>
          <option value="">— พิมพ์เอง (ไม่อยู่ใน Suppliers) —</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <label className="field">
          ชื่อ-สกุลผู้รับเงิน *
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
        </label>
        <label className="field">
          เลขประจำตัวผู้เสียภาษี / บัตรประชาชน 13 หลัก *
          <input value={taxId} onChange={(e) => setTaxId(e.target.value.replace(/[^\d-]/g, "").slice(0, 17))} inputMode="numeric" />
        </label>
        <label className="field">
          วันที่ออก 50 ทวิ *
          <DateInput value={issueText} onChange={(v) => setIssueText(formatDateDigitsCe(digits(v)))} />
        </label>
        <label className="field">
          รูปแบบ
          <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as WhtPayMethod)}>
            {(Object.keys(WHT_PAY_METHOD_LABEL) as WhtPayMethod[]).map((k) => (
              <option key={k} value={k}>
                {WHT_PAY_METHOD_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        ที่อยู่ผู้รับเงิน
        <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
      </label>

      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table>
          <thead>
            <tr>
              <th>ประเภทเงินได้</th>
              <th>รายละเอียด</th>
              <th>วันที่จ่าย</th>
              <th style={{ textAlign: "right" }}>จำนวนเงินที่จ่าย</th>
              <th>อัตรา</th>
              <th style={{ textAlign: "right" }}>ภาษีที่หัก</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td style={{ minWidth: 170 }}>
                  <select value={l.incomeType} onChange={(e) => patch(i, { incomeType: e.target.value as WhtIncomeType })} style={{ width: "100%" }}>
                    {WHT_OTHER_INCOME_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {WHT_INCOME_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </td>
                <td style={{ minWidth: 150 }}>
                  <input value={l.description} onChange={(e) => patch(i, { description: e.target.value })} placeholder="เช่น ค่าจ้างทำของ" maxLength={120} style={{ width: "100%" }} />
                </td>
                <td style={{ minWidth: 150 }}>
                  <DateInput value={l.dateText} onChange={(v) => patch(i, { dateText: formatDateDigitsCe(digits(v)) })} style={{ width: 110 }} />
                </td>
                <td>
                  <input value={l.amountText} onChange={(e) => patch(i, { amountText: e.target.value })} inputMode="decimal" style={{ width: 110, textAlign: "right" }} />
                </td>
                <td>
                  <select value={l.rate} onChange={(e) => patch(i, { rate: e.target.value as RateKey })}>
                    <option value="1">1%</option>
                    <option value="3">3%</option>
                    <option value="5">5%</option>
                    <option value="15">15%</option>
                    <option value="custom">กำหนดเอง</option>
                  </select>
                </td>
                <td>
                  <input value={l.taxText} onChange={(e) => patch(i, { taxText: e.target.value, rate: "custom" })} inputMode="decimal" style={{ width: 100, textAlign: "right" }} />
                </td>
                <td>
                  {lines.length > 1 && (
                    <button type="button" aria-label="ลบบรรทัด" onClick={() => setLines((all) => all.filter((_, x) => x !== i))}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <button type="button" onClick={() => setLines((all) => [...all, emptyLine()])} disabled={lines.length >= 12}>
                  + เพิ่มบรรทัด
                </button>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{formatMoney(totals.paid)}</b>
              </td>
              <td />
              <td style={{ textAlign: "right" }}>
                <b>{formatMoney(totals.tax)}</b>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        หมายเหตุ (พิมพ์ในฟอร์ม)
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={busy} onClick={submit}>
          {busy ? "กำลังออก…" : "ออก 50 ทวิ"}
        </button>
      </div>
    </HrDialog>
  );
}

// ตั้งเลขล่าสุดที่ใช้ไปแล้วนอกระบบ (ใบเดิมที่ออกจากไฟล์ก่อนมีระบบ) - ทำได้เฉพาะปีที่ยังไม่มีใบในระบบ
function SeriesPanel({ year, series, onSaved }: { year: number; series: WhtSeries | null; onSaved: () => void }) {
  const [last, setLast] = useState("");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!series) return null;
  async function save() {
    setError("");
    const n = Number(last);
    if (!Number.isInteger(n) || n < 0) return setError("เลขล่าสุดต้องเป็นจำนวนเต็ม 0 ขึ้นไป");
    setBusy(true);
    try {
      await hrApi.setWhtSeries(year, n, remark.trim());
      setLast("");
      setRemark("");
      onSaved();
    } catch (err) {
      setError(errorText(err, "ตั้งเลขไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" style={{ marginTop: 20, padding: "16px 23px", overflow: "visible" }}>
      <h2 style={{ marginBottom: 8 }}>เลขที่ 50 ทวิ ปี {year}</h2>
      <p style={{ margin: 0 }}>
        ใบถัดไปที่ระบบจะออก: <b>{series.nextNo}</b>
        {series.lastNumber > 0 && <span className="muted"> (ใช้ไปแล้วนอกระบบถึงเลข {series.lastNumber})</span>}
      </p>
      {series.systemCount === 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", marginTop: 10 }}>
          <label className="field" style={{ width: 170 }}>
            เลขล่าสุดที่ใช้ไปแล้ว (เช่น 8)
            <input value={last} onChange={(e) => setLast(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" />
          </label>
          <label className="field" style={{ minWidth: 260, flex: 1 }}>
            ที่มา *
            <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ออกจากไฟล์เดิม 2026-001 ถึง 2026-008" maxLength={200} />
          </label>
          <button type="button" disabled={busy || !last} onClick={save}>
            {busy ? "กำลังบันทึก…" : "ตั้งเลขเริ่ม"}
          </button>
        </div>
      ) : (
        <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>ปีนี้ออกในระบบแล้ว {series.systemCount} ใบ - แก้เลขเริ่มไม่ได้</p>
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ---------- หน้าหลัก ----------
export function WhtIssuePage() {
  const [year, setYear] = useState(thisYear);
  const [rows, setRows] = useState<WhtEmployeeYearRow[] | null>(null);
  const [unpaidRuns, setUnpaidRuns] = useState(0);
  const [certs, setCerts] = useState<WhtCertificate[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [series, setSeries] = useState<WhtSeries | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [signature, setSignature] = useState<PayslipSignature | null>(null);
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState<{ text: string; skipped: string[] } | null>(null);
  const [issueText, setIssueText] = useState(isoToDisplayDate(todayIso()));
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [printPicked, setPrintPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ type: "other"; replaces: WhtCertificate | null } | { type: "cancel"; cert: WhtCertificate } | { type: "history"; cert: WhtCertificate } | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [ey, list, ser, sup] = await Promise.all([hrApi.whtEmployeeYear(year), hrApi.listWht({ year, kind, q }), hrApi.whtSeries(year), hrApi.listSuppliers({ status: "ACTIVE" })]);
      setSeries(ser);
      setSuppliers(sup.suppliers);
      setRows(ey.rows);
      setUnpaidRuns(ey.unpaidRuns);
      setCerts(list.certificates);
      setTruncated(list.truncated);
      setPicked(new Set());
      setPrintPicked(new Set());
    } catch (err) {
      setError(errorText(err, "โหลดข้อมูล 50 ทวิ ไม่สำเร็จ"));
    }
  }, [year, kind, q]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    hrApi.getSignature().then(setSignature).catch(() => setSignature(null));
  }, []);

  const eligible = (rows ?? []).filter((r) => !r.certificate && r.idValid);

  async function issueEmployees() {
    setError("");
    setMessage(null);
    const issueDate = displayDateToIso(digits(issueText));
    if (!issueDate) return setError("วันที่ออกไม่ถูกต้อง");
    setBusy(true);
    try {
      const r = await hrApi.issueWhtEmployeeYear(year, issueDate, [...picked]);
      setMessage({ text: `ออก 50 ทวิ แล้ว ${r.created.length} ใบ${r.skipped.length ? ` · ข้าม ${r.skipped.length} คน` : ""}`, skipped: r.skipped.map((s) => `${s.name}: ${s.reason}`) });
      await load();
    } catch (err) {
      setError(errorText(err, "ออก 50 ทวิ ไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const printable = (certs ?? []).filter((c) => printPicked.has(c.id));

  return (
    <section className="content">
      <h1 tabIndex={-1}>Withholding Tax (50 ทวิ)</h1>
      <p>ออกหนังสือรับรองการหักภาษี ณ ที่จ่าย ให้พนักงาน (ประจำปี จากเงินเดือนที่จ่ายแล้ว) และผู้รับเงินอื่นๆ ที่เป็นบุคคลธรรมดา (ซับ) พิมพ์ได้ 2 ฉบับต่อใบ หรือบันทึกเป็น PDF</p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end", marginTop: 14 }}>
        <label className="field" style={{ width: 150 }}>
          ปีภาษี (พ.ศ.)
          <input type="number" value={year + 543} onChange={(e) => setYear(Number(e.target.value) - 543)} min={2563} max={2700} />
        </label>
        <button type="button" className="primary" onClick={() => setDialog({ type: "other", replaces: null })}>
          + ออก 50 ทวิ ให้ผู้รับเงินอื่น (ซับ)
        </button>
        <Link href="/hr/suppliers">จัดการ Suppliers ({suppliers.length} คน)</Link>
      </div>

      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <div className="customer-message" role="status">
          <b>{message.text}</b>
          {message.skipped.length > 0 && (
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {message.skipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <SeriesPanel year={year} series={series} onSaved={() => void load()} />

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>พนักงาน - ออกประจำปี {year + 543}</h2>
        </div>
        <p className="muted" style={{ margin: "0 23px 10px", fontSize: 13 }}>
          ยอดมาจากรอบเงินเดือนที่ &quot;จ่ายแล้ว&quot; ที่มีวันที่จ่ายในปีนี้เท่านั้น · แบบ ภ.ง.ด.1ก · ภาษีที่หักตามที่หักจริงในเงินเดือน (บริษัทไม่หัก = 0)
        </p>
        {unpaidRuns > 0 && (
          <p className="customer-message error" style={{ margin: "0 23px 10px" }}>
            ปี {year + 543} ยังมี {unpaidRuns} รอบเงินเดือนที่ยังไม่บันทึกว่าจ่ายแล้ว ยอดของรอบเหล่านั้นจะยังไม่ถูกรวม - ถ้าออกตอนนี้ต้องยกเลิกแล้วออกใหม่ภายหลัง
          </p>
        )}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="เลือกทุกคนที่ยังไม่ได้ออก"
                    checked={eligible.length > 0 && picked.size === eligible.length}
                    onChange={(e) => setPicked(e.target.checked ? new Set(eligible.map((r) => r.employeeId)) : new Set())}
                  />
                </th>
                <th>รหัส</th>
                <th>ชื่อ</th>
                <th>เลขประจำตัว</th>
                <th>ช่วงที่จ่าย</th>
                <th style={{ textAlign: "right" }}>เงินได้รวม</th>
                <th style={{ textAlign: "right" }}>ภาษีที่หัก</th>
                <th style={{ textAlign: "right" }}>ประกันสังคม</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {rows === null && (
                <tr>
                  <td colSpan={9} className="muted">
                    กำลังโหลด…
                  </td>
                </tr>
              )}
              {rows !== null && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    ปี {year + 543} ยังไม่มีเงินเดือนที่บันทึกว่าจ่ายแล้ว
                  </td>
                </tr>
              )}
              {rows?.map((r) => (
                <tr key={r.employeeId}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`เลือก ${r.fullName}`}
                      disabled={!!r.certificate || !r.idValid}
                      checked={picked.has(r.employeeId)}
                      onChange={() => setPicked((s) => toggle(s, r.employeeId))}
                    />
                  </td>
                  <td>{r.code}</td>
                  <td>{r.fullName}</td>
                  <td>{maskId(r.idNumber)}</td>
                  <td>
                    {r.periodLabel} ({r.months} งวด)
                  </td>
                  <td style={{ textAlign: "right" }}>{formatMoney(r.income)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(r.tax)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(r.sso)}</td>
                  <td>{r.certificate ? <span className="badge done">ออกแล้ว {r.certificate.certificateNo}</span> : r.idValid ? <span className="badge">ยังไม่ออก</span> : <span className="badge warn">เลขประจำตัวไม่ถูกต้อง</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end", padding: "14px 23px" }}>
          <label className="field" style={{ minWidth: 170 }}>
            วันที่ออก 50 ทวิ
            <DateInput value={issueText} onChange={(v) => setIssueText(formatDateDigitsCe(digits(v)))} />
          </label>
          <button type="button" className="primary" disabled={busy || picked.size === 0} onClick={issueEmployees}>
            {busy ? "กำลังออก…" : `ออก 50 ทวิ ที่เลือก (${picked.size} คน)`}
          </button>
        </div>
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>50 ทวิ ที่ออกแล้ว - ปี {year + 543}</h2>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", padding: "0 23px 12px" }}>
          <label className="field" style={{ minWidth: 150 }}>
            ผู้รับ
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">ทั้งหมด</option>
              <option value="EMPLOYEE">พนักงาน</option>
              <option value="OTHER">ผู้รับเงินอื่น (ซับ)</option>
            </select>
          </label>
          <label className="field" style={{ minWidth: 220 }}>
            ค้นหา (ชื่อ / เลขประจำตัว / เลขที่)
            <input value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button type="button" disabled={printable.length === 0} onClick={() => printWhtCertificates(printable, { signature })}>
            🖨 พิมพ์ที่เลือก ({printable.length})
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    aria-label="เลือกทุกใบ"
                    checked={!!certs?.length && printPicked.size === certs.length}
                    onChange={(e) => setPrintPicked(e.target.checked ? new Set((certs ?? []).map((c) => c.id)) : new Set())}
                  />
                </th>
                <th>เลขที่</th>
                <th>ผู้รับ</th>
                <th>เลขประจำตัว</th>
                <th>แบบ</th>
                <th style={{ textAlign: "right" }}>เงินที่จ่าย</th>
                <th style={{ textAlign: "right" }}>ภาษีที่หัก</th>
                <th>วันที่ออก</th>
                <th>สถานะ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {certs === null && (
                <tr>
                  <td colSpan={10} className="muted">
                    กำลังโหลด…
                  </td>
                </tr>
              )}
              {certs !== null && certs.length === 0 && (
                <tr>
                  <td colSpan={10} className="muted">
                    ยังไม่มี 50 ทวิ ที่ออก
                  </td>
                </tr>
              )}
              {certs?.map((c) => (
                <tr key={c.id} style={c.status === "CANCELLED" ? { opacity: 0.6 } : undefined}>
                  <td>
                    <input type="checkbox" aria-label={`เลือก ${c.certificateNo}`} checked={printPicked.has(c.id)} onChange={() => setPrintPicked((s) => toggle(s, c.id))} />
                  </td>
                  <td style={c.status === "CANCELLED" ? { textDecoration: "line-through" } : undefined}>{c.certificateNo}</td>
                  <td>
                    {c.payeeName}
                    {c.replacesId && <div className="muted" style={{ fontSize: 12 }}>ออกแทนใบที่ยกเลิก</div>}
                  </td>
                  <td>{maskId(c.payeeTaxId)}</td>
                  <td>{WHT_FORM_LABEL[c.formType]}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(c.totalPaid)}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(c.totalTax)}</td>
                  <td>{isoToDisplayDate(c.issueDate)}</td>
                  <td>
                    {c.status === "ISSUED" ? (
                      <span className="badge done">ออกแล้ว</span>
                    ) : (
                      <span className="badge" title={c.cancelReason ?? ""}>
                        ยกเลิก{c.replacedBy ? ` · แทนด้วย ${c.replacedBy.certificateNo}` : ""}
                      </span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" onClick={() => printWhtCertificates([c], { signature })}>
                      พิมพ์
                    </button>{" "}
                    <button type="button" onClick={() => setDialog({ type: "history", cert: c })}>
                      ประวัติ
                    </button>{" "}
                    {c.status === "ISSUED" && (
                      <button type="button" onClick={() => setDialog({ type: "cancel", cert: c })}>
                        ยกเลิก
                      </button>
                    )}
                    {c.status === "CANCELLED" && c.payeeKind === "OTHER" && !c.replacedBy && (
                      <button type="button" onClick={() => setDialog({ type: "other", replaces: c })}>
                        ออกใหม่แทน
                      </button>
                    )}
                    {c.status === "CANCELLED" && c.payeeKind === "EMPLOYEE" && !c.replacedBy && <span className="muted">ออกใหม่จากตารางพนักงานด้านบน</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {truncated && <p className="muted" style={{ padding: "0 23px 12px" }}>แสดง 500 ใบล่าสุด - ใช้ช่องค้นหาเพื่อหาใบที่เก่ากว่า</p>}
      </section>

      {dialog?.type === "other" && (
        <OtherDialog
          year={dialog.replaces?.taxYear ?? year}
          replaces={dialog.replaces}
          suppliers={suppliers}
          onClose={() => setDialog(null)}
          onDone={(c) => {
            setMessage({ text: `ออก 50 ทวิ ${c.certificateNo} ให้ ${c.payeeName} แล้ว`, skipped: [] });
            void load();
          }}
        />
      )}
      {dialog?.type === "cancel" && (
        <ReasonDialog
          title={`ยกเลิก 50 ทวิ ${dialog.cert.certificateNo}`}
          description={<span>เลขที่ {dialog.cert.certificateNo} ของ {dialog.cert.payeeName} จะคงอยู่เป็น &quot;ยกเลิก&quot; ไม่ถูกลบและไม่ใช้ซ้ำ จากนั้นออกใบใหม่แทนได้</span>}
          confirmLabel="ยกเลิกใบนี้"
          danger
          onConfirm={async (remark) => {
            await hrApi.cancelWht(dialog.cert.id, remark);
            await load();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "history" && <HistoryDialog title={`ประวัติ ${dialog.cert.certificateNo}`} load={() => hrApi.whtHistory(dialog.cert.id)} onClose={() => setDialog(null)} />}
    </section>
  );
}
