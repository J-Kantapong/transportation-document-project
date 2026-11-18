// แบบงานโอน - ใช้ร่วมกันทุกที่ที่ต้องรู้ชื่อ / หน้าเว็บ / ขั้นตรวจรถของแต่ละแบบ (Delivery, ค้นหารถ, ภาพรวม, งานของฉัน)
// OWNER = โอนตามผู้ถือกรรมสิทธิ์ (ยื่น -> รับใบเสร็จ) · INSPECTION = โอนตรวจรถ · MOVE_IN = โอนย้ายเข้า (ผู้ใช้ 2026-11-18)
// INSPECTION และ MOVE_IN มีขั้นตรวจรถ: ยื่น -> ส่งตรวจ -> ผลตรวจ (ผ่านเท่านั้น) -> รับใบเสร็จ
export const TRANSFER_TYPES = ['OWNER', 'INSPECTION', 'MOVE_IN'] as const;
export type TransferType = (typeof TRANSFER_TYPES)[number];

export const TRANSFER_INSPECTION_TYPES: TransferType[] = ['INSPECTION', 'MOVE_IN'];

export const TRANSFER_TYPE_LABEL: Record<string, string> = {
  OWNER: 'โอนตามผู้ถือกรรมสิทธิ์',
  INSPECTION: 'โอนตรวจรถ',
  MOVE_IN: 'โอนย้ายเข้า',
};

const SEGMENT: Record<string, string> = { OWNER: 'owner', INSPECTION: 'inspection', MOVE_IN: 'move-in' };

export const transferHasInspection = (transferType: string): boolean => transferType === 'INSPECTION' || transferType === 'MOVE_IN';

// หน้าเว็บของงานโอนแบบนั้น เช่น /registration/transfer/move-in/return
export const transferPage = (transferType: string, page: 'submit' | 'inspect' | 'return'): string =>
  `/registration/transfer/${SEGMENT[transferType] ?? 'owner'}/${page}`;
