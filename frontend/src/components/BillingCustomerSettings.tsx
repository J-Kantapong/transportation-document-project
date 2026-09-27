"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type BillingTerms, type RateVehicleKind, type ServiceFeeRate, type ServiceFeeRateInput } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

// ตั้งค่าวางบิลของลูกค้าหนึ่งราย (แสดงในหน้าวางบิล): เงื่อนไข VAT/หัก ณ ที่จ่าย และตารางค่าดำเนินการ
// ราคาในตารางเป็นแค่ราคาเริ่มต้นที่ระบบเสนอให้รายคัน - บัญชีแก้ราคารายคันตอนออกบิลได้เสมอ

const percent = (text: string): number | null => {
  const n = Number.parseFloat(text);
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

export function BillingTermsEditor({ customerId, terms, onSaved }: { customerId: string; terms: BillingTerms; onSaved: (terms: BillingTerms) => void }) {
  const [vat, setVat] = useState(terms.vat);
  const [whtText, setWhtText] = useState(String(terms.whtRate));
  const [specialText, setSpecialText] = useState(terms.whtSpecialRate === null ? "" : String(terms.whtSpecialRate));
  const [untilText, setUntilText] = useState(terms.whtSpecialUntil ? isoToDisplayDate(terms.whtSpecialUntil) : "");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    // เหตุผลบังคับ เก็บในประวัติลูกค้า (ผู้ใช้ 2026-09-27)
    if (!remark.trim()) return setError("ใส่เหตุผลที่แก้เงื่อนไข");
    const whtRate = percent(whtText);
    if (whtRate === null) return setError("อัตราหัก ณ ที่จ่ายปกติต้องเป็นตัวเลข 0-100");
    let whtSpecialRate: number | null = null;
    let whtSpecialUntil: string | null = null;
    if (specialText.trim() !== "") {
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

interface RateState {
  label: string;
  vehicleKind: RateVehicleKind;
  ccMinText: string;
  ccMaxText: string;
  amountText: string;
  vatInclusive: boolean;
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
      payload.push({ label: r.label.trim(), vehicleKind: r.vehicleKind, ccMin, ccMax, amount, vatInclusive: r.vatInclusive });
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
        ระบบใช้แถวแรกจากบนลงล่างที่ชนิดรถและช่วง CC ตรงกับรถ (ตั้งแต่ ≤ CC &lt; น้อยกว่า) เว้นช่อง CC ว่าง = ไม่จำกัด ติ๊ก &quot;ราคารวม VAT&quot; เมื่อราคาที่ตกลงกับลูกค้ารวม VAT แล้ว
        เช่น 1,045 ระบบจะถอดเป็น 976.64 ให้
      </p>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ชื่อรายการ</th>
                <th>ชนิดรถ</th>
                <th>CC ตั้งแต่</th>
                <th>CC น้อยกว่า</th>
                <th>ราคา (บาท)</th>
                <th>ราคารวม VAT</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <input type="text" value={r.label} onChange={(e) => patch(i, { label: e.target.value })} style={{ width: 280 }} aria-label="ชื่อรายการ" />
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
          onClick={() => setRows((prev) => [...prev, { label: "", vehicleKind: "ANY", ccMinText: "", ccMaxText: "", amountText: "", vatInclusive: false }])}
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
