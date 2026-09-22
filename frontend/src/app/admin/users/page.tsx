"use client";

import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type Customer } from "@/lib/api";
import { type AuthUser, ROLE_LABELS, STATUS_LABELS, type UserRole, type UserStatus, getCachedUser } from "@/lib/auth";
import { authApi } from "@/lib/auth-api";

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
}: {
  user: AuthUser;
  customers: Customer[];
  self: boolean;
  onSaved: (u: AuthUser) => void;
}) {
  const isCustomer = user.requestedRole === "CUSTOMER" || user.roles.includes("CUSTOMER");
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
        </div>
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
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
