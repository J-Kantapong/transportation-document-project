"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { ACTIVITY_GROUPS, activityApi, type ActivityDay, type ActivityGroup } from "@/lib/activity-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { DateInput } from "./DateInput";

// ภาพรวมการทำงาน (ผู้ใช้ 2026-10-08): วันนี้มีการเคลื่อนไหวอะไรบ้าง พร้อมราคา เพื่อกดเข้าไปตรวจ - ข้อมูลจาก GET /api/activity
// Bill / No bill / อากร แยกกัน (อากรไม่รวมในยอดรวม เหมือนหน้าอื่น)

const baht = (n: number | null) => (n === null ? "" : n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }));
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

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
        (!needle || [e.title, e.ref, e.customer, e.detail, e.actor].some((t) => t?.toLowerCase().includes(needle))),
    );
  }, [data, group, kind, q]);

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
  const groupCount = (g: ActivityGroup) => data.events.filter((e) => e.group === g).length;
  const t = data.totals;

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>ภาพรวมการทำงาน</h1>
          <p>
            {isToday ? "วันนี้" : `วันที่ ${isoToDisplayDate(data.date)}`} มีความเคลื่อนไหว {data.events.length} รายการ · กดชื่อรายการเพื่อเข้าไปตรวจ
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

      <section className="panel" style={{ display: "flex", flexWrap: "wrap", gap: "12px 32px" }}>
        <Stat label="ค่าใช้จ่าย (Bill + No bill)" value={t.spend} strong />
        <Stat label="Bill" value={t.bill} />
        <Stat label="No bill" value={t.noBill} />
        <Stat label="ค่าอากร (แยก ไม่รวม)" value={t.duty} />
        <Stat label="ออกบิล" value={t.invoiced} />
        <Stat label="รับเงิน" value={t.collected} />
      </section>

      <section className="panel">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <button type="button" className={group === "all" ? "primary" : ""} onClick={() => setGroup("all")}>
            ทั้งหมด ({data.events.length})
          </button>
          {ACTIVITY_GROUPS.map((g) => (
            <button key={g.key} type="button" className={group === g.key ? "primary" : ""} onClick={() => setGroup(g.key)}>
              {g.label} ({groupCount(g.key)})
            </button>
          ))}
          <span style={{ width: 1, alignSelf: "stretch", background: "currentColor", opacity: 0.2, margin: "0 4px" }} />
          {([
            ["all", "ทุกประเภทรถ"],
            ["car", `รถยนต์ (${data.kinds.car})`],
            ["moto", `มอเตอร์ไซค์ (${data.kinds.moto})`],
          ] as const).map(([key, label]) => (
            <button key={key} type="button" className={kind === key ? "primary" : ""} onClick={() => setKind(key)}>
              {label}
            </button>
          ))}
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ค้นหา เลขตัวถัง / ลูกค้า / ผู้ทำ"
            style={{ marginLeft: "auto", minWidth: 220 }}
          />
        </div>
        {rows.length === 0 ? (
          <p>ไม่มีรายการ</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>เวลา</th>
                  <th>รายการ</th>
                  <th>เลขตัวถัง / เลขที่</th>
                  <th>ประเภทรถ</th>
                  <th>ลูกค้า</th>
                  <th>รายละเอียด</th>
                  <th style={{ textAlign: "right" }}>Bill</th>
                  <th style={{ textAlign: "right" }}>No bill</th>
                  <th style={{ textAlign: "right" }}>อากร</th>
                  <th style={{ textAlign: "right" }}>ยอดเอกสาร</th>
                  <th>ผู้ทำ</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id} style={e.cancelled ? { opacity: 0.55, textDecoration: "line-through" } : undefined}>
                    <td>{e.timed ? timeOf(e.at) : "—"}</td>
                    <td>
                      <Link href={e.href}>{e.title}</Link>
                    </td>
                    <td>{e.ref}</td>
                    <td>{e.kind === "car" ? "รถยนต์" : e.kind === "moto" ? "มอเตอร์ไซค์" : ""}</td>
                    <td>{e.customer}</td>
                    <td>{e.detail}</td>
                    <td style={{ textAlign: "right" }}>{baht(e.bill)}</td>
                    <td style={{ textAlign: "right" }}>{baht(e.noBill)}</td>
                    <td style={{ textAlign: "right" }}>{baht(e.duty)}</td>
                    <td style={{ textAlign: "right" }}>{baht(e.amount)}</td>
                    <td>{e.actor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ marginTop: 8, fontSize: 13, opacity: 0.7 }}>
          เวลา “—” = ขั้นตอนที่ระบบเก็บแค่วันที่ (เช่น รับใบเสร็จ / ป้าย / เล่ม / รับเงิน) · ช่องผู้ทำว่าง = ระบบยังไม่ได้บันทึกว่าใครกด
        </p>
      </section>
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 13, opacity: 0.7 }}>{label}</div>
      <div style={{ fontSize: strong ? 26 : 20, fontWeight: strong ? 700 : 600 }}>{baht(value) || "0"}</div>
    </div>
  );
}
