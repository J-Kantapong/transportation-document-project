"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type Customer,
  type CustomerHistoryEntry,
  type NewCustomerInput,
  type UpdateCustomerInput,
} from "@/lib/api";
import { canCreateCustomer, getCachedUser } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, timestampToDisplayDate } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

const EMPTY_FORM: NewCustomerInput = {
  name: "",
  company: "",
  branch: "",
  address: "",
  taxId: "",
  phone: "",
  email: "",
};

const DETAIL_FIELDS: Array<[keyof NewCustomerInput, string]> = [
  ["name", "ชื่อลูกค้า"],
  ["company", "บริษัท"],
  ["branch", "สาขา"],
  ["address", "ที่อยู่บริษัท"],
  ["taxId", "เลขประจำตัวผู้เสียภาษี"],
  ["phone", "เบอร์โทรศัพท์"],
  ["email", "อีเมล"],
];

// ชื่อช่องในประวัติการแก้ไข (คีย์ = คอลัมน์ของ Customer ที่ backend เก็บใน AuditLog.changes)
const HISTORY_LABELS: Record<string, string> = {
  ...Object.fromEntries(DETAIL_FIELDS),
  billingVat: "VAT 7%",
  billingWhtRate: "หัก ณ ที่จ่าย อัตราปกติ (%)",
  billingWhtSpecialRate: "อัตราพิเศษชั่วคราว (%)",
  billingWhtSpecialUntil: "ใช้อัตราพิเศษถึงวันที่",
};

function historyValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "มี" : "ไม่มี";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return isoToDisplayDate(value);
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// วันเวลาที่แก้ ตามเวลาในเครื่องผู้ใช้ (เวลาไทย)
function historyTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${timestampToDisplayDate(iso)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")} น.`;
}

