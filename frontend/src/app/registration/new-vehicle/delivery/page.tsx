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

export default function DeliveryPage() {
  return (
    <ReceivingQueuePage
      title="Delivery"
      dateColumnLabel="วันที่รับงาน"
      doneLabel="ส่งมอบแล้ว"
      doneDateLabel="วันที่ส่งมอบ"
      emptyText="ไม่มีรถที่รอ Delivery (ต้องรับป้ายและเล่มทะเบียนครบก่อน)"
      showDeliveryFields
      loadPending={async () => (await api.listReceivingPending("delivery")).vehicles.map(toRow)}
      loadCompleted={async () => (await api.listReceivingCompleted("delivery")).vehicles.map(toRow)}
      markDone={async (id, data) => {
        await api.markReceivingDone(id, "delivery", data);
      }}
    />
  );
}
