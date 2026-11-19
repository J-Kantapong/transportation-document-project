"use client";

import type { ReactNode } from "react";

// รายการแนะนำระหว่างพิมพ์ (ใช้คู่กับ useTypeAhead ใน lib/use-type-ahead.ts) - หน้าตาเดียวกับรายการค้นรถของหน้าต่อภาษี
export interface Suggestion {
  key: string;
  title: ReactNode;
  sub?: ReactNode;
  tag?: string; // ป้ายเล็กด้านขวา เช่น "รถเก่าในระบบ" / "รถจดใหม่"
}

export function SuggestionList({
  items,
  searching,
  onPick,
  emptyText = "ไม่พบข้อมูลที่ตรงกับที่พิมพ์",
  showEmpty = true,
}: {
  items: Suggestion[];
  searching: boolean;
  onPick: (key: string) => void;
  emptyText?: string;
  showEmpty?: boolean; // false = ไม่พบก็ไม่ต้องแสดงกล่อง (ช่องที่พิมพ์ข้อมูลใหม่ได้ตามปกติ)
}) {
  if (!searching && items.length === 0 && !showEmpty) return null;
  return (
    <div className="suggestion-list" role="listbox" style={{ marginTop: 6, border: "1px solid #e3e8f1", borderRadius: 8, overflow: "hidden", background: "white" }}>
      {searching && (
        <div className="sub" style={{ padding: "10px 14px" }}>
          กำลังค้นหา…
        </div>
      )}
      {!searching && items.length === 0 && (
        <div className="sub" style={{ padding: "10px 14px" }}>
          {emptyText}
        </div>
      )}
      {!searching &&
        items.map((item) => (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={false}
            onClick={() => onPick(item.key)}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 10,
              width: "100%",
              textAlign: "left",
              border: 0,
              borderBottom: "1px solid #f0f2f6",
              background: "white",
              padding: "10px 14px",
              font: "inherit",
              cursor: "pointer",
            }}
          >
            <span>
              <span className="job" style={{ display: "block" }}>
                {item.title}
              </span>
              {item.sub && <span className="sub">{item.sub}</span>}
            </span>
            {item.tag && (
              <span className="sub" style={{ whiteSpace: "nowrap" }}>
                {item.tag}
              </span>
            )}
          </button>
        ))}
    </div>
  );
}
