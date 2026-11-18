"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, request } from "@/lib/api";
import { promptDialog } from "@/lib/confirm-dialog";

// ตรวจใบเสร็จซ้ำก่อนยืนยันรับใบเสร็จ (ผู้ใช้ 2026-11-19: "ใช้ AI ตรวจสอบยอดใบเสร็จทุกงาน ... สำคัญมากๆ เวลาคิดเงิน")
// backend: backend/src/receipts/receipt-recheck.ts - เทียบยอดตามใบเสร็จกับ Bill / เลขตัวถัง / ทะเบียนที่ AI อ่าน
export type RecheckJobType = "PLATE_SWAP" | "TRANSFER" | "USE_CANCEL" | "MOVE_OUT" | "PLATE_COPY" | "TAX_RENEWAL";
export type RecheckStatus = "MATCH" | "DIFF" | "MISSING";

export interface ReceiptRecheck {
  amount: { status: RecheckStatus; bill: number | null; receipt: number | null; diff: number | null };
  chassis: { status: RecheckStatus; read: string | null };
  plate: { status: RecheckStatus; read: string | null };
  itemsSumMismatch: boolean;
  problems: string[];
}

export const fetchRechecks = (type: RecheckJobType, ids: string[]) =>
  request<{ checks: Record<string, ReceiptRecheck> }>(`/api/receipts/recheck?type=${type}&ids=${ids.map(encodeURIComponent).join(",")}`);

// ผลตรวจของรายการในหน้า - โหลดใหม่เมื่อรายการ / ข้อมูลใบเสร็จเปลี่ยน (key = id + ยอด + จำนวนรูป ที่หน้าส่งมา)
export function useRechecks(type: RecheckJobType, items: Array<{ id: string; key: string }>): Record<string, ReceiptRecheck> {
  const [checks, setChecks] = useState<Record<string, ReceiptRecheck>>({});
  const signature = items.map((i) => i.key).join("|");
  useEffect(() => {
    const ids = items.map((i) => i.id);
    if (!ids.length) return;
    let cancelled = false;
    fetchRechecks(type, ids)
      .then((data) => {
        if (!cancelled) setChecks(data.checks);
      })
      .catch(() => undefined); // ตรวจไม่ได้ = ไม่แสดงกล่อง (backend ยังตรวจตอนยืนยันเสมอ)
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- โหลดใหม่ตาม signature ของรายการ
  }, [type, signature]);
  return checks;
}

// เรียกบันทึกรับใบเสร็จ - backend ตอบว่าตรวจไม่ผ่าน = ถามเหตุผลแล้วส่งซ้ำ (ยกเลิก = คืน false)
export function useRecheckConfirm() {
  return useCallback(async (save: (reason?: string) => Promise<unknown>): Promise<boolean> => {
    try {
      await save();
      return true;
    } catch (err) {
      const body = err instanceof ApiError ? (err.details as { code?: string; problems?: string[] } | undefined) : undefined;
      if (body?.code !== "RECEIPT_RECHECK_REASON_REQUIRED") throw err;
      const reason = await promptDialog(
        `ตรวจใบเสร็จไม่ผ่าน:\n\n• ${(body.problems ?? []).join("\n• ")}\n\nดูรูปใบเสร็จแล้วถ้าข้อมูลถูกต้อง ใส่เหตุผลเพื่อยืนยัน (เก็บในประวัติ)`,
        { confirmLabel: "ยืนยันพร้อมเหตุผล" },
      );
      if (!reason || !reason.trim()) return false;
      await save(reason.trim());
      return true;
    }
  }, []);
}
