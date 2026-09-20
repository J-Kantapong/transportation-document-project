"use client";

import { useRef, useState } from "react";
import { ApiError, api, receiptImageUrl, type ReceiptImage } from "@/lib/api";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";

// หน้าถ่ายใบเสร็จบนมือถือ: คนที่ถือใบเสร็จอยู่ถ่ายแล้วส่งเข้าระบบตรงๆ (ไม่ผ่าน LINE)
// รูปไม่ระบุรถ -> backend ให้ AI อ่านแล้วจับคู่ด้วยเลขตัวถังเอง; ที่จับคู่ไม่ได้ไปรอในถาด "รอจับคู่" ของหน้ารับใบเสร็จ
// บอกผลทันทีหลังถ่าย เพราะคนถ่ายยังมีใบเสร็จอยู่ในมือ - อ่านไม่ออกก็ถ่ายใหม่ได้เลย

type ShotStatus = "matched" | "unmatched" | "unreadable";

interface Shot {
  receipt: ReceiptImage;
  status: ShotStatus;
  text: string;
}

function toShot(receipt: ReceiptImage): Shot {
  const extraction = receipt.extraction;
  if (!extraction) return { receipt, status: "unmatched", text: "ส่งแล้ว - รอออฟฟิศจับคู่กับรถ" };
  if ("error" in extraction) return { receipt, status: "unreadable", text: `${extraction.error} - ลองถ่ายใหม่ให้ชัดขึ้น` };
  if (receipt.submissionId) return { receipt, status: "matched", text: "จับคู่กับรถให้แล้ว" };
  // ไม่มีเลขตัวถัง = ระบบจับคู่ให้ไม่ได้แน่ๆ -> นับเป็นอ่านไม่ออก ให้คนถ่ายถ่ายใหม่ตอนใบเสร็จยังอยู่ในมือ
  if (!extraction.reading.chassis) return { receipt, status: "unreadable", text: "อ่านเลขตัวถังไม่ออก - ลองถ่ายใหม่ให้ชัดขึ้น" };
  return { receipt, status: "unmatched", text: "อ่านได้ แต่ยังไม่พบรถที่รอใบเสร็จคันนี้ - รอออฟฟิศจับคู่" };
}

const STATUS_STYLE: Record<ShotStatus, { icon: string; color: string; background: string }> = {
  matched: { icon: "✅", color: "#23825f", background: "#edf8f3" },
  unmatched: { icon: "⚠️", color: "#bb8527", background: "#fff8e6" },
  unreadable: { icon: "❌", color: "#b43434", background: "#fdeeee" },
};

const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "ส่งรูปไม่สำเร็จ");

export function ReceiptCapturePage() {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [shots, setShots] = useState<Shot[]>([]); // ใหม่สุดอยู่บน - เฉพาะที่ส่งในรอบนี้
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");
    const list = Array.from(files);
    const failed: string[] = [];
    for (const [i, file] of list.entries()) {
      setProgress(list.length > 1 ? `กำลังส่งและอ่านใบเสร็จ ${i + 1}/${list.length}…` : "กำลังส่งและอ่านใบเสร็จ…");
      try {
        const image = await compressReceiptImage(file);
        const { receipt } = await api.uploadReceipt(image, compressedFileName(file));
        setShots((prev) => [toShot(receipt), ...prev]);
      } catch (err) {
        failed.push(errorText(err));
      }
    }
    setProgress("");
    if (failed.length) setError(`ส่งไม่สำเร็จ ${failed.length} รูป - ${failed.join(" · ")}`);
    if (cameraRef.current) cameraRef.current.value = "";
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
      <div style={{ maxWidth: 520, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 6 }}>ถ่ายใบเสร็จ</h1>
        <p className="customer-message" style={{ marginBottom: 16 }}>
          วางใบเสร็จให้เต็มจอ ตัวหนังสือชัด ไม่มีเงาทับ - ถ่ายทีละใบ ระบบจะอ่านและจับคู่กับรถให้เอง
        </p>

        {/* capture="environment" = เปิดกล้องหลังทันที ไม่ต้องผ่านหน้าเลือกไฟล์ */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleFiles(e.target.files)} />
        <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />

        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => cameraRef.current?.click()}
          style={{ width: "100%", justifyContent: "center", minHeight: 64, fontSize: 19 }}
        >
          {busy ? progress : shots.length === 0 ? "📷 ถ่ายใบเสร็จ" : "📷 ถ่ายใบต่อไป"}
        </button>
        <div style={{ textAlign: "center", marginTop: 8 }}>
          <button type="button" className="text-button" disabled={busy} onClick={() => galleryRef.current?.click()}>
            หรือเลือกรูปที่ถ่ายไว้แล้วจากคลังภาพ
          </button>
        </div>

        {error && (
          <div className="customer-message error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {shots.length > 0 && (
          <div className="customer-message" role="status" style={{ marginTop: 16, fontWeight: 600 }}>
            รอบนี้ส่งแล้ว {shots.length} ใบ · จับคู่แล้ว {count("matched")} · รอจับคู่ {count("unmatched")} · อ่านไม่ออก {count("unreadable")}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          {shots.map((shot) => {
            const style = STATUS_STYLE[shot.status];
            const extraction = shot.receipt.extraction;
            const reading = extraction && "reading" in extraction ? extraction.reading : null;
            return (
              <div key={shot.receipt.id} style={{ display: "flex", gap: 12, padding: 10, borderRadius: 10, border: "1px solid #dfe5f0", background: style.background }}>
                <a href={receiptImageUrl(shot.receipt.id)} target="_blank" rel="noreferrer" style={{ flexShrink: 0 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- รูปมาจาก backend API ไม่ผ่าน next/image */}
                  <img
                    src={receiptImageUrl(shot.receipt.id)}
                    alt="ใบเสร็จที่ส่งแล้ว"
                    style={{ width: 64, height: 86, objectFit: "cover", objectPosition: "top", borderRadius: 6, display: "block" }}
                  />
                </a>
                <div style={{ minWidth: 0, flex: 1, fontSize: 14, lineHeight: 1.6 }}>
                  <div style={{ color: style.color, fontWeight: 600 }}>
                    {style.icon} {shot.text}
                  </div>
                  {reading && (
                    <div style={{ color: "#3c4a63", wordBreak: "break-all" }}>
                      ทะเบียน {reading.plateCategory ?? "?"} {reading.plateNumber ?? "?"} · รวม {reading.total?.toLocaleString("th-TH") ?? "?"} บาท
                      <br />
                      ตัวถัง {reading.chassis ?? "อ่านไม่ออก"}
                    </div>
                  )}
                  {shot.status !== "matched" && (
                    <button type="button" className="text-button" disabled={busy} onClick={() => retake(shot)} style={{ paddingLeft: 0, fontSize: 14 }}>
                      ลบแล้วถ่ายใหม่
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
