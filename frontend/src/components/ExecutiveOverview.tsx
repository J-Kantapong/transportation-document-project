"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { overviewApi, type AgingBucket, type Overview, type OverviewAlert } from "@/lib/overview-api";
import { ChartLegend, GroupedBarChart, type ChartSeries } from "./OverviewCharts";
import { ProcessBoard, StuckList } from "./OverviewProcess";

// ภาพรวมผู้บริหาร (ADMIN) - ผู้ใช้ขอ 2026-09-24: สรุปใช้เงินรายวัน งานค้าง กระแสเงินสด ประมาณการ
// ข้อมูลทั้งหมดมาจาก GET /api/overview (คำนวณที่ backend) หน้านี้แค่จัดวางและวาดกราฟ

// สีชุดข้อมูล: เงินเข้า = น้ำเงิน, เงินออก = ส้ม ใช้คู่เดียวกันทุกกราฟในหน้านี้ (สีตามความหมาย ไม่ตามลำดับ)
const INFLOW = "#2a78d6";
const OUTFLOW = "#eb6834";
const CASH_SERIES: ChartSeries[] = [
  { name: "รับเงิน", color: INFLOW },
  { name: "ใช้เงิน", color: OUTFLOW },
];
const FORECAST_SERIES: ChartSeries[] = [
  { name: "เงินเข้า (คาด)", color: INFLOW },
  { name: "เงินออก (คาด)", color: OUTFLOW },
];
// ช่วงอายุลูกหนี้เรียงลำดับ -> น้ำเงินอ่อนไปเข้ม (ยิ่งค้างนานยิ่งเข้ม)
const AGING_RAMP = ["#86b6ef", "#3987e5", "#256abf", "#184f95"];

