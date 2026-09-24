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

// ถามผลของใบเสร็จที่ยังรออ่าน - onRead ได้เฉพาะรูปที่อ่านเสร็จแล้ว (รูปที่ถูกลบไประหว่างนั้นจะไม่กลับมา)
export function usePendingReceipts(pendingIds: string[], onRead: (receipts: ReceiptImage[]) => void) {
  usePolling(pendingIds.length > 0, async () => {
    const { receipts } = await api.getReceipts(pendingIds);
    const read = receipts.filter((r) => !r.readPending);
    if (read.length) onRead(read);
  });
}
