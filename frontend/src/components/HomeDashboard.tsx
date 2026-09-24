"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { getToken, rolesFromToken } from "@/lib/auth";
import { ExecutiveOverview } from "./ExecutiveOverview";

// หน้าภาพรวม "/" แยกตามบทบาท (ผู้ใช้ 2026-09-24): ADMIN เห็นภาพรวมผู้บริหาร บทบาทอื่นจะมีภาพรวมของตัวเองตามมา
// ระหว่างนี้บทบาทอื่นที่เข้าหน้านี้ได้ (ACCOUNTANT) ยังเห็นหน้าเดิม (fallback)
// roles อ่านจาก token ใน cookie ได้เฉพาะฝั่ง browser - ตอน render ฝั่ง server ยังไม่แสดงอะไร
const noopSubscribe = () => () => {};
const rolesKey = () => rolesFromToken(getToken() ?? "").join(",");

export function HomeDashboard({ fallback }: { fallback: ReactNode }) {
  const roles = useSyncExternalStore(noopSubscribe, rolesKey, () => null);
  if (roles === null) return null;
  return roles.split(",").includes("ADMIN") ? <ExecutiveOverview /> : <>{fallback}</>;
}
