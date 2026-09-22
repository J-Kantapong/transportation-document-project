"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PlateKindTabs, PlatePhotoPanel, isMotorcycleBody, loadPlateKind, savePlateKind } from "@/components/PlatePhotoPanel";
import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
import { api, platePhotoImageUrl, type PlateKind, type ReceivingRow } from "@/lib/api";
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
    photoUrl: r.platePhotoId ? platePhotoImageUrl(r.platePhotoId) : null,
    doneDate: r.doneDate,
    recipient: r.recipient,
    note: r.note,
  };
}

// ผู้ใช้ 2026-09-21: แยกป้ายรถยนต์กับมอเตอร์ไซค์ - ป้ายสองประเภทเลขซ้ำกันได้ จึงถ่าย/จับคู่/แสดงคิวแยกตามแท็บ
export default function ReceivePlatePage() {
  const [reloadSignal, setReloadSignal] = useState(0);
  const [kind, setKind] = useState<PlateKind>("car");
  const sameKind = (r: ReceivingRow) => isMotorcycleBody(r.body) === (kind === "moto");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount (ตอน render ฝั่ง server ไม่มี window)
    setKind(loadPlateKind());
  }, []);

  function switchKind(next: PlateKind) {
    setKind(next);
    savePlateKind(next);
  }

  return (
    <ReceivingQueuePage
      // เปลี่ยนแท็บ = โหลดคิวของประเภทนั้นใหม่
      key={kind}
      title="รับป้ายทะเบียน"
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับป้ายแล้ว"
      doneDateLabel="วันที่รับป้าย"
      emptyText={`ไม่มี${kind === "moto" ? "มอเตอร์ไซค์" : "รถยนต์"}ที่รอรับป้ายทะเบียน (ต้องได้รับใบเสร็จก่อน)`}
      showReceiptNo
      photoColumnLabel="รูปป้าย"
      // เรียงตามหมวด+เลขทะเบียน ให้ถือรายการไปห้องรับป้ายได้เลย (กก 1 … กก 9999 แล้ว กข 1 …)
      loadPending={async () => (await api.listReceivingPending("plate")).vehicles.filter(sameKind).map(toRow).sort(comparePlate)}
      loadCompleted={async () => (await api.listReceivingCompleted("plate")).vehicles.filter(sameKind).map(toRow)}
      // ไม่ส่ง markDone = ติ๊กรับป้ายในตารางไม่ได้ - ผู้ใช้ 2026-09-21: ต้องมีรูปป้ายทุกคัน ยืนยันผ่านส่วนถ่ายรูปป้ายเท่านั้น
      reloadSignal={reloadSignal}
      // ถ่ายรูปป้าย -> AI อ่านทะเบียน -> จับคู่กับรถในคิวด้านล่างให้เอง
      headerSlot={
        <>
          <Link
            href="/registration/new-vehicle/receive-plate/capture"
            className="primary"
            style={{ display: "inline-flex", marginTop: 14, textDecoration: "none" }}
          >
            📷 ถ่ายรูปป้ายจากมือถือ
          </Link>
          <PlateKindTabs kind={kind} onChange={switchKind} />
          <PlatePhotoPanel kind={kind} onConfirmed={() => setReloadSignal((n) => n + 1)} />
        </>
      }
    />
  );
}
