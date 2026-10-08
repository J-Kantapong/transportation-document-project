"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { isoToDisplayDate } from "@/lib/date";
import type { AlertDoc, ProcessRow, SplitValue, StuckItem, VehicleKind } from "@/lib/overview-api";
import { focusHref, workPageFor } from "@/lib/vehicle-focus";

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
  const dutyTotal = { car: 0, moto: 0 };
  for (const r of rows) {
    if (r.duty) {
      dutyTotal.car += r.duty.car ?? 0;
      dutyTotal.moto += r.duty.moto ?? 0;
    }
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
            {/* ค่าอากรแยกบรรทัด ไม่รวมในค่าใช้จ่ายด้านบน (ผู้ใช้ 2026-10-05) */}
            <tr className="muted">
              <td>ค่าอากร (แยก ไม่รวมในยอด)</td>
              <td colSpan={2} />
              <td className="num-col">{baht(dutyTotal.car)}</td>
              <td className="num-col proc-split-end">{baht(dutyTotal.moto)}</td>
              <td colSpan={5} />
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

type KindFilter = "all" | VehicleKind;

// "ไปจัดการ" พาไปหน้าที่มีรถคันนั้นจริงพร้อม ?focus= แบบเดียวกับหน้าค้นหารถ (พบ 2026-09-27: เดิมไปหน้าเมนู/หน้าเลือกประเภทรถ)
// ต่อภาษีไม่แสดงเลขตัวถังในตาราง จึงเปิดหน้าอย่างเดียว
export function stuckHref(s: StuckItem): string {
  // งานอื่นที่รอลงส่งงาน: หน้า Delivery กางใบของงานนั้นจากเลขตัวถังได้เหมือนรถจดใหม่
  if (s.stage === "jobDelivery") return focusHref(s.href, s.chassis);
  if (s.source !== "vehicle" && s.source !== "plateSwap") return s.href; // ต่อภาษีและงานอื่นๆ: href จาก backend (งานอื่นๆ พาไปหน้ารับใบเสร็จ/รับป้ายตรงๆ)
  return focusHref(workPageFor(s.stage, s.kind, s.flags, s.href), s.chassis);
}

// ตารางรายคัน ใช้ร่วมกันทั้ง "รถที่ติดขัด" (หนึ่งคันหนึ่งแถว มีช่องความเร่งด่วน) และรายคันของ "สิ่งที่ควรจัดการ" แต่ละเรื่อง
function StuckTable({ items, linkLabel, showSeverity }: { items: StuckItem[]; linkLabel: string; showSeverity?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="exec-table stuck-table">
        <thead>
          <tr>
            {showSeverity && <th>ความเร่งด่วน</th>}
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
          {items.map((s) => (
            <tr key={`${s.source}-${s.id}-${s.stage}`}>
              {showSeverity && (
                <td>
                  <span className={`exec-alert-chip exec-alert-chip--${s.severity}`}>
                    <b aria-hidden="true">{s.severity === "high" ? "!" : "•"}</b>
                    {s.severity === "high" ? "ด่วน" : "ควรดู"}
                  </span>
                </td>
              )}
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
                <Link href={stuckHref(s)} className="text-button">
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

// รายใบของเรื่องที่ไม่ใช่รถติดขัด (บิล ใบกำกับที่รอ 50 ทวิ ใบเสนอราคา ใบเสร็จที่ยอดไม่ตรง) - ลิงก์ของแต่ละใบมาจาก backend
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function DocTable({ docs }: { docs: AlertDoc[] }) {
  return (
    <div className="table-wrap">
      <table className="exec-table stuck-table">
        <thead>
          <tr>
            <th>รายการ</th>
            <th>ลูกค้า</th>
            <th className="num-col">ยอด (บาท)</th>
            <th>วันที่</th>
            <th>หมายเหตุ</th>
            <th aria-label="ลิงก์" />
          </tr>
        </thead>
        <tbody>
          {docs.map((doc) => (
            <tr key={doc.id}>
              <td className="job">{doc.title}</td>
              <td className="exec-wrap">{doc.customerName}</td>
              <td className="num-col">{doc.amount === null ? "–" : money(doc.amount)}</td>
              <td>{doc.date ? `${doc.dateLabel} ${isoToDisplayDate(doc.date)}` : "–"}</td>
              <td className="stuck-reason">{doc.note}</td>
              <td>
                <Link href={doc.href} className="text-button">
                  ไปที่รายการนี้ →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// รายคันของ "สิ่งที่ควรจัดการ" หนึ่งเรื่อง (ผู้ใช้ 2026-10-09: กดแล้วไปถึงคันที่มีปัญหา ไม่ต้องไปหาเองในหน้าคิว)
// คันเดียวอยู่ได้หลายเรื่อง (เช่น ยังไม่วางบิล + ป้ายยังไม่ส่งตาม) แต่ละเรื่องจึงลิงก์ไปหน้าของขั้นนั้นเอง
export function AlertItems({ items, docs, total, queueHref }: { items: StuckItem[]; docs: AlertDoc[]; total: number; queueHref: string }) {
  const shown = items.length + docs.length;
  return (
    <div className="exec-alert-items">
      {items.length > 0 && <StuckTable items={items} linkLabel="ไปที่คันนี้ →" />}
      {docs.length > 0 && <DocTable docs={docs} />}
      <p className="exec-note">
        {total > shown && `แสดง ${shown} รายการแรก จากทั้งหมด ${total} รายการ · `}
        <Link href={queueHref} className="text-button">
          เปิดหน้าคิวทั้งหมด →
        </Link>
      </p>
    </div>
  );
}

export function StuckList({
  total,
  byKind,
  limit,
  items,
}: {
  total: number;
  byKind: { car: number; moto: number };
  limit: number;
  items: StuckItem[];
}) {
  const [filter, setFilter] = useState<KindFilter>("all");
  // items มาไม่เกิน limit คันต่อประเภทรถ เรียงตามความด่วน - "ทั้งหมด" แสดง limit คันแรก (พบ 2026-09-27)
  const shown = filter === "all" ? items.slice(0, limit) : items.filter((i) => i.kind === filter);
  const count = filter === "all" ? total : byKind[filter];
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
        <StuckTable items={shown} linkLabel="ไปจัดการ →" showSeverity />
      )}
      {count > shown.length && (
        <p className="exec-note stuck-more">
          แสดง {shown.length} คันที่เร่งด่วนที่สุด จากทั้งหมด {count} คัน{filter === "all" ? "" : `ในกลุ่ม${KIND_LABEL[filter]}`}
        </p>
      )}
    </section>
  );
}
