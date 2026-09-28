"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError, type Customer } from "@/lib/api";
import { billingApi, type BillingTerms, type ServiceFeeRate } from "@/lib/billing-api";
import { BillingAccountEditor, BillingRatesEditor, BillingTermsEditor } from "@/components/BillingCustomerSettings";
import { termsSummary } from "@/lib/invoice";
import { todayIso } from "@/lib/date";

// ตั้งเงื่อนไขวางบิล/บัญชีรับเงิน/ตารางค่าดำเนินการล่วงหน้าให้ลูกค้ารายใดก็ได้ (ผู้ใช้ 2026-09-28: ลูกค้าเก่าที่ยังไม่มีรถ
// ในคิววางบิลไม่โผล่ในหน้าวางบิลเลย เพราะคิวกรองเฉพาะลูกค้าที่มีรถรอวางบิลจริง - หน้านี้ไม่เปลี่ยนกติกานั้น แค่ให้ตั้งราคาล่วงหน้าได้)
export function BillingCustomerRatesPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [terms, setTerms] = useState<BillingTerms | null>(null);
  const [rates, setRates] = useState<ServiceFeeRate[] | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState<"account" | "terms" | "rates" | "">("rates");

  useEffect(() => {
    api
      .listCustomers()
      .then((r) => setCustomers(r.customers))
      .catch((err) => setError(err instanceof ApiError ? err.message : "โหลดรายชื่อลูกค้าไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!customerId) return;
    setLoadingDetail(true);
    setError("");
    Promise.all([billingApi.customerTerms(customerId), billingApi.getRates(customerId)])
      .then(([t, r]) => {
        setTerms(t.terms);
        setRates(r.rates);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "โหลดข้อมูลลูกค้าไม่สำเร็จ"))
      .finally(() => setLoadingDetail(false));
  }, [customerId]);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const needle = q.trim().toLowerCase();
  const filtered = customers.filter((c) => !needle || (c.company || "").toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle));

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setTerms(null);
    setRates(null);
    setSettingsOpen("rates");
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>ตั้งราคาล่วงหน้า</h1>
      <p>
        ตั้งเงื่อนไขวางบิล บัญชีรับเงิน และตารางค่าดำเนินการให้ลูกค้ารายใดก็ได้ล่วงหน้า แม้ยังไม่มีรถส่งงานเข้าคิววางบิล - รายชื่อลูกค้าในหน้าวางบิลยังแสดงเฉพาะรายที่มีรถรอวางบิลจริงเหมือนเดิม
      </p>
      <Link href="/accounting/billing" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        ← กลับไปหน้าวางบิล
      </Link>

      {error && (
        <div className="customer-message error" role="status" style={{ marginTop: 16 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : (
        <>
          <label className="field" style={{ marginTop: 20, maxWidth: 360 }}>
            ค้นหาลูกค้า
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="ชื่อลูกค้า / บริษัท" autoFocus />
          </label>

          <div className="inspect-filter" style={{ padding: "12px 0 0" }}>
            {filtered.map((c) => (
              <button key={c.id} className={`filter-chip${c.id === customerId ? " selected" : ""}`} onClick={() => chooseCustomer(c.id)}>
                {c.company || c.name}
              </button>
            ))}
            {filtered.length === 0 && <span className="muted">ไม่พบลูกค้า</span>}
          </div>

          {customer &&
            (loadingDetail || !terms || !rates ? (
              <div className="customer-message" role="status" style={{ marginTop: 20 }}>
                กำลังโหลด...
              </div>
            ) : (
              <section className="panel" style={{ marginTop: 16, padding: "16px 23px", overflow: "visible" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", alignItems: "center", justifyContent: "space-between", fontSize: 14 }}>
                  <div>
                    <b style={{ fontWeight: 600 }}>{customer.company || customer.name}</b>
                    <span className="muted" style={{ margin: "0 10px" }}>
                      ·
                    </span>
                    เงื่อนไขวางบิล: {termsSummary(terms, todayIso())}
                    <span className="muted" style={{ marginLeft: 12 }}>
                      ตารางค่าดำเนินการ {rates.length} แถว
                    </span>
                  </div>
                  <div>
                    <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "account" ? "" : "account")}>
                      บัญชีรับเงิน
                    </button>
                    <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "terms" ? "" : "terms")}>
                      แก้เงื่อนไข
                    </button>
                    <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "rates" ? "" : "rates")}>
                      แก้ตารางค่าดำเนินการ
                    </button>
                  </div>
                </div>
                {settingsOpen === "account" && <BillingAccountEditor key={customer.id} customerId={customer.id} onSaved={() => {}} />}
                {settingsOpen === "terms" && (
                  <BillingTermsEditor
                    key={customer.id}
                    customerId={customer.id}
                    terms={terms}
                    onSaved={(t) => {
                      setTerms(t);
                      setSettingsOpen("");
                    }}
                  />
                )}
                {settingsOpen === "rates" && (
                  <BillingRatesEditor
                    key={customer.id}
                    customerId={customer.id}
                    rates={rates}
                    onSaved={() => billingApi.getRates(customer.id).then((r) => setRates(r.rates))}
                  />
                )}
              </section>
            ))}
        </>
      )}
    </section>
  );
}
