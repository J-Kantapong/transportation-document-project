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
    plateCategory: v.plateCategory,
    plateNumber: v.plateNumber,
    doneDate: s.receiptReceivedDate?.slice(0, 10) ?? null,
    // Bill = ค่าธรรมเนียม (รายการ Bill) + ภาษี - No bill ไม่อยู่บนใบเสร็จ จึงไม่รวม
    billFees: Number(s.billFeeTotal),
    taxAmount: s.taxAmount === null ? null : Number(s.taxAmount),
    receiptAmount: s.receiptAmount === null ? null : Number(s.receiptAmount),
  };
}

export default function ReceiveReceiptPage() {
  return (
    <ReceivingQueuePage
      title="รับใบเสร็จ"
      dateColumnLabel="วันที่ยื่นเอกสาร"
      doneLabel="ได้รับใบเสร็จแล้ว"
      doneDateLabel="วันที่รับใบเสร็จ"
      receiptCheck
      emptyText="ไม่มีรายการที่ยื่นแล้วรอใบเสร็จ"
      loadPending={async () => (await api.listDocumentSubmissions(undefined, "PENDING")).submissions.map(toRow)}
      loadCompleted={async () => (await api.listDocumentSubmissions(undefined, "RECEIPT_RECEIVED")).submissions.map(toRow)}
      markDone={async (id, data) => {
        await api.updateDocumentSubmissionStatus(id, "RECEIPT_RECEIVED", {
          receivedDate: data.date,
          plateCategory: data.plateCategory,
          plateNumber: data.plateNumber,
          receiptAmount: data.receiptAmount || undefined,
        });
      }}
      markFailed={async (id, remark) => {
        await api.updateDocumentSubmissionStatus(id, "FAILED", { failRemark: remark });
      }}
    />
  );
}
