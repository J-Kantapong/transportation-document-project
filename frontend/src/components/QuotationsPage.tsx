"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { getCachedUser } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatMoney } from "@/lib/invoice";
import {
  QUOTATION_KIND_LABEL,
  QUOTATION_STAGE_LABEL,
  quotationApi,
  quotationGrandTotal,
  type Quotation,
  type QuotationList,
  type QuotationSeries,
  type QuotationStage,
} from "@/lib/quotation-api";

// หน้า "ใบเสนอราคา" (ผู้ใช้ 2026-10-01): รายการทุกใบ แบ่งกลุ่มตามขั้น (ร่าง / รอลูกค้าตอบ / อนุมัติแล้ว / เสร็จ ...)
// แถวสั้นไม่มีตารางกว้าง (ผู้ใช้ไม่ชอบเลื่อนข้าง) · กลุ่มที่กรองและคำค้นอยู่ใน URL - refresh / ย้อนกลับแล้วยังอยู่
const STAGES: QuotationStage[] = ["DRAFT", "WAITING", "EXPIRED", "APPROVED", "DONE", "REJECTED", "CANCELLED", "SUPERSEDED"];

export const stageBadgeClass = (stage: QuotationStage) =>
  stage === "DONE" ? "badge done" : stage === "WAITING" || stage === "EXPIRED" ? "badge warn" : "badge";

// ข้อความขั้นของใบ: อนุมัติแล้ว = บอกว่าขั้นต่อไปคืออะไร · เสร็จแล้ว = บอกเลขบิล / ตั้งราคาแล้ว
export function stageText(q: Quotation): string {
  if (q.stage === "APPROVED") return q.kind === "JOB" ? "อนุมัติแล้ว · รอออกใบวางบิล" : "อนุมัติแล้ว · รอตั้งเป็นราคาลูกค้า";
  if (q.stage === "DONE") return q.invoice ? `ออกบิลแล้ว ${q.invoice.invoiceNo}` : "ตั้งเป็นราคาลูกค้าแล้ว";
  return QUOTATION_STAGE_LABEL[q.stage];
}

export const quotationHref = (q: Pick<Quotation, "id" | "status">) =>
  q.status === "DRAFT" ? `/accounting/quotations/new?edit=${encodeURIComponent(q.id)}` : `/accounting/quotations/view?id=${encodeURIComponent(q.id)}`;

