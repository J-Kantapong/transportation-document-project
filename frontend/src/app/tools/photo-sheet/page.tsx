"use client";

import { useRef, useState, type DragEvent } from "react";
import {
  downloadPhotoSheet,
  fitInCell,
  loadSheetPhoto,
  PAGE_H_MM,
  PAGE_W_MM,
  PHOTOS_PER_PAGE,
  rotateSheetPhoto,
  sheetPages,
  type SheetPhoto,
} from "@/lib/photo-sheet";

// จัดรูปลง A4 (ผู้ใช้ 2026-10-09): ลูกค้าส่งรูปตรวจนอกมาเป็นรูปๆ พนักงานเลือกรูปทั้งหมดใส่หน้านี้ แล้วได้ PDF A4 ที่จัดหน้าให้แล้ว
// แบบใบตัวอย่าง (รูปรวมกันในแผ่นเดียว) - ไม่ส่งรูปขึ้นเซิร์ฟเวอร์ ไม่เก็บลงระบบ ปิดหน้าแล้วรูปหาย

const pct = (value: number, of: number) => `${(value / of) * 100}%`;

export default function PhotoSheetPage() {
  const [photos, setPhotos] = useState<SheetPhoto[]>([]);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function addFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) {
      setError("ไม่พบไฟล์รูป เลือกได้เฉพาะไฟล์รูปภาพ");
      return;
    }
    setBusy(true);
    setError("");
    const failed: string[] = [];
    for (const file of images) {
      try {
        const photo = await loadSheetPhoto(file);
        setPhotos((prev) => [...prev, photo]);
      } catch {
        failed.push(file.name);
      }
    }
    if (failed.length) setError(`เปิดรูปไม่ได้ ${failed.length} ไฟล์: ${failed.join(", ")} (ลองบันทึกเป็น JPG แล้วเลือกใหม่)`);
    setBusy(false);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void addFiles([...event.dataTransfer.files]);
  }

  function move(index: number, by: number) {
    setPhotos((prev) => {
      const to = index + by;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[to]] = [next[to], next[index]];
      return next;
    });
  }

  async function rotate(id: string) {
    const photo = photos.find((p) => p.id === id);
    if (!photo) return;
    try {
      const rotated = await rotateSheetPhoto(photo);
      setPhotos((prev) => prev.map((p) => (p.id === id ? rotated : p)));
    } catch {
      setError("หมุนรูปไม่สำเร็จ");
    }
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      await downloadPhotoSheet(photos, title);
    } catch {
      setError("บันทึก PDF ไม่สำเร็จ ลองลดจำนวนรูปแล้วกดใหม่");
    } finally {
      setBusy(false);
    }
  }

  const heading = title.trim();
  const pages = sheetPages(photos.length, Boolean(heading));

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>จัดรูปลง A4</h1>
          <p>เลือกรูปที่ลูกค้าส่งมาทั้งหมด ระบบจัดลงกระดาษ A4 ให้ แล้วบันทึกเป็น PDF พร้อมพิมพ์ (รูปไม่ถูกเก็บในระบบ)</p>
        </div>
      </div>

      <section
        className="panel"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{ padding: 24, outline: dragging ? "2px dashed #1f6f8b" : undefined }}
      >
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label className="field" style={{ flex: "1 1 280px" }}>
            ข้อความหัวกระดาษ (ไม่ใส่ก็ได้)
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="เช่น เลขตัวถัง ทะเบียน หรือชื่อลูกค้า" maxLength={120} />
          </label>
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <button className="primary" type="button" onClick={() => input.current?.click()} disabled={busy}>
            + เลือกรูป
          </button>
          <button className="primary" type="button" onClick={save} disabled={busy || !photos.length}>
            {busy ? "กำลังทำ…" : "บันทึก PDF"}
          </button>
          {photos.length > 0 && (
            <button className="text-button" type="button" onClick={() => setPhotos([])} disabled={busy}>
              ล้างทั้งหมด
            </button>
          )}
        </div>
        <p className="muted" style={{ margin: "12px 0 0" }}>
          {photos.length
            ? `${photos.length} รูป · ${pages.length} หน้า (หน้าละไม่เกิน ${PHOTOS_PER_PAGE} รูป) · ลากรูปมาวางเพิ่มได้`
            : "กด + เลือกรูป หรือลากรูปมาวางตรงนี้ เลือกได้หลายรูปพร้อมกัน"}
        </p>
        {error && (
          <p className="customer-message error" role="alert">
            {error}
          </p>
        )}

        {photos.length > 0 && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
            {photos.map((photo, index) => (
              <div key={photo.id} style={{ width: 132, border: "1px solid #d5dbe3", borderRadius: 6, padding: 6, background: "#fff" }}>
                {/* eslint-disable-next-line @next/next/no-img-element -- รูปจากเครื่องผู้ใช้ (data URL) ไม่ผ่านตัวปรับรูปของ Next */}
                <img src={photo.dataUrl} alt={photo.name} style={{ width: "100%", height: 84, objectFit: "contain", background: "#f3f5f8" }} />
                <div className="sub" style={{ textAlign: "center" }}>
                  รูปที่ {index + 1}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button className="text-button" type="button" aria-label={`เลื่อนรูปที่ ${index + 1} ไปก่อนหน้า`} onClick={() => move(index, -1)} disabled={index === 0}>
                    ←
                  </button>
                  <button className="text-button" type="button" aria-label={`หมุนรูปที่ ${index + 1}`} onClick={() => void rotate(photo.id)}>
                    ↻
                  </button>
                  <button className="text-button" type="button" aria-label={`ลบรูปที่ ${index + 1}`} onClick={() => setPhotos((prev) => prev.filter((p) => p.id !== photo.id))}>
                    ✕
                  </button>
                  <button
                    className="text-button"
                    type="button"
                    aria-label={`เลื่อนรูปที่ ${index + 1} ไปถัดไป`}
                    onClick={() => move(index, 1)}
                    disabled={index === photos.length - 1}
                  >
                    →
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {pages.length > 0 && (
        <section className="panel" style={{ padding: 24 }}>
          <h2 style={{ marginTop: 0 }}>ตัวอย่างก่อนบันทึก</h2>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
            {pages.map((cells, pageIndex) => (
              <div
                key={pageIndex}
                aria-label={`ตัวอย่างหน้า ${pageIndex + 1}`}
                style={{
                  position: "relative",
                  width: "min(100%, 420px)",
                  aspectRatio: `${PAGE_W_MM} / ${PAGE_H_MM}`,
                  background: "#fff",
                  border: "1px solid #b9c2cd",
                  boxShadow: "0 2px 8px rgba(0,0,0,.08)",
                  containerType: "inline-size",
                }}
              >
                {heading && (
                  <div
                    style={{
                      position: "absolute",
                      left: pct(10, PAGE_W_MM),
                      right: pct(10, PAGE_W_MM),
                      top: pct(10, PAGE_H_MM),
                      height: pct(10, PAGE_H_MM),
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 700,
                      fontSize: "4cqw",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    }}
                  >
                    {heading}
                  </div>
                )}
                {cells.map((cell, i) => {
                  const photo = photos[pageIndex * PHOTOS_PER_PAGE + i];
                  const at = fitInCell(cell, photo.width, photo.height);
                  return (
                    // eslint-disable-next-line @next/next/no-img-element -- รูปจากเครื่องผู้ใช้ (data URL)
                    <img
                      key={photo.id}
                      src={photo.dataUrl}
                      alt={`รูปที่ ${pageIndex * PHOTOS_PER_PAGE + i + 1}`}
                      style={{
                        position: "absolute",
                        left: pct(at.x, PAGE_W_MM),
                        top: pct(at.y, PAGE_H_MM),
                        width: pct(at.w, PAGE_W_MM),
                        height: pct(at.h, PAGE_H_MM),
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
