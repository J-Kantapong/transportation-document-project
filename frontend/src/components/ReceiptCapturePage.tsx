"use client";

import { useRef, useState } from "react";
import { ApiError, api, receiptImageUrl, type ReceiptImage } from "@/lib/api";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { AuthedImage } from "@/components/AuthedImage";
import { isoToDisplayDate } from "@/lib/date";
import { receiptDuplicateText } from "@/lib/receipt-duplicate";
import { uploadReceiptsInBackground, usePendingReceipts } from "@/lib/receipt-upload";

// หน้าถ่ายใบเสร็จบนมือถือ: คนที่ถือใบเสร็จอยู่ถ่ายแล้วส่งเข้าระบบตรงๆ (ไม่ผ่าน LINE)
// รูปไม่ระบุรถ -> backend ให้ AI อ่านแล้วจับคู่ด้วยเลขตัวถังเอง; ที่จับคู่ไม่ได้ไปรอในถาด "รอจับคู่" ของหน้ารับใบเสร็จ
// บอกผลทันทีหลังถ่าย เพราะคนถ่ายยังมีใบเสร็จอยู่ในมือ - อ่านไม่ออกก็ถ่ายใหม่ได้เลย
// หน้าตาเหมือนหน้าถ่ายรูปป้าย/เล่ม (ผู้ใช้ 2026-09-25) - ไม่มีช่องวันที่: วันที่ในใบเสร็จมาจากที่ AI อ่าน
// ส่วนวันที่รับใบเสร็จตั้งตอนออฟฟิศบันทึกใบยื่นในหน้ารับใบเสร็จ

// เลือกจากคลังภาพ (หลายรูป) = ส่งแล้วให้ AI อ่านเบื้องหลัง (reading) คนส่งปิดหน้าไปทำอย่างอื่นได้
type ShotStatus = "reading" | "matched" | "unmatched" | "unreadable" | "duplicate";

interface Shot {
  receipt: ReceiptImage;
  status: ShotStatus;
  text: string;
}

function toShot(receipt: ReceiptImage): Shot {
  if (receipt.readPending) return { receipt, status: "reading", text: "ส่งแล้ว - ระบบกำลังอ่าน" };
  const extraction = receipt.extraction;
  if (!extraction) return { receipt, status: "unmatched", text: "ส่งแล้ว - รอออฟฟิศจับคู่กับรถ" };
  if ("error" in extraction) return { receipt, status: "unreadable", text: `${extraction.error} - ลองถ่ายใหม่ให้ชัดขึ้น` };
  if (extraction.duplicate) return { receipt, status: "duplicate", text: receiptDuplicateText(extraction.duplicate) };
  if (receipt.submissionId && extraction.match === "chassis-near")
    return { receipt, status: "matched", text: "จับคู่กับรถให้แล้ว (เลขตัวถังอ่านเพี้ยนเล็กน้อย - ออฟฟิศจะเช็กอีกครั้ง)" };
  if (receipt.submissionId) return { receipt, status: "matched", text: "จับคู่กับรถให้แล้ว" };
  // ไม่มีเลขตัวถัง = ระบบจับคู่ให้ไม่ได้แน่ๆ -> นับเป็นอ่านไม่ออก ให้คนถ่ายถ่ายใหม่ตอนใบเสร็จยังอยู่ในมือ
  if (!extraction.reading.chassis) return { receipt, status: "unreadable", text: "อ่านเลขตัวถังไม่ออก - ลองถ่ายใหม่ให้ชัดขึ้น" };
  return { receipt, status: "unmatched", text: "อ่านได้ แต่ยังไม่พบรถที่รอใบเสร็จคันนี้ - รอออฟฟิศจับคู่" };
}

const STATUS_STYLE: Record<ShotStatus, { icon: string; color: string; background: string }> = {
  reading: { icon: "⏳", color: "#4a5a78", background: "#f4f6fa" },
  matched: { icon: "✅", color: "#23825f", background: "#edf8f3" },
  unmatched: { icon: "⚠️", color: "#bb8527", background: "#fff8e6" },
  unreadable: { icon: "❌", color: "#b43434", background: "#fdeeee" },
  duplicate: { icon: "⚠️", color: "#b45309", background: "#fff1e0" },
};

const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "ส่งรูปไม่สำเร็จ");

