"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { REGISTRATION_CATEGORIES } from "@/lib/categories";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";
import { Icon } from "./Icon";

export function CreateCaseDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  // แสดงเฉพาะประเภทงานที่บทบาทเข้าได้ (พบ 2026-09-27: เดิมกดแล้วถูกพากลับหน้าแรกเงียบๆ) - กฎอยู่ใน lib/auth.ts
  const categories = REGISTRATION_CATEGORIES.filter((category) => roles === null || canAccessPage(category.href, roles));

  return (
    <>
      <button className="primary" onClick={() => dialogRef.current?.showModal()}>
        <Icon name="plus" />
        สร้างรายการใหม่
      </button>
      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>สร้างรายการใหม่</h2>
        <p>เลือกประเภทงานทะเบียน</p>
        <div className="choices">
          {categories.map((category) => (
            <Link key={category.href} href={category.href} onClick={() => dialogRef.current?.close()}>
              {category.title} <span style={{ float: "right" }}>→</span>
            </Link>
          ))}
        </div>
      </dialog>
    </>
  );
}
