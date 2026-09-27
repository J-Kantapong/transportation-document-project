"use client";

import { useEffect, useRef } from "react";
import { api, type ReceiptImage } from "@/lib/api";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";

// เลือกรูปหลายรูปจากคลังภาพ (ผู้ใช้ 2026-09-25) - ใบเสร็จ (Step 5), ป้าย (Step 6), เล่ม (Step 7):
// ส่งพร้อมกันทีละ UPLOAD_CONCURRENCY รูปแบบ background - backend เก็บรูปแล้วตอบทันที AI อ่านทีหลัง
// หน้าเว็บถามผลทุก POLL_MS จนอ่านครบ (ปิดหน้าไปก็อ่านต่อ) · ถ่ายจากกล้องทีละรูปยังอ่านทันทีเหมือนเดิม
const UPLOAD_CONCURRENCY = 4;
const POLL_MS = 3000;

// upload = ส่งรูปที่ย่อแล้ว 1 รูปแบบ background แล้วคืนผลจาก backend
export async function uploadAllInBackground<T>(
  files: File[],
  upload: (image: Blob, fileName: string) => Promise<T>,
  onUploaded: (result: T) => void,
  onFailed: (file: File, err: unknown) => void,
  onProgress?: (done: number) => void,
) {
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      try {
        const image = await compressReceiptImage(file);
        onUploaded(await upload(image, compressedFileName(file)));
      } catch (err) {
        onFailed(file, err);
      }
      onProgress?.(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
}

export function uploadReceiptsInBackground(
  files: File[],
  onUploaded: (receipt: ReceiptImage) => void,
  onFailed: (file: File, err: unknown) => void,
  onProgress?: (done: number) => void,
) {
  return uploadAllInBackground(
    files,
    async (image, fileName) => (await api.uploadReceipt(image, fileName, undefined, true)).receipt,
    onUploaded,
    onFailed,
    onProgress,
  );
}

// เรียก poll ทุก POLL_MS ระหว่างที่ active (ยังมีรูปรออ่าน) - error ไม่ต้องแจ้ง รอบหน้าถามใหม่
export function usePolling(active: boolean, poll: () => Promise<void>) {
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void pollRef.current().catch(() => undefined), POLL_MS);
    return () => window.clearInterval(timer);
  }, [active]);
}

// โหลดข้อมูลใหม่เป็นระยะระหว่างที่ active และเปิดหน้านี้อยู่ + ทันทีที่กลับมาที่หน้าต่าง/แท็บนี้ (พบ 2026-09-27: หน้ารับใบเสร็จ
// ไม่เห็นรูปที่อีกเครื่องเพิ่งถ่าย/จับคู่ จนกดโหลดหน้าใหม่เอง) - error ไม่ต้องแจ้ง รอบหน้าลองใหม่
const REFRESH_MS = 15000;

// intervalMs = 0 = โหลดใหม่เฉพาะตอนกลับมาที่แท็บ ไม่โหลดเป็นระยะ
export function useAutoRefresh(active: boolean, refresh: () => Promise<void>, intervalMs = REFRESH_MS) {
  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    const run = () => {
      if (document.visibilityState !== "visible") return;
      last = Date.now();
      void refreshRef.current().catch(() => undefined);
    };
    // กลับมาที่แท็บ: โหลดใหม่ถ้าไม่ได้โหลดมาสักพัก (focus กับ visibilitychange มักมาคู่กัน)
    const onReturn = () => {
      if (Date.now() - last > 2000) run();
    };
    const timer = intervalMs > 0 ? window.setInterval(run, intervalMs) : undefined;
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [active, intervalMs]);
}

// ถามผลของใบเสร็จที่ยังรออ่าน - onRead ได้รูปที่อ่านเสร็จแล้ว และ gone = id ที่ไม่อยู่ในผลลัพธ์แล้ว (อีกเครื่องลบไป
// หรือถูกจับคู่กับรถนอกขอบเขตของเรา) ให้เอาออกจากรายการ (พบ 2026-09-27: เดิมค้าง "กำลังอ่าน" แล้วถามซ้ำทุก 3 วินาทีจนโหลดหน้าใหม่)
export function usePendingReceipts(pendingIds: string[], onRead: (receipts: ReceiptImage[], gone: string[]) => void) {
  usePolling(pendingIds.length > 0, async () => {
    const { receipts } = await api.getReceipts(pendingIds);
    const returned = new Set(receipts.map((r) => r.id));
    const read = receipts.filter((r) => !r.readPending);
    const gone = pendingIds.filter((id) => !returned.has(id));
    if (read.length || gone.length) onRead(read, gone);
  });
}
