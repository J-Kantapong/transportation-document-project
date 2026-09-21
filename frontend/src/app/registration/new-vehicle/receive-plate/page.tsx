"use client";

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
    doneDate: r.doneDate,
    recipient: r.recipient,
    note: r.note,
  };
}

export default function ReceivePlatePage() {
  return (
    <ReceivingQueuePage
      title="รับป้ายทะเบียน"
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับป้ายแล้ว"
      doneDateLabel="วันที่รับป้าย"
      emptyText="ไม่มีรถที่รอรับป้ายทะเบียน (ต้องได้รับใบเสร็จก่อน)"
      showReceiptNo
      // เรียงตามหมวด+เลขทะเบียน ให้ถือรายการไปห้องรับป้ายได้เลย (กก 1 … กก 9999 แล้ว กข 1 …)
      loadPending={async () => (await api.listReceivingPending("plate")).vehicles.map(toRow).sort(comparePlate)}
      loadCompleted={async () => (await api.listReceivingCompleted("plate")).vehicles.map(toRow)}
      markDone={async (id, data) => {
        await api.markReceivingDone(id, "plate", data);
      }}
    />
  );
}
