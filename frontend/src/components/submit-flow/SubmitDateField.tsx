"use client";

import { useState } from "react";
import { DateInput } from "@/components/DateInput";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { useSubmitFlow } from "./SubmitFlowContext";

// ช่องวันที่ยื่นเอกสารของทั้งขั้นตอน (state เดียวใน SubmitFlowProvider) - อยู่ทั้งขั้นเลือกรถและขั้นตั้งค่า (ผู้ใช้ 2026-09-27:
// คิวขั้น 1 โหลดตามวันที่ยื่นนี้ ยกเลิก/ยื่นไม่สำเร็จแล้วยื่นใหม่ด้วยวันที่ยื่นเดิมได้ถ้ายังไม่ครบ 90 วันจากวันที่ตรวจผ่าน)
// ใช้วันที่ใหม่เมื่อกรอกครบและถูกต้องเท่านั้น (ปี พ.ศ. แปลงให้) ระหว่างพิมพ์วันที่เดิมยังใช้อยู่ - backend ตรวจซ้ำตอนยื่นเสมอ
export function SubmitDateField({ label = "วันที่ยื่นเอกสาร" }: { label?: string }) {
  const { submitDateText, setSubmitDateText, submitDate } = useSubmitFlow();
  const [dateText, setDateText] = useState(submitDateText);
  // วันที่ยื่นเปลี่ยนจากที่อื่น (อีกขั้น / ยังไม่ได้แก้เอง + เปิดค้างข้ามคืน = เลื่อนเป็นวันนี้ให้) - ช่องกรอกตามไปด้วย
  const [syncedDateText, setSyncedDateText] = useState(submitDateText);
  if (syncedDateText !== submitDateText) {
    setSyncedDateText(submitDateText);
    setDateText(submitDateText);
  }
  const typedDate = displayDateToIso(dateText.replace(/\D/g, ""));

  function changeDate(raw: string) {
    const text = formatDateDigitsCe(raw.replace(/\D/g, "").slice(0, 8));
    setDateText(text);
    if (displayDateToIso(text.replace(/\D/g, ""))) setSubmitDateText(text);
  }

  return (
    <>
      <label className="submit-date-field">
        {label}
        <DateInput value={dateText} onChange={changeDate} aria-invalid={!typedDate} />
      </label>
      {!typedDate ? <span className="field-error">วันที่ไม่ถูกต้อง (ยังใช้ {isoToDisplayDate(submitDate)})</span> : null}
    </>
  );
}
