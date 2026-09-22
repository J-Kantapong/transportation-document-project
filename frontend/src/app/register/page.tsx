"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Icon } from "@/components/Icon";
import { ApiError } from "@/lib/api";
import { ROLE_LABELS, STAFF_REQUESTABLE_ROLES, type UserRole } from "@/lib/auth";
import { authApi } from "@/lib/auth-api";

type Kind = "STAFF" | "CUSTOMER";

// ช่องสมัคร (ผู้ใช้ตกลง 2026-09-22) - พนักงาน: ชื่อ-นามสกุล, ชื่อเล่น, อีเมล, เบอร์โทร, รหัสผ่าน x2, ตำแหน่งที่ขอ
// ลูกค้า: ชื่อผู้ติดต่อ, บริษัท/ร้าน, เบอร์โทร, อีเมล, รหัสผ่าน x2 - ไม่ขอเลขบัตรประชาชน
const EMPTY = {
  name: "",
  displayName: "",
  company: "",
  email: "",
  phone: "",
  password: "",
  confirmPassword: "",
  requestedRole: "STAFF_ENTRY" as UserRole,
};

export default function RegisterPage() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>("STAFF");
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("รหัสผ่านทั้งสองช่องไม่ตรงกัน");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const shared = {
        name: form.name,
        email: form.email,
        phone: form.phone,
        password: form.password,
        confirmPassword: form.confirmPassword,
      };
      await authApi.register(
        kind === "STAFF"
          ? { kind, displayName: form.displayName, requestedRole: form.requestedRole, ...shared }
          : { kind, company: form.company, ...shared },
      );
      router.push("/login?registered=1");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "สมัครไม่สำเร็จ");
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card auth-card--wide" onSubmit={submit}>
        <div className="brand">
          <div className="mark">
            <Icon name="card" />
          </div>
          <div>
            <strong>
              ทะเบียน<span style={{ color: "#2854d9" }}>.</span>
            </strong>
            <small>TRANSPORT WORKSPACE</small>
          </div>
        </div>
        <h1>สมัครใช้งาน</h1>
        <p>หลังสมัคร ผู้ดูแลระบบจะตรวจสอบและอนุมัติก่อนจึงจะเข้าสู่ระบบได้</p>

        <div className="vehicle-tabs" role="tablist">
          {(["STAFF", "CUSTOMER"] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              className={`vehicle-tab${kind === k ? " selected" : ""}`}
              onClick={() => setKind(k)}
            >
              {k === "STAFF" ? "พนักงาน" : "ลูกค้า"}
            </button>
          ))}
        </div>

        <div className="auth-fields auth-fields--grid">
          <label className="field">
            {kind === "STAFF" ? "ชื่อ-นามสกุล" : "ชื่อผู้ติดต่อ"}
            <input value={form.name} onChange={set("name")} required maxLength={250} autoComplete="name" />
          </label>
          {kind === "STAFF" ? (
            <label className="field">
              ชื่อเล่น (ไม่บังคับ)
              <input value={form.displayName} onChange={set("displayName")} maxLength={100} autoComplete="nickname" />
            </label>
          ) : (
            <label className="field">
              บริษัท / ร้าน
              <input value={form.company} onChange={set("company")} required maxLength={250} autoComplete="organization" />
            </label>
          )}
          <label className="field">
            อีเมล
            <input type="email" value={form.email} onChange={set("email")} required maxLength={250} autoComplete="username" />
          </label>
          <label className="field">
            เบอร์โทรศัพท์
            <input type="tel" value={form.phone} onChange={set("phone")} required maxLength={50} autoComplete="tel" />
          </label>
          <label className="field">
            รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)
            <input
              type="password"
              value={form.password}
              onChange={set("password")}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>
          <label className="field">
            ยืนยันรหัสผ่าน
            <input type="password" value={form.confirmPassword} onChange={set("confirmPassword")} required autoComplete="new-password" />
          </label>
          {kind === "STAFF" && (
            <label className="field wide">
              ตำแหน่งที่ขอ
              <select value={form.requestedRole} onChange={set("requestedRole")}>
                {STAFF_REQUESTABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {kind === "CUSTOMER" && (
          <div className="auth-notice">ผู้ดูแลระบบจะผูกบัญชีของคุณกับบริษัทในฐานข้อมูล จากนั้นคุณจะเห็นสถานะรถของบริษัทได้</div>
        )}
        {error && <div className="customer-message error">{error}</div>}
        <button type="submit" className="primary auth-submit" disabled={busy}>
          {busy ? "กำลังสมัคร…" : "สมัครใช้งาน"}
        </button>
        <div className="auth-footer">
          มีบัญชีแล้ว? <Link href="/login">เข้าสู่ระบบ</Link>
        </div>
      </form>
    </div>
  );
}