export function ReceiptCapturePage() {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]); // ใหม่สุดอยู่บน - เฉพาะที่ส่งในรอบนี้
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const addShot = (receipt: ReceiptImage) => setShots((prev) => [toShot(receipt), ...prev]);
  const pendingIds = shots.filter((s) => s.status === "reading").map((s) => s.receipt.id);
  usePendingReceipts(pendingIds, (read) => {
    const byId = new Map(read.map((r) => [r.id, r]));
    setShots((prev) => prev.map((s) => (byId.has(s.receipt.id) ? toShot(byId.get(s.receipt.id)!) : s)));
  });

  // ถ่ายจากกล้อง (ทีละใบ) = อ่านทันที คนถ่ายรู้ผลตอนใบเสร็จยังอยู่ในมือ
  async function handleCamera(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError("");
    setProgress("กำลังส่งและอ่านใบเสร็จ…");
    try {
      const image = await compressReceiptImage(file);
      addShot((await api.uploadReceipt(image, compressedFileName(file))).receipt);
    } catch (err) {
      setError(`ส่งไม่สำเร็จ - ${errorText(err)}`);
    }
    setProgress("");
    if (cameraRef.current) cameraRef.current.value = "";
  }

  // เลือกจากคลังภาพ (หลายรูป) = ส่งพร้อมกันหลายรูป ไม่รอ AI อ่าน
  async function handleGallery(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");
    const list = Array.from(files);
    const failed: string[] = [];
    setProgress(`กำลังส่งรูป 0/${list.length}…`);
    await uploadReceiptsInBackground(
      list,
      addShot,
      (file, err) => failed.push(`${file.name}: ${errorText(err)}`),
      (done) => setProgress(`กำลังส่งรูป ${done}/${list.length}…`),
    );
    setProgress("");
    if (failed.length) setError(`ส่งไม่สำเร็จ ${failed.length} รูป - ${failed.join(" · ")}`);
    if (galleryRef.current) galleryRef.current.value = "";
  }

  // ถ่ายใหม่ = ลบรูปที่ยังไม่ได้จับคู่ทิ้ง แล้วเปิดกล้องอีกครั้ง (รูปที่จับคู่กับรถแล้วให้ออฟฟิศเป็นคนลบ)
  async function retake(shot: Shot) {
    setError("");
    try {
      await api.deleteReceipt(shot.receipt.id);
      setShots((prev) => prev.filter((s) => s.receipt.id !== shot.receipt.id));
      cameraRef.current?.click();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const busy = progress !== "";
  const count = (status: ShotStatus) => shots.filter((s) => s.status === status).length;

  return (
    <section className="content">
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 14 }}>ถ่ายรูปใบเสร็จ</h1>
        <section className="panel" style={{ marginTop: 0 }}>
          <div className="panel-head">
            <h2>ถ่ายรูปใบเสร็จ - ระบบอ่านและจับคู่ให้</h2>
          </div>
          <div style={{ padding: "0 23px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
            <p className="customer-message" style={{ margin: 0 }}>
              วางใบเสร็จให้เต็มจอ ตัวหนังสือชัด ไม่มีเงาทับ - ถ่ายทีละใบ ระบบจะอ่านและจับคู่กับรถที่รอใบเสร็จให้เอง
            </p>

            {/* capture="environment" = เปิดกล้องหลังทันที ไม่ต้องผ่านหน้าเลือกไฟล์ */}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleCamera(e.target.files)} />
            <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleGallery(e.target.files)} />
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => cameraRef.current?.click()}
                style={{ width: "100%", justifyContent: "center", minHeight: 60, fontSize: 18 }}
              >
                {busy ? progress : shots.length === 0 ? "📷 ถ่ายรูปใบเสร็จ" : "📷 ถ่ายใบต่อไป"}
              </button>
              <button type="button" className="text-button" disabled={busy} onClick={() => galleryRef.current?.click()}>
                เลือกรูปจากเครื่อง (หลายรูปได้)
              </button>
            </div>

            {error && (
              <div className="customer-message error" role="alert">
                {error}
              </div>
            )}

            {shots.length > 0 && (
              <div className="customer-message" role="status" style={{ fontWeight: 600 }}>
                รอบนี้ส่งแล้ว {shots.length} ใบ
                {count("reading") > 0 && ` · กำลังอ่าน ${count("reading")}`} · จับคู่แล้ว {count("matched")} · รอจับคู่ {count("unmatched")} · อ่านไม่ออก{" "}
                {count("unreadable")}
                {count("duplicate") > 0 && ` · อาจซ้ำ ${count("duplicate")}`}
              </div>
            )}
            {count("reading") > 0 && !busy && (
              <div className="customer-message">
                ส่งรูปครบแล้ว ปิดหน้านี้ไปทำอย่างอื่นได้เลย ระบบอ่านและจับคู่ต่อเอง - ใบที่อ่านไม่ออกหรือจับคู่ไม่ได้จะไปรอที่หน้ารับใบเสร็จ
              </div>
            )}

            {shots.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {shots.map((shot) => {
                  const style = STATUS_STYLE[shot.status];
                  const extraction = shot.receipt.extraction;
                  const reading = extraction && "reading" in extraction ? extraction.reading : null;
                  return (
                    <div key={shot.receipt.id} style={{ display: "flex", gap: 12, padding: 10, borderRadius: 10, border: "1px solid #dfe5f0", background: style.background }}>
                      <div style={{ flexShrink: 0 }}>
                        <AuthedImage
                          src={receiptImageUrl(shot.receipt.id)}
                          alt="ใบเสร็จที่ส่งแล้ว"
                          style={{ width: 64, height: 86, objectFit: "cover", objectPosition: "top", borderRadius: 6, display: "block" }}
                        />
                      </div>
                      <div style={{ minWidth: 0, flex: 1, fontSize: 14, lineHeight: 1.6 }}>
                        <div style={{ color: style.color, fontWeight: 600 }}>
                          {style.icon} {shot.text}
                        </div>
                        {reading && (
                          <div style={{ color: "#3c4a63", wordBreak: "break-all" }}>
                            ทะเบียน {reading.plateCategory ?? "?"} {reading.plateNumber ?? "?"} · รวม {reading.total?.toLocaleString("th-TH") ?? "?"} บาท
                            <br />
                            ตัวถัง {reading.chassis ?? "อ่านไม่ออก"}
                            <br />
                            วันที่ในใบเสร็จ {reading.date ? isoToDisplayDate(reading.date) : "อ่านไม่ออก"}
                          </div>
                        )}
                        {shot.status !== "matched" && shot.status !== "reading" && (
                          <button type="button" className="text-button" disabled={busy} onClick={() => retake(shot)} style={{ paddingLeft: 0, fontSize: 14 }}>
                            ลบแล้วถ่ายใหม่
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
