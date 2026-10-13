"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { getToken, rolesFromToken } from "@/lib/auth";
import { ExecutiveOverview } from "./ExecutiveOverview";
import { MyWorkPage } from "./MyWorkPage";

// หน้าภาพรวม "/" แยกตามบทบาท (ผู้ใช้ 2026-09-24): ADMIN เห็นภาพรวมผู้บริหาร · ACCOUNTANT (บทบาทอื่นที่เปิด "/" ได้) เห็น "งานของฉัน"
// (ผู้ใช้ 2026-10-13 - เดิมเห็นหน้าเมนูงานทะเบียนเฉยๆ) · fallback เหลือไว้สำหรับกรณีไม่มีบทบาทที่รู้จัก
// roles อ่านจาก token ใน cookie ได้เฉพาะฝั่ง browser - ตอน render ฝั่ง server ยังไม่แสดงอะไร
const noopSubscribe = () => () => {};
const rolesKey = () => rolesFromToken(getToken() ?? "").join(",");

export function HomeDashboard({ fallback }: { fallback: ReactNode }) {
  const roles = useSyncExternalStore(noopSubscribe, rolesKey, () => null);
  if (roles === null) return null;
  const list = roles.split(",");
  if (list.includes("ADMIN")) return <ExecutiveOverview />;
  if (list.includes("ACCOUNTANT")) return <MyWorkPage />;
  return <>{fallback}</>;
}
