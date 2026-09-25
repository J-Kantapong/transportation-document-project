"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  VEHICLE_SEARCH_STAGES,
  type VehicleSearchParams,
  type VehicleSearchResult,
  type VehicleSearchRow,
  type VehicleSearchStatus,
  type VehicleStageStatus,
} from "@/lib/api";
import { canAccessPage, getCachedUser, type UserRole } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { focusHref, stagePageFor } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";

// หน้าค้นหารถ (ผู้ใช้ 2026-09-25): ค้นรถจดใหม่ทั้งฐานข้อมูล + ดูว่าตอนนี้ค้างขั้นไหน ค้างกี่วัน มีปัญหาอะไร
// เงื่อนไขค้นหาเก็บใน URL (?q=&from=&to=&status=&kind=) ให้รีเฟรช/กดย้อนกลับ/ส่งลิงก์ต่อได้ - อ่านอย่างเดียว
// กรองทันทีระหว่างพิมพ์ ไม่ต้องกดปุ่มค้นหา (ผู้ใช้ 2026-09-25)

const STAGE_LABEL = new Map<string, string>(VEHICLE_SEARCH_STAGES);

const STATUS_CHIPS: ReadonlyArray<readonly [VehicleSearchStatus | "", string]> = [
  ["", "ทั้งหมด"],
  ["problem", "มีปัญหา / เกินกำหนด"],
  ...VEHICLE_SEARCH_STAGES,
  ["done", "จบงานแล้ว"],
];

const PARAM_KEYS = ["q", "from", "to", "status", "kind"] as const;

function paramsFrom(searchParams: URLSearchParams): VehicleSearchParams {
  return Object.fromEntries(PARAM_KEYS.map((k) => [k, searchParams.get(k) ?? ""])) as VehicleSearchParams;
}

