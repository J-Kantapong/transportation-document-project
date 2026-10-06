"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, HistoryDialog, HrDialog, moneyOf, ReasonDialog } from "@/components/hr/HrDialog";
import { hrApi, maskId, WHT_INCOME_LABEL, WHT_OTHER_INCOME_TYPES, type Supplier, type SupplierInput, type WhtIncomeType } from "@/lib/hr-api";

// ทะเบียนผู้รับเงินที่ไม่ใช่พนักงาน (ซับ/ผู้รับจ้างบุคคลธรรมดา) ไว้ออก 50 ทวิ (ผู้ใช้ 2026-10-06) - แยกจากทะเบียนพนักงาน, ADMIN เท่านั้น
// เก็บข้อมูลผู้รับ + ค่าเริ่มต้นของงาน (ประเภทเงินได้ / รายละเอียด / อัตราภาษี) ที่ไปเติมในฟอร์มออก 50 ทวิ

const SHORT_TYPE: Record<WhtIncomeType, string> = { SALARY: "เงินเดือน", FEE: "ค่าธรรมเนียม/นายหน้า", ROYALTY: "ค่าลิขสิทธิ์", INTEREST: "ดอกเบี้ย", SERVICE: "จ้างทำของ/บริการ", OTHER: "อื่นๆ" };

