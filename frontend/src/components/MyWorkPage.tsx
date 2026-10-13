"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { ROLE_LABELS, type UserRole } from "@/lib/auth";
import { isoToDisplayDate } from "@/lib/date";
import { myWorkApi, type MyWork, type Severity, type VehicleKind, type WorkCheck, type WorkRow } from "@/lib/my-work-api";

// งานของฉัน (ผู้ใช้ 2026-10-13 "ภาพรวมให้พนักงานแต่ละ Role ในการจัดการเอกสารที่ติดขัด"): ข้อมูลทั้งหมดมาจาก GET /api/my-work
// ซึ่งกรองขั้น/ประเภทรถตามบทบาทแล้ว หน้านี้แค่จัดวาง - 3 ส่วน: ต้องจัดการก่อน (ค้างเกินกำหนด/มีปัญหา) · ตรวจก่อนผิด (ตัวช่วยที่สร้าง
// จากข้อผิดพลาดที่เกิดซ้ำ พร้อมบทเรียน) · คิวของฉัน (ค้างรายขั้น) ทุกแถวมีลิงก์ไปถึงรถ/ใบนั้น สไตล์ mw-* ท้าย app/globals.css

const KIND_LABEL: Record<VehicleKind, string> = { car: "รถยนต์", moto: "จักรยานยนต์" };
const SEVERITY: Record<Severity, { label: string; icon: string }> = {
  high: { label: "ด่วน", icon: "!" },
  medium: { label: "ควรดู", icon: "•" },
  info: { label: "แจ้งให้ทราบ", icon: "i" },
};
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function SeverityChip({ severity }: { severity: Severity }) {
  return (
    <span className={`exec-alert--${severity}`}>
      <span className="exec-alert-chip">
        <b aria-hidden="true">{SEVERITY[severity].icon}</b>
        {SEVERITY[severity].label}
      </span>
    </span>
  );
}

