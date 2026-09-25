"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { FocusVehicleRow } from "./FocusVehicleRow";
import { ChangePasswordDialog } from "./ChangePasswordDialog";import {
  type RegistrationSubtask,
  NEW_VEHICLE_SUBTASKS,
  PLATE_SWAP_SUBTASKS,
  REGISTRATION_CATEGORIES,
  YAMAHA_RELOCATION_SUBTASKS,
} from "@/lib/categories";
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

interface Crumb {
  label: string;
  href?: string; // ไม่มี href = หัวข้อที่ไม่มีหน้าของตัวเอง (เช่น งานบัญชี)
}

const SUBTASKS_BY_CATEGORY: Record<string, RegistrationSubtask[]> = {
  "/registration/new-vehicle": NEW_VEHICLE_SUBTASKS,
  "/registration/plate-swap": PLATE_SWAP_SUBTASKS,
  "/registration/yamaha-relocation": YAMAHA_RELOCATION_SUBTASKS,
};

// หน้าย่อยใต้ขั้นตอนที่ควรขึ้นใน breadcrumb ด้วย (รับใบเสร็จ/ป้าย/เล่มแยกหน้ารถยนต์/มอเตอร์ไซค์ ผู้ใช้ 2026-09-25/26)
const DETAIL_CRUMBS: Record<string, string> = {
  "/registration/new-vehicle/receive-receipt/car": "รถยนต์",
  "/registration/new-vehicle/receive-receipt/moto": "มอเตอร์ไซค์",
  "/registration/new-vehicle/receive-plate/car": "รถยนต์",
  "/registration/new-vehicle/receive-plate/moto": "มอเตอร์ไซค์",
  "/registration/new-vehicle/receive-book/car": "รถยนต์",
  "/registration/new-vehicle/receive-book/moto": "มอเตอร์ไซค์",
};

function within(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function breadcrumbs(pathname: string): Crumb[] {
  if (pathname === "/") return [{ label: "ภาพรวม", href: "/" }];
  if (within(pathname, "/customers")) return [{ label: "ฐานข้อมูลลูกค้า", href: "/customers" }];
  if (within(pathname, "/vehicles")) return [{ label: "ค้นหารถ", href: "/vehicles" }];
  if (within(pathname, "/accounting/billing")) return [{ label: "งานบัญชี" }, { label: "วางบิล", href: "/accounting/billing" }];
  if (within(pathname, "/admin/users")) return [{ label: "ผู้ดูแลระบบ" }, { label: "จัดการผู้ใช้", href: "/admin/users" }];
  if (within(pathname, "/portal")) return [{ label: "สถานะรถของคุณ", href: "/portal" }];
  const category = REGISTRATION_CATEGORIES.find((c) => within(pathname, c.href));
  if (!category) return [];
  const crumbs: Crumb[] = [{ label: category.title, href: category.href }];
  const subtask = SUBTASKS_BY_CATEGORY[category.href]?.find((s) => within(pathname, s.href));
  if (subtask) crumbs.push({ label: subtask.title, href: subtask.href });
  const detail = Object.entries(DETAIL_CRUMBS).find(([href]) => within(pathname, href));
  if (detail) crumbs.push({ label: detail[1], href: detail[0] });
  return crumbs;
}

// ทุกส่วนของ breadcrumb กดได้ (ผู้ใช้ 2026-09-24) ยกเว้นหน้าที่อยู่ตอนนี้ และหน้าที่บทบาทนี้เปิดไม่ได้
function Breadcrumb({ pathname, roles, home }: { pathname: string; roles: UserRole[]; home: string | null }) {
  const crumbs = breadcrumbs(pathname);
  const linkable = (href?: string): href is string => !!href && href !== pathname && canAccessPage(href, roles);
  return (
    <nav className="breadcrumb" aria-label="ตำแหน่งหน้า">
      {home && home !== pathname ? <Link href={home}>พื้นที่ทำงาน</Link> : "พื้นที่ทำงาน"}
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1;
        const text = last ? <b>{c.label}</b> : c.label;
        return (
          <span key={c.label}>
            &nbsp;/&nbsp; {linkable(c.href) ? <Link href={c.href}>{text}</Link> : text}
          </span>
        );
      })}
    </nav>
  );
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
  // "พื้นที่ทำงาน" พาไปหน้าแรกของบทบาทนั้น - พนักงานที่ไม่มีหน้า / ให้เป็นข้อความเฉยๆ
  const home = !known ? null : canAccessPage("/", roles) ? "/" : isCustomer ? "/portal" : null;

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
              <>
                <NavLink href="/customers" icon="card" label="ฐานข้อมูลลูกค้า" pathname={pathname} onClick={close} />
                <NavLink href="/vehicles" icon="search" label="ค้นหารถ" pathname={pathname} onClick={close} />
              </>
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
            <Breadcrumb pathname={pathname} roles={roles} home={home} />
          </div>
          {/* มุมขวาบน (ผู้ใช้ 2026-09-23): ลูกค้าเห็นชื่อบริษัทที่ผูกไว้ ไม่มีบริษัท (พนักงาน) เห็นชื่อ-นามสกุลของตัวเอง
              คนละป้ายกัน - ชื่อบริษัทเป็นป้ายสีน้ำเงิน (status-badge) ส่วนชื่อผู้ใช้เป็นป้ายสีเทา (user-badge) */}
          {user &&
            (user.customerName ? (
              <span className="status-badge">{user.customerName}</span>
            ) : (
              <span className="user-badge">{user.name}</span>
            ))}
        </header>
        {blocked ? (
          <div className="content">
            <div className="empty-page">บัญชีของคุณไม่มีสิทธิ์ใช้งานหน้านี้</div>
          </div>
        ) : (
          <>
            {children}
            <FocusVehicleRow />
          </>
        )}
      </main>
      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </>
  );
}
