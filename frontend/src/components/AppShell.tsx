"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { NEW_VEHICLE_SUBTASKS, REGISTRATION_CATEGORIES } from "@/lib/categories";

function breadcrumbLabel(pathname: string): string {
  if (pathname === "/") return "ภาพรวม";
  if (pathname.startsWith("/customers")) return "ฐานข้อมูลลูกค้า";
  if (pathname.startsWith("/accounting/billing")) return "งานบัญชี / วางบิล";
  const subtask = NEW_VEHICLE_SUBTASKS.find((s) => pathname.startsWith(s.href));
  if (subtask) return `จดทะเบียนรถใหม่ / ${subtask.title}`;
  const category = REGISTRATION_CATEGORIES.find((c) => pathname.startsWith(c.href));
  return category?.title ?? "";
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      <aside className={open ? "open" : undefined}>
        <div className="brand">
          <div className="mark">
            <Icon name="card" />
          </div>
          <div>
            <strong>
              ทะเบียน<span style={{ color: "#2854d9" }}>.</span>
            </strong>
            <small>TRANSPORT WORKSPACE</small>
          </div>
        </div>
        <div className="label">พื้นที่ทำงาน</div>
        <Link href="/" className={`nav${pathname === "/" ? " active" : ""}`} onClick={() => setOpen(false)}>
          <Icon name="grid" />
          ภาพรวม
        </Link>
        <Link
          href="/customers"
          className={`nav${pathname.startsWith("/customers") ? " active" : ""}`}
          onClick={() => setOpen(false)}
        >
          <Icon name="card" />
          ฐานข้อมูลลูกค้า
        </Link>
        <div className="label">ประเภทงานทะเบียน</div>
        {REGISTRATION_CATEGORIES.map((category) => (
          <Link
            key={category.href}
            href={category.href}
            className={`nav${pathname.startsWith(category.href) ? " active" : ""}`}
            onClick={() => setOpen(false)}
          >
            <Icon name={category.icon} />
            {category.title}
          </Link>
        ))}
        <div className="label">งานบัญชี</div>
        <Link
          href="/accounting/billing"
          className={`nav${pathname.startsWith("/accounting/billing") ? " active" : ""}`}
          onClick={() => setOpen(false)}
        >
          <Icon name="stack" />
          วางบิล
        </Link>
        <div className="aside-bottom">
          <div className="profile">
            <span className="avatar">พน</span>
            <div>
              พนักงานบริษัท
              <div className="muted">พื้นที่ทำงานตัวอย่าง</div>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="screen-title">
            <button className="mobile-menu" aria-label="เปิดเมนู" onClick={() => setOpen((v) => !v)}>
              ☰
            </button>
            <div className="breadcrumb">
              พื้นที่ทำงาน &nbsp;/&nbsp; <b>{breadcrumbLabel(pathname)}</b>
            </div>
          </div>
          <span className="demo">ต้นแบบ UI</span>
        </header>
        {children}
      </main>
    </>
  );
}