// ประวัติการแก้ไขข้อมูลลูกค้า (ผู้ใช้ 2026-09-27) ใหม่สุดก่อน - ADMIN เท่านั้น
function CustomerHistory({ entries, error }: { entries: CustomerHistoryEntry[] | null; error: string }) {
  return (
    <section style={{ marginTop: 24, borderTop: "1px solid #edf0f5", paddingTop: 16 }}>
      <h3 style={{ fontSize: 15, margin: "0 0 10px" }}>ประวัติการแก้ไข</h3>
      {error ? (
        <div className="customer-message error">{error}</div>
      ) : entries === null ? (
        <div className="muted" style={{ fontSize: 13 }}>
          กำลังโหลดประวัติ…
        </div>
      ) : !entries.length ? (
        <div className="muted" style={{ fontSize: 13 }}>
          ยังไม่เคยแก้ไข
        </div>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12 }}>
          {entries.map((entry) => (
            <li key={entry.id} style={{ fontSize: 13, lineHeight: 1.7, overflowWrap: "anywhere" }}>
              <div className="muted">
                {historyTime(entry.createdAt)} · {entry.editedBy ?? "ระบบ"}
              </div>
              <div>เหตุผล: {entry.remark}</div>
              {Object.entries(entry.changes ?? {}).map(([field, change]) => (
                <div key={field} style={{ whiteSpace: "pre-wrap" }}>
                  {HISTORY_LABELS[field] ?? field}: {historyValue(change?.from)} → {historyValue(change?.to)}
                </div>
              ))}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// เงื่อนไขวางบิลในฟอร์มแก้ไข (ข้อความตามที่พิมพ์ - แปลงเป็นตัวเลขตอนบันทึก เหมือน BillingTermsEditor ในหน้าวางบิล)
interface TermsForm {
  vat: boolean;
  whtText: string;
  specialText: string;
  untilText: string; // วว/ดด/ปปปป
}

const formOf = (c: Customer): NewCustomerInput => ({
  name: c.name,
  company: c.company ?? "",
  branch: c.branch ?? "",
  address: c.address ?? "",
  taxId: c.taxId ?? "",
  phone: c.phone ?? "",
  email: c.email ?? "",
});

const numberText = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "" : String(Number(v)));

// ไม่มีคอลัมน์ billing* ในข้อมูลที่โหลดมา = ไม่แสดงส่วนเงื่อนไขวางบิล (ไม่ส่ง terms ไปแก้)
function termsOf(c: Customer): TermsForm | null {
  if (typeof c.billingVat !== "boolean") return null;
  return {
    vat: c.billingVat,
    whtText: numberText(c.billingWhtRate),
    specialText: numberText(c.billingWhtSpecialRate),
    // คอลัมน์วันที่ล้วน (เที่ยงคืน UTC) ตัด 10 ตัวแรกได้
    untilText: c.billingWhtSpecialUntil ? isoToDisplayDate(c.billingWhtSpecialUntil.slice(0, 10)) : "",
  };
}

const percent = (text: string): number | null => {
  const n = Number.parseFloat(text);
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
};

function termsText(c: Customer): string {
  const t = termsOf(c);
  if (!t) return "—";
  const parts = [t.vat ? "มี VAT 7%" : "ไม่มี VAT", `หัก ณ ที่จ่าย ${t.whtText || "0"}%`];
  if (t.specialText) parts.push(`อัตราพิเศษ ${t.specialText}% ถึง ${t.untilText || "—"}`);
  return parts.join(" · ");
}

function parseTerms(t: TermsForm): { terms: NonNullable<UpdateCustomerInput["terms"]> } | { error: string } {
  const whtRate = percent(t.whtText);
  if (whtRate === null) return { error: "อัตราหัก ณ ที่จ่ายปกติต้องเป็นตัวเลข 0-100" };
  if (t.specialText.trim() === "") return { terms: { vat: t.vat, whtRate, whtSpecialRate: null, whtSpecialUntil: null } };
  const whtSpecialRate = percent(t.specialText);
  if (whtSpecialRate === null) return { error: "อัตราพิเศษต้องเป็นตัวเลข 0-100" };
  if (t.untilText.trim() === "") return { error: "ใส่วันสุดท้ายที่ใช้อัตราพิเศษ" };
  const whtSpecialUntil = displayDateToIso(t.untilText.replace(/\D/g, ""));
  if (!whtSpecialUntil) return { error: "วันสุดท้ายที่ใช้อัตราพิเศษไม่ถูกต้อง" };
  return { terms: { vat: t.vat, whtRate, whtSpecialRate, whtSpecialUntil } };
}

// 7 ช่องของลูกค้า - ใช้ทั้งฟอร์มเพิ่มและฟอร์มแก้ไข (กติกาเดียวกัน)
function CustomerFieldInputs({
  value,
  onChange,
}: {
  value: NewCustomerInput;
  onChange: (key: keyof NewCustomerInput, value: string) => void;
}) {
  return (
    <div className="customer-grid">
      <label className="field">
        ชื่อลูกค้า *
        <input value={value.name} maxLength={250} required autoComplete="name" onChange={(e) => onChange("name", e.target.value)} />
      </label>
      <label className="field">
        บริษัท
        <input value={value.company} maxLength={250} autoComplete="organization" onChange={(e) => onChange("company", e.target.value)} />
      </label>
      <label className="field">
        สาขา
        <input value={value.branch} maxLength={250} autoComplete="off" onChange={(e) => onChange("branch", e.target.value)} />
      </label>
      <label className="field wide">
        ที่อยู่บริษัท
        <textarea
          value={value.address}
          maxLength={2000}
          rows={3}
          autoComplete="street-address"
          onChange={(e) => onChange("address", e.target.value)}
        />
      </label>
      <label className="field">
        เลขประจำตัวผู้เสียภาษี
        <input
          value={value.taxId}
          maxLength={13}
          inputMode="numeric"
          pattern="[0-9]{13}"
          title="กรอกตัวเลข 13 หลัก"
          autoComplete="off"
          onChange={(e) => onChange("taxId", e.target.value)}
        />
      </label>
      <label className="field">
        เบอร์โทรศัพท์
        <input type="tel" value={value.phone} maxLength={250} autoComplete="tel" onChange={(e) => onChange("phone", e.target.value)} />
      </label>
      <label className="field">
        อีเมล
        <input type="email" value={value.email} maxLength={250} autoComplete="email" onChange={(e) => onChange("email", e.target.value)} />
      </label>
    </div>
  );
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [form, setForm] = useState<NewCustomerInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({
    text: "",
  });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<Customer | null>(null);
  // เพิ่มและแก้ไขลูกค้าได้เฉพาะ ADMIN (ผู้ใช้ 2026-09-22 / แก้ไข 2026-09-27) - backend กัน POST/PATCH /api/customers อีกชั้น
  const [canAdd, setCanAdd] = useState(false);

  // แก้ไขข้อมูลลูกค้าใน dialog (ผู้ใช้ 2026-09-27): ต้องมีเหตุผลทุกครั้ง backend เก็บค่าก่อน/หลังลงประวัติ
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<NewCustomerInput>(EMPTY_FORM);
  const [editTerms, setEditTerms] = useState<TermsForm | null>(null);
  // ส่งเงื่อนไขวางบิลเฉพาะเมื่อแก้ช่องเหล่านั้นจริง - ไม่งั้นค่าเก่าในหน้านี้จะทับค่าที่บัญชีเพิ่งแก้ในหน้าวางบิล
  const [termsTouched, setTermsTouched] = useState(false);
  const [editRemark, setEditRemark] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editMessage, setEditMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [history, setHistory] = useState<CustomerHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState("");
  // ลูกค้าที่เปิดดูอยู่ - คำตอบประวัติที่มาช้าของลูกค้าคนก่อนจะไม่ทับของคนปัจจุบัน
  const historyFor = useRef("");

  async function loadHistory(id: string) {
    historyFor.current = id;
    setHistory(null);
    setHistoryError("");
    try {
      const { entries } = await api.customerHistory(id);
      if (historyFor.current === id) setHistory(entries);
    } catch (error) {
      if (historyFor.current === id) setHistoryError(error instanceof ApiError ? error.message : "โหลดประวัติไม่สำเร็จ");
    }
  }

  // คืนรายการที่โหลดได้ (null = โหลดไม่สำเร็จ) - ตอนแก้ชนกับคนอื่นใช้หาข้อมูลล่าสุดของลูกค้าที่เปิดอยู่
  async function loadCustomers(): Promise<Customer[] | null> {
    setLoading(true);
    setListError("");
    try {
      const data = await api.listCustomers();
      setCustomers(data.customers);
      return data.customers;
    } catch (error) {
      setListError(
        error instanceof ApiError
          ? error.message
          : "โหลดข้อมูลไม่สำเร็จ กรุณากดโหลดรายการใหม่",
      );
      return null;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadCustomers sets a loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCustomers();
    setCanAdd(canCreateCustomer(getCachedUser()?.roles ?? []));
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await api.createCustomer(form);
      setForm(EMPTY_FORM);
      setMessage({ text: "บันทึกข้อมูลลูกค้าเรียบร้อยแล้ว" });
      await loadCustomers();
    } catch (error) {
      setMessage({
        text: error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ",
        error: true,
      });
    } finally {
      setSaving(false);
    }
  }

  function openDetail(customer: Customer) {
    setDetail(customer);
    setEditing(false);
    setEditMessage({ text: "" });
    if (canAdd) void loadHistory(customer.id);
    dialogRef.current?.showModal();
  }

  function startEdit() {
    if (!detail) return;
    setEditForm(formOf(detail));
    setEditTerms(termsOf(detail));
    setTermsTouched(false);
    setEditRemark("");
    setEditMessage({ text: "" });
    setEditing(true);
  }

  function patchTerms(patch: Partial<TermsForm>) {
    setEditTerms((prev) => (prev ? { ...prev, ...patch } : prev));
    setTermsTouched(true);
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail) return;
    if (!editRemark.trim()) {
      setEditMessage({ text: "กรุณาระบุเหตุผลที่แก้ไข (Remark) ก่อนบันทึก", error: true });
      return;
    }
    // ส่ง updatedAt ตอนเปิดไปด้วย: ถ้ามีคนแก้ลูกค้ารายนี้ไปก่อน backend ตอบ 409 แทนการเอาค่าเก่าในหน้านี้ไปทับ
    const data: UpdateCustomerInput = { ...editForm, remark: editRemark.trim(), expectedUpdatedAt: detail.updatedAt };
    if (editTerms && termsTouched) {
      const parsed = parseTerms(editTerms);
      if ("error" in parsed) {
        setEditMessage({ text: parsed.error, error: true });
        return;
      }
      data.terms = parsed.terms;
    }
    setEditSaving(true);
    setEditMessage({ text: "กำลังบันทึก…" });
    try {
      const { customer } = await api.updateCustomer(detail.id, data);
      setDetail(customer);
      setEditing(false);
      setEditMessage({ text: "บันทึกการแก้ไขเรียบร้อยแล้ว" });
      void loadHistory(customer.id);
      await loadCustomers();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // มีคนแก้ไปก่อน: โหลดข้อมูลล่าสุดมาแสดงแทน ให้ ADMIN ดูของใหม่แล้วกดแก้ไขอีกครั้ง
        const id = detail.id;
        const fresh = (await loadCustomers())?.find((c) => c.id === id);
        if (fresh) {
          setDetail(fresh);
          setEditing(false);
          void loadHistory(id);
          setEditMessage({
            text: "มีคนแก้ข้อมูลลูกค้ารายนี้ไปก่อน - ด้านบนคือข้อมูลล่าสุด กรุณากด แก้ไข แล้วแก้ใหม่",
            error: true,
          });
          return;
        }
      }
      setEditMessage({ text: error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setEditSaving(false);
    }
  }

  function updateField<K extends keyof NewCustomerInput>(
    key: K,
    value: string,
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>ฐานข้อมูลลูกค้า</h1>
          <p>จัดเก็บข้อมูลลูกค้า บริษัท และข้อมูลติดต่อ</p>
        </div>
      </div>

      {canAdd && (
        <section className="panel">
          <div
            className="panel-head"
            style={{ borderBottom: "1px solid #edf0f5" }}
          >
            <h2>เพิ่มลูกค้า</h2>
            <span className="muted">* จำเป็นต้องกรอก</span>
          </div>
          <form className="customer-form" onSubmit={handleSubmit}>
            <CustomerFieldInputs value={form} onChange={updateField} />
            <div className="form-actions">
              <button className="primary" type="submit" disabled={saving}>
                บันทึกข้อมูลลูกค้า
              </button>
              <span
                className={`customer-message${message.error ? " error" : message.text ? " success" : ""}`}
                role="status"
                aria-live="polite"
              >
                {message.text}
              </span>
            </div>
          </form>
        </section>
      )}

      <section className="panel customer-list">
        <div className="panel-head">
          <h2>
            รายชื่อลูกค้า{" "}
            <span className="muted">
              {customers.length ? `(${customers.length} รายการ)` : ""}
            </span>
          </h2>
          <button className="text-button" onClick={loadCustomers}>
            โหลดรายการใหม่
          </button>
        </div>
        {loading ? (
          <div className="empty-customers">กำลังโหลดข้อมูลลูกค้า…</div>
        ) : listError ? (
          <div className="empty-customers" role="alert">
            {listError}
          </div>
        ) : !customers.length ? (
          <div className="empty-customers">
            ยังไม่มีข้อมูลลูกค้า
            <br />
            เพิ่มลูกค้ารายแรกด้วยแบบฟอร์มด้านบน
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ชื่อลูกค้า</th>
                  <th>บริษัท / สาขา</th>
                  <th>เบอร์โทรศัพท์</th>
                  <th>อีเมล</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer) => (
                  <tr key={customer.id}>
                    <td>{customer.name}</td>
                    <td>
                      {customer.company || "—"}
                      <div className="sub">{customer.branch || "—"}</div>
                    </td>
                    <td>{customer.phone || "—"}</td>
                    <td>{customer.email || "—"}</td>
                    <td>
                      <button
                        className="text-button"
                        onClick={() => openDetail(customer)}
                      >
                        ดูข้อมูล
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <dialog
        ref={dialogRef}
        onClick={(event) => {
          // กำลังแก้ไขอยู่ คลิกนอกกล่องไม่ปิด (กันข้อมูลที่พิมพ์ไว้หาย) - ปิดด้วยปุ่ม × หรือ ยกเลิก
          if (event.target === event.currentTarget && !editing) dialogRef.current?.close();
        }}
        style={editing ? { width: "min(760px, 92vw)" } : undefined}
      >
        <button
          className="close"
          aria-label="ปิด"
          onClick={() => dialogRef.current?.close()}
        >
          ×
        </button>
        {detail && !editing && (
          <>
            <h2>ข้อมูลลูกค้า</h2>
            <dl className="customer-detail">
              {DETAIL_FIELDS.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{detail[key] || "—"}</dd>
                </div>
              ))}
              {canAdd && (
                <div>
                  <dt>เงื่อนไขวางบิล</dt>
                  <dd>{termsText(detail)}</dd>
                </div>
              )}
            </dl>
            {canAdd && (
              <div className="form-actions">
                <button type="button" className="primary" onClick={startEdit}>
                  แก้ไข
                </button>
                {editMessage.text && (
                  <span className={`customer-message${editMessage.error ? " error" : " success"}`} role="status">
                    {editMessage.text}
                  </span>
                )}
              </div>
            )}
            {canAdd && <CustomerHistory entries={history} error={historyError} />}
          </>
        )}
        {detail && editing && (
          <>
            <h2>แก้ไขข้อมูลลูกค้า</h2>
            <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
              บิลที่ออกไปแล้วยังใช้ชื่อ ที่อยู่ และเลขภาษีตามตอนออกบิล - บิลที่ออกหลังจากนี้ใช้ข้อมูลที่แก้
            </p>
            <form onSubmit={handleEditSubmit}>
              <CustomerFieldInputs value={editForm} onChange={(key, value) => setEditForm((prev) => ({ ...prev, [key]: value }))} />
              {editTerms && (
                <fieldset style={{ border: "1px solid #edf0f5", borderRadius: 8, padding: "14px 16px", marginTop: 20, display: "grid", gap: 14 }}>
                  <legend style={{ fontSize: 14, padding: "0 6px" }}>เงื่อนไขวางบิล</legend>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                    <input type="checkbox" checked={editTerms.vat} onChange={(e) => patchTerms({ vat: e.target.checked })} />
                    บิลของลูกค้ารายนี้มี VAT 7%
                  </label>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14 }}>
                    <label className="field">
                      หัก ณ ที่จ่าย อัตราปกติ (%)
                      <input type="text" inputMode="decimal" value={editTerms.whtText} onChange={(e) => patchTerms({ whtText: e.target.value })} />
                    </label>
                    <label className="field">
                      อัตราพิเศษชั่วคราว (%) เว้นว่างถ้าไม่มี
                      <input
                        type="text"
                        inputMode="decimal"
                        value={editTerms.specialText}
                        placeholder="เช่น 1"
                        onChange={(e) => patchTerms({ specialText: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      ใช้อัตราพิเศษถึงวันที่
                      <DateInput
                        value={editTerms.untilText}
                        onChange={(value) => patchTerms({ untilText: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)) })}
                      />
                    </label>
                  </div>
                </fieldset>
              )}
              <label className="field" style={{ marginTop: 20 }}>
                เหตุผลที่แก้ไข (Remark) *
                <textarea
                  required
                  maxLength={500}
                  value={editRemark}
                  onChange={(e) => setEditRemark(e.target.value)}
                  placeholder="ระบุเหตุผลที่แก้ไขข้อมูลลูกค้ารายนี้ - จำเป็นต้องกรอกทุกครั้ง"
                />
              </label>
              <div className="form-actions" style={{ marginTop: 16 }}>
                <button type="submit" className="primary" disabled={editSaving || !editRemark.trim()}>
                  บันทึกการแก้ไข
                </button>
                <button type="button" className="text-button" disabled={editSaving} onClick={() => setEditing(false)}>
                  ยกเลิก
                </button>
                <span className={`customer-message${editMessage.error ? " error" : editMessage.text ? " success" : ""}`} role="status">
                  {editMessage.text}
                </span>
              </div>
            </form>
          </>
        )}
      </dialog>
    </div>
  );
}
