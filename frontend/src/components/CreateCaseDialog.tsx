"use client";

import Link from "next/link";
import { useRef } from "react";
import { REGISTRATION_CATEGORIES } from "@/lib/categories";
import { Icon } from "./Icon";

export function CreateCaseDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);

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
          {REGISTRATION_CATEGORIES.map((category) => (
            <Link key={category.href} href={category.href} onClick={() => dialogRef.current?.close()}>
              {category.title} <span style={{ float: "right" }}>→</span>
            </Link>
          ))}
        </div>
      </dialog>
    </>
  );
}
