"use client";

import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
import { api, type ReceivingRow } from "@/lib/api";

function toRow(r: ReceivingRow): QueueRow {
  return {
    id: r.id,
    date: r.date,
    customerName: r.customerName,
    chassis: r.chassis,
    body: r.body,
    plateCategory: r.plateCategory,
    plateNumber: r.plateNumber,
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
      loadPending={async () => (await api.listReceivingPending("plate")).vehicles.map(toRow)}
      loadCompleted={async () => (await api.listReceivingCompleted("plate")).vehicles.map(toRow)}
      markDone={async (id, data) => {
        await api.markReceivingDone(id, "plate", data);
      }}
    />
  );
}
