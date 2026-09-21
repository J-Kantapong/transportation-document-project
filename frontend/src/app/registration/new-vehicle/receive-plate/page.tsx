"use client";

import Link from "next/link";
import { useState } from "react";
import { PlatePhotoPanel } from "@/components/PlatePhotoPanel";
import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
import { api, type ReceivingRow } from "@/lib/api";
import { comparePlate } from "@/lib/plate-order";

function toRow(r: ReceivingRow): QueueRow {
  return {
    id: r.id,
    date: r.date,
    customerName: r.customerName,
    chassis: r.chassis,
    body: r.body,
    plateCategory: r.plateCategory,
    plateNumber: r.plateNumber,
    receiptNo: r.receiptNo,
    platePhotoId: r.platePhotoId,
    doneDate: r.doneDate,
    recipient: r.recipient,
    note: r.note,
  };
}

export default function ReceivePlatePage() {
  const [reloadSignal, setReloadSignal] = useState(0);
  return (
    <ReceivingQueuePage
      title="รับป้ายทะเบียน"
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับป้ายแล้ว"
      doneDateLabel="วันที่รับป้าย"
      emptyText="ไม่มีรถที่รอรับป้ายทะเบียน (ต้องได้รับใบเสร็จก่อน)"
      showReceiptNo
      showPlatePhoto
      // เรียงตามหมวด+เลขทะเบียน ให้ถือรายการไปห้องรับป้ายได้เลย (กก 1 … กก 9999 แล้ว กข 1 …)
      loadPending={async () => (await api.listReceivingPending("plate")).vehicles.map(toRow).sort(comparePlate)}
      loadCompleted={async () => (await api.listReceivingCompleted("plate")).vehicles.map(toRow)}
      // ไม่ส่ง markDone = ติ๊กรับป้ายในตารางไม่ได้ - ผู้ใช้ 2026-09-21: ต้องมีรูปป้ายทุกคัน ยืนยันผ่านส่วนถ่ายรูปป้ายเท่านั้น
      reloadSignal={reloadSignal}
      // ถ่ายรูปป้าย -> AI อ่านทะเบียน -> จับคู่กับรถในคิวด้านล่างให้เอง (ติ๊กในตารางเองยังทำได้เหมือนเดิม)
      headerSlot={
        <>
          <Link
            href="/registration/new-vehicle/receive-plate/capture"
            className="primary"
            style={{ display: "inline-flex", marginTop: 14, textDecoration: "none" }}
          >
            📷 ถ่ายรูปป้ายจากมือถือ
          </Link>
          <PlatePhotoPanel onConfirmed={() => setReloadSignal((n) => n + 1)} />
        </>
      }
    />
  );
}