export function QuotationsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const stage = (STAGES as string[]).includes(params.get("stage") ?? "") ? (params.get("stage") as QuotationStage) : "";
  const q = params.get("q") ?? "";

  const [search, setSearch] = useState(q);
  const [data, setData] = useState<QuotationList | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [series, setSeries] = useState<QuotationSeries | null>(null);

  // ADMIN เห็นแผงตั้งเลขล่าสุด (ต่อเลขจากระบบเดิม)
  useEffect(() => {
    if (!(getCachedUser()?.roles ?? []).includes("ADMIN")) return;
    quotationApi.series().then(setSeries).catch(() => undefined);
  }, []);

  function setQuery(next: { stage?: string; q?: string }) {
    const merged = { stage, q, ...next };
    const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v) as string[][]).toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  // พิมพ์แล้วค้นเอง (หน่วง 300 ms)
  useEffect(() => {
    if (search === q) return;
    const t = setTimeout(() => setQuery({ q: search.trim() }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ตามคำค้นที่พิมพ์เท่านั้น
  }, [search]);

  useEffect(() => {
    let stale = false;
    quotationApi
      .list({ stage, q })
      .then((d) => !stale && (setData(d), setError("")))
      .catch((err) => !stale && setError(err instanceof ApiError ? err.message : "โหลดใบเสนอราคาไม่สำเร็จ"));
    return () => {
      stale = true;
    };
  }, [stage, q]);

  async function loadMore() {
    if (!data) return;
    setLoadingMore(true);
    try {
      const more = await quotationApi.list({ stage, q, offset: data.quotations.length });
      setData({ ...more, quotations: [...data.quotations, ...more.quotations] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดเพิ่มไม่สำเร็จ");
    } finally {
      setLoadingMore(false);
    }
  }

  const total = data ? STAGES.reduce((s, k) => s + data.counts[k], 0) : 0;

  return (
    <section className="content">
      <div className="heading">
        <div>
          <h1 tabIndex={-1}>ใบเสนอราคา</h1>
          <p>เสนอราคาให้ลูกค้าก่อนวางบิล - ลูกค้าอนุมัติแล้วออกใบวางบิลจากใบเสนอราคาได้เลย หรือตั้งเป็นราคาต่อคันของลูกค้า</p>
        </div>
        <Link href="/accounting/quotations/new" className="primary" style={{ textDecoration: "none" }}>
          + ออกใบเสนอราคา
        </Link>
      </div>

      {error && (
        <div className="customer-message error" role="alert" style={{ margin: "12px 0" }}>
          {error}
        </div>
      )}

      <section className="panel">
        <div className="panel-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>รายการใบเสนอราคา</h2>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ค้นเลขที่ / ลูกค้า / ชื่องาน / PO"
            aria-label="ค้นหาใบเสนอราคา"
            style={{ border: "1px solid #dce2ec", borderRadius: 8, padding: "9px 12px", flex: "0 1 300px", minWidth: 0 }}
          />
        </div>
        <div className="inspect-filter" role="group" aria-label="กรองตามสถานะ">
          <button type="button" className={`filter-chip${stage === "" ? " selected" : ""}`} onClick={() => setQuery({ stage: "" })}>
            ทั้งหมด {data ? total : ""}
          </button>
          {STAGES.filter((s) => s === stage || (data?.counts[s] ?? 0) > 0).map((s) => (
            <button key={s} type="button" className={`filter-chip${stage === s ? " selected" : ""}`} onClick={() => setQuery({ stage: s })}>
              {QUOTATION_STAGE_LABEL[s]} {data?.counts[s] ?? ""}
            </button>
          ))}
        </div>

        {!data ? (
          !error && <div className="empty-customers">กำลังโหลด...</div>
        ) : data.quotations.length === 0 ? (
          <div className="empty-customers">{q || stage ? "ไม่พบใบเสนอราคาตามที่ค้น" : "ยังไม่มีใบเสนอราคา - กด “+ ออกใบเสนอราคา” เพื่อเริ่ม"}</div>
        ) : (
          <div style={{ display: "grid" }}>
            {data.quotations.map((row) => {
              const closed = row.stage === "CANCELLED" || row.stage === "SUPERSEDED" || row.stage === "REJECTED";
              return (
                <Link
                  key={row.id}
                  href={quotationHref(row)}
                  style={{ padding: "12px 23px", borderTop: "1px solid #f0f2f6", textDecoration: "none", display: "block", color: closed ? "#8a94a6" : undefined }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span>
                      <b>{row.quotationNo ?? "ร่าง (ยังไม่มีเลข)"}</b> · {row.customer.name}
                      {!row.customerId && <span className="muted"> (ลูกค้าใหม่ ยังไม่อยู่ในระบบ)</span>}
                    </span>
                    <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {row.kind === "JOB" && <b>{formatMoney(quotationGrandTotal(row))}</b>}
                      <span className={stageBadgeClass(row.stage)}>{stageText(row)}</span>
                    </span>
                  </div>
                  <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                    {QUOTATION_KIND_LABEL[row.kind]}
                    {row.title ? ` · ${row.title}` : ""} · ออก {isoToDisplayDate(row.issueDate)} · ยืนราคาถึง {isoToDisplayDate(row.validUntil)}
                    {row.poNumber ? ` · PO ${row.poNumber}` : ""}
                    {row.replaces?.quotationNo ? ` · ฉบับแก้ไขของ ${row.replaces.quotationNo}` : ""}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
        {data?.hasMore && (
          <div style={{ padding: "12px 23px", borderTop: "1px solid #f0f2f6" }}>
            <button type="button" className="text-button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "กำลังโหลด..." : "โหลดเพิ่มอีก 100 ใบ"}
            </button>
          </div>
        )}
      </section>

      {series && <SeriesPanel series={series} onSaved={setSeries} />}
    </section>
  );
}

// ตั้งเลขล่าสุดที่ใช้ไปแล้ว (ผู้ใช้ 2026-10-30: ระบบเดิมออกถึง QT2026-022 ใบในระบบต้องเริ่ม 023) - ADMIN เท่านั้น
function SeriesPanel({ series, onSaved }: { series: QuotationSeries; onSaved: (s: QuotationSeries) => void }) {
  const [year, setYear] = useState(todayIso().slice(0, 4));
  const [lastNumber, setLastNumber] = useState("");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const y = Number(year);
  const n = Number(lastNumber);
  const valid = Number.isInteger(y) && y >= 2020 && lastNumber.trim() !== "" && Number.isInteger(n) && n >= 0;
  const highest = series.series.find((s) => s.year === y)?.highestInSystem ?? 0;

  async function save() {
    setError("");
    if (!valid) return setError("ใส่ปี ค.ศ. และเลขล่าสุดเป็นตัวเลข");
    if (n < highest) return setError(`ปี ${y} ออกเลข ${highest} ในระบบไปแล้ว - ตั้งต่ำกว่านี้ไม่ได้`);
    if (!remark.trim()) return setError("ใส่ที่มาของเลข เช่น เลขล่าสุดในระบบเดิม");
    setSaving(true);
    try {
      onSaved(await quotationApi.setSeries({ year: y, lastNumber: n, remark: remark.trim() }));
      setLastNumber("");
      setRemark("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>เลขที่ใบเสนอราคา (ADMIN)</h2>
      </div>
      <div style={{ padding: "0 23px 16px" }}>
        <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
          {series.series.map((s) => (
            <li key={s.year}>
              ปี {s.year}: เลขล่าสุด {s.lastNumber} · ใบถัดไป <b>{s.nextNo}</b>
              {s.highestInSystem > 0 ? ` · เลขสูงสุดที่ออกในระบบ ${s.highestInSystem}` : ""}
            </li>
          ))}
        </ul>
        <p className="muted" style={{ fontSize: 13 }}>
          ใส่เลขล่าสุดที่ออกไปแล้วนอกระบบ (เช่น QT{year}-022 → ใส่ 22) ใบถัดไปจะเป็น QT{year}-{String((valid ? n : 0) + 1).padStart(3, "0")} · ตั้งต่ำกว่าเลขที่ออกในระบบแล้วไม่ได้
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <label className="field">
            ปี ค.ศ.
            <input type="text" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} style={{ width: 80 }} />
          </label>
          <label className="field">
            เลขล่าสุดที่ใช้ไปแล้ว
            <input type="text" inputMode="numeric" value={lastNumber} onChange={(e) => setLastNumber(e.target.value.replace(/\D/g, "").slice(0, 5))} style={{ width: 110 }} />
          </label>
          <label className="field" style={{ flex: "1 1 220px" }}>
            ที่มา / เหตุผล *
            <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ระบบเดิมออกถึง QT2026-022" />
          </label>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        </div>
        {error && (
          <p className="customer-message error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