const baht = (n: number) => Math.round(n).toLocaleString("en-US");
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${baht(Math.abs(n))}`;
const shortDate = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function Change({ pct, suffix, invert }: { pct: number | null; suffix: string; invert?: boolean }) {
  if (pct === null) return <span className="exec-change">ไม่มีข้อมูลเทียบ{suffix}</span>;
  const up = pct > 0;
  // ใช้เงินเพิ่ม = สัญญาณให้ดู (invert) / รับเงินเพิ่ม = ดี
  const tone = pct === 0 ? "" : up !== !!invert ? " good" : " bad";
  return (
    <span className={`exec-change${tone}`}>
      {up ? "▲" : pct < 0 ? "▼" : "•"} {Math.abs(pct).toLocaleString("en-US", { maximumFractionDigits: 1 })}% {suffix}
    </span>
  );
}

const SEVERITY: Record<OverviewAlert["severity"], { label: string; icon: string }> = {
  high: { label: "ด่วน", icon: "!" },
  medium: { label: "ควรดู", icon: "•" },
  info: { label: "แจ้งให้ทราบ", icon: "i" },
};

function AgingBars({ buckets }: { buckets: AgingBucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.amount));
  return (
    <div className="exec-hbars">
      {buckets.map((b, i) => (
        <div className="exec-hbar" key={b.key} title={`${b.label}: ${baht(b.amount)} บาท (${b.count} รายการ)`}>
          <span className="exec-hbar-label">{b.label}</span>
          <span className="exec-hbar-track">
            {b.amount > 0 && <span className="exec-hbar-fill" style={{ width: `${(b.amount / max) * 100}%`, background: AGING_RAMP[i] }} />}
          </span>
          <span className="exec-hbar-value">
            {baht(b.amount)} <small>({b.count})</small>
          </span>
        </div>
      ))}
    </div>
  );
}

export function ExecutiveOverview() {
  const [date, setDate] = useState<string | null>(null); // null = วันนี้
  const [nonce, setNonce] = useState(0); // กดรีเฟรช = โหลดใหม่ด้วยวันที่เดิม
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [doneKey, setDoneKey] = useState(""); // คำขอล่าสุดที่โหลดเสร็จ (สำเร็จหรือไม่ก็ตาม)
  const key = `${date ?? "today"}|${nonce}`;
  const loading = doneKey !== key;

  useEffect(() => {
    let cancelled = false;
    overviewApi
      .get(date ?? undefined)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setError("");
      })
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e.message : "โหลดข้อมูลไม่สำเร็จ"))
      .finally(() => !cancelled && setDoneKey(key));
    return () => {
      cancelled = true;
    };
  }, [date, key]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  if (!data) {
    return (
      <div className="content">
        <div className="heading">
          <div>
            <h1>ภาพรวมผู้บริหาร</h1>
            <p>{error || "กำลังโหลดข้อมูล…"}</p>
          </div>
          {error && (
            <button type="button" className="primary" onClick={refresh}>
              ลองใหม่
            </button>
          )}
        </div>
      </div>
    );
  }

  const { spend, cash, workingCapital: wc, forecast, process, stuck, alerts } = data;
  const isToday = data.asOf === data.today;
  const dayWord = isToday ? "วันนี้" : `วันที่ ${isoToDisplayDate(data.asOf)}`;
  const updated = new Date(data.generatedAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
  const maxCategory = Math.max(1, ...spend.categories.map((c) => c.last30));
  const net30 = cash.net30;

  return (
    <div className="content exec">
      <div className="heading">
        <div>
          <h1>ภาพรวมผู้บริหาร</h1>
          <p>
            สรุปการใช้เงิน กระแสเงินสด งานค้าง และประมาณการ · อัปเดต {updated} น.{loading && " · กำลังโหลด…"}
          </p>
        </div>
        <div className="exec-date" role="group" aria-label="เลือกวันที่ของสรุปรายวัน">
          <button type="button" aria-label="วันก่อนหน้า" onClick={() => setDate(addDays(data.asOf, -1))}>
            ‹
          </button>
          <span>{isoToDisplayDate(data.asOf)}</span>
          <button type="button" aria-label="วันถัดไป" disabled={isToday} onClick={() => setDate(addDays(data.asOf, 1))}>
            ›
          </button>
          <button type="button" className="exec-date-today" disabled={loading} onClick={() => (isToday ? refresh() : setDate(null))}>
            {isToday ? "รีเฟรช" : "วันนี้"}
          </button>
        </div>
      </div>
      {error && <p className="customer-message error">{error}</p>}

      {/* ---------- ตัวเลขหลัก ---------- */}
      <section className="stats exec-kpis" aria-label="ตัวเลขหลัก">
        <div className="stat">
          <div className="stat-top">ใช้เงิน{dayWord}</div>
          <div className="num">
            {baht(spend.today.total)}
            <small>บาท</small>
          </div>
          <div className="foot">
            Bill {baht(spend.today.bill)} · No bill {baht(spend.today.noBill)}
            {spend.today.other > 0 && ` · อื่นๆ ${baht(spend.today.other)}`}
            <br />
            <Change pct={spend.changeVsYesterday} suffix="จากวันก่อน" invert />
          </div>
        </div>
        <div className="stat">
          <div className="stat-top">รับเงิน{dayWord}</div>
          <div className="num">
            {baht(cash.collectedToday)}
            <small>บาท</small>
          </div>
          <div className="foot">
            วางบิลใหม่ {baht(cash.billedToday)} บาท
            <br />
            เดือนนี้รับแล้ว {baht(cash.collectedMonth)} บาท
          </div>
        </div>
        <div className="stat">
          <div className="stat-top">เงินสุทธิ 30 วัน</div>
          <div className={`num ${net30 < 0 ? "exec-neg" : "exec-pos"}`}>
            {signed(net30)}
            <small>บาท</small>
          </div>
          <div className="foot">
            รับ {baht(cash.collected30)} − ใช้ {baht(spend.last30.total)}
            <br />
            <Change pct={spend.changeVs30} suffix="ใช้เงินเทียบ 30 วันก่อน" invert />
          </div>
        </div>
        <div className="stat">
          <div className="stat-top">เงินจมรอเรียกคืน</div>
          <div className="num">
            {baht(wc.total)}
            <small>บาท</small>
          </div>
          <div className="foot">
            ค้างรับจากบิล {baht(wc.receivable.amount)} บาท
            <br />
            {wc.avgDaysToPay === null ? "ยังไม่มีประวัติรับเงิน" : `ลูกค้าจ่ายเฉลี่ย ${wc.avgDaysToPay} วันหลังวางบิล`}
          </div>
        </div>
      </section>

      {/* ---------- เรื่องที่ต้องจัดการ ---------- */}
      <section className="panel exec-panel">
        <div className="panel-head">
          <h2>สิ่งที่ควรจัดการ</h2>
          <span className="muted">{alerts.length ? `${alerts.length} เรื่อง` : "ไม่มีเรื่องค้าง"}</span>
        </div>
        {alerts.length === 0 ? (
          <div className="exec-empty">ไม่มีเรื่องเร่งด่วนตอนนี้</div>
        ) : (
          <ul className="exec-alerts">
            {alerts.map((a) => (
              <li key={a.key} className={`exec-alert exec-alert--${a.severity}`}>
                <span className="exec-alert-chip">
                  <b aria-hidden="true">{SEVERITY[a.severity].icon}</b>
                  {SEVERITY[a.severity].label}
                </span>
                <div>
                  <strong>{a.title}</strong>
                  <div className="sub">{a.detail}</div>
                </div>
                <Link href={a.href} className="text-button">
                  ไปจัดการ →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- งานแต่ละขั้นตอน + รถที่ติดขัด (แยกรถยนต์/จักรยานยนต์) ---------- */}
      <ProcessBoard rows={process} dayWord={dayWord} />
      <StuckList total={stuck.total} byKind={stuck.byKind} items={stuck.items} />

      {/* ---------- กระแสเงินรายวัน ---------- */}
      <section className="panel exec-panel">
        <div className="panel-head">
          <div>
            <h2>เงินเข้า-ออกรายวัน 30 วัน</h2>
            <p className="exec-sub">
              ใช้ {baht(spend.last30.total)} · รับ {baht(cash.collected30)} · วางบิล {baht(cash.billed30)} บาท
            </p>
          </div>
          <ChartLegend series={CASH_SERIES} />
        </div>
        <div className="exec-chart">
          <GroupedBarChart
            ariaLabel="กราฟแท่งเงินรับและเงินใช้รายวัน 30 วันล่าสุด"
            series={CASH_SERIES}
            groups={cash.daily.map((d) => ({
              label: shortDate(d.date),
              values: [d.collected, d.spend],
              tip: (
                <>
                  <b>{isoToDisplayDate(d.date)}</b>
                  <div>
                    <i style={{ background: INFLOW }} />
                    รับเงิน <span>{baht(d.collected)}</span>
                  </div>
                  <div>
                    <i style={{ background: OUTFLOW }} />
                    ใช้เงิน <span>{baht(d.spend)}</span>
                  </div>
                  <div className="chart-tip-sub">
                    Bill {baht(d.bill)} · No bill {baht(d.noBill)}
                    {d.other > 0 && ` · แจ้งย้าย ${baht(d.other)}`}
                  </div>
                  <div className="chart-tip-sub">
                    วางบิล {baht(d.billed)} · ยื่นเอกสาร {d.submitted} คัน
                  </div>
                </>
              ),
            }))}
          />
          <details className="exec-table-toggle">
            <summary>ดูเป็นตาราง</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>วันที่</th>
                    <th className="num-col">ใช้เงิน</th>
                    <th className="num-col">Bill</th>
                    <th className="num-col">No bill</th>
                    <th className="num-col">รับเงิน</th>
                    <th className="num-col">วางบิล</th>
                    <th className="num-col">ยื่นเอกสาร (คัน)</th>
                  </tr>
                </thead>
                <tbody>
                  {[...cash.daily].reverse().map((d) => (
                    <tr key={d.date}>
                      <td>{isoToDisplayDate(d.date)}</td>
                      <td className="num-col">{baht(d.spend)}</td>
                      <td className="num-col">{baht(d.bill)}</td>
                      <td className="num-col">{baht(d.noBill)}</td>
                      <td className="num-col">{baht(d.collected)}</td>
                      <td className="num-col">{baht(d.billed)}</td>
                      <td className="num-col">{d.submitted}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>

      {/* ---------- ใช้เงินกับอะไร / เงินจมอยู่ที่ไหน ---------- */}
      <div className="exec-grid">
        <section className="panel">
          <div className="panel-head">
            <h2>ใช้เงินแยกตามประเภทงาน</h2>
            <span className="muted">30 วัน</span>
          </div>
          <div className="table-wrap">
            <table className="exec-table">
              <thead>
                <tr>
                  <th>ประเภทงาน</th>
                  <th className="num-col">{isToday ? "วันนี้" : isoToDisplayDate(data.asOf)}</th>
                  <th className="num-col">30 วัน</th>
                  <th aria-label="สัดส่วน" />
                </tr>
              </thead>
              <tbody>
                {spend.categories.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td className="num-col">{baht(c.today)}</td>
                    <td className="num-col">{baht(c.last30)}</td>
                    <td className="exec-bar-cell">
                      <span className="exec-hbar-track">
                        {c.last30 > 0 && <span className="exec-hbar-fill" style={{ width: `${(c.last30 / maxCategory) * 100}%`, background: OUTFLOW }} />}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>รวม</td>
                  <td className="num-col">{baht(spend.today.total)}</td>
                  <td className="num-col">{baht(spend.last30.total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>เงินจมอยู่ที่ไหน</h2>
            <span className="muted">รวม {baht(wc.total)} บาท</span>
          </div>
          <div className="exec-pipeline">
            <div>
              <span>จ่ายแล้ว ระหว่างดำเนินการ</span>
              <b>{baht(wc.inProcess.amount)}</b>
              <small>{wc.inProcess.count} คัน · ยังไม่ส่งงาน</small>
            </div>
            <div>
              <span>ส่งงานแล้ว รอวางบิล</span>
              <b>{baht(wc.unbilled.amount)}</b>
              <small>{wc.unbilled.count} คัน · ค่าใบเสร็จ ไม่รวมค่าบริการ</small>
            </div>
            <div>
              <span>วางบิลแล้ว รอรับเงิน</span>
              <b>{baht(wc.receivable.amount)}</b>
              <small>{wc.receivable.count} ใบ · รวม VAT/หัก ณ ที่จ่ายแล้ว</small>
            </div>
          </div>
          <div className="exec-block">
            <h3>อายุบิลค้างรับ</h3>
            <AgingBars buckets={wc.aging} />
          </div>
          {wc.topCustomers.length > 0 && (
            <div className="exec-block">
              <h3>ลูกค้าที่มียอดค้างมากสุด</h3>
              <table className="exec-table">
                <thead>
                  <tr>
                    <th>ลูกค้า</th>
                    <th className="num-col">รอวางบิล</th>
                    <th className="num-col">รอรับเงิน</th>
                  </tr>
                </thead>
                <tbody>
                  {wc.topCustomers.map((c) => (
                    <tr key={c.customerId}>
                      <td className="exec-wrap">{c.name}</td>
                      <td className="num-col">{baht(c.unbilled)}</td>
                      <td className="num-col">{baht(c.receivable)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {/* ---------- ประมาณการ ---------- */}
      <section className="panel exec-panel">
        <div className="panel-head">
          <div>
            <h2>ประมาณการกระแสเงินสด 4 สัปดาห์</h2>
            <p className="exec-sub">
              เงินเข้า = บิลค้างรับ + งานที่ส่งแล้วรอวางบิล ตามรอบจ่ายของลูกค้า · เงินออก = ค่าเฉลี่ยใช้เงิน 28 วันล่าสุด (
              {baht(forecast.avgDailySpend)} บาท/วัน)
            </p>
          </div>
          <ChartLegend series={FORECAST_SERIES} />
        </div>
        <div className="exec-chart">
          <GroupedBarChart
            height={210}
            ariaLabel="กราฟแท่งประมาณการเงินเข้าและเงินออก 4 สัปดาห์ข้างหน้า"
            series={FORECAST_SERIES}
            emptyText="ยังไม่มีข้อมูลพอสำหรับประมาณการ"
            groups={forecast.weeks.map((w, i) => ({
              label: i === 0 ? "สัปดาห์นี้" : `${shortDate(w.weekStart)}–${shortDate(w.weekEnd)}`,
              values: [w.inflow, w.outflow],
              tip: (
                <>
                  <b>
                    {isoToDisplayDate(w.weekStart)} – {isoToDisplayDate(w.weekEnd)}
                  </b>
                  <div>
                    <i style={{ background: INFLOW }} />
                    เงินเข้า <span>{baht(w.inflow)}</span>
                  </div>
                  <div>
                    <i style={{ background: OUTFLOW }} />
                    เงินออก <span>{baht(w.outflow)}</span>
                  </div>
                  <div className="chart-tip-sub">สุทธิ {signed(w.net)} · สะสม {signed(w.cumulativeNet)}</div>
                </>
              ),
            }))}
          />
          <div className="table-wrap">
            <table className="exec-table">
              <thead>
                <tr>
                  <th>สัปดาห์</th>
                  <th className="num-col">เงินเข้า (คาด)</th>
                  <th className="num-col">เงินออก (คาด)</th>
                  <th className="num-col">สุทธิ</th>
                  <th className="num-col">สะสม</th>
                </tr>
              </thead>
              <tbody>
                {forecast.weeks.map((w) => (
                  <tr key={w.weekStart}>
                    <td>
                      {isoToDisplayDate(w.weekStart)} – {isoToDisplayDate(w.weekEnd)}
                      {w.overdueInflow > 0 && <div className="sub">รวมบิลเลยกำหนด {baht(w.overdueInflow)} บาท ต้องตามทวง</div>}
                    </td>
                    <td className="num-col">{baht(w.inflow)}</td>
                    <td className="num-col">{baht(w.outflow)}</td>
                    <td className={`num-col ${w.net < 0 ? "exec-neg" : ""}`}>{signed(w.net)}</td>
                    <td className={`num-col ${w.cumulativeNet < 0 ? "exec-neg" : ""}`}>{signed(w.cumulativeNet)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="exec-note">
            {forecast.assumptions.payDaysFromHistory
              ? `ใช้รอบจ่ายจริงของลูกค้าจากบิลที่รับเงินแล้ว ${forecast.assumptions.paySamples} ใบ (เฉลี่ย ${forecast.assumptions.payDays} วัน)`
              : "ยังไม่มีประวัติรับเงิน ใช้สมมติฐานลูกค้าจ่ายภายใน 30 วันหลังวางบิล"}{" "}
            · วางบิลหลังส่งงาน {forecast.assumptions.billingLagDays} วัน
            {forecast.atRiskCount > 0 && (
              <>
                {" "}
                · <b className="exec-neg">ไม่นับบิลค้างเกิน 90 วัน {forecast.atRiskCount} ใบ ({baht(forecast.atRiskAmount)} บาท) ซึ่งเสี่ยงเก็บไม่ได้</b>
              </>
            )}
            {" "}· ระบบยังไม่มียอดเงินในบัญชีธนาคาร จึงแสดงเป็นกระแสสุทธิ ไม่ใช่ยอดคงเหลือ
          </p>
        </div>
      </section>
    </div>
  );
}
