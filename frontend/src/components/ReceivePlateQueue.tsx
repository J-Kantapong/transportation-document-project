"use client";

import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
import { VEHICLE_KIND_LABEL } from "@/components/VehicleKindChooser";
import { api, platePhotoImageUrl, type PlateKind, type ReceivingRow } from "@/lib/api";

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
    photoUrl: r.platePhotoId ? platePhotoImageUrl(r.platePhotoId) : null,
    doneDate: r.doneDate,
    recipient: r.recipient,
    note: r.note,
    submitDate: r.submitDate,
    urgent: r.urgent,
    submittedAt: r.submittedAt,
  };
}

// ผู้ใช้ 2026-09-21: แยกป้ายรถยนต์กับมอเตอร์ไซค์ - ป้ายสองประเภทเลขซ้ำกันได้ จึงแสดงคิวแยกกัน
// ผู้ใช้ 2026-09-26: จากแท็บเป็นคนละหน้า /receive-plate/car และ /receive-plate/moto (หน้า /receive-plate ให้เลือกก่อน)
export function ReceivePlateQueue({ kind }: { kind: PlateKind }) {
  const sameKind = (r: ReceivingRow) => isMotorcycleBody(r.body) === (kind === "moto");

  return (
    <ReceivingQueuePage
      title={`รับป้ายทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      back={{ href: "/registration/new-vehicle/receive-plate", label: "← เลือกประเภทรถ" }}
      groupBySheet
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับป้ายแล้ว"
      doneDateLabel="วันที่รับป้าย"
      emptyText={`ไม่มี${VEHICLE_KIND_LABEL[kind]}ที่รอรับป้ายทะเบียน (ต้องได้รับใบเสร็จก่อน)`}
      showReceiptNo
      photoColumnLabel="รูปป้าย"
      printTitle={`รายการรอรับป้ายทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      // ลำดับ: ตามที่บันทึกยื่นเป็นค่าเริ่มต้น กดเรียงตามหมวด+เลขทะเบียนได้ (จัดใน ReceivingQueuePage)
      loadPending={async () => (await api.listReceivingPending("plate")).vehicles.filter(sameKind).map(toRow)}
      loadCompleted={async () => (await api.listReceivingCompleted("plate")).vehicles.filter(sameKind).map(toRow)}
      // ไม่ส่ง markDone = ติ๊กรับป้ายในตารางไม่ได้ - ต้องมีรูปป้ายทุกคัน (ผู้ใช้ 2026-09-21): แนบรูปทีละคันแล้วบันทึกรับทันที
      // (ผู้ใช้ 2026-09-26 ยกเลิก AI อ่าน/จับคู่รูป)
      attachPhoto={{
        label: "แนบรูปป้าย",
        upload: async (id, file, date) => {
          await api.attachPlatePhoto(id, await compressReceiptImage(file), compressedFileName(file), date);
        },
      }}
    />
  );
}
