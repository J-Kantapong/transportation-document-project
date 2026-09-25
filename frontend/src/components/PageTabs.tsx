"use client";

import Link from "next/link";

// แท็บแบบขีดเส้นใต้ที่แต่ละแท็บเป็น URL ของตัวเอง (ผู้ใช้ 2026-09-25): กดย้อนกลับได้ ส่งลิงก์ต่อได้ และหน้าอื่นลิงก์
// ตรงมาที่แท็บได้ - ใช้แทนปุ่มสลับ state ในหน้าเดียว (สไตล์เดิม .vehicle-tabs / .vehicle-tab)
export interface PageTab {
  href: string;
  label: string;
  selected: boolean;
}

export function PageTabs({ tabs, label, style }: { tabs: PageTab[]; label: string; style?: React.CSSProperties }) {
  return (
    <nav className="vehicle-tabs" aria-label={label} style={style}>
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          replace={false}
          scroll={false}
          className={`vehicle-tab${tab.selected ? " selected" : ""}`}
          aria-current={tab.selected ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
