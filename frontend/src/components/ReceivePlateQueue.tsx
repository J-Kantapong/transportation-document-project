"use client";

import { useEffect, useState } from "react";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { canEditSubmitSteps, getCachedUser, writeScopeFor } from "@/lib/auth";
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
    submitDate: r.submitDate,
    receiptDate: r.receiptDate,
    urgent: r.urgent,
    submittedAt: r.submittedAt,
    itemDeliveredDate: r.itemDeliveredDate,
    bookDeliveredDate: r.bookDeliveredDate ?? null,
  };
}

// บันทึก/แก้ได้เฉพาะ ADMIN / STAFF_CAR / STAFF_MOTO ในประเภทรถของตัวเอง - ACCOUNTANT ดูอย่างเดียว
// (พบ 2026-09-27: เดิมแสดงปุ่มแนบรูปให้ทุกบทบาท กดแล้วขึ้น 403) - อ่าน localStorage หลัง mount (null = ยังไม่รู้)
export function useCanReceive(kind: PlateKind): boolean | null {
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  useEffect(() => {
    const roles = getCachedUser()?.roles ?? [];
    const scope = writeScopeFor(roles);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCanWrite(canEditSubmitSteps(roles) && (scope === "ALL" || scope === (kind === "moto" ? "MOTO" : "CAR")));
  }, [kind]);
  return canWrite;
}

// ผู้ใช้ 2026-09-21: แยกป้ายรถยนต์กับมอเตอร์ไซค์ - ป้ายสองประเภทเลขซ้ำกันได้ จึงแสดงคิวแยกกัน
// ผู้ใช้ 2026-09-26: จากแท็บเป็นคนละหน้า /receive-plate/car และ /receive-plate/moto (หน้า /receive-plate ให้เลือกก่อน)
export function ReceivePlateQueue({ kind }: { kind: PlateKind }) {
  const canWrite = useCanReceive(kind);

  return (
    <ReceivingQueuePage
      title={`รับป้ายทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      back={{ href: "/registration/new-vehicle/receive-plate", label: "← เลือกประเภทรถ" }}
      headerSlot={canWrite === false ? <p className="muted">ดูได้อย่างเดียว - บันทึกรับป้ายได้เฉพาะพนักงานยื่น{VEHICLE_KIND_LABEL[kind]}</p> : undefined}
      groupBySheet
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับป้ายแล้ว"
      doneDateLabel="วันที่รับป้าย"
      emptyText={`ไม่มี${VEHICLE_KIND_LABEL[kind]}ที่รอรับป้ายทะเบียน (ต้องได้รับใบเสร็จก่อน)`}
      showReceiptNo
      photoColumnLabel="รูปป้าย"
      printTitle={`รายการรอรับป้ายทะเบียน · ${VEHICLE_KIND_LABEL[kind]}`}
      // ลำดับ: ตามที่บันทึกยื่นเป็นค่าเริ่มต้น กดเรียงตามหมวด+เลขทะเบียนได้ (จัดใน ReceivingQueuePage)
      // กรองประเภทรถที่ backend (พบ 2026-09-27: ตาราง "ดำเนินการแล้ว" เคยตัด 100 คันรวมสองประเภทก่อนกรอง คันที่เพิ่งแนบจึงหายไป)
      loadPending={async () => (await api.listReceivingPending("plate", kind)).vehicles.map(toRow)}
      loadCompleted={async ({ q, offset, limit }) => {
        const res = await api.listReceivingCompleted("plate", { kind, q, offset, limit });
        return { rows: res.vehicles.map(toRow), hasMore: res.hasMore };
      }}
      // ต้องมีรูปป้ายทุกคัน (ผู้ใช้ 2026-09-21): แนบรูปทีละคันแล้วบันทึกรับทันที (ผู้ใช้ 2026-09-26 ยกเลิก AI อ่าน/จับคู่รูป)
      attachPhoto={
        canWrite
          ? {
              label: "แนบรูปป้าย",
              upload: async (id, file, date) => api.attachPlatePhoto(id, await compressReceiptImage(file), compressedFileName(file), date),
            }
          : undefined
      }
      fixReceived={
        canWrite
          ? {
              itemLabel: "ป้าย",
              updateDate: (id, date, remark) => api.updatePlateReceivedDate(id, date, remark),
              detach: (id, remark) => api.detachPlatePhoto(id, remark),
            }
          : undefined
      }
    />
  );
}
