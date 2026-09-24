"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { isoToDisplayDate } from "@/lib/date";
import type { ProcessRow, SplitValue, StuckItem, VehicleKind } from "@/lib/overview-api";

// ภาพรวมผู้บริหาร - งานแต่ละขั้นตอน + คันที่ติดขัด แยกรถยนต์/จักรยานยนต์ (ผู้ใช้ขอ 2026-09-24)

const KIND_LABEL: Record<VehicleKind, string> = { car: "รถยนต์", moto: "จักรยานยนต์" };
const baht = (n: number) => Math.round(n).toLocaleString("en-US");

function Cell({ value, money }: { value: number | null; money?: boolean }) {
  if (value === null) return <td className="num-col proc-na">–</td>;
  return <td className={`num-col${value === 0 ? " proc-zero" : " proc-val"}`}>{money ? baht(value) : value}</td>;
}

function SplitCells({ value, money }: { value: SplitValue | null; money?: boolean }) {
  if (value === null) {
    return (
      <>
        <td className="num-col proc-na">–</td>
        <td className="num-col proc-na proc-split-end">–</td>
      </>
    );
  }
  if (value.unsplit !== undefined) {
    return (
      <td colSpan={2} className={`num-col proc-split-end${value.unsplit === 0 ? " proc-zero" : " proc-val"}`}>
        {money ? baht(value.unsplit) : value.unsplit} <small className="muted">(ไม่แยกประเภท)</small>
      </td>
    );
  }
  return (
    <>
      <Cell value={value.car} money={money} />
      {/* เส้นแบ่งกลุ่มคอลัมน์อยู่หลังช่องจักรยานยนต์ */}
      <td className={`num-col proc-split-end${value.moto === null ? " proc-na" : value.moto === 0 ? " proc-zero" : " proc-val"}`}>
        {value.moto === null ? "–" : money ? baht(value.moto) : value.moto}
      </td>
    </>
  );
}

const GROUPS: Array<{ key: ProcessRow["group"]; label: string }> = [
  { key: "new", label: "จดทะเบียนรถใหม่" },
  { key: "other", label: "งานอื่น" },
];

