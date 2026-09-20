"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, receiptImageUrl, type ReceiptImage, type ReceiptSummary } from "@/lib/api";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";

// รูปใบเสร็จในหน้ารับใบเสร็จ: แนบทีละแถว (ReceiptAttachButton) หรืออัปโหลดหลายใบแล้วจับคู่กับรถ (ReceiptBatchPanel)
// ตอนนี้ยังไม่ได้เปิดใช้ AI อ่านใบเสร็จ - เก็บรูปอย่างเดียว พนักงานกรอกยอด/ทะเบียนเอง

export const toReceiptSummary = (r: ReceiptImage): ReceiptSummary => ({
  id: r.id,
  extractionSource: r.extractionSource,
  extraction: r.extraction,
  createdAt: r.createdAt,
});

async function uploadOne(file: File, submissionId?: string): Promise<ReceiptImage> {
  const image = await compressReceiptImage(file);
  return (await api.uploadReceipt(image, compressedFileName(file), submissionId)).receipt;
}

const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "อัปโหลดไม่สำเร็จ");

// รูปย่อ - กดแล้วเปิดรูปเต็มในแท็บใหม่
export function ReceiptThumbs({ receipts, onDelete }: { receipts: ReceiptSummary[]; onDelete?: (id: string) => void }) {
  if (receipts.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {receipts.map((r, i) => (
        <div key={r.id} style={{ position: "relative" }}>
          <a href={receiptImageUrl(r.id)} target="_blank" rel="noreferrer" title={`ดูใบเสร็จรูปที่ ${i + 1}`}>
            {/* eslint-disable-next-line @next/next/no-img-element -- รูปมาจาก backend API ไม่ผ่าน next/image */}
            <img
              src={receiptImageUrl(r.id)}
              alt={`ใบเสร็จรูปที่ ${i + 1}`}
              style={{ width: 44, height: 58, objectFit: "cover", borderRadius: 4, border: "1px solid #dfe5f0", display: "block" }}
            />
          </a>
          {onDelete && (
            <button
              type="button"
              onClick={() => onDelete(r.id)}
              aria-label={`ลบใบเสร็จรูปที่ ${i + 1}`}
              style={{
                position: "absolute",
                top: -6,
                right: -6,
                width: 18,
                height: 18,
                borderRadius: 9,
                border: "none",
                background: "#c0392b",
                color: "#fff",
                fontSize: 11,
                lineHeight: "18px",
                padding: 0,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ปุ่มแนบรูปในแถว - บนมือถือจะให้เลือกถ่ายรูปหรือเลือกจากคลังภาพ เลือกได้หลายรูป (ใบเสร็จหลายแผ่น)
export function ReceiptAttachButton({
  submissionId,
  disabled,
  onUploaded,
  onMessage,
}: {
  submissionId: string;
  disabled?: boolean;
  onUploaded: (receipt: ReceiptImage) => void;
  onMessage: (text: string, error?: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    onMessage("กำลังอัปโหลดรูป…");
    try {
      let last: ReceiptImage | null = null;
      for (const file of Array.from(files)) {
        last = await uploadOne(file, submissionId);
        onUploaded(last);
      }
      const extraction = last?.extraction;
      if (!extraction) onMessage("แนบรูปแล้ว (ยังไม่ได้เปิดใช้ AI อ่าน - กรอกทะเบียนและยอดเอง)");
      else if ("error" in extraction) onMessage(`แนบรูปแล้ว แต่${extraction.error} - กรอกเอง`, true);
      else if (extraction.match === "chassis-mismatch") onMessage(`เลขตัวถังในใบเสร็จ (${extraction.reading.chassis}) ไม่ตรงกับรถคันนี้ - ตรวจว่าแนบผิดคันหรือไม่`, true);
      else onMessage("");
    } catch (err) {
      onMessage(errorText(err), true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
      <button type="button" className="text-button" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
        {busy ? "กำลังอัปโหลด…" : "📷 แนบใบเสร็จ"}
      </button>
    </>
  );
}

export interface BatchTarget {
  id: string; // DocumentSubmission.id
  label: string;
}

// อัปโหลดหลายใบพร้อมกัน แล้วเลือกว่าแต่ละรูปเป็นของรถคันไหน (ตอนมี AI จะเลือกให้อัตโนมัติ แล้วพนักงานตรวจทาน)
export function ReceiptBatchPanel({ targets, onAssigned }: { targets: BatchTarget[]; onAssigned: (receipt: ReceiptImage) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [tray, setTray] = useState<ReceiptImage[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  useEffect(() => {
    api
      .listUnassignedReceipts()
      .then((res) => setTray(res.receipts))
      .catch((err) => setMessage({ text: errorText(err), error: true }));
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    const list = Array.from(files);
    const failed: string[] = [];
    let autoMatched = 0;
    let waiting = 0;
    for (const [i, file] of list.entries()) {
      setMessage({ text: `กำลังอัปโหลดและอ่านใบเสร็จ ${i + 1}/${list.length}…` });
      try {
        const receipt = await uploadOne(file);
        // AI อ่านเลขตัวถังแล้วเจอรถที่รอใบเสร็จ -> backend แนบให้แล้ว ย้ายไปอยู่ในแถวรถเลย
        if (receipt.submissionId) {
          autoMatched++;
          onAssigned(receipt);
        } else {
          waiting++;
          setTray((prev) => [receipt, ...prev]);
        }
      } catch (err) {
        failed.push(`${file.name}: ${errorText(err)}`);
      }
    }
    const parts = [
      `อัปโหลดแล้ว ${list.length - failed.length} รูป`,
      autoMatched ? `จับคู่กับรถให้อัตโนมัติ ${autoMatched} รูป` : "",
      waiting ? `รอจับคู่ ${waiting} รูป (เลือกรถแล้วกด "จับคู่")` : "",
      failed.length ? `ไม่สำเร็จ ${failed.length} รูป - ${failed.join(" · ")}` : "",
    ].filter(Boolean);
    setMessage({ text: parts.join(" · "), error: failed.length > 0 });
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function assign(receiptId: string) {
    const submissionId = choice[receiptId];
    if (!submissionId) return setMessage({ text: "กรุณาเลือกรถก่อนกดจับคู่", error: true });
    try {
      const { receipt } = await api.assignReceipt(receiptId, submissionId);
      setTray((prev) => prev.filter((r) => r.id !== receiptId));
      onAssigned(receipt);
      setMessage({ text: "จับคู่แล้ว - รูปย้ายไปอยู่ในแถวของรถคันนั้น" });
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  async function remove(receiptId: string) {
    if (!window.confirm("ลบรูปนี้?")) return;
    try {
      await api.deleteReceipt(receiptId);
      setTray((prev) => prev.filter((r) => r.id !== receiptId));
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  const q = filter.trim().toLowerCase();
  const options = q ? targets.filter((t) => t.label.toLowerCase().includes(q)) : targets;

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>อัปโหลดใบเสร็จหลายใบ ({tray.length} รูปรอจับคู่)</h2>
        <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
        <button type="button" className="text-button" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? "กำลังอัปโหลด…" : "📷 เลือกรูปหลายใบ"}
        </button>
      </div>
      <div style={{ padding: "0 23px 20px" }}>
        {message.text && (
          <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ marginBottom: 10 }}>
            {message.text}
          </div>
        )}
        {/* คนที่ถือใบเสร็จอยู่เปิดหน้านี้บนมือถือแล้วถ่ายส่งเข้าระบบได้เลย - รูปที่จับคู่ไม่ได้จะมาโผล่ในถาดนี้ */}
        <div className="customer-message" style={{ marginBottom: 10 }}>
          📱 ถ่ายจากมือถือ: เปิด <Link href="/registration/new-vehicle/receive-receipt/capture">หน้าถ่ายใบเสร็จ</Link> บนมือถือ
        </div>
        {tray.length === 0 ? (
          <div className="customer-message">ไม่มีรูปรอจับคู่ - กด &quot;เลือกรูปหลายใบ&quot; เพื่ออัปโหลดใบเสร็จทีละหลายรูป</div>
        ) : (
          <>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="ค้นหารถในรายการเลือก (ชื่อลูกค้า / เลขตัวถัง / ทะเบียน)"
              aria-label="ค้นหารถ"
              style={{ width: 360, marginBottom: 12 }}
            />
            {/* รูปรอจับคู่เยอะ - เลื่อนดูในกรอบ ไม่ดันตารางรถลงไปไกล */}
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", maxHeight: 460, overflowY: "auto", padding: 2 }}>
              {tray.map((r) => {
                // รถที่เลือกไว้แล้วต้องอยู่ในรายการเสมอ แม้ไม่ตรงคำค้นหา
                const chosen = targets.find((t) => t.id === choice[r.id]);
                const cardOptions = chosen && !options.includes(chosen) ? [chosen, ...options] : options;
                return (
                <div key={r.id} style={{ width: 220, border: "1px solid #dfe5f0", borderRadius: 8, padding: 10 }}>
                  <a href={receiptImageUrl(r.id)} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element -- รูปมาจาก backend API ไม่ผ่าน next/image */}
                    <img
                      src={receiptImageUrl(r.id)}
                      alt={r.originalName ?? "ใบเสร็จ"}
                      style={{ width: "100%", height: 150, objectFit: "cover", objectPosition: "top", borderRadius: 4, display: "block" }}
                    />
                  </a>
                  {r.originalName && (
                    <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.originalName}>
                      {r.originalName}
                    </div>
                  )}
                  {r.extraction && "reading" in r.extraction && (
                    <div style={{ fontSize: 11, color: "#bb8527", marginTop: 2 }}>
                      AI อ่านเลขตัวถัง {r.extraction.reading.chassis ?? "ไม่ออก"} - ไม่พบรถที่รอใบเสร็จ
                    </div>
                  )}
                  {r.extraction && "error" in r.extraction && (
                    <div style={{ fontSize: 11, color: "#b43434", marginTop: 2 }}>{r.extraction.error}</div>
                  )}
                  <select
                    value={choice[r.id] ?? ""}
                    onChange={(e) => setChoice((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    aria-label="เลือกรถของใบเสร็จนี้"
                    style={{ width: "100%", marginTop: 8 }}
                  >
                    <option value="">— เลือกรถ ({options.length}) —</option>
                    {cardOptions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6 }}>
                    <button type="button" className="text-button" onClick={() => assign(r.id)}>
                      จับคู่
                    </button>
                    <button type="button" className="text-button" style={{ color: "#c0392b" }} onClick={() => remove(r.id)}>
                      ลบ
                    </button>
                  </div>
                </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
