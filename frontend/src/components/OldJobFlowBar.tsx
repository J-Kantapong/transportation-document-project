"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { API_MUTATED_EVENT } from "@/lib/api";
import {
  OLD_JOB_FLOW_PARAM,
  OLD_JOB_STATUS_LABEL,
  OLD_JOB_TYPE_LABEL,
  OLD_VEHICLE_HOME,
  isFlowEndStatus,
  nextStepHref,
  oldVehicleJobsApi,
  plateOf,
  type IntakePrefill,
} from "@/lib/old-vehicle-jobs-api";

// ทำงานรถเก่าตามขั้นต่อเนื่อง (ผู้ใช้ 2026-11-19: "ทำเสร็จให้ไปหน้าถัดไปเรื่อยๆ จนจบก่อนถึง Delivery")
// เปิดหน้าด้วย ?flow=<id แถวรับงาน> (ลิงก์ขั้นถัดไปจากหน้ารวม / หน้าตรวจรถ) = แถบนี้บอกว่ากำลังทำงานไหนขั้นไหน
// ทุกครั้งที่หน้าบันทึกอะไรสำเร็จ (lib/api.ts ส่ง API_MUTATED_EVENT) จะอ่านสถานะงานใหม่ ถ้าขยับขั้นแล้ว:
// - ขั้นถัดไปยังไม่ใช่ส่งงาน -> ไปหน้าของขั้นนั้นเอง (พก flow ต่อไปด้วย)
// - ถึงรอส่งงาน / เสร็จ / ถูกยกเลิก -> กลับหน้ารวมงานรถเก่า แถบแจ้งว่าครบขั้นแล้ว (ไม่พาเข้า Delivery)
// บันทึกที่ไม่ทำให้งานนี้ขยับขั้น (รถคันอื่นในคิวเดียวกัน, แนบรูปบางส่วน) = อยู่หน้าเดิม
// ไม่แก้หน้าของแต่ละงาน - ตัดสินจากสถานะของแถวรับงานที่ backend คิดจากงานจริงอย่างเดียว
const DEBOUNCE_MS = 400;

function flowId(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(OLD_JOB_FLOW_PARAM)?.trim() ?? "";
}

export function OldJobFlowBar() {
  const pathname = usePathname();
  const router = useRouter();
  const [data, setData] = useState<IntakePrefill | null>(null);
  const [note, setNote] = useState("");
  const startStatus = useRef<string | null>(null);

  useEffect(() => {
    const id = flowId();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- เริ่มใหม่ทุกครั้งที่เปลี่ยนหน้า
    setData(null);
    setNote("");
    startStatus.current = null;
    if (!id) return;
    let cancelled = false;
    let timer: number | undefined;
    const onHub = pathname === OLD_VEHICLE_HOME;

    const load = (afterSave: boolean) =>
      oldVehicleJobsApi
        .job(id)
        .then((loaded) => {
          if (cancelled) return;
          setData(loaded);
          const { job, vehicle } = loaded;
          if (startStatus.current === null || !afterSave || onHub) {
            startStatus.current = job.status;
            return;
          }
          if (job.status === startStatus.current) return;
          // ขยับขั้นแล้ว (จำไว้ กันพาไปซ้ำถ้าขั้นถัดไปอยู่หน้าเดียวกัน)
          startStatus.current = job.status;
          if (isFlowEndStatus(job.status)) {
            router.push(`${OLD_VEHICLE_HOME}?${new URLSearchParams({ [OLD_JOB_FLOW_PARAM]: id, focus: vehicle.chassis })}`);
            return;
          }
          const next = nextStepHref(vehicle, job);
          if (!next) return;
          setNote(`บันทึกแล้ว - ไปขั้น "${OLD_JOB_STATUS_LABEL[job.status]}"`);
          router.push(next);
        })
        .catch((err: unknown) => {
          // ไม่พบ = แถวรับงานถูกยกเลิก
          if (!cancelled) setNote(err instanceof Error ? err.message : "อ่านสถานะงานไม่สำเร็จ");
        });

    load(false);
    const onMutated = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path ?? "";
      if (path.startsWith("/api/auth")) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => load(true), DEBOUNCE_MS);
    };
    window.addEventListener(API_MUTATED_EVENT, onMutated);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener(API_MUTATED_EVENT, onMutated);
    };
  }, [pathname, router]);

  if (!data && !note) return null;
  if (!data) {
    return (
      <div className="flow-bar error" role="status">
        {note}
      </div>
    );
  }
  const { vehicle, job } = data;
  const end = isFlowEndStatus(job.status);
  const typeLabel = job.jobType ? OLD_JOB_TYPE_LABEL[job.jobType] : "ยังไม่เลือกประเภทงาน";
  const onHub = pathname === OLD_VEHICLE_HOME;
  return (
    <div className={`flow-bar${end ? " done" : ""}`} role="status">
      <span>
        งานรถเก่า <strong>{plateOf(vehicle)}</strong> · {typeLabel} ·{" "}
        {end
          ? job.status === "TO_DELIVER"
            ? "ทำครบทุกขั้นแล้ว รอส่งงาน (Delivery)"
            : OLD_JOB_STATUS_LABEL[job.status]
          : `ขั้นนี้: ${OLD_JOB_STATUS_LABEL[job.status]} - บันทึกแล้วจะไปขั้นถัดไปเอง`}
      </span>
      {note && <span className="flow-bar-note">{note}</span>}
      {!onHub && (
        <Link href={OLD_VEHICLE_HOME} className="text-button">
          กลับหน้ารวมงานรถเก่า
        </Link>
      )}
    </div>
  );
}
