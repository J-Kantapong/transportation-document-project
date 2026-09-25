"use client";

import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
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
    recipient: r.recipient,
    note: r.note,
    submitDate: r.submitDate,
    urgent: r.urgent,
    submittedAt: r.submittedAt,
  };
}

// ใช้วิธีเดียวกับรับป้ายทะเบียน: แนบรูปเล่มทีละคันในคิวแล้วบันทึกรับทันที (ผู้ใช้ 2026-09-26 ยกเลิก AI อ่าน/จับคู่รูป)
// ผู้ใช้ 2026-09-26: รถยนต์กับมอเตอร์ไซค์คนละหน้า (/receive-book/car, /moto) - คิวแยกตามประเภท
export function ReceiveBookQueue({ kind }: { kind: VehicleKind }) {
  const sameKind = (r: ReceivingRow) => isMotorcycleBody(r.body) === (kind === "moto");

  return (
    <ReceivingQueuePage
      title={`รับเล่มทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      back={{ href: "/registration/new-vehicle/receive-book", label: "← เลือกประเภทรถ" }}
      groupBySheet
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับเล่มแล้ว"
      doneDateLabel="วันที่รับเล่ม"
      emptyText={`ไม่มี${VEHICLE_KIND_LABEL[kind]}ที่รอรับเล่มทะเบียน (ต้องได้รับใบเสร็จก่อน)`}
      showReceiptNo
      photoColumnLabel="รูปเล่ม"
      printTitle={`รายการรอรับเล่มทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      loadPending={async () => (await api.listReceivingPending("book")).vehicles.filter(sameKind).map(toRow)}
      loadCompleted={async () => (await api.listReceivingCompleted("book")).vehicles.filter(sameKind).map(toRow)}
      // ไม่ส่ง markDone = ติ๊กรับเล่มในตารางไม่ได้ ต้องมีรูปเล่มทุกคัน
      attachPhoto={{
        label: "แนบรูปเล่ม",
        upload: async (id, file, date) => {
          await api.attachBookPhoto(id, await compressReceiptImage(file), compressedFileName(file), date);
        },
      }}
    />
  );
}
