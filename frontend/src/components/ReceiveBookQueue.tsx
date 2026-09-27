"use client";

import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
import { useCanReceive } from "@/components/ReceivePlateQueue";
import { VEHICLE_KIND_LABEL, type VehicleKind } from "@/components/VehicleKindChooser";
import { api, bookPhotoImageUrl, type ReceivingRow } from "@/lib/api";

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
    photoUrl: r.bookPhotoId ? bookPhotoImageUrl(r.bookPhotoId) : null,
    doneDate: r.doneDate,
    submitDate: r.submitDate,
    receiptDate: r.receiptDate,
    urgent: r.urgent,
    submittedAt: r.submittedAt,
    itemDeliveredDate: r.itemDeliveredDate,
  };
}

// ใช้วิธีเดียวกับรับป้ายทะเบียน: แนบรูปเล่มทีละคันในคิวแล้วบันทึกรับทันที (ผู้ใช้ 2026-09-26 ยกเลิก AI อ่าน/จับคู่รูป)
// ผู้ใช้ 2026-09-26: รถยนต์กับมอเตอร์ไซค์คนละหน้า (/receive-book/car, /moto) - คิวแยกตามประเภท
export function ReceiveBookQueue({ kind }: { kind: VehicleKind }) {
  const canWrite = useCanReceive(kind);

  return (
    <ReceivingQueuePage
      title={`รับเล่มทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      back={{ href: "/registration/new-vehicle/receive-book", label: "← เลือกประเภทรถ" }}
      headerSlot={canWrite === false ? <p className="muted">ดูได้อย่างเดียว - บันทึกรับเล่มได้เฉพาะพนักงานยื่น{VEHICLE_KIND_LABEL[kind]}</p> : undefined}
      groupBySheet
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับเล่มแล้ว"
      doneDateLabel="วันที่รับเล่ม"
      emptyText={`ไม่มี${VEHICLE_KIND_LABEL[kind]}ที่รอรับเล่มทะเบียน (ต้องได้รับใบเสร็จก่อน)`}
      showReceiptNo
      photoColumnLabel="รูปเล่ม"
      printTitle={`รายการรอรับเล่มทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      // กรองประเภทรถที่ backend (พบ 2026-09-27) - ดู ReceivePlateQueue
      loadPending={async () => (await api.listReceivingPending("book", kind)).vehicles.map(toRow)}
      loadCompleted={async ({ q, offset, limit }) => {
        const res = await api.listReceivingCompleted("book", { kind, q, offset, limit });
        return { rows: res.vehicles.map(toRow), hasMore: res.hasMore };
      }}
      // ต้องมีรูปเล่มทุกคัน: แนบรูปทีละคันแล้วบันทึกรับทันที
      attachPhoto={
        canWrite
          ? {
              label: "แนบรูปเล่ม",
              upload: async (id, file, date) => api.attachBookPhoto(id, await compressReceiptImage(file), compressedFileName(file), date),
            }
          : undefined
      }
      fixReceived={
        canWrite
          ? {
              itemLabel: "เล่ม",
              updateDate: (id, date, remark) => api.updateBookReceivedDate(id, date, remark),
              detach: (id, remark) => api.detachBookPhoto(id, remark),
            }
          : undefined
      }
    />
  );
}
