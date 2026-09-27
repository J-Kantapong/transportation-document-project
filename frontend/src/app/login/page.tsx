"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Icon } from "@/components/Icon";
import { ApiError } from "@/lib/api";
import { homeFor, safeNextPath, saveSession } from "@/lib/auth";
import { authApi } from "@/lib/auth-api";

function LoginForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const registered = params.get("registered") === "1";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { token, user } = await authApi.login(email, password);
      saveSession(token, user);
      // กลับไปหน้าที่ตั้งใจจะเข้า (ถ้าเป็นหน้าในเว็บนี้และมีสิทธิ์) ไม่งั้นไปหน้าแรกของบทบาท - ใช้ full reload ให้ proxy.ts เห็น cookie
      window.location.href = safeNextPath(params.get("next"), user.roles) ?? homeFor(user.roles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "เข้าสู่ระบบไม่สำเร็จ");
      setBusy(false);
    }
  }

  return (
    <form className="auth-card" onSubmit={submit}>
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
      <h1>เข้าสู่ระบบ</h1>
      <p>สำหรับพนักงานและลูกค้าที่ได้รับการอนุมัติแล้ว</p>
      {registered && (
        <div className="auth-notice">สมัครสำเร็จแล้ว บัญชีจะใช้งานได้หลังผู้ดูแลระบบอนุมัติ</div>
      )}
      <div className="auth-fields">
        <label className="field">
          อีเมล
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          รหัสผ่าน
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
      </div>
      {error && <div className="customer-message error">{error}</div>}
      <button type="submit" className="primary auth-submit" disabled={busy}>
        {busy ? "กำลังเข้าสู่ระบบ…" : "เข้าสู่ระบบ"}
      </button>
      <div className="auth-footer">
        ยังไม่มีบัญชี? <Link href="/register">สมัครใช้งาน</Link>
      </div>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="auth-page">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
