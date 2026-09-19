"use client";

import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
import { api, type DocumentSubmission } from "@/lib/api";

function toRow(s: DocumentSubmission): QueueRow {
  const v = s.vehicle;
  return {
    id: s.id, // DocumentSubmission.id - รับใบเสร็จผูกกับรายการที่ยื่น ไม่ใช่ตัวรถ
    date: s.submitDate.slice(0, 10),
    customerName: v.customer.name,
    chassis: v.chassis,
    body: v.body,
    plate: v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : "—",
    doneDate: s.receiptReceivedDate?.slice(0, 10) ?? null,
  };
}

export default function ReceiveReceiptPage() {
  return (
    <ReceivingQueuePage
      title="รับใบเสร็จ"
      dateColumnLabel="วันที่ยื่นเอกสาร"
      doneLabel="ได้รับใบเสร็จแล้ว"
      doneDateLabel="วันที่รับใบเสร็จ"
      emptyText="ไม่มีรายการที่ยื่นแล้วรอใบเสร็จ"
      loadPending={async () => (await api.listDocumentSubmissions(undefined, "PENDING")).submissions.map(toRow)}
      loadCompleted={async () => (await api.listDocumentSubmissions(undefined, "RECEIPT_RECEIVED")).submissions.map(toRow)}
      markDone={async (id, data) => {
        await api.updateDocumentSubmissionStatus(id, "RECEIPT_RECEIVED", data.date);
      }}
      markFailed={async (id) => {
        await api.updateDocumentSubmissionStatus(id, "FAILED");
      }}
    />
  );
}
