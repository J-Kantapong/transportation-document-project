"use client";

import { type FormEvent, useState } from "react";
import { ApiError, bookPhotoImageUrl, platePhotoImageUrl, receiptImageUrl } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { type VehiclePhotos, vehiclePhotosApi } from "@/lib/vehicle-photos-api";

// ค้นรูปตามเลขตัวถัง (ผู้ใช้ 2026-09-22): พิมพ์เลขตัวถัง (ทั้งหมดหรือส่วนท้าย) แล้วเห็นใบเสร็จ ป้าย เล่ม ของคันนั้นในหน้าเดียว
// รูปป้าย/เล่ม 1 รูปมีหลายคัน จึงแสดงรูปที่ใช้ยืนยันการรับของคันนั้น (Vehicle.platePhotoId / bookPhotoId)

const STATUS_LABEL: Record<string, string> = {
  PENDING: "รอใบเสร็จ",
  RECEIPT_RECEIVED: "ได้ใบเสร็จแล้ว",
  FAILED: "ยื่นไม่สำเร็จ",
};

const thumbStyle = { width: 96, height: 128, objectFit: "cover", borderRadius: 6, border: "1px solid #dfe5f0", display: "block" } as const;

function Thumb({ src, alt }: { src: string; alt: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" title="เปิดรูปเต็ม">
      {/* eslint-disable-next-line @next/next/no-img-element -- รูปมาจาก backend API ไม่ผ่าน next/image */}
      <img src={src} alt={alt} style={thumbStyle} />
    </a>
  );
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
      </div>
    </section>
  );
}

export function VehiclePhotosPage() {
  const [chassis, setChassis] = useState("");
  const [results, setResults] = useState<VehiclePhotos[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    if (!chassis.trim()) {
      setError("กรุณาระบุเลขตัวถัง");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { vehicles } = await vehiclePhotosApi.search(chassis);
      setResults(vehicles);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "ค้นหาไม่สำเร็จ");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="content">
      <h1>ค้นหารูปตามเลขตัวถัง</h1>
      <p className="muted" style={{ marginTop: -6, marginBottom: 16 }}>
        พิมพ์เลขตัวถังทั้งหมดหรือเฉพาะส่วนท้าย แล้วดูใบเสร็จ ป้ายทะเบียน และเล่มทะเบียนของรถคันนั้น
      </p>
      <form onSubmit={search} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <input
          className="inspect-input"
          style={{ flex: "1 1 260px", maxWidth: 420 }}
          value={chassis}
          onChange={(e) => setChassis(e.target.value)}
          placeholder="เลขตัวถัง เช่น MR0FZ29G001234567 หรือ 234567"
          autoFocus
        />
        <button type="submit" className="primary" disabled={loading}>
          {loading ? "กำลังค้นหา..." : "ค้นหา"}
        </button>
      </form>
      {error && <div className="import-error">{error}</div>}
      {results && results.length === 0 && <div className="empty-page">ไม่พบรถที่มีเลขตัวถังนี้</div>}
      {results && results.length >= 10 && <div className="muted" style={{ marginBottom: 10 }}>แสดง 10 คันแรก พิมพ์เลขตัวถังให้ยาวขึ้นเพื่อให้แคบลง</div>}
      {results?.map((v) => <VehicleCard key={v.id} v={v} />)}
    </div>
  );
}
