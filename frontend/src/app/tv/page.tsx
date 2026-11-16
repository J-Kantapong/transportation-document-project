"use client";

// หน้าเปิดใบกำกับภาษีจากลิงก์ที่เลขาส่งในไลน์ (ผู้ใช้ 2026-11-16) - ไม่ต้องล็อกอิน ใช้ token ในลิงก์ (หมดอายุ 7 วัน)
// backend: GET /api/secretary/tax-invoice?token= · แสดงเฉพาะใบกำกับใบนั้น ไม่มีเมนูหรือข้อมูลอื่นของระบบ
// ปุ่มและไฟล์ PDF (รวมแผ่นแชร์บนมือถือ) อยู่ใน DocumentLinkView ใช้ร่วมกับ /iv
import { useEffect, useMemo, useState } from "react";
import { DocumentLinkView } from "@/components/DocumentLinkView";
import type { TaxInvoice } from "@/lib/billing-api";
import { buildTaxInvoiceHtml, printTaxInvoice } from "@/lib/tax-invoice-print";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

// ชื่อไฟล์ = เลขใบกำกับ + ชื่อลูกค้า (ผู้ใช้ 2026-11-16: ให้รู้ว่าส่งให้ใครโดยไม่ต้องเปิดไฟล์) - ตัดอักขระที่ใช้ในชื่อไฟล์ไม่ได้
function pdfFileName(t: TaxInvoice): string {
  const customer = t.customer.name.replace(/[\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${t.taxInvoiceNo}${customer ? ` ${customer}` : ""}.pdf`;
}

export default function TaxInvoiceLinkPage() {
  const [taxInvoice, setTaxInvoice] = useState<TaxInvoice | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    let cancelled = false;
    fetch(`${API_BASE_URL}/api/secretary/tax-invoice?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { taxInvoice?: TaxInvoice; error?: string };
        if (cancelled) return;
        if (res.ok && body.taxInvoice) setTaxInvoice(body.taxInvoice);
        else setError(body.error ?? "เปิดใบกำกับไม่สำเร็จ");
      })
      .catch(() => {
        if (!cancelled) setError("เชื่อมต่อระบบไม่ได้ ลองใหม่อีกครั้ง");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ใบที่ยกเลิกแล้ว buildTaxInvoiceHtml พิมพ์เป็นสำเนามีลายน้ำเอง
  const html = useMemo(() => (taxInvoice ? buildTaxInvoiceHtml(taxInvoice, "original") : ""), [taxInvoice]);

  if (error && !taxInvoice) {
    return (
      <main style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>เปิดใบกำกับไม่ได้</h1>
        <p role="alert">{error}</p>
        <p style={{ color: "#666", marginTop: 8 }}>ลิงก์ใช้ได้ 7 วันหลังออกใบกำกับ หลังจากนั้นเปิดได้จากหน้าใบกำกับภาษีในระบบ</p>
      </main>
    );
  }
  if (!taxInvoice) return <main style={{ padding: 24 }}>กำลังโหลดใบกำกับ…</main>;

  return (
    <DocumentLinkView
      title={`${taxInvoice.taxInvoiceNo} · ${taxInvoice.customer.name}${taxInvoice.status === "CANCELLED" ? " (ยกเลิกแล้ว)" : ""}`}
      html={html}
      fileName={pdfFileName(taxInvoice)}
      frameTitle={`ใบกำกับภาษี ${taxInvoice.taxInvoiceNo}`}
      onPrint={() => printTaxInvoice(taxInvoice, "original")}
    />
  );
}
