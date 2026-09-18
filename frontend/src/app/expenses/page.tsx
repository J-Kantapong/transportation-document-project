"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/Icon";
import {
  api,
  ApiError,
  type DailyExpenseRule,
  type DailyExpenseSummary,
  type DailyExpenseTotal,
  type ExpenseCategory,
} from "@/lib/api";
import type { CSSVarStyle } from "@/lib/css-vars";
import { addDaysIso, displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { formatBaht } from "@/lib/money";

const CATEGORY_COLORS: Record<ExpenseCategory, { color: string; bg: string }> = {
  DAILY_RULE: { color: "#bd8a2c", bg: "#fff6e5" },
  TRANSFER_NOTICE: { color: "#2854d9", bg: "#edf2ff" },
  INSPECTION: { color: "#228d91", bg: "#eaf7f7" },
  INSPECTION_ROUND2: { color: "#7560c7", bg: "#f2eeff" },
  YAMAHA_RELOCATION: { color: "#bd8131", bg: "#fff5e8" },
};

// จำนวนวันย้อนหลังในแผง "ยอดรายวันย้อนหลัง" (รวมวันที่เลือก)
const HISTORY_DAYS = 7;

const THAI_WEEKDAYS = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];

function weekday(iso: string): string {
  return THAI_WEEKDAYS[new Date(`${iso}T00:00:00.000Z`).getUTCDay()];
}

