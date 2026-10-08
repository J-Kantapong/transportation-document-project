"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { ACTIVITY_GROUPS, ACTIVITY_TYPES, activityApi, type ActivityDay, type ActivityGroup } from "@/lib/activity-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { DateInput } from "./DateInput";

// ภาพรวมการทำงาน (ผู้ใช้ 2026-10-08): วันนี้มีการเคลื่อนไหวอะไรบ้าง พร้อมราคา เพื่อกดเข้าไปตรวจ - ข้อมูลจาก GET /api/activity
// Bill / No bill / อากร แยกกัน (อากรไม่รวมในยอดรวม เหมือนหน้าอื่น) สไตล์อยู่ท้าย app/globals.css (คลาส act-*)

const baht = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
const GROUP_LABEL = Object.fromEntries(ACTIVITY_GROUPS.map((g) => [g.key, g.label])) as Record<ActivityGroup, string>;

function Money({ value }: { value: number | null }) {
  if (value === null) return <span className="act-zero">–</span>;
  return value === 0 ? <span className="act-zero">0</span> : <>{baht(value)}</>;
}

export function ActivityPage() {
  const [date, setDate] = useState<string | null>(null); // null = วันนี้
  const [dateText, setDateText] = useState<string | null>(null);
  const [data, setData] = useState<ActivityDay | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [doneKey, setDoneKey] = useState(""); // คำขอล่าสุดที่โหลดเสร็จ (สำเร็จหรือไม่ก็ตาม)
  const key = `${date ?? "today"}|${nonce}`;
  const loading = doneKey !== key;
  const [group, setGroup] = useState<ActivityGroup | "all">("all");
  const [kind, setKind] = useState<"all" | "car" | "moto">("all");
  const [type, setType] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    activityApi
      .day(date ?? undefined)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError("");
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "โหลดข้อมูลไม่สำเร็จ"))
      .finally(() => !cancelled && setDoneKey(key));
    return () => {
      cancelled = true;
    };
  }, [date, key]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.events.filter(
      (e) =>
        (group === "all" || e.group === group) &&
        (kind === "all" || e.kind === kind) &&
        (!type || e.type === type) &&
        (!needle || [e.title, e.ref, e.customer, e.detail, e.actor].some((t) => t?.toLowerCase().includes(needle))),
    );
  }, [data, group, kind, type, q]);

  if (!data) {
    return (
      <div className="content">
        <div className="heading">
          <div>
            <h1>ภาพรวมการทำงาน</h1>
            <p>{error || "กำลังโหลดข้อมูล…"}</p>
          </div>
          {error && (
            <button type="button" className="primary" onClick={() => setNonce((n) => n + 1)}>
              ลองใหม่
            </button>
          )}
        </div>
      </div>
    );
  }

  const isToday = data.date === data.today;
  const t = data.totals;
  const groupCount = (g: ActivityGroup) => data.events.filter((e) => e.group === g).length;
  const stepChips = ACTIVITY_TYPES.filter((s) => data.counts[s.type]);
  const dayWord = isToday ? "วันนี้" : `วันที่ ${isoToDisplayDate(data.date)}`;

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>ภาพรวมการทำงาน</h1>
          <p>
            {dayWord} ทีมทำงานไป {data.events.length} รายการ · กดชื่อรายการเพื่อเข้าไปตรวจ
            {loading && " · กำลังโหลด…"}
          </p>
        </div>
        <div className="exec-date" role="group" aria-label="เลือกวันที่">
          <button type="button" aria-label="วันก่อนหน้า" onClick={() => setDate(data.prev)}>
            ‹
          </button>
          <DateInput
            key={data.date}
            aria-label="วันที่"
            style={{ width: 110 }}
            value={dateText ?? isoToDisplayDate(data.date)}
            onChange={(v) => {
              const text = formatDateDigitsCe(v.replace(/\D/g, ""));
              setDateText(text);
              const iso = displayDateToIso(text.replace(/\D/g, ""));
              if (iso && iso !== data.date && iso <= data.today) {
                setDateText(null);
                setDate(iso);
              }
            }}
            onBlur={() => setDateText(null)}
          />
          <button type="button" aria-label="วันถัดไป" disabled={!data.next} onClick={() => data.next && setDate(data.next)}>
            ›
          </button>
          <button type="button" className="exec-date-today" disabled={loading} onClick={() => (isToday ? setNonce((n) => n + 1) : setDate(null))}>
            {isToday ? "รีเฟรช" : "วันนี้"}
          </button>
        </div>
      </div>
      {error && <p className="customer-message error">{error}</p>}

      <div className="act-kpis">
        <div className="act-kpi main">
          <div className="act-kpi-label">ค่าใช้จ่ายของวัน (Bill + No bill)</div>
          <div className="act-kpi-value">{baht(t.spend)}</div>
          <div className="act-kpi-sub">
            <span>
              Bill <b>{baht(t.bill)}</b>
            </span>
            <span>
              No bill <b>{baht(t.noBill)}</b>
            </span>
          </div>
        </div>
        <div className="act-kpi">
          <div className="act-kpi-label">ค่าอากร (แยก ไม่รวมในยอด)</div>
          <div className="act-kpi-value">{baht(t.duty)}</div>
        </div>
        <div className="act-kpi">
          <div className="act-kpi-label">ออกบิลวางบิล</div>
          <div className="act-kpi-value">{baht(t.invoiced)}</div>
        </div>
        <div className="act-kpi">
          <div className="act-kpi-label">รับเงินเข้า</div>
          <div className="act-kpi-value">{baht(t.collected)}</div>
        </div>
      </div>

      {stepChips.length > 0 && (
        <div className="act-steps" aria-label="ขั้นตอนที่ทำวันนี้ กดเพื่อกรอง">
          {stepChips.map((s) => (
            <button
              key={s.type}
              type="button"
              className={`act-step g-${s.group}${type === s.type ? " active" : ""}`}
              onClick={() => setType(type === s.type ? null : s.type)}
            >
              {s.label} <b>{data.counts[s.type]}</b>
            </button>
          ))}
        </div>
      )}

      <section className="panel">
        <div className="act-bar">
          <div className="act-seg" role="group" aria-label="กรองตามกลุ่มงาน">
            <button type="button" className={group === "all" ? "on" : ""} onClick={() => setGroup("all")}>
              ทั้งหมด<span>{data.events.length}</span>
            </button>
            {ACTIVITY_GROUPS.map((g) => (
              <button key={g.key} type="button" className={group === g.key ? "on" : ""} onClick={() => setGroup(g.key)}>
                {g.label}
                <span>{groupCount(g.key)}</span>
              </button>
            ))}
          </div>
          <div className="act-seg" role="group" aria-label="กรองตามประเภทรถ">
            <button type="button" className={kind === "all" ? "on" : ""} onClick={() => setKind("all")}>
              ทุกประเภทรถ
            </button>
            <button type="button" className={kind === "car" ? "on" : ""} onClick={() => setKind("car")}>
              รถยนต์<span>{data.kinds.car}</span>
            </button>
            <button type="button" className={kind === "moto" ? "on" : ""} onClick={() => setKind("moto")}>
              มอเตอร์ไซค์<span>{data.kinds.moto}</span>
            </button>
          </div>
          <input
            className="act-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหา เลขตัวถัง / ลูกค้า / ผู้ทำ"
          />
        </div>

        {rows.length === 0 ? (
          <div className="act-empty">
            <strong>ไม่มีรายการ</strong>
            {data.events.length === 0 ? `${dayWord}ยังไม่มีความเคลื่อนไหวในระบบ` : "ลองเปลี่ยนตัวกรองหรือคำค้นหา"}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="act-table">
              <thead>
                <tr>
                  <th>เวลา</th>
                  <th>รายการ</th>
                  <th>เลขตัวถัง / เลขที่</th>
                  <th>ประเภทรถ</th>
                  <th>ลูกค้า</th>
                  <th className="num-col">Bill</th>
                  <th className="num-col">No bill</th>
                  <th className="num-col">อากร</th>
                  <th className="num-col">ยอดเอกสาร</th>
                  <th>ผู้ทำ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const hasMoney = e.bill !== null || e.noBill !== null || e.duty !== null;
                  return (
                    <tr key={e.id} className={e.cancelled ? "act-row-cancelled" : undefined}>
                      <td>
                        <span className={`act-time g-${e.group}${e.timed ? "" : " untimed"}`} title={e.timed ? undefined : "ระบบเก็บเฉพาะวันที่ ไม่มีเวลา"}>
                          <i />
                          {e.timed ? timeOf(e.at) : "ทั้งวัน"}
                        </span>
                      </td>
                      <td>
                        <Link href={e.href} className={`act-type g-${e.group}`} title={GROUP_LABEL[e.group]}>
                          {e.title}
                        </Link>
                        {e.detail && <span className="act-sub">{e.detail}</span>}
                      </td>
                      <td>
                        <span className="act-ref">{e.ref ?? ""}</span>
                      </td>
                      <td>{e.kind && <span className={`act-kind ${e.kind}`}>{e.kind === "car" ? "รถยนต์" : "มอเตอร์ไซค์"}</span>}</td>
                      <td>{e.customer}</td>
                      <td className="num-col">{hasMoney && <Money value={e.bill} />}</td>
                      <td className="num-col">{hasMoney && <Money value={e.noBill} />}</td>
                      <td className="num-col">{hasMoney && <Money value={e.duty} />}</td>
                      <td className="num-col">{e.amount !== null && <Money value={e.amount} />}</td>
                      <td>
                        {e.actor && (
                          <span className="act-actor">
                            <i>{e.actor.slice(0, 1).toUpperCase()}</i>
                            {e.actor}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="act-note">
          “ทั้งวัน” = ขั้นตอนที่ระบบเก็บเฉพาะวันที่ ไม่มีเวลา · รับใบเสร็จ / ป้าย / เล่ม แสดงเวลาจริงเมื่อรูปถูกอัปโหลดในวันนั้น · ช่องผู้ทำว่าง = ระบบยังไม่ได้บันทึกว่าใครกด · บิลที่ยกเลิกแล้วแสดงจางๆ และไม่นับในยอด
        </p>
      </section>
    </div>
  );
}
