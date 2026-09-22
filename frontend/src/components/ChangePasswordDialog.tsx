"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "@/lib/api";
import { authApi } from "@/lib/auth-api";

const EMPTY = { currentPassword: "", password: "", confirmPassword: "" };

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setForm(EMPTY);
      setMessage({ text: "" });
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await authApi.changePassword(form);
      setMessage({ text: "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว" });
      setForm(EMPTY);
    } catch (error) {
      setMessage({ text: error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose}>
      <button type="button" className="close" aria-label="ปิด" onClick={onClose}>
        ✕
      </button>
      <h2>เปลี่ยนรหัสผ่าน</h2>
      <form onSubmit={submit} className="auth-fields">
        <label className="field">
          รหัสผ่านเดิม
          <input
            type="password"
            autoComplete="current-password"
            value={form.currentPassword}
            onChange={(e) => setForm({ ...form, currentPassword: e.target.value })}
            required
          />
        </label>
        <label className="field">
          รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)
          <input
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
          />
        </label>
        <label className="field">
          ยืนยันรหัสผ่านใหม่
          <input
            type="password"
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
            required
          />
        </label>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            บันทึก
          </button>
          {message.text && <span className={`customer-message${message.error ? " error" : " success"}`}>{message.text}</span>}
        </div>
      </form>
    </dialog>
  );
}
