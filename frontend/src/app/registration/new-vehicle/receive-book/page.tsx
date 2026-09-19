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
    plate: r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—",
    doneDate: r.doneDate,
    recipient: r.recipient,
    note: r.note,
  };
}

export default function ReceiveBookPage() {
  return (
    <ReceivingQueuePage
      title="รับเล่มทะเบียน"
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับเล่มแล้ว"
      doneDateLabel="วันที่รับเล่ม"
      emptyText="ไม่มีรถที่รอรับเล่มทะเบียน (ต้องได้รับใบเสร็จก่อน)"
      loadPending={async () => (await api.listReceivingPending("book")).vehicles.map(toRow)}
      loadCompleted={async () => (await api.listReceivingCompleted("book")).vehicles.map(toRow)}
      markDone={async (id, data) => {
        await api.markReceivingDone(id, "book", data);
      }}
    />
  );
}
