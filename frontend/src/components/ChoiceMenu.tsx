"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";

export interface Choice {
  title: string;
  href: string;
  // ใช้ตรวจสิทธิ์แทน href (เช่น หน้าประเภทรถที่ไม่มีกฎของตัวเอง ให้ดูสิทธิ์ของงานย่อยข้างใน)
  accessHrefs?: string[];
}

// roles = null ระหว่างที่ยังไม่ได้อ่านจาก localStorage
export function useCachedRoles(): UserRole[] | null {
  const [roles, setRoles] = useState<UserRole[] | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);
  return roles;
}

export function visibleChoices(choices: Choice[], roles: UserRole[] | null): Choice[] {
  if (roles === null) return choices;
  return choices.filter((c) => (c.accessHrefs ?? [c.href]).some((href) => canAccessPage(href, roles)));
}

// หน้าเมนูที่เหลือตัวเลือกเดียว (เช่น STAFF_CAR เห็นแค่รถยนต์) ไม่มีอะไรให้เลือก - ข้ามไปหน้าถัดไปเลย
// ใช้ replace ไม่ใช่ push เพื่อให้ปุ่ม back ของเบราว์เซอร์ไม่วนกลับมาหน้าเมนูที่ถูกข้าม
// ปุ่ม "← กลับ" ในหน้าลูกลิงก์มาด้วย ?menu=1 (MENU_STAY) เพื่อไม่ให้ถูกดีดกลับไปหน้าลูกอีก
export const MENU_STAY = "?menu=1";

export function useSkipSingleChoice(choices: Choice[], roles: UserRole[] | null) {
  const router = useRouter();
  const only = roles !== null && choices.length === 1 ? choices[0].href : null;
  const [stay, setStay] = useState<boolean | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน query หลัง mount (ไม่ใช้ useSearchParams จะได้ไม่ต้องมี Suspense)
    setStay(new URLSearchParams(window.location.search).has("menu"));
  }, []);
  const skip = only !== null && stay === false;
  useEffect(() => {
    if (skip && only) router.replace(only);
  }, [skip, only, router]);
  return skip;
}

// หน้าเมนูตัวเลือกแบบการ์ดตัวเลข (รูปแบบเดียวกับเมนูสลับเลข / ยกเลิกการใช้รถ / ย้ายออก / อื่นๆ)
export function ChoiceMenu({
  title,
  back,
  choices,
}: {
  title: string;
  back?: { href: string; label: string };
  choices: Choice[];
}) {
  const roles = useCachedRoles();
  const shown = visibleChoices(choices, roles);
  const skipping = useSkipSingleChoice(shown, roles);
  if (skipping) return null;

  return (
    <div className="content">
      {back && (
        <Link href={back.href} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
          ← {back.label}
        </Link>
      )}
      <h1>{title}</h1>
      <div className="registration-tasks">
        {shown.map((c, index) => (
          <Link key={c.href} href={c.href} className="registration-task">
            <span className="task-number">{index + 1}</span>
            <strong>{c.title}</strong>
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
