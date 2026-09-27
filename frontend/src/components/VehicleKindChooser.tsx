"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCachedUser, submitWriteScopeFor, type UserRole, vehicleScopeFor, type VehicleScope } from "@/lib/auth";

// หน้าเลือกประเภทรถก่อนเข้างาน (ผู้ใช้ 2026-09-25/26: รับใบเสร็จ / รับป้าย / รับเล่ม - รถยนต์กับมอเตอร์ไซค์เป็นงานแยกกัน)
// กดแล้วไป {basePath}/car หรือ {basePath}/moto; พนักงานที่ดูแลประเภทเดียว (STAFF_CAR / STAFF_MOTO) เห็นเฉพาะของตัวเอง
// เห็นตามขอบเขตการอ่าน แต่ประเภทที่บันทึกไม่ได้ขึ้น "ดูอย่างเดียว" (พบ 2026-09-27: เช่น STAFF_MOTO + DELIVERY เห็นรถยนต์ได้
// แต่แก้ได้เฉพาะมอเตอร์ไซค์ - submitWriteScopeFor; ACCOUNTANT ดูอย่างเดียวทุกประเภท)
export type VehicleKind = "car" | "moto";
export const VEHICLE_KIND_LABEL: Record<VehicleKind, string> = {
  car: "รถยนต์",
  moto: "มอเตอร์ไซค์",
};
const KINDS: VehicleKind[] = ["car", "moto"];

function kindInScope(scope: VehicleScope, kind: VehicleKind): boolean {
  return scope === "ALL" || (kind === "car" ? scope === "CAR" : scope === "MOTO");
}

export function VehicleKindChooser({
  title,
  basePath,
  capture,
}: {
  title: string;
  basePath: string;
  capture?: { href: string; label: string };
}) {
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  const scope = roles === null ? null : vehicleScopeFor(roles);
  const writeScope = roles === null ? null : submitWriteScopeFor(roles);
  const kinds = KINDS.filter((k) => scope === null || kindInScope(scope, k));

  return (
    <div className="content">
      <Link
        href="/registration/new-vehicle"
        className="text-button"
        style={{ marginBottom: 18, display: "inline-block" }}
      >
        ← จดทะเบียนรถใหม่
      </Link>
      <h1>{title}</h1>
      <div className="registration-tasks">
        {kinds.map((k, i) => (
          <Link key={k} href={`${basePath}/${k}`} className="registration-task">
            <span className="task-number">{i + 1}</span>
            <strong>{VEHICLE_KIND_LABEL[k]}</strong>
            {writeScope !== null && !kindInScope(writeScope, k) && (
              <span className="muted" style={{ fontSize: 12 }}>
                ดูอย่างเดียว
              </span>
            )}
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
      {capture && (
        <p style={{ marginTop: 18 }}>
          <Link href={capture.href} className="text-button">
            {capture.label} →
          </Link>
        </p>
      )}
    </div>
  );
}
