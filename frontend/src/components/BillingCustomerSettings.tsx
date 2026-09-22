"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type BillingTerms, type RateVehicleKind, type ServiceFeeRate, type ServiceFeeRateInput } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate } from "@/lib/date";

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    const whtRate = percent(whtText);
    if (whtRate === null) return setError("อัตราหัก ณ ที่จ่ายปกติต้องเป็นตัวเลข 0-100");
    let whtSpecialRate: number | null = null;
    let whtSpecialUntil: string | null = null;
    if (specialText.trim() !== "") {
      whtSpecialRate = percent(specialText);
      if (whtSpecialRate === null) return setError("อัตราพิเศษต้องเป็นตัวเลข 0-100");
      whtSpecialUntil = displayDateToIso(untilText.replace(/\D/g, "")) || null;
      if (!whtSpecialUntil) return setError("ใส่วันสุดท้ายที่ใช้อัตราพิเศษ");
    }
    setSaving(true);
    setError("");
    try {
      const result = await billingApi.updateTerms(customerId, { vat, whtRate, whtSpecialRate, whtSpecialUntil });
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
          <input
            type="text"
            inputMode="numeric"
            placeholder="วว/ดด/ปปปป"
            value={untilText}
            onChange={(e) => setUntilText(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
          />
        </label>
      </div>
      <p style={{ fontSize: 12 }}>ระบบเทียบวันสิ้นสุดกับวันที่ออกบิล พ้นวันนั้นแล้วกลับไปใช้อัตราปกติเอง บิลที่ออกไปแล้วไม่เปลี่ยน</p>
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

const toState = (r: ServiceFeeRate): RateState => ({
  label: r.label,
  vehicleKind: r.vehicleKind,
  ccMinText: r.ccMin === null ? "" : String(r.ccMin),
  ccMaxText: r.ccMax === null ? "" : String(r.ccMax),
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
      const cc = (text: string) => (text.trim() === "" ? null : Number.parseFloat(text));
      const ccMin = cc(r.ccMinText);
      const ccMax = cc(r.ccMaxText);
      if ((ccMin !== null && !Number.isFinite(ccMin)) || (ccMax !== null && !Number.isFinite(ccMax))) return setError(`${at}: ช่วง CC ไม่ถูกต้อง`);
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
