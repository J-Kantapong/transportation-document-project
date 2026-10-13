"use client";

import { useRef, type InputHTMLAttributes } from "react";
import { displayDateToIso, isoToDisplayDate } from "@/lib/date";
import { WEEKEND_WARNING, isWeekend, weekdayName, weekdayShort } from "@/lib/date-check";

// ช่องวันที่ วว/ดด/ปปปป ที่ใช้ทั้งระบบ (ผู้ใช้ 2026-09-25): พิมพ์เองได้เหมือนเดิม + ปุ่มปฏิทินเลือกวันที่
// onChange ได้ข้อความในช่อง - ตอนพิมพ์ = ข้อความที่พิมพ์ (ผู้เรียกจัดรูปแบบ/แปลงปี พ.ศ. เองเหมือนเดิม), ตอนเลือกจากปฏิทิน
// = "วว/ดด/ปปปป" (ค.ศ.) ผู้เรียกทุกที่ตัดเหลือตัวเลขแล้วจัดรูปแบบอยู่แล้ว จึงใช้ได้ทั้งสองทาง
// ปฏิทินใช้ <input type="date"> ที่ซ่อนไว้ (showPicker) - ไม่ใช้เป็นช่องหลักเพราะรูปแบบวันที่ตามเครื่อง (มักเป็น ดด/วว/ปปปป)
// weekday (ผู้ใช้ 2026-10-13): ช่องวันที่ของงานขนส่ง - บอกวันในสัปดาห์ต่อท้ายช่อง เสาร์-อาทิตย์เป็นสีส้ม (ขนส่งปิด) ดู lib/date-check.ts
type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: string;
  onChange: (value: string) => void;
  weekday?: boolean;
};

// className / style ที่ส่งมาใช้กับช่องพิมพ์ (ความกว้างเดิมของแต่ละหน้า) ปุ่มปฏิทินต่อท้ายนอกความกว้างนั้น
export function DateInput({ value, onChange, disabled, weekday, ...rest }: Props) {
  const pickerRef = useRef<HTMLInputElement>(null);
  const iso = weekday ? displayDateToIso(value.replace(/\D/g, "")) : "";
  const weekend = iso !== "" && isWeekend(iso);

  function openPicker() {
    const picker = pickerRef.current;
    if (!picker) return;
    picker.value = displayDateToIso(value.replace(/\D/g, "")) || "";
    try {
      picker.showPicker();
    } catch {
      // เบราว์เซอร์เก่าที่ไม่มี showPicker - โฟกัสแล้วคลิกให้ปฏิทินเปิดแทน
      picker.focus();
      picker.click();
    }
  }

  return (
    <span className="date-input">
      <input
        type="text"
        inputMode="numeric"
        placeholder="วว/ดด/ปปปป"
        {...rest}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="date-input-button" onClick={openPicker} disabled={disabled} aria-label="เลือกวันที่จากปฏิทิน" title="เลือกจากปฏิทิน">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4m8-4v4" />
        </svg>
      </button>
      {iso && (
        <span
          className={`date-input-weekday${weekend ? " weekend" : ""}`}
          title={weekend ? `${weekdayName(iso)} - ${WEEKEND_WARNING}` : weekdayName(iso)}
          aria-label={weekend ? `${weekdayName(iso)} ${WEEKEND_WARNING}` : weekdayName(iso)}
        >
          {weekend ? `⚠ ${weekdayShort(iso)}` : weekdayShort(iso)}
        </span>
      )}
      <input
        ref={pickerRef}
        type="date"
        className="date-input-native"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => e.target.value && onChange(isoToDisplayDate(e.target.value))}
      />
    </span>
  );
}
