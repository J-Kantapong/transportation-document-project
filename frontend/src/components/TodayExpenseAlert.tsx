"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { api, type DailyExpenseSummary } from "@/lib/api";
import { todayIso } from "@/lib/date";
import { formatBaht } from "@/lib/money";

// แถบแจ้งเตือนค่าใช้จ่ายวันนี้บนหน้าภาพรวม - กดเพื่อไปดูรายละเอียดที่หน้า ค่าใช้จ่ายรายวัน
export function TodayExpenseAlert() {
  const [summary, setSummary] = useState<DailyExpenseSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .getDailyExpenses(todayIso())
      .then(setSummary)
      .catch(() => setFailed(true));
  }, []);

  if (failed) return null;

  return (
    <Link href="/expenses" className="expense-alert">
      <span className="icon" aria-hidden="true">
        <Icon name="wallet" />
      </span>
      <span className="expense-alert-text">
        {summary ? (
          <>
            วันนี้ใช้จ่ายไปแล้ว <b>{formatBaht(summary.total)} บาท</b>
            <span className="muted">
              {" "}
              · {summary.count} รายการ
              {summary.categories.length > 0 && ` (${summary.categories.map((c) => c.label).join(", ")})`}
            </span>
          </>
        ) : (
          "กำลังโหลดค่าใช้จ่ายวันนี้…"
        )}
      </span>
      <span className="expense-alert-link">ดูรายละเอียด ↗</span>
    </Link>
  );
}
