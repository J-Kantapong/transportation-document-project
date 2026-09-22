"use client";

import Link from "next/link";
import { useState } from "react";
import { BookPhotoPanel } from "@/components/BookPhotoPanel";
import { ReceivingQueuePage, type QueueRow } from "@/components/ReceivingQueuePage";
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
    photoUrl: r.bookPhotoId ? bookPhotoImageUrl(r.bookPhotoId) : null,
    doneDate: r.doneDate,
    recipient: r.recipient,
    note: r.note,
  };
}

// ใช้วิธีเดียวกับรับป้ายทะเบียน: ถ่ายรูปเล่ม -> AI อ่านเลขตัวรถ/ทะเบียน -> จับคู่กับรถในคิวด้านล่างให้เอง
export default function ReceiveBookPage() {
  const [reloadSignal, setReloadSignal] = useState(0);

  return (
    <ReceivingQueuePage
      title="รับเล่มทะเบียน"
      dateColumnLabel="วันที่รับงาน"
      doneLabel="รับเล่มแล้ว"
      doneDateLabel="วันที่รับเล่ม"
      emptyText="ไม่มีรถที่รอรับเล่มทะเบียน (ต้องได้รับใบเสร็จก่อน)"
      photoColumnLabel="รูปเล่ม"
      loadPending={async () => (await api.listReceivingPending("book")).vehicles.map(toRow)}
      loadCompleted={async () => (await api.listReceivingCompleted("book")).vehicles.map(toRow)}
      // ไม่ส่ง markDone = ติ๊กรับเล่มในตารางไม่ได้ ต้องมีรูปเล่มทุกคัน ยืนยันผ่านส่วนถ่ายรูปเล่มเท่านั้น
      reloadSignal={reloadSignal}
      headerSlot={
        <>
          <Link
            href="/registration/new-vehicle/receive-book/capture"
            className="primary"
            style={{ display: "inline-flex", marginTop: 14, textDecoration: "none" }}
          >
            📷 ถ่ายรูปเล่มจากมือถือ
          </Link>
          <BookPhotoPanel onConfirmed={() => setReloadSignal((n) => n + 1)} />
        </>
      }
    />
  );
}
