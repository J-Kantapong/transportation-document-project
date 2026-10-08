"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, ApiError, type SubmitCandidate } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { isSupplierProvince } from "@/lib/supplier-route";
import { FOCUS_PARAM } from "@/lib/vehicle-focus";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { SubmitDateField } from "@/components/submit-flow/SubmitDateField";
import {
  isInWriteScope,
  isMotoBody,
  jobTypeLabel,
  lastFailedLabel,
  SETTINGS_HREF,
  summarizeList,
  useWriteScope,
} from "@/components/submit-flow/shared";

// ขั้น 1 เลือกรถ (ผู้ใช้ 2026-09-25): คิวรถที่พร้อมยื่น ติ๊กเลือกแล้วไปขั้นตั้งค่า - ตั้งค่ารายคัน (เจ้าของรถ/
// ขอเลข/ป้าย/ด่วน) ทำในขั้นตรวจทานที่เดียว ไม่มีฟอร์มรายคันแยกแล้ว
// คิวโหลดตามวันที่ยื่นของขั้นตอนนี้ (ผู้ใช้ 2026-09-27): ยกเลิก/ยื่นไม่สำเร็จแล้วยื่นใหม่ด้วยวันที่ยื่นเดิมได้ ถ้าวันนั้นยังไม่ครบ
// 90 วันจากวันที่ตรวจผ่าน (เดิมคิวใช้วันนี้เสมอ รถที่ผลตรวจเพิ่งหมดอายุเลือกไม่ได้ ต้องไปตรวจรอบ 2) - backend ตรวจซ้ำตอนยื่น
const QUEUE_PAGE_SIZE = 50;

type KindFilter = "all" | "car" | "moto";
type FacetKey = "date" | "brand" | "owner" | "kind";

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="inspect-pagination">
      <button className="text-button" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
        ← ก่อนหน้า
      </button>
      <span className="muted">
        หน้า {page + 1} จาก {totalPages}
      </span>
      <button className="text-button" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>
        ถัดไป →
      </button>
    </div>
  );
}

// useSearchParams ต้องอยู่ใต้ Suspense ตอน prerender - หน้าค้นหารถส่ง ?focus=เลขตัวถัง มา (lib/vehicle-focus.ts)
export default function SubmitPickPage() {
  return (
    <Suspense>
      <SubmitPickStep />
    </Suspense>
  );
}

