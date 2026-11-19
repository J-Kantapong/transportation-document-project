"use client";

import { useEffect, useRef, useState } from "react";

// ค้นระหว่างพิมพ์ (ผู้ใช้ 2026-11-19: "พอพิมพ์แล้วมีข้อมูลแนะนำก่อนเลยโดยไม่ต้องกด enter ทำแบบนี้ในทุกๆหน้าที่มีการดึงข้อมูล")
// หยุดพิมพ์ TYPING_DELAY_MS แล้วค่อยถาม backend ครั้งเดียว / คำตอบของคำค้นเก่าที่มาช้าไม่ทับคำค้นปัจจุบัน
// ใช้ร่วมกับ components/SuggestionList.tsx - หน้าที่ค้นในรายการที่โหลดมาแล้ว (กรองฝั่ง client) ไม่ต้องใช้
export const TYPING_DELAY_MS = 300;

export interface TypeAheadState<T> {
  data: T | null; // ผลของคำค้นปัจจุบัน (null = ยังไม่มี / คำค้นสั้นเกินไป)
  searching: boolean; // กำลังรอผลของคำค้นปัจจุบัน
}

export function useTypeAhead<T>(
  query: string,
  fetcher: (q: string) => Promise<T>,
  { minLength = 2, enabled = true }: { minLength?: number; enabled?: boolean } = {},
): TypeAheadState<T> {
  const q = query.trim();
  const active = enabled && q.length >= minLength;
  const [result, setResult] = useState<{ q: string; data: T | null }>({ q: "", data: null });
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetcherRef
        .current(q)
        .then((data) => {
          if (!cancelled) setResult({ q, data });
        })
        .catch(() => {
          if (!cancelled) setResult({ q, data: null });
        });
    }, TYPING_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, active]);
  if (!active) return { data: null, searching: false };
  return result.q === q ? { data: result.data, searching: false } : { data: null, searching: true };
}

// ค่าที่ตามหลังการพิมพ์ TYPING_DELAY_MS - สำหรับหน้าที่โหลดรายการใหม่ทั้งรายการตามคำค้น (ไม่ใช่รายการแนะนำ)
export function useDebouncedValue<T>(value: T, delay = TYPING_DELAY_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
