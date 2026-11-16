"use client";

// หน้าเอกสารจากลิงก์ที่เลขาส่งในไลน์ (/tv ใบกำกับ, /iv ใบวางบิล - ผู้ใช้ 2026-11-16): แสดงเอกสาร + ปริ้น + ไฟล์ PDF
// มือถือ (ผู้ใช้ 2026-11-16: เปิดบน iPhone แล้วเห็นเป็นหน้าเว็บ ไม่ได้ไฟล์ PDF): เบราว์เซอร์มือถือไม่ยอมให้หน้าเว็บบันทึกไฟล์เอง
// จึงสร้างไฟล์ PDF ไว้ตั้งแต่เปิดหน้า แล้วให้ปุ่ม "ส่ง / บันทึกไฟล์ PDF" เปิดแผ่นแชร์ของเครื่อง (ส่งเข้า LINE เป็นไฟล์ หรือบันทึกลงเครื่อง)
// แผ่นแชร์ต้องเกิดจากการแตะของผู้ใช้ จึงทำเองตอนเปิดหน้าไม่ได้ · คอมพิวเตอร์: ลิงก์ที่มี download=1 ดาวน์โหลดไฟล์เองเหมือนเดิม
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadBlob, htmlToPdfBlob } from "@/lib/pdf-export";

interface Props {
  title: string;
  /** HTML ที่แสดงบนจอ */
  html: string;
  /** HTML ที่ใช้วาดลงไฟล์ PDF (ไม่ใส่ = ใช้ html) */
  pdfHtml?: string;
  fileName: string;
  frameTitle: string;
  onPrint: () => void;
}

const PDF_SETUP = { orientation: "portrait", marginMm: 12 } as const;

// มือถือ/แท็บเล็ตที่แชร์ไฟล์ PDF ผ่านแผ่นแชร์ของเครื่องได้ (iPhone, iPad, Android)
function canShareFile(fileName: string): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") return false;
  if (!window.matchMedia("(pointer: coarse)").matches) return false;
  try {
    return navigator.canShare({ files: [new File([new Blob(["x"], { type: "application/pdf" })], fileName, { type: "application/pdf" })] });
  } catch {
    return false;
  }
}

export function DocumentLinkView({ title, html, pdfHtml, fileName, frameTitle, onPrint }: Props) {
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<Promise<Blob> | null>(null);

  // สร้างไฟล์ครั้งเดียว กดซ้ำใช้ไฟล์เดิม
  const preparePdf = useCallback((): Promise<Blob> => {
    if (!pending.current) {
      setBusy(true);
      pending.current = htmlToPdfBlob(pdfHtml ?? html, PDF_SETUP)
        .then((blob) => {
          setReady(true);
          return blob;
        })
        .catch((e: unknown) => {
          pending.current = null;
          setError("สร้างไฟล์ PDF ไม่สำเร็จ ลองกดปริ้นแทน");
          throw e;
        })
        .finally(() => setBusy(false));
    }
    return pending.current;
  }, [html, pdfHtml]);

  const started = useRef(false);
  useEffect(() => {
    // เลื่อนไปรอบถัดไป: ไม่ตั้ง state ระหว่าง effect และให้เอกสารแสดงก่อน
    // ตั้ง started ในตัวจับเวลา ไม่ใช่ใน effect: โหมดพัฒนาเรียก effect สองรอบและยกเลิกตัวจับเวลารอบแรก
    const timer = window.setTimeout(() => {
      if (started.current) return;
      started.current = true;
      const mobile = canShareFile(fileName);
      setShare(mobile);
      const wantsDownload = new URLSearchParams(window.location.search).get("download") === "1";
      if (mobile) void preparePdf().catch(() => undefined); // เตรียมไฟล์ไว้ให้ปุ่มแชร์ทำงานทันทีที่แตะ
      else if (wantsDownload) void preparePdf().then((blob) => downloadBlob(blob, fileName)).catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [fileName, preparePdf]);

  const savePdf = useCallback(() => {
    void preparePdf()
      .then((blob) => downloadBlob(blob, fileName))
      .catch(() => undefined);
  }, [fileName, preparePdf]);

  // เปิดไฟล์ PDF ในตัวดู PDF ของเบราว์เซอร์ (ทางสำรองเมื่อแผ่นแชร์ใช้ไม่ได้)
  const openPdf = useCallback(() => {
    void preparePdf()
      .then((blob) => {
        window.location.href = URL.createObjectURL(blob);
      })
      .catch(() => undefined);
  }, [preparePdf]);

  const sharePdf = useCallback(() => {
    void preparePdf()
      .then(async (blob) => {
        try {
          await navigator.share({ files: [new File([blob], fileName, { type: "application/pdf" })], title: fileName.replace(/\.pdf$/i, "") });
        } catch (e) {
          if ((e as { name?: string })?.name === "AbortError") return; // ผู้ใช้ปิดแผ่นแชร์เอง
          setError('เปิดแผ่นแชร์ไม่สำเร็จ ลองกด "เปิดไฟล์ PDF" แทน');
        }
      })
      .catch(() => undefined);
  }, [fileName, preparePdf]);

  return (
    <main style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
      <header style={{ position: "sticky", top: 0, zIndex: 1, background: "#fff", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "8px 0", marginBottom: 8 }}>
        <h1 style={{ fontSize: 18, flex: "1 1 200px", margin: 0 }}>{title}</h1>
        {share ? (
          <>
            <button type="button" className="button" onClick={sharePdf} disabled={!ready}>
              {ready ? "ส่ง / บันทึกไฟล์ PDF" : busy ? "กำลังสร้าง PDF…" : "ส่ง / บันทึกไฟล์ PDF"}
            </button>
            <button type="button" className="button" onClick={openPdf} disabled={!ready}>
              เปิดไฟล์ PDF
            </button>
          </>
        ) : (
          <button type="button" className="button" onClick={savePdf} disabled={busy}>
            {busy ? "กำลังสร้าง PDF…" : "บันทึกเป็น PDF"}
          </button>
        )}
        <button type="button" className="button" onClick={onPrint}>
          ปริ้น
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <iframe title={frameTitle} srcDoc={html} style={{ width: "100%", height: "80vh", border: "1px solid #ddd", background: "#fff" }} />
    </main>
  );
}