// ตารางเดียวใช้ทุกส่วน: รถ / งาน / ใบ (บิล ใบกำกับ ใบเสนอราคา) ต่างกันแค่ช่องเลขตัวถังและยอด
function WorkTable({ rows, linkLabel }: { rows: WorkRow[]; linkLabel: string }) {
  const showAmount = rows.some((r) => r.amount !== null);
  const showKind = rows.some((r) => r.kind !== null);
  return (
    <div className="table-wrap">
      <table className="exec-table stuck-table">
        <thead>
          <tr>
            <th>ความเร่งด่วน</th>
            {showKind && <th>ประเภท</th>}
            <th>รายการ</th>
            <th>ลูกค้า</th>
            <th>ขั้น</th>
            <th className="num-col">ค้างมา</th>
            <th>สาเหตุ / สิ่งที่ต้องทำ</th>
            {showAmount && <th className="num-col">ยอด (บาท)</th>}
            <th aria-label="ลิงก์" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <SeverityChip severity={r.severity} />
              </td>
              {showKind && <td>{r.kind && <span className={`kind-badge kind-${r.kind}`}>{KIND_LABEL[r.kind]}</span>}</td>}
              <td>
                <div className="job">{r.title}</div>
                {r.chassis && r.chassis !== r.title && <div className="sub">{r.chassis}</div>}
              </td>
              <td className="exec-wrap">{r.customerName}</td>
              <td>{r.stageLabel}</td>
              <td className="num-col">
                {r.days !== null ? `${r.days} วัน` : "–"}
                {r.overdueDays > 0 && <div className="sub exec-neg">เกิน {r.overdueDays} วัน</div>}
                {r.since && <div className="sub">ตั้งแต่ {isoToDisplayDate(r.since)}</div>}
              </td>
              <td className="stuck-reason">{r.reason}</td>
              {showAmount && <td className="num-col">{r.amount === null ? "–" : money(r.amount)}</td>}
              <td>
                <Link href={r.href} className="text-button">
                  {linkLabel}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckBlock({ check }: { check: WorkCheck }) {
  const [open, setOpen] = useState(check.severity === "high");
  return (
    <div className={`mw-check mw-check--${check.severity}`}>
      <button type="button" className="mw-check-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <SeverityChip severity={check.severity} />
        <span className="mw-check-title">
          {check.title} <b>{check.total}</b>
        </span>
        <span className="mw-check-toggle">{open ? "ซ่อน ▴" : "ดูรายการ ▾"}</span>
      </button>
      <p className="mw-lesson">
        <span>บทเรียน:</span> {check.lesson}
      </p>
      {open && (
        <>
          <WorkTable rows={check.items} linkLabel="ไปตรวจ →" />
          {check.total > check.items.length && <p className="exec-note mw-more">แสดง {check.items.length} รายการแรก จากทั้งหมด {check.total} รายการ</p>}
        </>
      )}
    </div>
  );
}

type KindFilter = "all" | VehicleKind;

export function MyWorkPage() {
  const [data, setData] = useState<MyWork | null>(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [doneNonce, setDoneNonce] = useState(-1); // คำขอล่าสุดที่โหลดเสร็จ (สำเร็จหรือไม่ก็ตาม)
  const loading = doneNonce !== nonce;
  const [kind, setKind] = useState<KindFilter>("all");
  const [stage, setStage] = useState<string>("all");
  const load = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    myWorkApi
      .get()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError("");
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "โหลดข้อมูลไม่สำเร็จ"))
      .finally(() => !cancelled && setDoneNonce(nonce));
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  useEffect(() => {
    // กลับมาที่แท็บนี้หลังไปจัดการ = โหลดใหม่ ให้รายการที่แก้แล้วหายไป (เหมือนหน้าคิวอื่น)
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const bothKinds = useMemo(() => !!data && new Set(data.problems.map((p) => p.kind).filter(Boolean)).size > 1, [data]);
  const stageOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, number>();
    for (const p of data.problems) seen.set(p.stageLabel, (seen.get(p.stageLabel) ?? 0) + 1);
    return [...seen.entries()];
  }, [data]);
  const shown = useMemo(
    () => (data ? data.problems.filter((p) => (kind === "all" || p.kind === kind) && (stage === "all" || p.stageLabel === stage)) : []),
    [data, kind, stage],
  );

  if (!data) {
    return (
      <div className="content">
        <div className="heading">
          <div>
            <h1>งานของฉัน</h1>
            <p>{error || "กำลังโหลดข้อมูล…"}</p>
          </div>
          {error && (
            <button type="button" className="primary" onClick={load}>
              ลองใหม่
            </button>
          )}
        </div>
      </div>
    );
  }

  const roleText = data.roles.map((r) => ROLE_LABELS[r as UserRole] ?? r).join(" · ");
  const kindCount = (k: VehicleKind) => data.problems.filter((p) => p.kind === k).length;

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>งานของฉัน</h1>
          <p>
            {roleText} · ข้อมูล ณ วันที่ {isoToDisplayDate(data.today)}
            {loading && " · กำลังโหลด…"}
            {error && <span className="exec-neg"> · {error}</span>}
          </p>
        </div>
        <button type="button" className="secondary" onClick={load} disabled={loading}>
          โหลดใหม่
        </button>
      </div>

      <div className="mw-kpis">
        <a href="#mw-problems" className={`mw-kpi${data.summary.high ? " mw-kpi--high" : ""}`}>
          <span className="mw-kpi-label">ต้องจัดการก่อน</span>
          <span className="mw-kpi-value">{data.summary.problems}</span>
          <span className="mw-kpi-sub">{data.summary.high ? `ด่วน ${data.summary.high} รายการ` : "ไม่มีรายการด่วน"}</span>
        </a>
        <a href="#mw-checks" className="mw-kpi">
          <span className="mw-kpi-label">ตรวจก่อนผิด</span>
          <span className="mw-kpi-value">{data.summary.checks}</span>
          <span className="mw-kpi-sub">{data.checks.length ? `${data.checks.length} เรื่องที่ควรตรวจ` : "ไม่มีเรื่องให้ตรวจ"}</span>
        </a>
        <a href="#mw-stages" className="mw-kpi">
          <span className="mw-kpi-label">งานค้างทั้งหมด</span>
          <span className="mw-kpi-value">{data.summary.pending}</span>
          <span className="mw-kpi-sub">{data.stages.filter((s) => s.pending.car + s.pending.moto > 0).length} ขั้นที่มีงานค้าง</span>
        </a>
      </div>

      <section className="panel exec-panel" id="mw-problems">
        <div className="panel-head">
          <div>
            <h2>ต้องจัดการก่อน</h2>
            <p className="exec-sub">ค้างเกินกำหนดของขั้นนั้น หรือมีปัญหา (ตรวจไม่ผ่าน ยื่นไม่สำเร็จ ผลตรวจใกล้หมดอายุ ฯลฯ) เฉพาะขั้นที่คุณรับผิดชอบ - เรียงจากด่วนที่สุด</p>
          </div>
        </div>
        {data.problems.length > 0 && (
          <div className="inspect-filter">
            {bothKinds &&
              (["all", "car", "moto"] as KindFilter[]).map((k) => (
                <button key={k} type="button" className={`filter-chip${kind === k ? " selected" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === "all" ? "ทุกประเภท" : KIND_LABEL[k]} ({k === "all" ? data.problems.length : kindCount(k)})
                </button>
              ))}
            {stageOptions.length > 1 && (
              <select className="mw-stage-select" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="กรองตามขั้น">
                <option value="all">ทุกขั้น</option>
                {stageOptions.map(([label, n]) => (
                  <option key={label} value={label}>
                    {label} ({n})
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {shown.length === 0 ? (
          <div className="exec-empty">✓ ไม่มีรายการที่ต้องจัดการ{data.problems.length ? "ตามตัวกรองนี้" : ""}</div>
        ) : (
          <WorkTable rows={shown} linkLabel="ไปจัดการ →" />
        )}
        {data.problemTotal > data.problems.length && <p className="exec-note stuck-more">แสดง {data.problems.length} รายการที่เร่งด่วนที่สุด จากทั้งหมด {data.problemTotal} รายการ</p>}
      </section>

      <section className="panel exec-panel" id="mw-checks">
        <div className="panel-head">
          <div>
            <h2>ตรวจก่อนผิด</h2>
            <p className="exec-sub">ตัวช่วยที่สร้างจากข้อผิดพลาดที่เคยเกิดซ้ำ (วันที่ผิด ข้อมูลรถผิด ใบเสร็จไม่ตรง) - ยังไม่ใช่ความผิดพลาดแน่นอน แต่ควรเทียบกับเอกสารก่อนไปขั้นต่อไป</p>
          </div>
        </div>
        {data.checks.length === 0 ? <div className="exec-empty">✓ ไม่มีเรื่องให้ตรวจ</div> : <div className="mw-checks">{data.checks.map((c) => <CheckBlock key={c.key} check={c} />)}</div>}
      </section>

      <section className="panel exec-panel" id="mw-stages">
        <div className="panel-head">
          <div>
            <h2>คิวของฉัน</h2>
            <p className="exec-sub">งานค้างแต่ละขั้นที่คุณรับผิดชอบ (รวมที่ยังไม่เกินกำหนด) - กำหนดเวลาของแต่ละขั้นเป็นค่าตั้งต้นของระบบ</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="exec-table">
            <thead>
              <tr>
                <th>ขั้น</th>
                <th className="num-col">ค้าง</th>
                <th className="num-col">รถยนต์</th>
                <th className="num-col">จักรยานยนต์</th>
                <th className="num-col">นานสุด</th>
                <th className="num-col">เกินกำหนด</th>
                <th aria-label="ลิงก์" />
              </tr>
            </thead>
            <tbody>
              {data.stages.map((s) => {
                const total = s.pending.car + s.pending.moto;
                return (
                  <tr key={s.key} className={total === 0 ? "mw-row-empty" : undefined}>
                    <td>{s.label}</td>
                    <td className="num-col">{total || "–"}</td>
                    <td className="num-col">{s.kinds.includes("car") ? s.pending.car : "–"}</td>
                    <td className="num-col">{s.kinds.includes("moto") ? s.pending.moto : "–"}</td>
                    <td className="num-col">{s.oldestDays === null ? "–" : `${s.oldestDays} วัน`}</td>
                    <td className={`num-col${s.lateCount ? " exec-neg" : ""}`}>{s.lateCount ? `${s.lateCount} (เกิน ${s.sla} วัน)` : "–"}</td>
                    <td>
                      <Link href={s.href} className="text-button">
                        เปิดหน้าคิว →
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
