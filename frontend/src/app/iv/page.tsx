"use client";

// หน้าเปิดใบวางบิลจากลิงก์ดาวน์โหลดที่เลขาส่งในไลน์ (ผู้ใช้ 2026-11-16) - ไม่ต้องล็อกอิน ใช้ token ในลิงก์ (หมดอายุ 7 วัน)
// backend: GET /api/secretary/invoice?token= · แสดงเฉพาะบิลใบนั้น ไม่มีเมนูหรือข้อมูลอื่นของระบบ (คู่กับ /tv ของใบกำกับ)
// ปุ่มและไฟล์ PDF (รวมแผ่นแชร์บนมือถือ) อยู่ใน DocumentLinkView ใช้ร่วมกับ /tv
import { useEffect, useMemo, useState } from "react";
import { DocumentLinkView } from "@/components/DocumentLinkView";
import { LoadingState, Notice } from "@/components/ui";
import type { Invoice } from "@/lib/billing-api";
import { buildInvoiceHtml, printInvoice } from "@/lib/invoice-print";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3000";

// ชื่อไฟล์ = เลขบิล + ชื่อลูกค้า (เหมือนใบกำกับ: รู้ว่าส่งให้ใครโดยไม่ต้องเปิดไฟล์) - ตัดอักขระที่ใช้ในชื่อไฟล์ไม่ได้
function pdfFileName(inv: Invoice): string {
  const customer = inv.customer.name.replace(/[\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return `${inv.invoiceNo}${customer ? ` ${customer}` : ""}.pdf`;
}

export default function InvoiceLinkPage() {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState("");

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

  // บิลที่ยกเลิกแล้ว buildInvoiceHtml ใส่ลายน้ำ "ยกเลิก" เอง · forPdf = จัดหน้าสำหรับวาดลงไฟล์ PDF
  const html = useMemo(() => (invoice ? buildInvoiceHtml(invoice) : ""), [invoice]);
  const pdfHtml = useMemo(() => (invoice ? buildInvoiceHtml(invoice, true) : ""), [invoice]);

  if (error && !invoice) {
    return (
      <main style={{ padding: 24, maxWidth: 520, margin: "0 auto" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>เปิดใบวางบิลไม่ได้</h1>
        <Notice tone="error">{error}</Notice>
        <p style={{ color: "#666", marginTop: 8 }}>ลิงก์ใช้ได้ 7 วัน หลังจากนั้นเปิดได้จากหน้าวางบิลในระบบ</p>
      </main>
    );
  }
  if (!invoice) return <main style={{ padding: 24 }}><LoadingState label="กำลังโหลดใบวางบิล…" /></main>;

  return (
    <DocumentLinkView
      title={`${invoice.invoiceNo} · ${invoice.customer.name}${invoice.status === "VOID" ? " (ยกเลิกแล้ว)" : ""}`}
      html={html}
      pdfHtml={pdfHtml}
      fileName={pdfFileName(invoice)}
      frameTitle={`ใบวางบิล ${invoice.invoiceNo}`}
      onPrint={() => printInvoice(invoice)}
    />
  );
}
