"use client";

// หน้าเปิดใบวางบิลจากลิงก์ดาวน์โหลดที่เลขาส่งในไลน์ (ผู้ใช้ 2026-11-16) - ไม่ต้องล็อกอิน ใช้ token ในลิงก์ (หมดอายุ 7 วัน)
// backend: GET /api/secretary/invoice?token= · แสดงเฉพาะบิลใบนั้น ไม่มีเมนูหรือข้อมูลอื่นของระบบ (คู่กับ /tv ของใบกำกับ)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Invoice } from "@/lib/billing-api";
import { buildInvoiceHtml, printInvoice } from "@/lib/invoice-print";
import { downloadHtmlAsPdf } from "@/lib/pdf-export";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

// ชื่อไฟล์ = เลขบิล + ชื่อลูกค้า (เหมือนใบกำกับ: รู้ว่าส่งให้ใครโดยไม่ต้องเปิดไฟล์) - ตัดอักขระที่ใช้ในชื่อไฟล์ไม่ได้
function pdfFileName(inv: Invoice): string {
  const customer = inv.customer.name.replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${inv.invoiceNo}${customer ? ` ${customer}` : ""}.pdf`;
}

export default function InvoiceLinkPage() {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    let cancelled = false;
    fetch(`${API_BASE_URL}/api/secretary/invoice?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { invoice?: Invoice; error?: string };
        if (cancelled) return;
        if (res.ok && body.invoice) setInvoice(body.invoice);
        else setError(body.error ?? "เปิดใบวางบิลไม่สำเร็จ");
      })
      .catch(() => {
        if (!cancelled) setError("เชื่อมต่อระบบไม่ได้ ลองใหม่อีกครั้ง");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // บิลที่ยกเลิกแล้ว buildInvoiceHtml ใส่ลายน้ำ "ยกเลิก" เอง
  const html = useMemo(() => (invoice ? buildInvoiceHtml(invoice) : ""), [invoice]);

  const savePdf = useCallback(async () => {
    if (!invoice) return;
    setBusy(true);
    try {
      await downloadHtmlAsPdf(buildInvoiceHtml(invoice, true), pdfFileName(invoice), { orientation: "portrait", marginMm: 12 });
    } catch {
      setError("สร้างไฟล์ PDF ไม่สำเร็จ ลองกดปริ้นแทน");
    } finally {
      setBusy(false);
    }
  }, [invoice]);

  // ลิงก์ดาวน์โหลดจากไลน์ (?download=1): เปิดแล้วสร้างไฟล์ PDF ให้เองหนึ่งครั้ง ปุ่มยังอยู่เผื่อเบราว์เซอร์กันการดาวน์โหลดอัตโนมัติ
  const autoDownloaded = useRef(false);
  useEffect(() => {
    if (!invoice || autoDownloaded.current) return;
    if (new URLSearchParams(window.location.search).get("download") !== "1") return;
    autoDownloaded.current = true;
    const timer = window.setTimeout(() => void savePdf(), 0);
    return () => window.clearTimeout(timer);
  }, [invoice, savePdf]);

  if (error && !invoice) {
    return (
      <main style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>เปิดใบวางบิลไม่ได้</h1>
        <p role="alert">{error}</p>
        <p style={{ color: "#666", marginTop: 8 }}>ลิงก์ใช้ได้ 7 วัน หลังจากนั้นเปิดได้จากหน้าวางบิลในระบบ</p>
      </main>
    );
  }
  if (!invoice) return <main style={{ padding: 24 }}>กำลังโหลดใบวางบิล…</main>;

  return (
    <main style={{ padding: 16, maxWidth: 900, margin: "0 auto" }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, flex: "1 1 200px", margin: 0 }}>
          {invoice.invoiceNo} · {invoice.customer.name}
          {invoice.status === "VOID" ? " (ยกเลิกแล้ว)" : ""}
        </h1>
        <button type="button" className="button" onClick={() => printInvoice(invoice)}>
          ปริ้น
        </button>
        <button type="button" className="button" onClick={savePdf} disabled={busy}>
          {busy ? "กำลังสร้าง PDF…" : "บันทึกเป็น PDF"}
        </button>
      </header>
      {error ? <p role="alert">{error}</p> : null}
      <iframe title={`ใบวางบิล ${invoice.invoiceNo}`} srcDoc={html} style={{ width: "100%", height: "80vh", border: "1px solid #ddd", background: "#fff" }} />
    </main>
  );
}
