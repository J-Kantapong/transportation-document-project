"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, request, type Customer } from "@/lib/api";
import { type AuthUser, ROLE_LABELS, STATUS_LABELS, type UserRole, type UserStatus, getCachedUser } from "@/lib/auth";
import { authApi } from "@/lib/auth-api";

// ADMIN ตั้งรหัสผ่านชั่วคราวให้ผู้ใช้ที่ลืมรหัส (ผู้ใช้ 2026-09-27) - backend เก็บประวัติ (ไม่เก็บรหัสผ่าน)
// บัญชีตัวเองใช้ไม่ได้ ต้องเปลี่ยนที่เมนู "เปลี่ยนรหัสผ่าน" ซึ่งถามรหัสผ่านเดิม
const EMPTY_PASSWORD_FORM = { password: "", confirmPassword: "", remark: "" };

// PATCH /api/admin/users/:id/password - ใช้หน้านี้หน้าเดียว จึงเก็บไว้ที่นี่แทน lib/auth-api.ts
function setUserPassword(id: string, data: { password: string; confirmPassword: string; remark: string }) {
  return request<{ user: AuthUser }>(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

function SetPasswordDialog({ user, onClose }: { user: AuthUser | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState(EMPTY_PASSWORD_FORM);
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (user && !dialog.open) {
      setForm(EMPTY_PASSWORD_FORM);
      setShow(false);
      setMessage({ text: "" });
      dialog.showModal();
    } else if (!user && dialog.open) {
      dialog.close();
    }
  }, [user]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    if (form.password.length < 8) return setMessage({ text: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร", error: true });
    if (form.password !== form.confirmPassword) return setMessage({ text: "รหัสผ่านทั้งสองช่องไม่ตรงกัน", error: true });
    if (!form.remark.trim()) return setMessage({ text: "กรุณาระบุเหตุผลที่ตั้งรหัสผ่านใหม่", error: true });
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await setUserPassword(user.id, { ...form, remark: form.remark.trim() });
      setForm(EMPTY_PASSWORD_FORM);
      setMessage({
        text: `ตั้งรหัสผ่านใหม่ให้ ${user.name} แล้ว - แจ้งรหัสนี้ให้ผู้ใช้โดยตรง และให้ผู้ใช้เปลี่ยนเองที่เมนู "เปลี่ยนรหัสผ่าน" หลังเข้าสู่ระบบ`,
      });
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose}>
      <button type="button" className="close" aria-label="ปิด" onClick={onClose}>
        ✕
      </button>
      <h2>ตั้งรหัสผ่านใหม่</h2>
      {user && (
        <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
          {user.name} · {user.email}
          <br />
          รหัสนี้เป็นรหัสชั่วคราว ผู้ใช้ควรเปลี่ยนเองหลังเข้าสู่ระบบ
        </p>
      )}
      <form onSubmit={submit} className="auth-fields" style={{ marginTop: 12 }}>
        <label className="field">
          รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)
          <input
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
            maxLength={200}
          />
        </label>
        <label className="field">
          ยืนยันรหัสผ่านใหม่
          <input
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
            required
            maxLength={200}
          />
        </label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          แสดงรหัสผ่าน
        </label>
        <label className="field">
          เหตุผล *
          <textarea
            required
            maxLength={500}
            rows={2}
            value={form.remark}
            onChange={(e) => setForm({ ...form, remark: e.target.value })}
            placeholder="เช่น ผู้ใช้ลืมรหัสผ่าน"
          />
        </label>
        <div className="form-actions" style={{ marginTop: 0 }}>
          <button type="submit" className="primary" disabled={saving || !form.remark.trim()}>
            บันทึกรหัสผ่านใหม่
          </button>
          {message.text && <span className={`customer-message${message.error ? " error" : " success"}`}>{message.text}</span>}
        </div>
      </form>
    </dialog>
  );
}

const STAFF_ROLES: UserRole[] = ["ADMIN", "STAFF_ENTRY", "STAFF_CAR", "STAFF_MOTO", "ACCOUNTANT", "DELIVERY"];
const FILTERS: Array<{ key: UserStatus | "ALL"; label: string }> = [
  { key: "PENDING", label: "รออนุมัติ" },
  { key: "APPROVED", label: "ใช้งานได้" },
  { key: "REJECTED", label: "ไม่อนุมัติ" },
  { key: "DISABLED", label: "ระงับ" },
  { key: "ALL", label: "ทั้งหมด" },
];

function customerLabel(c: Customer): string {
  return c.company && c.company !== c.name ? `${c.name} (${c.company})` : c.name;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

// แถวผู้ใช้ 1 คน: Admin เลือกบทบาท (หลายอัน) / บริษัทลูกค้า แล้วกดอนุมัติ หรือเปลี่ยนสถานะ
function UserRow({
  user,
  customers,
  self,
  onSaved,
  onSetPassword,
}: {
  user: AuthUser;
  customers: Customer[];
  self: boolean;
  onSaved: (u: AuthUser) => void;
  onSetPassword: () => void;
}) {
  // ประเภทบัญชี (พนักงาน / ลูกค้า) Admin สลับได้ (พบ 2026-09-27): สมัครผิดแท็บแล้วไม่ต้องสมัครใหม่ด้วยอีเมลอื่น
  // เริ่มจากบทบาทที่มีอยู่ ถ้ายังไม่มีบทบาทใช้ตามแท็บที่สมัคร - backend กันลูกค้าปนบทบาทพนักงาน / ลูกค้าไม่มีบริษัทอยู่แล้ว
  const [isCustomer, setIsCustomer] = useState(
    user.roles.length ? user.roles.includes("CUSTOMER") : user.requestedRole === "CUSTOMER",
  );
  const [roles, setRoles] = useState<UserRole[]>(
    user.roles.length ? user.roles : isCustomer ? ["CUSTOMER"] : user.requestedRole ? [user.requestedRole] : [],
  );
  const [customerId, setCustomerId] = useState(user.customerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(status?: UserStatus) {
    setBusy(true);
    setError("");
    try {
      const { user: saved } = await authApi.updateUser(user.id, {
        status,
        roles,
        customerId: roles.includes("CUSTOMER") ? customerId || null : null,
      });
      onSaved(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  function toggleRole(role: UserRole) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  function switchKind(customer: boolean) {
    setIsCustomer(customer);
    if (customer) {
      setRoles(["CUSTOMER"]);
      setCustomerId(user.customerId ?? "");
    } else {
      // เป็นพนักงาน: เริ่มจากบทบาทพนักงานที่มีอยู่ ไม่มีก็ตำแหน่งที่ขอตอนสมัคร (ถ้าขอเป็นพนักงาน) แล้วให้ Admin ติ๊กเอง
      const staffRoles = user.roles.filter((r) => r !== "CUSTOMER");
      setRoles(staffRoles.length ? staffRoles : user.requestedRole && user.requestedRole !== "CUSTOMER" ? [user.requestedRole] : []);
      setCustomerId("");
    }
  }

  return (
    <tr className={user.status === "PENDING" ? "row-backlog" : undefined}>
      <td>
        <div className="job">
          {user.name}
          {user.displayName && <span className="muted"> ({user.displayName})</span>}
          {self && <span className="badge" style={{ marginLeft: 8 }}>คุณ</span>}
        </div>
        <div className="sub">{user.email}</div>
        <div className="sub">{user.phone}</div>
      </td>
      <td>
        <span className={`badge${user.status === "APPROVED" ? " done" : user.status === "PENDING" ? " warn" : ""}`}>
          {STATUS_LABELS[user.status]}
        </span>
        <div className="sub">สมัคร {formatDate(user.createdAt)}</div>
        {user.requestedRole && (
          <div className="sub">
            ขอเป็น: {ROLE_LABELS[user.requestedRole]}
            {user.requestedCompany ? ` · ${user.requestedCompany}` : ""}
          </div>
        )}
      </td>
      <td>
        <div
          className="admin-roles"
          role="radiogroup"
          aria-label="ประเภทบัญชี"
          style={{ flexDirection: "row", gap: 14, paddingBottom: 6, marginBottom: 6, borderBottom: "1px solid #e3e8f1" }}
        >
          <label>
            <input type="radio" name={`kind-${user.id}`} checked={!isCustomer} onChange={() => switchKind(false)} disabled={busy || self} />
            พนักงาน
          </label>
          <label>
            <input type="radio" name={`kind-${user.id}`} checked={isCustomer} onChange={() => switchKind(true)} disabled={busy || self} />
            ลูกค้า
          </label>
        </div>
        {isCustomer ? (
          <div className="admin-roles">
            <label>
              <input type="checkbox" checked readOnly /> {ROLE_LABELS.CUSTOMER}
            </label>
            <select className="inspect-input admin-customer-select" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">— เลือกบริษัทลูกค้า —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {customerLabel(c)}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <div className="admin-roles">
            {STAFF_ROLES.map((role) => (
              <label key={role}>
                <input type="checkbox" checked={roles.includes(role)} onChange={() => toggleRole(role)} disabled={busy} />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
        )}
      </td>
      <td>
        <div className="admin-actions">
          {user.status === "PENDING" && (
            <>
              <button type="button" className="primary" disabled={busy} onClick={() => save("APPROVED")}>
                อนุมัติ
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => save("REJECTED")}>
                ไม่อนุมัติ
              </button>
            </>
          )}
          {user.status === "APPROVED" && (
            <>
              <button type="button" className="text-button" disabled={busy} onClick={() => save()}>
                บันทึกบทบาท
              </button>
              {!self && (
                <button type="button" className="text-button" disabled={busy} onClick={() => save("DISABLED")}>
                  ระงับบัญชี
                </button>
              )}
            </>
          )}
          {(user.status === "REJECTED" || user.status === "DISABLED") && (
            <button type="button" className="primary" disabled={busy} onClick={() => save("APPROVED")}>
              เปิดใช้งาน
            </button>
          )}
          {!self && (
            <button type="button" className="text-button" disabled={busy} onClick={onSetPassword}>
              ตั้งรหัสผ่านใหม่
            </button>
          )}
        </div>
        {self && <div className="sub">เปลี่ยนรหัสผ่านของตัวเองที่เมนู &quot;เปลี่ยนรหัสผ่าน&quot;</div>}
        {error && <div className="customer-message error">{error}</div>}
      </td>
    </tr>
  );
}

export default function AdminUsersPage() {
  const [filter, setFilter] = useState<UserStatus | "ALL">("PENDING");
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [passwordTarget, setPasswordTarget] = useState<AuthUser | null>(null);
  const selfId = useMemo(() => getCachedUser()?.id, []);

  async function load() {
    setLoading(true);
    setListError("");
    try {
      const [u, c] = await Promise.all([authApi.listUsers(), api.listCustomers()]);
      setUsers(u.users);
      setCustomers(c.customers);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, []);

  const shown = users.filter((u) => filter === "ALL" || u.status === filter);
  const pendingCount = users.filter((u) => u.status === "PENDING").length;

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>จัดการผู้ใช้</h1>
          <p>อนุมัติผู้สมัครใหม่ กำหนดบทบาท และผูกบัญชีลูกค้ากับบริษัทในฐานข้อมูล</p>
        </div>
        <button type="button" className="text-button" onClick={load}>
          โหลดรายการใหม่
        </button>
      </div>

      <div className="panel">
        <div className="inspect-filter" style={{ paddingTop: 18 }}>
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`filter-chip${filter === f.key ? " selected" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {f.key === "PENDING" && pendingCount > 0 ? ` (${pendingCount})` : ""}
            </button>
          ))}
        </div>
        {listError && <div className="empty-customers customer-message error">{listError}</div>}
        {loading ? (
          <div className="empty-customers">กำลังโหลด…</div>
        ) : shown.length === 0 ? (
          <div className="empty-customers">ไม่มีผู้ใช้ในสถานะนี้</div>
        ) : (
          <div className="table-wrap">
            <table className="inspect-table">
              <thead>
                <tr>
                  <th>ผู้ใช้</th>
                  <th>สถานะ</th>
                  <th>บทบาท / บริษัทลูกค้า</th>
                  <th>ดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    customers={customers}
                    self={u.id === selfId}
                    onSaved={(saved) => setUsers((prev) => prev.map((x) => (x.id === saved.id ? saved : x)))}
                    onSetPassword={() => setPasswordTarget(u)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <SetPasswordDialog user={passwordTarget} onClose={() => setPasswordTarget(null)} />
    </div>
  );
}
