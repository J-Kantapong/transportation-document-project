"use client";

/* eslint-disable @next/next/no-img-element -- ลายเซ็นเป็น data URL จากฐานข้อมูล ใช้ next/image ไม่ได้ */
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "@/components/hr/HrDialog";
import { hrApi, type PayslipSignature } from "@/lib/hr-api";
import { cleanSignatureImage } from "@/lib/signature-image";
import { timestampToDisplayDate } from "@/lib/date";

// ลายเซ็นผู้จ่ายเงินบนสลิป (ผู้ใช้ 2026-10-06): อัปโหลดรูปลายเซ็น (ถ่ายหรือสแกน) หน้าเว็บลบพื้นกระดาษให้โปร่งใสก่อน
// สลิปทุกใบพิมพ์ลายเซ็น + ชื่อ + วันที่จ่ายให้เอง เหลือช่องผู้รับเงินให้พนักงานเซ็น - เห็นและแก้ได้เฉพาะ ADMIN

export function SignaturePanel() {
  const [sig, setSig] = useState<PayslipSignature | null>(null);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<string | null>(null); // รูปที่เลือกใหม่ ยังไม่บันทึก
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const s = await hrApi.getSignature();
      setSig(s);
      setName(s.signerName ?? "");
    } catch (err) {
      setMessage({ text: errorText(err, "โหลดลายเซ็นไม่สำเร็จ"), error: true });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function onPick(file: File | undefined) {
    setMessage({ text: "" });
    if (!file) return;
    setBusy(true);
    try {
      setPreview(await cleanSignatureImage(file));
    } catch (err) {
      setPreview(null);
      setMessage({ text: err instanceof Error ? err.message : "ทำรูปไม่สำเร็จ", error: true });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function save() {
    const image = preview ?? sig?.imageDataUrl;
    if (!image) return setMessage({ text: "เลือกรูปลายเซ็นก่อน", error: true });
    setBusy(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const s = await hrApi.setSignature(image, name.trim() || null);
      setSig(s);
      setPreview(null);
      setMessage({ text: "บันทึกลายเซ็นแล้ว สลิปที่พิมพ์ต่อจากนี้จะมีลายเซ็นนี้" });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm("ลบลายเซ็นผู้จ่ายเงิน? สลิปจะกลับเป็นช่องเซ็นเปล่า")) return;
    setBusy(true);
    try {
      setSig(await hrApi.removeSignature());
      setPreview(null);
      setName("");
      setMessage({ text: "ลบลายเซ็นแล้ว" });
    } catch (err) {
      setMessage({ text: errorText(err, "ลบไม่สำเร็จ"), error: true });
    } finally {
      setBusy(false);
    }
  }

  const shown = preview ?? sig?.imageDataUrl ?? null;
  const dirty = preview !== null || (sig?.exists === true && (sig.signerName ?? "") !== name.trim());

  return (
    <section className="panel" style={{ marginTop: 20, padding: "20px 23px", overflow: "visible" }}>
      <h2 style={{ marginBottom: 6 }}>ลายเซ็นผู้จ่ายเงินและผู้เสนอราคา</h2>
      <p className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
        อัปโหลดรูปลายเซ็น (ถ่ายหรือสแกนที่เซ็นด้วยปากกาสีเข้มบนกระดาษขาว) ระบบลบพื้นกระดาษให้เหลือเฉพาะลายเซ็นสีดำ แล้วพิมพ์ในช่องผู้จ่ายเงินของสลิปทุกใบ พร้อมชื่อและวันที่จ่าย
        ช่องผู้รับเงินยังให้พนักงานเซ็นเอง ลายเซ็นชุดเดียวกันนี้พิมพ์ในช่องผู้เสนอราคาของใบเสนอราคาที่ออกเลขแล้วด้วย (ร่างและใบที่ยกเลิกไม่พิมพ์)
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 22, alignItems: "flex-end", marginTop: 14 }}>
        <div
          style={{ width: 300, height: 120, border: "1px dashed #bbb", borderRadius: 8, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", padding: 8 }}
          aria-label="ตัวอย่างลายเซ็น"
        >
          {shown ? <img src={shown} alt="ลายเซ็นผู้จ่ายเงิน" style={{ maxWidth: "100%", maxHeight: "100%" }} /> : <span className="muted">ยังไม่มีลายเซ็น</span>}
        </div>
        <div style={{ display: "grid", gap: 12, minWidth: 260 }}>
          <label className="field">
            ชื่อที่พิมพ์ใต้ลายเซ็น
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="เช่น นาย กันตพงศ์ จิตกุศลรุ่งเรือง" />
          </label>
          <div className="form-actions" style={{ flexWrap: "wrap" }}>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onPick(e.target.files?.[0])} />
            <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
              {sig?.exists ? "เปลี่ยนรูปลายเซ็น" : "เลือกรูปลายเซ็น"}
            </button>
            <button type="button" className="primary" disabled={busy || !shown || !dirty} onClick={save}>
              บันทึก
            </button>
            {sig?.exists && (
              <button type="button" className="text-button danger" disabled={busy} onClick={remove}>
                ลบลายเซ็น
              </button>
            )}
          </div>
        </div>
      </div>
      {sig?.exists && sig.updatedAt && (
        <p className="muted" style={{ marginTop: 10 }}>
          ตั้งไว้เมื่อ {timestampToDisplayDate(sig.updatedAt)}
          {sig.updatedByName ? ` โดย ${sig.updatedByName}` : ""}
        </p>
      )}
      {message.text && (
        <p className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ marginTop: 8 }}>
          {message.text}
        </p>
      )}
    </section>
  );
}
