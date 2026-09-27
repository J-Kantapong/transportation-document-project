"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { ACCOUNT_LABEL, billingApi, type AccountPeriod, type BillingAccount, type BillingTerms, type RateKind, type RateVehicleKind, type ServiceFeeRate, type ServiceFeeRateInput } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

// ตั้งค่าวางบิลของลูกค้าหนึ่งราย (แสดงในหน้าวางบิล): เงื่อนไข VAT/หัก ณ ที่จ่าย และตารางค่าดำเนินการ
// ราคาในตารางเป็นแค่ราคาเริ่มต้นที่ระบบเสนอให้รายคัน - บัญชีแก้ราคารายคันตอนออกบิลได้เสมอ

const percent = (text: string): number | null => {
  const n = Number.parseFloat(text);
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

export function BillingTermsEditor({ customerId, terms, onSaved }: { customerId: string; terms: BillingTerms; onSaved: (terms: BillingTerms) => void }) {
  const [vat, setVat] = useState(terms.vat);
  // ปุ่มเลือกหัก / ไม่หัก ณ ที่จ่าย (ผู้ใช้ 2026-09-27) - ไม่หัก = อัตรา 0 ทั้งปกติและพิเศษ, กลับมาหักเริ่มที่ 3%
  const [withholds, setWithholds] = useState(terms.whtRate > 0 || (terms.whtSpecialRate ?? 0) > 0);
  const [whtText, setWhtText] = useState(String(terms.whtRate || 3));
  const [specialText, setSpecialText] = useState(terms.whtSpecialRate === null ? "" : String(terms.whtSpecialRate));
  const [untilText, setUntilText] = useState(terms.whtSpecialUntil ? isoToDisplayDate(terms.whtSpecialUntil) : "");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    // เหตุผลบังคับ เก็บในประวัติลูกค้า (ผู้ใช้ 2026-09-27)
    if (!remark.trim()) return setError("ใส่เหตุผลที่แก้เงื่อนไข");
    const whtRate = withholds ? percent(whtText) : 0;
    if (whtRate === null) return setError("อัตราหัก ณ ที่จ่ายปกติต้องเป็นตัวเลข 0-100");
    let whtSpecialRate: number | null = null;
    let whtSpecialUntil: string | null = null;
    if (withholds && specialText.trim() !== "") {
      whtSpecialRate = percent(specialText);
      if (whtSpecialRate === null) return setError("อัตราพิเศษต้องเป็นตัวเลข 0-100");
      if (untilText.trim() === "") return setError("ใส่วันสุดท้ายที่ใช้อัตราพิเศษ");
      whtSpecialUntil = displayDateToIso(untilText.replace(/\D/g, "")) || null;
      if (!whtSpecialUntil) return setError("วันสุดท้ายที่ใช้อัตราพิเศษไม่ถูกต้อง");
    }
    setSaving(true);
    setError("");
    try {
      const result = await billingApi.updateTerms(customerId, { vat, whtRate, whtSpecialRate, whtSpecialUntil, remark: remark.trim() });
      onSaved(result.terms);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f0f2f6", display: "grid", gap: 14 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
        <input type="checkbox" checked={vat} onChange={(e) => setVat(e.target.checked)} />
        บิลของลูกค้ารายนี้มี VAT 7%
      </label>
      <div className="inspect-filter" style={{ padding: 0 }} role="group" aria-label="หัก ณ ที่จ่าย">
        <button type="button" className={`filter-chip${withholds ? " selected" : ""}`} onClick={() => setWithholds(true)}>
          ลูกค้าหัก ณ ที่จ่าย
        </button>
        <button type="button" className={`filter-chip${!withholds ? " selected" : ""}`} onClick={() => setWithholds(false)}>
          ไม่หัก ณ ที่จ่าย
        </button>
      </div>
      {withholds && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
            <label className="field">
              หัก ณ ที่จ่าย อัตราปกติ (%)
              <input type="text" inputMode="decimal" value={whtText} onChange={(e) => setWhtText(e.target.value)} />
            </label>
            <label className="field">
              อัตราพิเศษชั่วคราว (%) เว้นว่างถ้าไม่มี
              <input type="text" inputMode="decimal" value={specialText} onChange={(e) => setSpecialText(e.target.value)} placeholder="เช่น 1" />
            </label>
            <label className="field">
              ใช้อัตราพิเศษถึงวันที่
              <DateInput
                value={untilText}
                onChange={(value) => setUntilText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
              />
            </label>
          </div>
          <p style={{ fontSize: 12 }}>ระบบเทียบวันสิ้นสุดกับวันที่ออกบิล พ้นวันนั้นแล้วกลับไปใช้อัตราปกติเอง บิลที่ออกไปแล้วไม่เปลี่ยน</p>
        </>
      )}
      <label className="field">
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ลูกค้าแจ้งเปลี่ยนอัตราหัก ณ ที่จ่าย" maxLength={500} />
      </label>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="primary" disabled={saving} onClick={handleSave}>
          บันทึกเงื่อนไข
        </button>
        {error && (
          <div className="customer-message error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

// บัญชีรับเงินของลูกค้า (ผู้ใช้ 2026-09-27): บริษัท (มี VAT) หรือบุคคล พร้อมวันเริ่มใช้ - ย้ายบัญชีแล้วงานที่ส่งก่อนวันนั้นยังอยู่บัญชีเดิม
export function BillingAccountEditor({ customerId, onSaved }: { customerId: string; onSaved: (current: BillingAccount) => void }) {
  const [periods, setPeriods] = useState<AccountPeriod[] | null>(null);
  const [current, setCurrent] = useState<BillingAccount>("COMPANY");
  const [account, setAccount] = useState<BillingAccount>("PERSONAL");
  const [fromText, setFromText] = useState(isoToDisplayDate(todayIso()));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    billingApi
      .accountPeriods(customerId)
      .then((r) => {
        if (!alive) return;
        setPeriods(r.periods);
        setCurrent(r.current);
        setAccount(r.current === "COMPANY" ? "PERSONAL" : "COMPANY");
      })
      .catch((err) => alive && setError(err instanceof ApiError ? err.message : "โหลดบัญชีไม่สำเร็จ"));
    return () => {
      alive = false;
    };
  }, [customerId]);

  async function handleSave() {
    if (!remark.trim()) return setError("ใส่เหตุผลที่ตั้ง/ย้ายบัญชี");
    const effectiveFrom = displayDateToIso(fromText.replace(/\D/g, ""));
    if (!effectiveFrom) return setError("วันที่เริ่มใช้ไม่ถูกต้อง");
    setSaving(true);
    setError("");
    try {
      const r = await billingApi.setAccount(customerId, { account, effectiveFrom, remark: remark.trim() });
      setPeriods(r.periods);
      setCurrent(r.current);
      setRemark("");
      onSaved(r.current);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f0f2f6", display: "grid", gap: 14 }}>
      <p style={{ fontSize: 14 }}>
        ตอนนี้ใช้ <b style={{ fontWeight: 600 }}>{ACCOUNT_LABEL[current]}</b>
        {periods && periods.length === 0 && <span className="muted"> (ยังไม่เคยตั้ง = บัญชีบริษัท)</span>}
      </p>
      {periods && periods.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ตั้งแต่วันที่</th>
                <th>บัญชี</th>
                <th>เหตุผล</th>
                <th>ผู้ตั้ง</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id}>
                  <td>{isoToDisplayDate(p.effectiveFrom)}</td>
                  <td>{ACCOUNT_LABEL[p.account]}</td>
                  <td>{p.remark}</td>
                  <td>{p.createdBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14 }}>
        <label className="field">
          ย้ายไปใช้
          <select value={account} onChange={(e) => setAccount(e.target.value as BillingAccount)}>
            <option value="COMPANY">{ACCOUNT_LABEL.COMPANY} (มี VAT)</option>
            <option value="PERSONAL">{ACCOUNT_LABEL.PERSONAL} (ไม่มี VAT)</option>
          </select>
        </label>
        <label className="field">
          ตั้งแต่วันที่
          <DateInput value={fromText} onChange={(value) => setFromText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
        </label>
      </div>
      <p style={{ fontSize: 12 }}>รถที่ส่งงานก่อนวันที่นี้ยังอยู่บัญชีเดิม ตั้งวันเดียวกับแถวเดิม = แก้แถวนั้น</p>
      <label className="field">
        เหตุผล *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น แยกบัญชีเพื่อกระจายฐานภาษี" maxLength={500} />
      </label>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button className="primary" disabled={saving || !periods} onClick={handleSave}>
          บันทึกบัญชี
        </button>
        {error && (
          <div className="customer-message error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

interface RateState {
  label: string;
  vehicleKind: RateVehicleKind;
  ccMinText: string;
  ccMaxText: string;
  amountText: string;
  vatInclusive: boolean;
  includesReceipt: boolean;
  kind: RateKind;
}

// CC พิมพ์มีจุลภาคได้เหมือนราคา (1,601) แต่ทั้งช่องต้องเป็นตัวเลข - ว่าง = ไม่จำกัด, NaN = ไม่ถูกต้อง
// (พบ 2026-09-27: เดิม parseFloat("1,601") = 1 บันทึกช่วง CC ผิดโดยไม่เตือน ราคาที่ระบบเสนอรายคันเลยผิดแถว)
function parseCc(text: string): number | null {
  const s = text.replace(/,/g, "").trim();
  if (s === "") return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}

// แสดง CC ที่บันทึกไว้แบบมีจุลภาค ให้ค่าที่ผิด (เช่น 1 แทน 1,601) เห็นชัด
const ccText = (cc: number | null) => (cc === null ? "" : cc.toLocaleString("en-US"));

const toState = (r: ServiceFeeRate): RateState => ({
  label: r.label,
  vehicleKind: r.vehicleKind,
  ccMinText: ccText(r.ccMin),
  ccMaxText: ccText(r.ccMax),
  amountText: String(r.amount),
  vatInclusive: r.vatInclusive,
  includesReceipt: r.includesReceipt,
  kind: r.kind,
});

export function BillingRatesEditor({ customerId, rates, onSaved }: { customerId: string; rates: ServiceFeeRate[]; onSaved: () => void }) {
  const [rows, setRows] = useState<RateState[]>(rates.map(toState));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const patch = (i: number, p: Partial<RateState>) => setRows((prev) => prev.map((r, n) => (n === i ? { ...r, ...p } : r)));

  async function handleSave() {
    const payload: ServiceFeeRateInput[] = [];
    for (const [i, r] of rows.entries()) {
      const at = `แถวที่ ${i + 1}`;
      if (!r.label.trim()) return setError(`${at}: ใส่ชื่อรายการ`);
      const amount = Number.parseFloat(r.amountText.replace(/,/g, ""));
      if (!Number.isFinite(amount) || amount < 0) return setError(`${at}: ราคาไม่ถูกต้อง`);
      const ccMin = parseCc(r.ccMinText);
      const ccMax = parseCc(r.ccMaxText);
      const ccInvalid = (ccMin !== null && !Number.isFinite(ccMin)) || (ccMax !== null && !Number.isFinite(ccMax));
      if (ccInvalid || (ccMin !== null && ccMax !== null && ccMin >= ccMax)) return setError(`${at}: ช่วง CC ไม่ถูกต้อง`);
      payload.push({ label: r.label.trim(), vehicleKind: r.vehicleKind, ccMin, ccMax, amount, vatInclusive: r.vatInclusive, includesReceipt: r.includesReceipt, kind: r.kind });
    }
    setSaving(true);
    setError("");
    try {
      await billingApi.replaceRates(customerId, payload);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #f0f2f6", display: "grid", gap: 12 }}>
      <p style={{ fontSize: 12 }}>
        ราคาหลัก: ระบบเลือกแถวแรกจากบนลงล่างที่ชนิดรถและช่วง CC ตรงกับรถ · ค่าเพิ่ม: &quot;ขอใช้&quot; ระบบบวกให้เองเมื่อรถจดจังหวัดอื่น (จังหวัดที่จดทะเบียนไม่ตรงกับจังหวัดเจ้าของรถ เช่น กรุงเทพฯ) และ &quot;ด่วน&quot; เมื่อยื่นเป็นงานด่วน · ช่อง CC (ตั้งแต่ ≤ CC &lt; น้อยกว่า) เว้นช่อง CC ว่าง = ไม่จำกัด ติ๊ก &quot;ราคารวม VAT&quot; เมื่อราคาที่ตกลงกับลูกค้ารวม VAT แล้ว และ &quot;ราคารวมใบเสร็จ&quot; เมื่อเป็นราคาเหมารวมค่าใบเสร็จ (เช่น YMAC จดใหม่ 650 = ใบเสร็จ 340 + ค่าดำเนินการ 310 ระบบหักค่าใบเสร็จจริงรายคันให้)
        เช่น 1,045 ระบบจะถอดเป็น 976.64 ให้
      </p>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ประเภท</th>
                <th>ชื่อรายการ</th>
                <th>ชนิดรถ</th>
                <th>CC ตั้งแต่</th>
                <th>CC น้อยกว่า</th>
                <th>ราคา (บาท)</th>
                <th>ราคารวม VAT</th>
                <th>ราคารวมใบเสร็จ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <select value={r.kind} onChange={(e) => patch(i, { kind: e.target.value as RateKind })} aria-label="ประเภท">
                      <option value="BASE">ราคาหลัก</option>
                      <option value="OTHER_PROVINCE">ค่าเพิ่ม: ขอใช้ (จดจังหวัดอื่น)</option>
                      <option value="URGENT">ค่าเพิ่ม: ด่วน</option>
                    </select>
                  </td>
                  <td>
                    <input type="text" value={r.label} onChange={(e) => patch(i, { label: e.target.value })} style={{ width: 200 }} aria-label="ชื่อรายการ" />
                  </td>
                  <td>
                    <select value={r.vehicleKind} onChange={(e) => patch(i, { vehicleKind: e.target.value as RateVehicleKind })} aria-label="ชนิดรถ">
                      <option value="ANY">ทุกชนิด</option>
                      <option value="CAR">รถยนต์</option>
                      <option value="MOTO">จักรยานยนต์</option>
                    </select>
                  </td>
                  <td>
                    <input type="text" inputMode="decimal" value={r.ccMinText} onChange={(e) => patch(i, { ccMinText: e.target.value })} style={{ width: 80 }} aria-label="CC ตั้งแต่" />
                  </td>
                  <td>
                    <input type="text" inputMode="decimal" value={r.ccMaxText} onChange={(e) => patch(i, { ccMaxText: e.target.value })} style={{ width: 80 }} aria-label="CC น้อยกว่า" />
                  </td>
                  <td>
                    <input type="text" inputMode="decimal" value={r.amountText} onChange={(e) => patch(i, { amountText: e.target.value })} style={{ width: 100, textAlign: "right" }} aria-label="ราคา" />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.vatInclusive} onChange={(e) => patch(i, { vatInclusive: e.target.checked })} aria-label="ราคารวม VAT" />
                  </td>
                  <td>
                    <input type="checkbox" checked={r.includesReceipt} onChange={(e) => patch(i, { includesReceipt: e.target.checked })} aria-label="ราคารวมใบเสร็จ" />
                  </td>
                  <td>
                    <button className="text-button" onClick={() => setRows((prev) => prev.filter((_, n) => n !== i))}>
                      ลบ
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button
          className="text-button"
          onClick={() => setRows((prev) => [...prev, { label: "", vehicleKind: "ANY", ccMinText: "", ccMaxText: "", amountText: "", vatInclusive: false, includesReceipt: false, kind: "BASE" }])}
        >
          + เพิ่มแถวราคา
        </button>
        <button className="primary" disabled={saving} onClick={handleSave}>
          บันทึกตารางค่าดำเนินการ
        </button>
        {error && (
          <div className="customer-message error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
