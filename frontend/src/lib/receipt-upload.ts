"use client";

import { useEffect, useRef } from "react";
import { api, type ReceiptImage } from "@/lib/api";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";

// เลือกรูปใบเสร็จหลายใบ (ผู้ใช้ 2026-09-25): ส่งพร้อมกันทีละ UPLOAD_CONCURRENCY รูป แบบ background -
// backend เก็บรูปแล้วตอบทันที AI อ่านทีหลัง หน้าเว็บถามผลทุก POLL_MS จนอ่านครบ (ปิดหน้าไปก็อ่านต่อ)
const UPLOAD_CONCURRENCY = 4;
const POLL_MS = 3000;

export async function uploadReceiptsInBackground(
  files: File[],
  onUploaded: (receipt: ReceiptImage) => void,
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
        onUploaded((await api.uploadReceipt(image, compressedFileName(file), undefined, true)).receipt);
      } catch (err) {
        onFailed(file, err);
      }
      onProgress?.(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
}

// ถามผลของรูปที่ยังรออ่าน - onRead ได้เฉพาะรูปที่อ่านเสร็จแล้ว (รูปที่ถูกลบไประหว่างนั้นจะไม่กลับมา)
export function usePendingReceipts(pendingIds: string[], onRead: (receipts: ReceiptImage[]) => void) {
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  });
  const key = pendingIds.join(",");
  useEffect(() => {
    if (!key) return;
    const timer = window.setInterval(() => {
      api
        .getReceipts(key.split(","))
        .then(({ receipts }) => {
          const read = receipts.filter((r) => !r.readPending);
          if (read.length) onReadRef.current(read);
        })
        .catch(() => undefined); // เน็ตสะดุด - รอบหน้าถามใหม่
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [key]);
}
