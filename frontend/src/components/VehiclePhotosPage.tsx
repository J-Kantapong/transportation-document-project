"use client";

import { useState } from "react";
import { bookPhotoImageUrl, platePhotoImageUrl, receiptImageUrl } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { PageHeader } from "@/components/ui";
import { isoToDisplayDate } from "@/lib/date";
import { type VehiclePhotos, vehiclePhotosApi } from "@/lib/vehicle-photos-api";
import { useTypeAhead } from "@/lib/use-type-ahead";

// ค้นรูปตามเลขตัวถัง (ผู้ใช้ 2026-09-22): พิมพ์เลขตัวถัง (ทั้งหมดหรือส่วนท้าย) แล้วเห็นใบเสร็จ ป้าย เล่ม ของคันนั้นในหน้าเดียว
// รูปป้าย/เล่ม 1 รูปมีหลายคัน จึงแสดงรูปที่ใช้ยืนยันการรับของคันนั้น (Vehicle.platePhotoId / bookPhotoId)

const STATUS_LABEL: Record<string, string> = {
  PENDING: "รอใบเสร็จ",
  RECEIPT_RECEIVED: "ได้ใบเสร็จแล้ว",
  FAILED: "ยื่นไม่สำเร็จ",
};

const thumbStyle = { width: 96, height: 128, objectFit: "cover", borderRadius: 6, border: "1px solid #dfe5f0", display: "block" } as const;

function Thumb({ src, alt }: { src: string; alt: string }) {
  return <AuthedImage src={src} alt={alt} style={thumbStyle} linkTitle="เปิดรูปเต็ม" />;
}

function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>
        {title} <span className="muted">({count})</span>
      </div>
      {count === 0 ? <div className="muted">ยังไม่มีรูป</div> : <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>{children}</div>}
    </div>
  );
}

// รูปใบเสร็จ / ป้าย / เล่มของรถคันหนึ่ง - ใช้ทั้งหน้าค้นหารูปและกล่องรูปในหน้าค้นหารถ
export function VehiclePhotoGallery({ v }: { v: VehiclePhotos }) {
  return (
    <>
        <Group title="ใบเสร็จ" count={v.receipts.length}>
          {v.receipts.map((r, i) => (
            <div key={r.id} style={{ width: 96 }}>
              <Thumb src={receiptImageUrl(r.id)} alt={`ใบเสร็จรูปที่ ${i + 1}`} />
              <div className="muted" style={{ fontSize: 12, marginTop: 4, lineHeight: 1.35 }}>
                ยื่น {isoToDisplayDate(r.submitDate)}
                <br />
                {r.receiptNo ? `เลขที่ ${r.receiptNo}` : (STATUS_LABEL[r.submissionStatus] ?? r.submissionStatus)}
              </div>
            </div>
          ))}
        </Group>
        <Group title="ป้ายทะเบียน" count={v.platePhoto ? 1 : 0}>
          {v.platePhoto && (
            <div style={{ width: 96 }}>
              <Thumb src={platePhotoImageUrl(v.platePhoto.id)} alt="รูปป้ายทะเบียน" />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                รับป้าย {v.platePhoto.receivedDate ? isoToDisplayDate(v.platePhoto.receivedDate) : "-"}
              </div>
            </div>
          )}
        </Group>
        <Group title="เล่มทะเบียน" count={v.bookPhoto ? 1 : 0}>
          {v.bookPhoto && (
            <div style={{ width: 96 }}>
              <Thumb src={bookPhotoImageUrl(v.bookPhoto.id)} alt="รูปเล่มทะเบียน" />
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                รับเล่ม {v.bookPhoto.receivedDate ? isoToDisplayDate(v.bookPhoto.receivedDate) : "-"}
              </div>
            </div>
          )}
        </Group>
    </>
  );
}

function VehicleCard({ v }: { v: VehiclePhotos }) {
  const plate = [v.plateCategory, v.plateNumber].filter(Boolean).join(" ");
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <div>
          <strong style={{ fontSize: 16 }}>{v.chassis}</strong>
          <div className="muted" style={{ marginTop: 2 }}>
            {v.brandName} · {v.customerName} · {v.body ?? "ไม่ระบุประเภทรถ"}
            {plate ? ` · ทะเบียน ${plate}` : ""} · บันทึก {isoToDisplayDate(v.date)}
          </div>
        </div>
      </div>
      <div style={{ padding: "0 18px 18px" }}>
        <VehiclePhotoGallery v={v} />
      </div>
    </section>
  );
}

export function VehiclePhotosPage() {
  const [chassis, setChassis] = useState("");
  // ค้นระหว่างพิมพ์ตั้งแต่ 3 ตัวอักษร (ผู้ใช้ 2026-11-19) - เดิมต้องกดปุ่มค้นหา
  const { data, searching: loading } = useTypeAhead(chassis, vehiclePhotosApi.search, { minLength: 3 });
  const results = data?.vehicles ?? null;

  return (
    <div className="content">
      <PageHeader title="ค้นหารูปตามเลขตัวถัง" subtitle="พิมพ์เลขตัวถังทั้งหมดหรือเฉพาะส่วนท้าย แล้วดูใบเสร็จ ป้ายทะเบียน และเล่มทะเบียนของรถคันนั้น" />
      <form onSubmit={(e) => e.preventDefault()} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 20 }}>
        <input
          className="inspect-input"
          style={{ flex: "1 1 260px", maxWidth: 420 }}
          value={chassis}
          onChange={(e) => setChassis(e.target.value)}
          placeholder="เลขตัวถัง เช่น MR0FZ29G001234567 หรือ 234567"
          autoFocus
        />
        {loading && <span className="muted">กำลังค้นหา…</span>}
      </form>
      {chassis.trim().length > 0 && chassis.trim().length < 3 && <div className="muted">พิมพ์อย่างน้อย 3 ตัวอักษร</div>}
      {results && results.length === 0 && <div className="empty-page">ไม่พบรถที่มีเลขตัวถังนี้</div>}
      {results && results.length >= 10 && <div className="muted" style={{ marginBottom: 10 }}>แสดง 10 คันแรก พิมพ์เลขตัวถังให้ยาวขึ้นเพื่อให้แคบลง</div>}
      {results?.map((v) => <VehicleCard key={v.id} v={v} />)}
    </div>
  );
}
