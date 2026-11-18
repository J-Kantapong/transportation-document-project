"use client";

import { useEffect, useRef, useState } from "react";
import { oldVehicleJobsApi, plateOf, type IntakePrefill } from "@/lib/old-vehicle-jobs-api";

// เติมฟอร์มยื่นของหน้างานเดิมจากแถวรับงานของหน้ารวมงานรถเก่า (รอบ 2 ผู้ใช้ 2026-11-18: ไม่ต้องกรอกข้อมูลรถซ้ำ)
// หน้ารวมส่ง ?intake=<id ของแถวรับงาน> มากับลิงก์ "ยื่น" - อ่านจาก window.location ใน effect (ไม่ใช้ useSearchParams
// เพื่อไม่ต้องห่อ Suspense ทุกหน้า) โหลดครั้งเดียวแล้วเรียก apply ให้หน้านั้นใส่ค่าลงฟอร์มของตัวเอง
// คืนข้อความแถบแจ้ง (ว่าง = ไม่ได้เปิดจากหน้ารวม) - พนักงานยังแก้ทุกช่องได้ก่อนบันทึก
// ระหว่างโหลด (ประมาณ 1 วินาที) กันกดบันทึกฟอร์ม (พบ 2026-11-19 ตอนทดสอบ: กดเร็วเกิน = ยื่นด้วยฟอร์มที่ยังว่าง)
export function useIntakePrefill(apply: (prefill: IntakePrefill) => void): { notice: string; error: boolean } {
  const [state, setState] = useState<{ notice: string; error: boolean }>({ notice: "", error: false });
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("intake");
    if (!id) return;
    let cancelled = false;
    // กันส่งฟอร์มทุกฟอร์มในหน้าจนกว่าจะเติมข้อมูลเสร็จ (จับที่ capture phase ก่อน onSubmit ของหน้า)
    const block = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener("submit", block, true);
    const unblock = () => document.removeEventListener("submit", block, true);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- แจ้งสถานะทันทีที่เริ่มโหลด
    setState({ notice: "กำลังเติมข้อมูลจากการรับงาน... รอสักครู่ก่อนบันทึก", error: false });
    oldVehicleJobsApi
      .job(id)
      .then((prefill) => {
        if (cancelled) return;
        if (prefill.job.jobId) {
          setState({ notice: `งานของ ${plateOf(prefill.vehicle)} ยื่นไปแล้ว - ไม่ได้เติมข้อมูลให้`, error: true });
          return;
        }
        applyRef.current(prefill);
        setState({ notice: `เติมข้อมูลจากการรับงาน ${plateOf(prefill.vehicle)} ให้แล้ว - ตรวจและกรอกส่วนที่เหลือก่อนบันทึก`, error: false });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ notice: err instanceof Error ? `เติมข้อมูลจากการรับงานไม่สำเร็จ: ${err.message}` : "เติมข้อมูลจากการรับงานไม่สำเร็จ", error: true });
      })
      .finally(() => {
        // ให้ React วาดค่าที่เติมก่อนปลดล็อก
        setTimeout(unblock, 0);
      });
    return () => {
      cancelled = true;
      unblock();
    };
  }, []);
  return state;
}