export default function DailyExpensesPage() {
  const [date, setDate] = useState(() => todayIso());
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const typedIso = useMemo(() => displayDateToIso(dateText.replace(/\D/g, "")), [dateText]);

  const [summary, setSummary] = useState<DailyExpenseSummary | null>(null);
  const [history, setHistory] = useState<DailyExpenseTotal[]>([]);
  const [rules, setRules] = useState<DailyExpenseRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const isToday = date === todayIso();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const [daily, totals] = await Promise.all([
          api.getDailyExpenses(date),
          api.listDailyExpenseTotals(addDaysIso(date, -(HISTORY_DAYS - 1)), date),
        ]);
        if (cancelled) return;
        setSummary(daily);
        setHistory([...totals.days].reverse());
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "โหลดข้อมูลค่าใช้จ่ายไม่สำเร็จ");
        setSummary(null);
        setHistory([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    api
      .listDailyExpenseRules()
      .then((data) => setRules(data.rules))
      .catch(() => setRules([]));
  }, []);

  function goTo(iso: string) {
    setDate(iso);
    setDateText(isoToDisplayDate(iso));
  }

  function handleDateTextChange(raw: string) {
    const text = formatDateDigits(raw.replace(/\D/g, "").slice(0, 8));
    setDateText(text);
    const iso = displayDateToIso(text.replace(/\D/g, ""));
    if (iso) setDate(iso);
  }

  const maxHistoryTotal = Math.max(1, ...history.map((d) => d.total));

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>ค่าใช้จ่ายรายวัน</h1>
          <p>สรุปค่าใช้จ่ายทุกขั้นตอนที่บันทึกไว้ในแต่ละวัน รวมค่าใช้จ่ายตามเงื่อนไข</p>
        </div>
        <div className="expense-date-controls">
          <button className="expense-step" aria-label="วันก่อนหน้า" onClick={() => goTo(addDaysIso(date, -1))}>
            ‹
          </button>
          <input
            type="text"
            inputMode="numeric"
            aria-label="วันที่"
            placeholder="วว/ดด/ปปปป"
            value={dateText}
            onChange={(e) => handleDateTextChange(e.target.value)}
            aria-invalid={dateText.length === 10 && !typedIso}
          />
          <button className="expense-step" aria-label="วันถัดไป" onClick={() => goTo(addDaysIso(date, 1))}>
            ›
          </button>
          <button className="text-button" disabled={isToday} onClick={() => goTo(todayIso())}>
            วันนี้
          </button>
        </div>
      </div>

      {error && (
        <div className="expense-alert expense-alert--error" role="alert">
          {error}
        </div>
      )}

      <section className="stats expense-stats" aria-label="สรุปค่าใช้จ่าย">
        <div className="stat expense-total">
          <div className="stat-top">
            {isToday ? "ใช้จ่ายวันนี้" : `ใช้จ่ายวันที่ ${isoToDisplayDate(date)}`}
            <span className="icon" style={{ "--c": "#2854d9", "--bg": "#edf2ff" } as CSSVarStyle}>
              <Icon name="wallet" />
            </span>
          </div>
          <div className="num">
            {loading ? "…" : formatBaht(summary?.total ?? 0)}
            <small>บาท</small>
          </div>
          <div className="foot">{loading ? "กำลังโหลด" : `${summary?.count ?? 0} รายการ`}</div>
        </div>
        {!loading &&
          summary?.categories.map((c) => (
            <div className="stat" key={c.category}>
              <div className="stat-top">
                {c.label}
                <span className="expense-dot" style={{ "--c": CATEGORY_COLORS[c.category].color } as CSSVarStyle} />
              </div>
              <div className="num">
                {formatBaht(c.total)}
                <small>บาท</small>
              </div>
              <div className="foot">{c.count} รายการ</div>
            </div>
          ))}
      </section>

      <div className="lower">
        <section className="panel">
          <div className="panel-head">
            <h2>รายการค่าใช้จ่าย</h2>
            <span className="muted">{isoToDisplayDate(date)}</span>
          </div>
          {loading ? (
            <div className="empty-customers">กำลังโหลดรายการ…</div>
          ) : !summary?.items.length ? (
            <div className="empty-customers">ไม่มีค่าใช้จ่ายในวันนี้</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>หมวด</th>
                    <th>รายการ</th>
                    <th>รายละเอียด</th>
                    <th className="expense-amount">จำนวนเงิน (บาท)</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <span
                          className="expense-chip"
                          style={
                            {
                              "--c": CATEGORY_COLORS[item.category].color,
                              "--bg": CATEGORY_COLORS[item.category].bg,
                            } as CSSVarStyle
                          }
                        >
                          {item.categoryLabel}
                        </span>
                      </td>
                      <td>{item.label}</td>
                      <td className="muted">{item.detail}</td>
                      <td className="expense-amount">{formatBaht(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>
                      <strong>รวม</strong>
                    </td>
                    <td className="expense-amount">
                      <strong>{formatBaht(summary.total)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>

        <div className="expense-side">
          <section className="panel">
            <div className="panel-head">
              <h2>ย้อนหลัง {HISTORY_DAYS} วัน</h2>
            </div>
            <div className="expense-history">
              {history.map((day) => (
                <button
                  key={day.date}
                  className={`expense-day${day.date === date ? " active" : ""}`}
                  onClick={() => goTo(day.date)}
                >
                  <span className="expense-day-label">
                    {weekday(day.date)} {isoToDisplayDate(day.date).slice(0, 5)}
                  </span>
                  <span className="expense-day-track">
                    <span className="expense-day-fill" style={{ width: `${(day.total / maxHistoryTotal) * 100}%` }} />
                  </span>
                  <b>{formatBaht(day.total)}</b>
                </button>
              ))}
              {!loading && !history.length && <div className="muted">ไม่มีข้อมูล</div>}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>เงื่อนไขค่าใช้จ่าย</h2>
            </div>
            <div className="expense-rules">
              {!rules.length && <div className="muted">ยังไม่มีเงื่อนไข</div>}
              {rules.map((rule) => (
                <div className={`expense-rule${rule.active ? "" : " inactive"}`} key={rule.id}>
                  <div className="expense-rule-head">
                    <strong>{rule.label}</strong>
                    <b>{formatBaht(Number(rule.amount))} บาท/วัน</b>
                  </div>
                  <div className="muted">{rule.triggerLabel}</div>
                  <div className="muted">
                    {/* seed ใช้ 2000-01-01 แทน "ใช้กับข้อมูลทั้งหมด" */}
                    {rule.active && rule.effectiveFrom <= "2000-01-01"
                      ? "ใช้กับข้อมูลทั้งหมด (รวมย้อนหลัง)"
                      : `${rule.active ? "ใช้ตั้งแต่" : "ปิดใช้ตั้งแต่"} ${isoToDisplayDate(rule.effectiveFrom)}`}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