export function ProcessBoard({ rows, dayWord }: { rows: ProcessRow[]; dayWord: string }) {
  const spendTotal = { car: 0, moto: 0, unsplit: 0 };
  for (const r of rows) {
    if (!r.spend) continue;
    spendTotal.car += r.spend.car ?? 0;
    spendTotal.moto += r.spend.moto ?? 0;
    spendTotal.unsplit += r.spend.unsplit ?? 0;
  }

  return (
    <section className="panel exec-panel">
      <div className="panel-head">
        <div>
          <h2>งานแต่ละขั้นตอน</h2>
          <p className="exec-sub">ทำไปและค่าใช้จ่ายของ{dayWord} · งานค้างเป็นข้อมูล ณ ตอนนี้</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="exec-table proc-table">
          <thead>
            <tr>
              <th rowSpan={2}>ขั้นตอน</th>
              <th colSpan={2} className="proc-group-head">
                ทำไป{dayWord} (คัน)
              </th>
              <th colSpan={2} className="proc-group-head">
                ค่าใช้จ่าย (บาท)
              </th>
              <th colSpan={2} className="proc-group-head">
                ค้างอยู่ (คัน)
              </th>
              <th rowSpan={2} className="num-col">
                ค้างนานสุด
              </th>
              <th rowSpan={2}>เกินกำหนด</th>
              <th rowSpan={2} aria-label="ลิงก์" />
            </tr>
            <tr>
              {[0, 1, 2].map((i) => (
                <Fragment key={i}>
                  <th className="num-col">รถยนต์</th>
                  <th className="num-col proc-split-end">จยย.</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => (
              <Fragment key={g.key}>
                <tr className="proc-group-row">
                  <td colSpan={10}>{g.label}</td>
                </tr>
                {rows
                  .filter((r) => r.group === g.key)
                  .map((r) => (
                    <tr key={r.key}>
                      <td>
                        {r.label}
                        {r.doneNote && <div className="sub">{r.doneNote}</div>}
                      </td>
                      <SplitCells value={r.done} />
                      <SplitCells value={r.spend} money />
                      <SplitCells value={r.pending} />
                      <td className="num-col">{r.oldestDays === null ? "–" : `${r.oldestDays} วัน`}</td>
                      <td>
                        {r.lateCount > 0 ? (
                          <span className="badge warn">
                            ⚠ {r.lateCount} คัน (เกิน {r.sla} วัน)
                          </span>
                        ) : r.pending && (r.pending.car || r.pending.moto) ? (
                          <span className="badge done">✓ ตามกำหนด</span>
                        ) : (
                          <span className="muted">–</span>
                        )}
                      </td>
                      <td>
                        <Link href={r.href} className="text-button">
                          เปิด →
                        </Link>
                      </td>
                    </tr>
                  ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>ค่าใช้จ่ายรวม</td>
              <td colSpan={2} />
              <td className="num-col">{baht(spendTotal.car)}</td>
              <td className="num-col proc-split-end">{baht(spendTotal.moto)}</td>
              <td colSpan={5} className="muted">
                {spendTotal.unsplit > 0 && `+ ไม่แยกประเภท ${baht(spendTotal.unsplit)} บาท`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

type KindFilter = "all" | VehicleKind;

export function StuckList({ total, byKind, items }: { total: number; byKind: { car: number; moto: number }; items: StuckItem[] }) {
  const [filter, setFilter] = useState<KindFilter>("all");
  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const chips: Array<{ key: KindFilter; label: string; count: number }> = [
    { key: "all", label: "ทั้งหมด", count: total },
    { key: "car", label: "รถยนต์", count: byKind.car },
    { key: "moto", label: "จักรยานยนต์", count: byKind.moto },
  ];

  return (
    <section className="panel exec-panel">
      <div className="panel-head">
        <div>
          <h2>รถที่ติดขัด</h2>
          <p className="exec-sub">ค้างเกินกำหนดของขั้นนั้น หรือมีปัญหาที่ต้องจัดการ (ตรวจไม่ผ่าน ยื่นไม่สำเร็จ ผลตรวจใกล้หมดอายุ ฯลฯ)</p>
        </div>
      </div>
      <div className="inspect-filter">
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`filter-chip${filter === c.key ? " selected" : ""}`}
            aria-pressed={filter === c.key}
            onClick={() => setFilter(c.key)}
          >
            {c.label} ({c.count})
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <div className="exec-empty">✓ ไม่มีรถติดขัด{filter === "all" ? "" : `ในกลุ่ม${KIND_LABEL[filter]}`}</div>
      ) : (
        <div className="table-wrap">
          <table className="exec-table stuck-table">
            <thead>
              <tr>
                <th>ความเร่งด่วน</th>
                <th>ประเภท</th>
                <th>รถ</th>
                <th>ลูกค้า</th>
                <th>ติดที่ขั้น</th>
                <th className="num-col">ค้างมา</th>
                <th>สาเหตุ</th>
                <th aria-label="ลิงก์" />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={`${s.source}-${s.id}`}>
                  <td>
                    <span className={`exec-alert-chip exec-alert-chip--${s.severity}`}>
                      <b aria-hidden="true">{s.severity === "high" ? "!" : "•"}</b>
                      {s.severity === "high" ? "ด่วน" : "ควรดู"}
                    </span>
                  </td>
                  <td>
                    <span className={`kind-badge kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                  </td>
                  <td>
                    <div className="job">{[s.brandName, s.plate].filter(Boolean).join(" · ") || "-"}</div>
                    <div className="sub">{s.chassis}</div>
                  </td>
                  <td className="exec-wrap">{s.customerName}</td>
                  <td>{s.stageLabel}</td>
                  <td className="num-col">
                    {s.days} วัน
                    {s.overdueDays > 0 && <div className="sub exec-neg">เกิน {s.overdueDays} วัน</div>}
                    <div className="sub">ตั้งแต่ {isoToDisplayDate(s.since)}</div>
                  </td>
                  <td className="stuck-reason">{s.reason}</td>
                  <td>
                    <Link href={s.href} className="text-button">
                      ไปจัดการ →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {total > items.length && (
        <p className="exec-note stuck-more">
          แสดง {items.length} คันที่เร่งด่วนที่สุด จากทั้งหมด {total} คัน
        </p>
      )}
    </section>
  );
}
