"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type Customer, type NewCustomerInput } from "@/lib/api";

const EMPTY_FORM: NewCustomerInput = {
  name: "",
  company: "",
  branch: "",
  address: "",
  taxId: "",
  phone: "",
  email: "",
};

const DETAIL_FIELDS: Array<[keyof Customer, string]> = [
  ["name", "ชื่อลูกค้า"],
  ["company", "บริษัท"],
  ["branch", "สาขา"],
  ["address", "ที่อยู่บริษัท"],
  ["taxId", "เลขประจำตัวผู้เสียภาษี"],
  ["phone", "เบอร์โทรศัพท์"],
  ["email", "อีเมล"],
];

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [form, setForm] = useState<NewCustomerInput>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<Customer | null>(null);

  async function loadCustomers() {
    setLoading(true);
    setListError("");
    try {
      const data = await api.listCustomers();
      setCustomers(data.customers);
    } catch (error) {
      setListError(error instanceof ApiError ? error.message : "โหลดข้อมูลไม่สำเร็จ กรุณากดโหลดรายการใหม่");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadCustomers sets a loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCustomers();
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
      setMessage({ text: error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSaving(false);
    }
  }

  function openDetail(customer: Customer) {
    setDetail(customer);
    dialogRef.current?.showModal();
  }

  function updateField<K extends keyof NewCustomerInput>(key: K, value: string) {
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

      <section className="panel">
        <div className="panel-head" style={{ borderBottom: "1px solid #edf0f5" }}>
          <h2>เพิ่มลูกค้า</h2>
          <span className="muted">* จำเป็นต้องกรอก</span>
        </div>
        <form className="customer-form" onSubmit={handleSubmit}>
          <div className="customer-grid">
            <label className="field">
              ชื่อลูกค้า *
              <input
                value={form.name}
                maxLength={250}
                required
                autoComplete="name"
                onChange={(e) => updateField("name", e.target.value)}
              />
            </label>
            <label className="field">
              บริษัท
              <input
                value={form.company}
                maxLength={250}
                autoComplete="organization"
                onChange={(e) => updateField("company", e.target.value)}
              />
            </label>
            <label className="field">
              สาขา
              <input
                value={form.branch}
                maxLength={250}
                autoComplete="off"
                onChange={(e) => updateField("branch", e.target.value)}
              />
            </label>
            <label className="field wide">
              ที่อยู่บริษัท
              <textarea
                value={form.address}
                maxLength={2000}
                rows={3}
                autoComplete="street-address"
                onChange={(e) => updateField("address", e.target.value)}
              />
            </label>
            <label className="field">
              เลขประจำตัวผู้เสียภาษี
              <input
                value={form.taxId}
                maxLength={13}
                inputMode="numeric"
                pattern="[0-9]{13}"
                title="กรอกตัวเลข 13 หลัก"
                autoComplete="off"
                onChange={(e) => updateField("taxId", e.target.value)}
              />
            </label>
            <label className="field">
              เบอร์โทรศัพท์
              <input
                type="tel"
                value={form.phone}
                maxLength={250}
                autoComplete="tel"
                onChange={(e) => updateField("phone", e.target.value)}
              />
            </label>
            <label className="field">
              อีเมล
              <input
                type="email"
                value={form.email}
                maxLength={250}
                autoComplete="email"
                onChange={(e) => updateField("email", e.target.value)}
              />
            </label>
          </div>
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

      <section className="panel customer-list">
        <div className="panel-head">
          <h2>
            รายชื่อลูกค้า <span className="muted">{customers.length ? `(${customers.length} รายการ)` : ""}</span>
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
                      <button className="text-button" onClick={() => openDetail(customer)}>
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
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        {detail && (
          <>
            <h2>ข้อมูลลูกค้า</h2>
            <dl className="customer-detail">
              {DETAIL_FIELDS.map(([key, label]) => (
                <div key={key}>
                  <dt>{label}</dt>
                  <dd>{(detail[key] as string) || "—"}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </dialog>
    </div>
  );
}