function SubmitPickStep() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { selected, selectedIds, select, unselect, refreshSelected, submitDate, today, checks } = useSubmitFlow();
  // คิว = รถที่ยื่นได้ ณ วันที่ยื่นของขั้นตอนนี้ (ช่องวันที่ยื่นบนหน้านี้กับขั้นตั้งค่าเป็นค่าเดียวกัน ผู้ใช้ 2026-09-27)
  // ยังไม่แก้วันที่ = วันนี้ เปิดค้างข้ามคืนแล้วกลับมาที่หน้าต่าง = วันใหม่ โหลดคิวใหม่ (พบ 2026-09-27)
  const queueDate = submitDate || today;
  // ยื่นได้เฉพาะประเภทรถที่บัญชีนี้บันทึกได้ (เช่น STAFF_CAR + ACCOUNTANT เห็นมอเตอร์ไซค์ในคิวแต่ยื่นไม่ได้ - พบ 2026-09-27)
  const writeScope = useWriteScope();

  const [queue, setQueue] = useState<SubmitCandidate[]>([]);
  // วันที่ยื่นที่คิวในจอโหลดมา - ระหว่างโหลดคิวของวันใหม่ แถวที่ติ๊กยังเป็นของวันเดิม (ขั้นตอนตรวจสิทธิ์ของวันใหม่ให้เอง)
  const [queueLoadedFor, setQueueLoadedFor] = useState("");
  // โหลดคิวสำเร็จแล้วหรือยัง (ห้ามแสดง "ไม่มีรถ" ตอนโหลดไม่ขึ้น)
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const [passDateFilter, setPassDateFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [chassisFilter, setChassisFilter] = useState(() => searchParams.get(FOCUS_PARAM) ?? "");
  const [page, setPage] = useState(0);

  // ผลค้น "ทำไมไม่อยู่ในคิว" ตรวจ ณ วันที่ยื่นตอนค้น - แสดงเฉพาะตอนวันที่ยื่นยังเป็นวันเดียวกัน (พบ 2026-09-27: เปลี่ยนวันที่ยื่นแล้ว
  // ผลของวันเดิม เช่น "ยื่นได้" ยังค้างอยู่ข้างคิวของวันใหม่)
  const [lookup, setLookup] = useState<{ date: string; vehicles: SubmitCandidate[] } | null>(null);
  const lookupResults = lookup && lookup.date === queueDate ? lookup.vehicles : null;
  const [lookupLoading, setLookupLoading] = useState(false);

  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดคิวตอนเปิดหน้า/กดลองใหม่
    setLoading(true);
    setLoadError("");
    const date = queueDate;
    api
      .listSubmissionQueue(date)
      .then(({ vehicles }) => {
        if (cancelled) return;
        setQueue(vehicles);
        setQueueLoadedFor(date);
        setLoaded(true);
        // รถที่เลือกไว้แล้วใช้ข้อมูลล่าสุด (เช่น เจ้าของรถที่เพิ่งกรอกในหน้าเพิ่มข้อมูลรถ - พบ 2026-09-27) และนับว่ายื่นได้ ณ วันนั้น
        refreshSelected(vehicles, date);
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : "โหลดคิวรอยื่นเอกสารไม่สำเร็จ"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // refreshSelected เปลี่ยนตาม state ของขั้นตอนทุกครั้ง - โหลดคิวใหม่เฉพาะเมื่อเปลี่ยนวัน/กดลองใหม่
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueDate, reload]);

  // ---- ตัวกรองแบบ faceted: ตัวเลือกของแต่ละตัวกรองนับจากรถที่ผ่านตัวกรองอื่นแล้ว ----
  const queueReady = loaded;
  const rows = queueReady ? queue.filter((v) => isInWriteScope(writeScope, v.body)) : [];

  function matches(v: SubmitCandidate, except: FacetKey | null, f: { date: string; brand: string; owner: string; kind: KindFilter }) {
    if (except !== "date" && f.date && v.inspectionResultDate !== f.date) return false;
    if (except !== "brand" && f.brand && v.brandName !== f.brand) return false;
    if (except !== "owner" && f.owner && v.customerName !== f.owner) return false;
    if (except !== "kind" && f.kind !== "all" && (f.kind === "moto") !== isMotoBody(v.body)) return false;
    return true;
  }
  function countBy(list: SubmitCandidate[], keyOf: (v: SubmitCandidate) => string | null): Map<string, number> {
    const counts = new Map<string, number>();
    for (const v of list) {
      const key = keyOf(v);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }
  const rawFilters = { date: passDateFilter, brand: brandFilter, owner: ownerFilter, kind: kindFilter };
  const dateCounts = countBy(rows.filter((v) => matches(v, "date", rawFilters)), (v) => v.inspectionResultDate);
  const brandCounts = countBy(rows.filter((v) => matches(v, "brand", rawFilters)), (v) => v.brandName);
  const ownerCounts = countBy(rows.filter((v) => matches(v, "owner", rawFilters)), (v) => v.customerName);
  const kindRows = rows.filter((v) => matches(v, "kind", rawFilters));
  const motoCount = kindRows.filter((v) => isMotoBody(v.body)).length;
  const filters = {
    date: dateCounts.has(passDateFilter) ? passDateFilter : "",
    brand: brandCounts.has(brandFilter) ? brandFilter : "",
    owner: ownerCounts.has(ownerFilter) ? ownerFilter : "",
    kind: kindFilter,
  };
  const chassisQuery = chassisFilter.trim().toLowerCase();
  const filtered = rows.filter((v) => matches(v, null, filters) && (!chassisQuery || v.chassis.toLowerCase().includes(chassisQuery)));
  const totalPages = Math.max(1, Math.ceil(filtered.length / QUEUE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(currentPage * QUEUE_PAGE_SIZE, (currentPage + 1) * QUEUE_PAGE_SIZE);
  const allFilteredSelected = filtered.length > 0 && filtered.every((v) => selectedIds.has(v.id));

  function onFilterChange(apply: () => void) {
    apply();
    setPage(0);
  }

  function toggle(v: SubmitCandidate) {
    if (selectedIds.has(v.id)) unselect([v.id]);
    else select([v], queueLoadedFor);
  }

  // เลือก/เอาออกทุกคันที่ตรงตัวกรอง (ทุกหน้า ไม่ใช่แค่ 50 คันที่เห็น)
  function toggleAllFiltered() {
    if (allFilteredSelected) unselect(filtered.map((v) => v.id));
    else select(filtered, queueLoadedFor);
  }

  async function handleLookupOutsideQueue() {
    const query = chassisFilter.trim();
    if (!query) return;
    setLookupLoading(true);
    setNotice(null);
    const date = queueDate;
    try {
      const { vehicles } = await api.searchVehiclesByChassis(query, date);
      setLookup({ date, vehicles });
    } catch (err) {
      setLookup(null);
      setNotice({ text: err instanceof ApiError ? err.message : "ค้นหาไม่สำเร็จ", error: true });
    } finally {
      setLookupLoading(false);
    }
  }

  // วางเลขตัวถังหลายคัน = เลือกคันที่พร้อมยื่นให้ทีเดียว (ต้องอยู่ในคิว) คันที่ยื่นไม่ได้แจ้งพร้อมเหตุผล
  async function handlePaste() {
    const lines = Array.from(new Set(pasteText.split("\n").map((l) => l.trim()).filter(Boolean)));
    if (lines.length === 0) return setNotice({ text: "วางเลขตัวถังอย่างน้อย 1 รายการ", error: true });
    if (lines.length > 1000) return setNotice({ text: `รองรับไม่เกิน 1,000 คันต่อครั้ง (พบ ${lines.length} รายการ)`, error: true });
    setPasteBusy(true);
    setNotice(null);
    const date = queueDate;
    try {
      const lookup = await api.lookupVehiclesByChassis(lines, date);
      const { notFound } = lookup;
      // คันนอกประเภทรถที่บัญชีนี้ยื่นได้ นับเป็นยื่นไม่ได้พร้อมเหตุผล
      const found = lookup.found.filter((v) => isInWriteScope(writeScope, v.body));
      const blocked = [
        ...lookup.blocked,
        ...lookup.found.filter((v) => !isInWriteScope(writeScope, v.body)).map((v) => ({ chassis: v.chassis, reason: "บัญชีของคุณยื่นรถประเภทนี้ไม่ได้" })),
      ];
      // ผลค้นเลขตัวถังเป็นข้อมูลล่าสุด ณ วันที่ยื่นนี้ (คิวในจออาจโหลดไว้ก่อน/เป็นของวันเดิม)
      // backend ค้นด้วย `in` ไม่การันตีลำดับ (ได้ตามลำดับในฐานข้อมูล) - เรียงกลับตามลำดับที่ยิง/วางมา เพื่อให้ขั้นตั้งค่า/ตรวจทาน/ใบส่งงาน
      // เรียงตามลำดับเดิม (พบ 2026-10-02)
      const position = new Map(lines.map((c, i) => [c.toLowerCase(), i]));
      const vehicles = [...found].sort((a, b) => (position.get(a.chassis.toLowerCase()) ?? 0) - (position.get(b.chassis.toLowerCase()) ?? 0));
      const fresh = vehicles.filter((v) => !selectedIds.has(v.id));
      select(fresh, date);
      const parts = [`เลือกเพิ่ม ${fresh.length} คัน`];
      if (vehicles.length > fresh.length) parts.push(`เลือกไว้แล้ว ${vehicles.length - fresh.length} คัน`);
      if (notFound.length > 0) parts.push(`ไม่พบในระบบ ${notFound.length} รายการ: ${summarizeList(notFound)}`);
      if (blocked.length > 0) parts.push(`ยื่นไม่ได้ ${blocked.length} คัน: ${summarizeList(blocked.map((b) => `${b.chassis} - ${b.reason}`))}`);
      setNotice({ text: parts.join(" · "), error: fresh.length === 0 });
      if (fresh.length > 0) {
        setPasteText("");
        setPasteOpen(false);
      }
    } catch (err) {
      setNotice({ text: err instanceof ApiError ? err.message : "ตรวจสอบเลขตัวถังไม่สำเร็จ", error: true });
    } finally {
      setPasteBusy(false);
    }
  }

  const pasteCount = pasteText.split("\n").map((l) => l.trim()).filter(Boolean).length;

  return (
    <>
      <p className="muted" style={{ marginBottom: 16 }}>
        ติ๊กเลือกคันที่จะยื่น แล้วกด &quot;ถัดไป: ตั้งค่า&quot;
      </p>

      <section className="panel" style={{ padding: 22, marginBottom: 16 }}>
        {/* วันที่ยื่นช่องเดียวกับขั้นตั้งค่า (ผู้ใช้ 2026-09-27) - ยื่นใหม่ด้วยวันที่ยื่นเดิมหลังยกเลิก/ยื่นไม่สำเร็จ เปลี่ยนตรงนี้ได้เลย */}
        <div
          style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", marginBottom: 16, paddingBottom: 16, borderBottom: "1px solid #edf0f5" }}
        >
          <SubmitDateField />
          <span className="muted" style={{ fontSize: 13 }}>
            คิวนี้คือรถที่ยื่นได้ ณ วันที่ยื่นนี้ (ตรวจผ่านไม่เกิน 90 วัน) และรถจดต่างจังหวัดที่แจ้งย้ายแล้ว รอส่งงานให้ซับ - ยื่นใหม่ด้วยวันที่ยื่นเดิม
            เช่น หลังยกเลิก ให้เปลี่ยนวันที่ตรงนี้
          </span>
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 190 }}>
            วันที่ตรวจผ่าน
            <select value={filters.date} onChange={(e) => onFilterChange(() => setPassDateFilter(e.target.value))}>
              <option value="">ทุกวันที่</option>
              {Array.from(dateCounts.keys())
                .sort()
                .map((d) => (
                  <option key={d} value={d}>
                    {isoToDisplayDate(d)} ({dateCounts.get(d)} คัน)
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 170 }}>
            ยี่ห้อ
            <select value={filters.brand} onChange={(e) => onFilterChange(() => setBrandFilter(e.target.value))}>
              <option value="">ทุกยี่ห้อ</option>
              {Array.from(brandCounts.keys())
                .sort((a, b) => a.localeCompare(b, "th"))
                .map((b) => (
                  <option key={b} value={b}>
                    {b} ({brandCounts.get(b)} คัน)
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 210 }}>
            เจ้าของงาน
            <select value={filters.owner} onChange={(e) => onFilterChange(() => setOwnerFilter(e.target.value))}>
              <option value="">ทุกเจ้าของงาน</option>
              {Array.from(ownerCounts.keys())
                .sort((a, b) => a.localeCompare(b, "th"))
                .map((o) => (
                  <option key={o} value={o}>
                    {o} ({ownerCounts.get(o)} คัน)
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 190 }}>
            ค้นหาเลขตัวถัง
            <input
              value={chassisFilter}
              onChange={(e) =>
                onFilterChange(() => {
                  setChassisFilter(e.target.value);
                  setLookup(null);
                })
              }
              placeholder="บางส่วนก็ได้"
            />
          </label>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(
              [
                ["all", `ทั้งหมด (${kindRows.length})`],
                ["car", `รถยนต์ (${kindRows.length - motoCount})`],
                ["moto", `มอเตอร์ไซค์ (${motoCount})`],
              ] as Array<[KindFilter, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`filter-chip${kindFilter === key ? " selected" : ""}`}
                onClick={() => onFilterChange(() => setKindFilter(key))}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="text-button" aria-expanded={pasteOpen} onClick={() => setPasteOpen((o) => !o)}>
            {pasteOpen ? "ปิดช่องวางเลขตัวถัง" : "วางเลขตัวถังหลายคัน"}
          </button>
        </div>

        {pasteOpen && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #edf0f5" }}>
            <label className="field wide">
              เลขตัวถัง 1 เลขต่อ 1 บรรทัด (สูงสุด 1,000 คัน) - ระบบเลือกคันที่ยื่นได้ให้ คันที่ยื่นไม่ได้จะบอกเหตุผล
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={"CHASSIS0001\nCHASSIS0002"}
                rows={6}
                style={{ fontFamily: "monospace" }}
              />
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
              <button type="button" className="primary" disabled={pasteBusy || pasteCount === 0} onClick={handlePaste}>
                {pasteBusy ? "กำลังตรวจสอบ…" : `เลือก ${pasteCount} คันนี้`}
              </button>
            </div>
          </div>
        )}
      </section>

      {notice && (
        <p className={`customer-message${notice.error ? " error" : ""}`} role="status" style={{ marginBottom: 12 }}>
          {notice.text}
        </p>
      )}

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "16px 22px" }}>
          <div>
            <strong style={{ fontSize: 15 }}>
              รถที่ยื่นได้ {filtered.length} คัน
              {queueLoadedFor ? <span style={{ fontWeight: 400 }}> ณ วันที่ยื่น {isoToDisplayDate(queueLoadedFor)}</span> : null}
            </strong>
            <span className="muted" role="status">
              {loading ? " · กำลังโหลด…" : queueReady ? ` · ในคิวทั้งหมด ${rows.length} คัน` : ""}
            </span>
          </div>
        </div>

        {loadError ? (
          <div className="empty-customers" role="alert">
            <p className="customer-message error" style={{ marginBottom: 12 }}>
              โหลดคิวรอยื่นไม่สำเร็จ: {loadError}
            </p>
            <button type="button" className="primary" disabled={loading} onClick={() => setReload((n) => n + 1)}>
              {loading ? "กำลังโหลด…" : "ลองใหม่"}
            </button>
          </div>
        ) : !queueReady ? (
          <div className="empty-customers">กำลังโหลดคิวรอยื่น…</div>
        ) : filtered.length === 0 ? (
          <div className="empty-customers">
            {chassisQuery ? (
              <>
                ไม่พบเลขตัวถังนี้ในคิวรอยื่น ·{" "}
                <button type="button" className="text-button" disabled={lookupLoading} onClick={handleLookupOutsideQueue}>
                  {lookupLoading ? "กำลังค้นหา…" : "ตรวจสอบว่าทำไมไม่อยู่ในคิว"}
                </button>
              </>
            ) : rows.length === 0 ? (
              "ยังไม่มีรถที่พร้อมยื่น ณ วันที่ยื่นนี้ (ต้องแจ้งย้าย/ตัดบัญชีและตรวจรถผ่านไม่เกิน 90 วัน - รถจดต่างจังหวัดที่ส่งซับไม่ต้องตรวจรถ)"
            ) : (
              "ไม่มีรถตรงกับตัวกรอง"
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label={`เลือกทุกคันที่ตรงกับตัวกรอง (${filtered.length} คัน ทุกหน้า)`}
                      title={`เลือกทุกคันที่ตรงกับตัวกรอง (${filtered.length} คัน ทุกหน้า)`}
                      checked={allFilteredSelected}
                      onChange={toggleAllFiltered}
                    />
                  </th>
                  <th>วันที่ตรวจผ่าน</th>
                  <th>เจ้าของงาน</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>ประเภทรถ</th>
                  <th>ประเภทงาน</th>
                  <th>หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((v) => (
                  <tr key={v.id} onClick={() => toggle(v)} style={{ cursor: "pointer" }} className={selectedIds.has(v.id) ? "row-selected" : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`เลือก ${v.chassis}`}
                        checked={selectedIds.has(v.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(v)}
                      />
                    </td>
                    <td>
                      {v.inspectionResultDate ? (
                        isoToDisplayDate(v.inspectionResultDate)
                      ) : isSupplierProvince(v.registrationProvince) ? (
                        <span className="badge warn">ซับตรวจ</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.body || "—"}</td>
                    <td>{jobTypeLabel(v)}</td>
                    <td>{v.lastFailedSubmission ? <span className="badge warn">{lastFailedLabel(v.lastFailedSubmission)}</span> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={currentPage} totalPages={totalPages} onPageChange={setPage} />
      </section>

      {lookupResults && (
        <section className="panel" style={{ marginTop: 16 }}>
          <p style={{ margin: 0, padding: "16px 22px", fontSize: 14, fontWeight: 500 }}>
            ผลค้นหาในระบบทั้งหมด <span style={{ fontWeight: 400 }}>ณ วันที่ยื่น {isoToDisplayDate(queueDate)}</span>
          </p>
          {lookupResults.length === 0 ? (
            <div className="empty-customers">ไม่พบข้อมูลรถเลขตัวถังนี้ในระบบ</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>เลขตัวถัง</th>
                    <th>เจ้าของงาน</th>
                    <th>วันที่ตรวจผ่าน</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {lookupResults.map((v) => (
                    <tr key={v.id}>
                      <td>{v.chassis}</td>
                      <td>{v.customerName}</td>
                      <td>{v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}</td>
                      <td>
                        {/* ค้นหาใช้ขอบเขตที่ดูได้ (เช่น STAFF_CAR + ACCOUNTANT เห็นมอเตอร์ไซค์) - บอกเหตุผลเดียวกับช่องวางเลขตัวถัง (พบ 2026-09-27) */}
                        {!isInWriteScope(writeScope, v.body) ? (
                          <span className="badge warn">บัญชีของคุณยื่นรถประเภทนี้ไม่ได้</span>
                        ) : v.submitBlockReason ? (
                          <span className="badge warn">{v.submitBlockReason}</span>
                        ) : (
                          <span className="badge done">ยื่นได้</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* แถบล่างติดจอ: เลือกแล้วกี่คัน (รวมคันที่อยู่นอกตัวกรองตอนนี้) + ไปขั้นถัดไป */}
      <div className="submit-footer">
        <span>
          เลือกแล้ว <strong>{selected.length}</strong> คัน
          {/* คันที่เลือกไว้แต่ยื่นไม่ได้ ณ วันที่ยื่นที่เพิ่งเปลี่ยน - เหตุผลอยู่ในขั้นตั้งค่า */}
          {checks.dateBlockedIds.length > 0 && (
            <span className="field-error"> · ยื่นไม่ได้ ณ วันที่ยื่นนี้ {checks.dateBlockedIds.length} คัน (ดูเหตุผลที่ขั้นตั้งค่า)</span>
          )}
          {selected.length > 0 && (
            <>
              {" · "}
              <button type="button" className="text-button" onClick={() => unselect(selected.map((v) => v.id))}>
                ล้างที่เลือก
              </button>
            </>
          )}
        </span>
        <button type="button" className="primary" disabled={selected.length === 0} onClick={() => router.push(SETTINGS_HREF)}>
          ถัดไป: ตั้งค่า →
        </button>
      </div>
    </>
  );
}
