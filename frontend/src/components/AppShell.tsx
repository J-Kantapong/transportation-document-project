"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { ChangePasswordDialog } from "./ChangePasswordDialog";
import { NEW_VEHICLE_SUBTASKS, REGISTRATION_CATEGORIES } from "@/lib/categories";
import {
  type AuthUser,
  type UserRole,
  cacheUser,
  canAccessPage,
  clearSession,
  displayName,
  getCachedUser,
  getToken,
  initials,
  PUBLIC_PATHS,
  ROLE_LABELS,
} from "@/lib/auth";
import { authApi } from "@/lib/auth-api";

function breadcrumbLabel(pathname: string): string {
  if (pathname === "/") return "ภาพรวม";
  if (pathname.startsWith("/customers")) return "ฐานข้อมูลลูกค้า";
  if (pathname.startsWith("/accounting/billing")) return "งานบัญชี / วางบิล";
  if (pathname.startsWith("/admin/users")) return "ผู้ดูแลระบบ / จัดการผู้ใช้";
  if (pathname.startsWith("/portal")) return "สถานะรถของคุณ";
  const subtask = NEW_VEHICLE_SUBTASKS.find((s) => pathname.startsWith(s.href));
  if (subtask) return `จดทะเบียนรถใหม่ / ${subtask.title}`;
  const category = REGISTRATION_CATEGORIES.find((c) => pathname.startsWith(c.href));
  return category?.title ?? "";
}

// เมนูแสดงตามบทบาท (สิทธิ์จริงอยู่ที่ backend + proxy.ts - ตรงนี้แค่ซ่อนเมนูที่ใช้ไม่ได้)
function NavLink({
  href,
  icon,
  label,
  pathname,
  exact,
  onClick,
}: {
  href: string;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  pathname: string;
  exact?: boolean;
  onClick: () => void;
}) {
  const active = exact ? pathname === href : pathname.startsWith(href);
  return (
    <Link href={href} className={`nav${active ? " active" : ""}`} onClick={onClick}>
      <Icon name={icon} />
      {label}
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    if (isPublic || !getToken()) return;
    // แสดงชื่อจาก cache ทันที แล้วดึงข้อมูลสดจาก backend (ถ้า token หมดอายุ request() พาไปหน้า login เอง)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUser(getCachedUser());
    authApi
      .me()
      .then(({ user }) => {
        cacheUser(user);
        setUser(user);
      })
      .catch(() => {});
  }, [isPublic]);

  if (isPublic) return <>{children}</>;

  const roles: UserRole[] = user?.roles ?? [];
  const has = (...wanted: UserRole[]) => wanted.some((r) => roles.includes(r));
  const isCustomer = has("CUSTOMER");
  const close = () => setOpen(false);
  // ระหว่างยังไม่รู้ roles (โหลดครั้งแรก) ให้แสดงเมนูว่างไว้ก่อน ไม่กะพริบเมนูที่ไม่มีสิทธิ์
  const known = user !== null;
  const blocked = known && !canAccessPage(pathname, roles);

  function logout() {
    clearSession();
    // full reload โดยตั้งใจ ให้ proxy.ts เห็นว่า cookie หายแล้วและล้าง state ทุกหน้า
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

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
        {known && isCustomer && (
          <>
            <div className="label">ลูกค้า</div>
            <NavLink href="/portal" icon="car" label="สถานะรถของคุณ" pathname={pathname} onClick={close} />
          </>
        )}
        {known && !isCustomer && (
          <>
            <div className="label">พื้นที่ทำงาน</div>
            {has("ADMIN", "ACCOUNTANT") && (
              <NavLink href="/" icon="grid" label="ภาพรวม" pathname={pathname} exact onClick={close} />
            )}
            {has("ADMIN", "STAFF_ENTRY", "STAFF_CAR", "STAFF_MOTO", "ACCOUNTANT") && (
              <NavLink href="/customers" icon="card" label="ฐานข้อมูลลูกค้า" pathname={pathname} onClick={close} />
            )}
            {has("ADMIN", "STAFF_ENTRY", "STAFF_CAR", "STAFF_MOTO", "ACCOUNTANT") && (
              <>
                <div className="label">ประเภทงานทะเบียน</div>
                {REGISTRATION_CATEGORIES.map((category) => (
                  <NavLink
                    key={category.href}
                    href={category.href}
                    icon={category.icon}
                    label={category.title}
                    pathname={pathname}
                    onClick={close}
                  />
                ))}
              </>
            )}
            {has("DELIVERY") && !has("ADMIN", "STAFF_CAR", "STAFF_MOTO") && (
              <>
                <div className="label">งานส่งของ</div>
                <NavLink href="/registration/new-vehicle/delivery" icon="move" label="Delivery" pathname={pathname} onClick={close} />
              </>
            )}
            {has("ADMIN", "ACCOUNTANT") && (
              <>
                <div className="label">งานบัญชี</div>
                <NavLink href="/accounting/billing" icon="stack" label="วางบิล" pathname={pathname} onClick={close} />
              </>
            )}
            {has("ADMIN") && (
              <>
                <div className="label">ผู้ดูแลระบบ</div>
                <NavLink href="/admin/users" icon="users" label="จัดการผู้ใช้" pathname={pathname} onClick={close} />
              </>
            )}
          </>
        )}
        <div className="aside-bottom">
          <div className="profile">
            <span className="avatar">{initials(user)}</span>
            <div style={{ minWidth: 0 }}>
              <div className="profile-name">{displayName(user) || "…"}</div>
              <div className="muted">{roles.map((r) => ROLE_LABELS[r]).join(" · ") || "กำลังโหลด"}</div>
            </div>
          </div>
          <div className="profile-actions">
            <button type="button" className="text-button" onClick={() => setPasswordOpen(true)}>
              เปลี่ยนรหัสผ่าน
            </button>
            <button type="button" className="text-button" onClick={logout}>
              ออกจากระบบ
            </button>
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
          {user?.customerName ? <span className="status-badge">{user.customerName}</span> : <span className="demo">ต้นแบบ UI</span>}
        </header>
        {blocked ? (
          <div className="content">
            <div className="empty-page">บัญชีของคุณไม่มีสิทธิ์ใช้งานหน้านี้</div>
          </div>
        ) : (
          children
        )}
      </main>
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
