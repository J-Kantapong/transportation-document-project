"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, receiptImageUrl, type ReceiptImage, type ReceiptSummary } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { getCachedUser, submitWriteScopeFor } from "@/lib/auth";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { receiptDuplicateText } from "@/lib/receipt-duplicate";
import { uploadReceiptsInBackground, useAutoRefresh, usePendingReceipts } from "@/lib/receipt-upload";

// รูปใบเสร็จในหน้ารับใบเสร็จ: แนบทีละแถว (ReceiptAttachButton) หรืออัปโหลดหลายใบแล้วจับคู่กับรถ (ReceiptBatchPanel)
// มี AI = อ่านทะเบียน/ยอด/เลขตัวถังแล้วจับคู่ให้ · ไม่มี AI = เก็บรูปอย่างเดียว พนักงานกรอกยอด/ทะเบียนเอง

export const toReceiptSummary = (r: ReceiptImage): ReceiptSummary => ({
  id: r.id,
  extractionSource: r.extractionSource,
  extraction: r.extraction,
  readPending: r.readPending,
  createdAt: r.createdAt,
});

// บันทึก/แนบ/ลบใบเสร็จได้เฉพาะ ADMIN / STAFF_CAR / STAFF_MOTO ในประเภทรถของตัวเอง (backend กันอีกชั้น)
// ACCOUNTANT และคนที่ดูประเภทอื่นได้แต่แก้ไม่ได้ = อ่านอย่างเดียว ซ่อนปุ่มที่กดแล้วได้ 403 (พบ 2026-09-27)
// null = ยังไม่ได้อ่านสิทธิ์ (อ่านจาก localStorage หลัง mount กัน hydration ไม่ตรง)
export function useCanEditReceipts(kind?: "car" | "moto"): boolean | null {
  const [canEdit, setCanEdit] = useState<boolean | null>(null);
  useEffect(() => {
    const scope = submitWriteScopeFor(getCachedUser()?.roles ?? []);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCanEdit(scope === "ALL" || (scope !== "NONE" && (!kind || scope === (kind === "moto" ? "MOTO" : "CAR"))));
  }, [kind]);
  return canEdit;
}

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
          <AuthedImage
            src={receiptImageUrl(r.id)}
            alt={`ใบเสร็จรูปที่ ${i + 1}`}
            style={{ width: 44, height: 58, objectFit: "cover", borderRadius: 4, border: "1px solid #dfe5f0", display: "block" }}
            linkTitle={`ดูใบเสร็จรูปที่ ${i + 1}`}
          />
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
      else if (extraction.duplicate) onMessage(receiptDuplicateText(extraction.duplicate), true);
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
  const [total, setTotal] = useState(0); // รูปรอจับคู่ทั้งหมด - ถาดโหลดทีละ 200 รูป
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const shownRef = useRef(0);
  useEffect(() => {
    shownRef.current = tray.length;
  });
  // เพิ่มทุกครั้งที่ถาดนี้อัปโหลด/จับคู่/ลบ/ได้ผลอ่าน - ผลโหลดถาดที่เริ่มก่อนหน้านั้นเป็นถาดก่อนเปลี่ยน ทิ้งไป
  // (พบ 2026-09-27: รูปที่เพิ่งจับคู่/ลบกลับมาโผล่ในถาดจนรอบโหลดถัดไป)
  const localChange = useRef(0);

  // โหลดถาดใหม่เท่าจำนวนที่เปิดดูอยู่ - รูปที่อีกเครื่องเพิ่งอัปโหลด/จับคู่/ลบจะตรงกับ server
  const reload = useCallback(async () => {
    const local = localChange.current;
    const res = await api.listUnassignedReceipts(0, Math.max(200, shownRef.current));
    if (local !== localChange.current) return;
    setTray(res.receipts);
    setTotal(res.total);
  }, []);

  useEffect(() => {
    reload().catch((err) => setMessage({ text: errorText(err), error: true }));
  }, [reload]);
  useAutoRefresh(!busy, reload);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const res = await api.listUnassignedReceipts(tray.length);
      setTray((prev) => [...prev, ...res.receipts.filter((r) => !prev.some((p) => p.id === r.id))]);
      setTotal(res.total);
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    } finally {
      setLoadingMore(false);
    }
  }

  // AI อ่านเบื้องหลังเสร็จ: เจอรถที่รอใบเสร็จ -> backend แนบให้แล้ว ย้ายไปอยู่ในแถวรถ ที่เหลือคงอยู่ในถาดพร้อมผลอ่าน
  // รูปที่หายไปจากผลลัพธ์ (อีกเครื่องลบ/จับคู่นอกขอบเขตเรา) เอาออกจากถาด
  usePendingReceipts(
    tray.filter((r) => r.readPending).map((r) => r.id),
    (read, gone) => {
      const byId = new Map(read.map((r) => [r.id, r]));
      const leaving = new Set([...gone, ...read.filter((r) => r.submissionId).map((r) => r.id)]);
      localChange.current++;
      setTray((prev) => prev.flatMap((r) => (leaving.has(r.id) ? [] : [byId.get(r.id) ?? r])));
      setTotal((n) => Math.max(0, n - leaving.size));
      read.filter((r) => r.submissionId).forEach(onAssigned);
    },
  );

  // ส่งพร้อมกันหลายรูปแบบไม่รอ AI - รูปเข้าถาดเป็น "กำลังอ่าน" ก่อน (ไม่มี AI = รอจับคู่เองเหมือนเดิม)
  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    const list = Array.from(files);
    const failed: string[] = [];
    setMessage({ text: `กำลังอัปโหลด 0/${list.length} รูป…` });
    await uploadReceiptsInBackground(
      list,
      (receipt) => {
        localChange.current++;
        setTray((prev) => [receipt, ...prev]);
        setTotal((n) => n + 1);
      },
      (file, err) => failed.push(`${file.name}: ${errorText(err)}`),
      (done) => setMessage({ text: `กำลังอัปโหลด ${done}/${list.length} รูป…` }),
    );
    const parts = [
      `อัปโหลดแล้ว ${list.length - failed.length} รูป - ระบบกำลังอ่านและจับคู่กับรถให้ ไปทำอย่างอื่นก่อนได้`,
      failed.length ? `ไม่สำเร็จ ${failed.length} รูป - ${failed.join(" · ")}` : "",
    ].filter(Boolean);
    setMessage({ text: parts.join(" · "), error: failed.length > 0 });
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
    void reload().catch(() => undefined); // ผลโหลดที่ถูกทิ้งระหว่างอัปโหลด (localChange) - โหลดถาดให้ตรงกับ server อีกรอบ
  }

  // ถาดเป็นของรูปที่ยังไม่จับคู่เท่านั้น (unassignedOnly) - ถาดเก่าที่อีกเครื่องจับคู่/ลบไปแล้วได้ error แล้วโหลดถาดใหม่
  async function assign(receiptId: string) {
    const submissionId = choice[receiptId];
    if (!submissionId) return setMessage({ text: "กรุณาเลือกรถก่อนกดจับคู่", error: true });
    try {
      const { receipt } = await api.assignReceipt(receiptId, submissionId, true);
      localChange.current++;
      setTray((prev) => prev.filter((r) => r.id !== receiptId));
      setTotal((n) => Math.max(0, n - 1));
      onAssigned(receipt);
      setMessage({ text: "จับคู่แล้ว - รูปย้ายไปอยู่ในแถวของรถคันนั้น" });
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
      await reload().catch(() => undefined);
    }
  }

  async function remove(receiptId: string) {
    if (!window.confirm("ลบรูปนี้?")) return;
    try {
      await api.deleteReceipt(receiptId, true);
      localChange.current++;
      setTray((prev) => prev.filter((r) => r.id !== receiptId));
      setTotal((n) => Math.max(0, n - 1));
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
      await reload().catch(() => undefined);
    }
  }

  const q = filter.trim().toLowerCase();
  const options = q ? targets.filter((t) => t.label.toLowerCase().includes(q)) : targets;

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>อัปโหลดใบเสร็จหลายใบ ({Math.max(total, tray.length)} รูปรอจับคู่)</h2>
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
                  <AuthedImage
                    src={receiptImageUrl(r.id)}
                    alt={r.originalName ?? "ใบเสร็จ"}
                    style={{ width: "100%", height: 150, objectFit: "cover", objectPosition: "top", borderRadius: 4, display: "block" }}
                  />
                  {r.originalName && (
                    <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.originalName}>
                      {r.originalName}
                    </div>
                  )}
                  {r.readPending && <div style={{ fontSize: 11, color: "#4a5a78", fontWeight: 600, marginTop: 2 }}>⏳ กำลังอ่านใบเสร็จ…</div>}
                  {r.extraction?.duplicate && (
                    <div style={{ fontSize: 11, color: "#b45309", fontWeight: 600, marginTop: 2 }}>⚠️ {receiptDuplicateText(r.extraction.duplicate)}</div>
                  )}
                  {r.extraction && "reading" in r.extraction && !r.extraction.duplicate && (
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
            {tray.length < total && (
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
                <span className="customer-message" style={{ fontSize: 13 }}>
                  แสดง {tray.length} จาก {total} รูป (ใหม่สุดก่อน)
                </span>
                <button type="button" className="text-button" disabled={loadingMore} onClick={loadMore}>
                  {loadingMore ? "กำลังโหลด…" : "โหลดเพิ่ม"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