function SupplierDialog({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const closeRef = useRef<() => void>(() => {});
  const [name, setName] = useState(supplier?.name ?? "");
  const [taxId, setTaxId] = useState(supplier?.taxId ?? "");
  const [address, setAddress] = useState(supplier?.address ?? "");
  const [type, setType] = useState<WhtIncomeType>(supplier?.defaultIncomeType ?? "SERVICE");
  const [description, setDescription] = useState(supplier?.defaultDescription ?? "ค่าจ้างทำของ");
  const [rateText, setRateText] = useState(String(supplier?.defaultRate ?? 3));
  const [note, setNote] = useState(supplier?.note ?? "");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    const rate = moneyOf(rateText);
    if (rate === null || Number.isNaN(rate) || rate > 100) return setError("อัตราภาษีต้องเป็นตัวเลข 0 ถึง 100");
    if (supplier && !remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้ไข");
    const data: SupplierInput = {
      name: name.trim(),
      taxId: taxId.replace(/\D/g, ""),
      address: address.trim() || null,
      defaultIncomeType: type,
      defaultDescription: description.trim() || null,
      defaultRate: rate,
      note: note.trim() || null,
    };
    setBusy(true);
    try {
      if (supplier) await hrApi.updateSupplier(supplier.id, { ...data, remark: remark.trim(), expectedUpdatedAt: supplier.updatedAt });
      else await hrApi.createSupplier(data);
      onSaved();
      closeRef.current();
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HrDialog title={supplier ? `แก้ไข ${supplier.name}` : "เพิ่ม Supplier"} onClose={onClose} width={640} closeRef={closeRef}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
        <label className="field">
          ชื่อ-สกุล (พร้อมคำนำหน้า) *
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
        </label>
        <label className="field">
          เลขประจำตัวประชาชน / ผู้เสียภาษี 13 หลัก *
          <input value={taxId} onChange={(e) => setTaxId(e.target.value.replace(/[^\d-]/g, "").slice(0, 17))} inputMode="numeric" />
        </label>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        ที่อยู่ (พิมพ์ในใบ 50 ทวิ)
        <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={300} />
      </label>
      <p className="muted" style={{ margin: "14px 0 6px", fontSize: 13 }}>
        ค่าเริ่มต้นเมื่อเลือกคนนี้ในฟอร์มออก 50 ทวิ (แก้ในฟอร์มได้ทุกครั้ง)
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <label className="field">
          ประเภทเงินได้
          <select value={type} onChange={(e) => setType(e.target.value as WhtIncomeType)}>
            {WHT_OTHER_INCOME_TYPES.map((t) => (
              <option key={t} value={t}>
                {WHT_INCOME_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          รายละเอียด
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={120} />
        </label>
        <label className="field" style={{ maxWidth: 140 }}>
          อัตราภาษี (%)
          <input value={rateText} onChange={(e) => setRateText(e.target.value)} inputMode="decimal" />
        </label>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        หมายเหตุภายใน
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </label>
      {supplier && (
        <label className="field" style={{ marginTop: 12 }}>
          เหตุผลที่แก้ไข *
          <input value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} />
        </label>
      )}
      {supplier && supplier.certificateCount > 0 && <p className="muted" style={{ fontSize: 13 }}>แก้ที่นี่ไม่ทำให้ 50 ทวิ ที่ออกไปแล้ว ({supplier.certificateCount} ใบ) เปลี่ยน - ใบเก่าเก็บข้อมูลตอนที่ออกไว้</p>}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions" style={{ marginTop: 14 }}>
        <button type="button" className="primary" disabled={busy} onClick={submit}>
          {busy ? "กำลังบันทึก…" : "บันทึก"}
        </button>
      </div>
    </HrDialog>
  );
}

export function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [status, setStatus] = useState("ACTIVE");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<{ type: "edit"; supplier: Supplier | null } | { type: "status"; supplier: Supplier } | { type: "history"; supplier: Supplier } | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      setSuppliers((await hrApi.listSuppliers({ status, q })).suppliers);
    } catch (err) {
      setError(errorText(err, "โหลดรายการ Supplier ไม่สำเร็จ"));
    }
  }, [status, q]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className="content">
      <h1 tabIndex={-1}>Suppliers</h1>
      <p>
        Supplier = ซับ/ผู้รับจ้างที่เป็นบุคคลธรรมดา ไว้เลือกตอนออก <Link href="/hr/wht">50 ทวิ</Link> ไม่ต้องพิมพ์ชื่อ เลขประจำตัว และที่อยู่ใหม่ทุกครั้ง · พนักงานอยู่ในทะเบียนพนักงานแยกต่างหาก
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", marginTop: 14 }}>
        <label className="field" style={{ minWidth: 150 }}>
          สถานะ
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="ACTIVE">ใช้งาน</option>
            <option value="INACTIVE">เลิกใช้</option>
            <option value="">ทั้งหมด</option>
          </select>
        </label>
        <label className="field" style={{ minWidth: 240 }}>
          ค้นหา (ชื่อ / เลขประจำตัว)
          <input value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className="primary" onClick={() => setDialog({ type: "edit", supplier: null })}>
          + เพิ่ม Supplier
        </button>
      </div>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ชื่อ</th>
                <th>เลขประจำตัว</th>
                <th>ค่าเริ่มต้น</th>
                <th style={{ textAlign: "right" }}>50 ทวิ ที่ออก</th>
                <th>สถานะ</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {suppliers === null && (
                <tr>
                  <td colSpan={6} className="muted">
                    กำลังโหลด…
                  </td>
                </tr>
              )}
              {suppliers !== null && suppliers.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted">
                    ยังไม่มี Supplier ในทะเบียน
                  </td>
                </tr>
              )}
              {suppliers?.map((s) => (
                <tr key={s.id} style={s.status === "INACTIVE" ? { opacity: 0.6 } : undefined}>
                  <td>
                    {s.name}
                    {s.address && <div className="muted" style={{ fontSize: 12 }}>{s.address}</div>}
                  </td>
                  <td>{maskId(s.taxId)}</td>
                  <td>
                    {SHORT_TYPE[s.defaultIncomeType]}
                    {s.defaultDescription ? ` · ${s.defaultDescription}` : ""} · {s.defaultRate}%
                  </td>
                  <td style={{ textAlign: "right" }}>{s.certificateCount}</td>
                  <td>{s.status === "ACTIVE" ? <span className="badge done">ใช้งาน</span> : <span className="badge">เลิกใช้</span>}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button type="button" onClick={() => setDialog({ type: "edit", supplier: s })}>
                      แก้ไข
                    </button>{" "}
                    <button type="button" onClick={() => setDialog({ type: "history", supplier: s })}>
                      ประวัติ
                    </button>{" "}
                    <button type="button" onClick={() => setDialog({ type: "status", supplier: s })}>
                      {s.status === "ACTIVE" ? "เลิกใช้" : "ใช้ต่อ"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {dialog?.type === "edit" && <SupplierDialog supplier={dialog.supplier} onClose={() => setDialog(null)} onSaved={() => void load()} />}
      {dialog?.type === "status" && (
        <ReasonDialog
          title={dialog.supplier.status === "ACTIVE" ? `เลิกใช้ ${dialog.supplier.name}` : `ใช้ต่อ ${dialog.supplier.name}`}
          description={dialog.supplier.status === "ACTIVE" ? "เลิกใช้แล้วจะไม่ขึ้นในตัวเลือกตอนออก 50 ทวิ แต่ไม่ถูกลบ ใบที่ออกไปแล้วยังอยู่ครบ" : "จะกลับมาอยู่ในตัวเลือกตอนออก 50 ทวิ"}
          confirmLabel={dialog.supplier.status === "ACTIVE" ? "เลิกใช้" : "ใช้ต่อ"}
          danger={dialog.supplier.status === "ACTIVE"}
          onConfirm={async (remark) => {
            if (dialog.supplier.status === "ACTIVE") await hrApi.deactivateSupplier(dialog.supplier.id, remark);
            else await hrApi.reactivateSupplier(dialog.supplier.id, remark);
            await load();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.type === "history" && <HistoryDialog title={`ประวัติ ${dialog.supplier.name}`} load={() => hrApi.supplierHistory(dialog.supplier.id)} onClose={() => setDialog(null)} />}
    </section>
  );
}