function queryString(params: VehicleSearchParams): string {
  const search = new URLSearchParams();
  for (const k of PARAM_KEYS) if (params[k]) search.set(k, params[k]!);
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

// กรองทันทีระหว่างพิมพ์ (ผู้ใช้ 2026-09-25): หยุดพิมพ์ครู่หนึ่งแล้วค้นเอง ไม่ต้องกดปุ่ม
const TYPING_DELAY_MS = 300;

// URL ที่หน้านี้เขียนเองระหว่างพิมพ์/กดกรอง - ไม่ต้องสร้างหน้าใหม่ (ช่องค้นหาจะหลุดโฟกัส) ส่วน URL ที่เปลี่ยนจากภายนอก
// (กดย้อนกลับ / เปิดลิงก์ / กดเมนูค้นหารถซ้ำ) ให้สร้างหน้าใหม่ให้ช่องกรอกตรงกับ URL
let lastWrittenQuery: string | null = null;

// useSearchParams ต้องอยู่ใต้ Suspense ตอน prerender
export default function VehicleSearchPage() {
  return (
    <Suspense>
      <VehicleSearchFromUrl />
    </Suspense>
  );
}

function VehicleSearchFromUrl() {
  const current = useSearchParams().toString();
  const [seen, setSeen] = useState(current);
  const [mountKey, setMountKey] = useState(current);
  if (current !== seen) {
    setSeen(current);
    if (current !== lastWrittenQuery) setMountKey(current);
  }
  return <VehicleSearch key={mountKey} initial={paramsFrom(new URLSearchParams(mountKey))} />;
}

// วันที่ในช่อง: ว่าง = ไม่กรอง, ครบ 8 หลักและมีจริง = กรอง, นอกนั้น = ยังพิมพ์ไม่เสร็จ (null = ยังไม่ค้น)
function dateParam(text: string): string | null {
  if (!text) return "";
  return displayDateToIso(text.replace(/\D/g, "")) || null;
}

function VehicleSearch({ initial }: { initial: VehicleSearchParams }) {
  const router = useRouter();
  const [searchText, setSearchText] = useState(initial.q ?? "");
  const [fromText, setFromText] = useState(isoToDisplayDate(initial.from ?? ""));
  const [toText, setToText] = useState(isoToDisplayDate(initial.to ?? ""));
  const [applied, setApplied] = useState<VehicleSearchParams>(initial);

  const [result, setResult] = useState<VehicleSearchResult | null>(null);
  const [rows, setRows] = useState<VehicleSearchRow[]>([]);
  const [searching, setSearching] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [roles, setRoles] = useState<UserRole[]>([]);

  const appliedKey = queryString(applied);
  const filtered = Boolean(applied.q || applied.from || applied.to || applied.kind);
  const fromIso = dateParam(fromText);
  const toIso = dateParam(toText);
  const dateError =
    fromIso === null || toIso === null
      ? ""
      : fromIso && toIso && fromIso > toIso
        ? "วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด"
        : "";

  useEffect(() => {
    // localStorage อ่านได้เฉพาะฝั่ง browser - ใช้ซ่อนลิงก์ไปหน้างานที่บทบาทนี้เปิดไม่ได้
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  // ค้นใหม่ทุกครั้งที่เงื่อนไขเปลี่ยน - ผลของคำค้นเก่าที่ตอบช้ากว่าถูกทิ้ง ตารางเดิมค้างไว้ระหว่างรอ (ไม่กระพริบ)
  useEffect(() => {
    let cancelled = false;
    api
      .searchVehicles(applied)
      .then((data) => {
        if (cancelled) return;
        setError("");
        setResult(data);
        setRows(data.vehicles);
      })
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : "ค้นหาไม่สำเร็จ"))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
    // appliedKey แทน applied ทั้งก้อน - object ใหม่ที่เงื่อนไขเหมือนเดิมไม่ต้องค้นซ้ำ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedKey]);

  // พิมพ์ = แทนที่ URL เดิม (ย้อนกลับไม่ต้องไล่ทีละตัวอักษร) / กดปุ่มกรองสถานะหรือล้าง = เพิ่มประวัติ
  function apply(next: VehicleSearchParams, history: "push" | "replace" = "replace") {
    const qs = queryString(next);
    if (qs === appliedKey) return;
    lastWrittenQuery = qs.replace(/^\?/, "");
    router[history](`/vehicles${qs}`, { scroll: false });
    setSearching(true);
    setApplied(next);
  }

  // เงื่อนไขที่กำลังพิมพ์อยู่ในช่อง - null = วันที่ยังพิมพ์ไม่ครบหรือผิด (ยังไม่ค้น)
  function typed(): VehicleSearchParams | null {
    if (fromIso === null || toIso === null || dateError) return null;
    return { ...applied, q: searchText.trim(), from: fromIso, to: toIso };
  }

  useEffect(() => {
    const next = typed();
    if (!next) return;
    const timer = setTimeout(() => apply(next), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText, fromIso, toIso, dateError]);

  // Enter = ค้นทันทีไม่ต้องรอ
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = typed();
    if (next) apply(next);
  }

  function clearAll() {
    setSearchText("");
    setFromText("");
    setToText("");
    apply({}, "push");
  }

  async function loadMore() {
    setLoadingMore(true);
    setError("");
    try {
      const data = await api.searchVehicles(applied, rows.length);
      setRows((prev) => {
        const seen = new Set(prev.map((v) => v.id));
        return [...prev, ...data.vehicles.filter((v) => !seen.has(v.id))];
      });
      setResult(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดเพิ่มไม่สำเร็จ");
    } finally {
      setLoadingMore(false);
    }
  }

  const incompleteDate = fromIso === null || toIso === null;

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>ค้นหารถ</h1>
          <p>พิมพ์แล้วกรองให้ทันที เช่น พิมพ์ MLHKF5 จะเห็นทุกคันที่เลขตัวถังมี MLHKF5 พร้อมสถานะของแต่ละคัน</p>
        </div>
      </div>

      <section className="panel">
        <form className="vehicle-search-filter" onSubmit={handleSubmit}>
          <label className="field">
            ค้นหา
            <input
              type="search"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="เลขตัวถัง / เลขเครื่อง / ทะเบียน / ชื่อลูกค้า / ชื่อเจ้าของ"
              autoFocus
            />
          </label>
          <label className="field">
            วันที่ตั้งแต่
            <DateInput
              value={fromText}
              onChange={(value) => setFromText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
            />
          </label>
          <label className="field">
            ถึงวันที่
            <DateInput
              value={toText}
              onChange={(value) => setToText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
            />
          </label>
          <label className="field">
            ประเภทรถ
            <select value={applied.kind ?? ""} onChange={(e) => apply({ ...applied, kind: e.target.value }, "push")}>
              <option value="">ทั้งหมด</option>
              <option value="car">รถยนต์</option>
              <option value="moto">จักรยานยนต์</option>
            </select>
          </label>
          <div className="vehicle-list-filter-actions">
            {(filtered || applied.status || searchText || fromText || toText) && (
              <button className="text-button" type="button" onClick={clearAll}>
                ล้างทั้งหมด
              </button>
            )}
          </div>
        </form>
        {(dateError || (incompleteDate && (fromText.length === 10 || toText.length === 10))) && (
          <p className="customer-message error" style={{ padding: "0 24px 12px" }} role="alert">
            {dateError || "วันที่ไม่ถูกต้อง กรุณาตรวจ วว/ดด/ปปปป"}
          </p>
        )}

        <div className="status-chips" role="group" aria-label="กรองตามสถานะ">
          {STATUS_CHIPS.map(([status, label]) => {
            const count = result ? (status ? result.counts[status] : result.all) : null;
            const active = (applied.status ?? "") === status;
            if (status && status !== "problem" && count === 0 && !active) return null; // ซ่อนขั้นที่ไม่มีรถค้าง
            return (
              <button
                key={status || "all"}
                type="button"
                className={`status-chip${active ? " active" : ""}${status === "problem" && count ? " warn" : ""}`}
                aria-pressed={active}
                onClick={() => apply({ ...applied, status }, "push")}
              >
                {label}
                {count !== null && <span>{count.toLocaleString()}</span>}
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel customer-list">
        <div className="panel-head">
          <h2>ผลค้นหา</h2>
          {result && (
            <span className="sub" aria-live="polite">
              {searching
                ? "กำลังค้นหา…"
                : `${filtered || applied.status ? "ตรงเงื่อนไข" : "รถทั้งหมด"} ${result.total.toLocaleString()} คัน · แสดง ${rows.length.toLocaleString()} คัน · เรียงจากที่บันทึกล่าสุด`}
            </span>
          )}
        </div>
        {!result && searching ? (
          <div className="empty-customers">กำลังค้นหา…</div>
        ) : error && !rows.length ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : !rows.length ? (
          <div className="empty-customers">ไม่พบรถที่ตรงกับเงื่อนไข</div>
        ) : (
          <div className="table-wrap" style={{ opacity: searching ? 0.55 : 1, transition: "opacity .15s" }}>
            <table>
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง / เลขเครื่อง</th>
                  <th>ทะเบียน</th>
                  <th>ยี่ห้อ</th>
                  <th>สถานะ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td>{isoToDisplayDate(v.date)}</td>
                    <td>
                      <Highlight text={v.customerName} query={applied.q} />
                    </td>
                    <td>
                      <Highlight text={v.chassis} query={applied.q} />
                      {v.engine && (
                        <div className="sub">
                          <Highlight text={v.engine} query={applied.q} />
                        </div>
                      )}
                    </td>
                    <td>{v.plate ? <Highlight text={v.plate} query={applied.q} /> : "—"}</td>
                    <td>
                      {v.brandName}
                      <div className="sub">{v.kind === "moto" ? "จักรยานยนต์" : "รถยนต์"}</div>
                    </td>
                    <td>
                      <VehicleStatusCell row={v} roles={roles} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result && rows.length > 0 && (error || result.hasMore) && (
          <div className="vehicle-list-more">
            {error && (
              <p className="customer-message error" role="alert">
                {error}
              </p>
            )}
            {result.hasMore && (
              <button className="primary" type="button" onClick={loadMore} disabled={loadingMore || searching}>
                {loadingMore ? "กำลังโหลด…" : "โหลดเพิ่มอีก 100 คัน"}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ไฮไลต์ส่วนที่ตรงกับคำค้น (ไม่สนตัวพิมพ์เล็ก/ใหญ่) ให้เห็นว่าคันนี้ขึ้นมาเพราะอะไร
function Highlight({ text, query }: { text: string; query?: string }) {
  const q = query?.trim();
  if (!q) return <>{text}</>;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="search-hit">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}


// ทำอะไรไปแล้ว (ผู้ใช้ 2026-09-25): วันที่เริ่มรอขั้นนี้ (since) = วันที่ขั้นก่อนหน้าเสร็จ ตามกฎใน waitsFor()
// ของ backend/src/overview/overview-process.ts - แก้กฎที่นั่นต้องแก้ข้อความตรงนี้ด้วย
function doneText(s: VehicleStageStatus): string {
  const date = isoToDisplayDate(s.since);
  switch (s.stage) {
    case "transfer":
      return `รับงานเข้า ${date}`;
    case "inspectSend":
      if (s.flags.includes("INSPECTION_FAILED")) return `ตรวจไม่ผ่าน ${date}`;
      if (s.flags.includes("INSPECTION_EXPIRED")) return `ผลตรวจหมดอายุ ${date}`;
      return `แจ้งย้าย/ตัดบัญชีแล้ว ${date}`;
    case "inspectResult":
      return `ส่งตรวจรถแล้ว ${date}`;
    case "submit":
      return `ตรวจผ่านแล้ว ${date}`;
    case "receipt":
      return `ยื่นเอกสารแล้ว ${date}`;
    case "plate":
    case "book":
      return `ได้ใบเสร็จแล้ว ${date}`;
    case "delivery":
      return `ได้เล่มทะเบียนแล้ว ${date}`;
    case "plateDelivery":
      return `ส่งงานแล้ว ได้ป้ายตามมา ${date}`;
    case "billing":
      return `ส่งงานลูกค้าแล้ว ${date}`;
  }
}

// รถคันเดียวค้างได้หลายขั้นพร้อมกัน (เช่น รอป้าย + รอเล่ม ซึ่งเริ่มจากใบเสร็จใบเดียวกัน) - บรรทัด "ทำอะไรไปแล้ว"
// ที่ซ้ำกันแสดงครั้งเดียว - สีส้ม = เกินกำหนดหรือมีปัญหา
function VehicleStatusCell({ row, roles }: { row: VehicleSearchRow; roles: UserRole[] }) {
  if (!row.statuses.length) return <span className="badge done">จบงานแล้ว</span>;
  return (
    <div className="vehicle-statuses">
      {row.statuses.map((s, i) => {
        const warn = s.late || s.flags.length > 0;
        const label = STAGE_LABEL.get(s.stage) ?? s.label;
        const done = doneText(s);
        const sameAsPrevious = i > 0 && doneText(row.statuses[i - 1]) === done;
        // ไปหน้าที่มีรายการรถของขั้นนั้นพร้อมเลขตัวถัง - หน้าปลายทางเลื่อนไปที่รถคันนี้และไฮไลต์ให้ (lib/vehicle-focus.ts)
        // หน้ารับป้ายแยกแท็บรถยนต์/จักรยานยนต์ จึงบอกประเภทรถไปด้วย
        const page = stagePageFor(s.stage, s.href);
        const href = focusHref(page, row.chassis, s.stage === "plate" ? { kind: row.kind } : {});
        return (
          <div key={s.stage}>
            {!sameAsPrevious && <div className="status-done">{done}</div>}
            <span className={`badge${warn ? " warn" : ""}`}>
              → {label} · {s.days} วัน
            </span>
            {canAccessPage(page, roles) && (
              <Link className="text-button" href={href}>
                ไปที่งาน →
              </Link>
            )}
            {(s.reason || s.late) && (
              <div className="sub">{s.reason ?? `เกินกำหนด ${s.sla} วัน`}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
