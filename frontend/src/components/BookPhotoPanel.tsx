"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api, bookPhotoImageUrl, type BookPhotoBook, type BookPhotoList, type BookPhotoVehicle } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { uploadAllInBackground, usePolling } from "@/lib/receipt-upload";
import { DateInput } from "@/components/DateInput";

// ถ่ายรูปเล่มทะเบียนเพื่อยืนยันการรับเล่ม (Step 7) - ใช้วิธีเดียวกับรูปป้าย (PlatePhotoPanel):
// AI อ่านเลขตัวรถ (VIN) + ทะเบียนในเล่ม (รูปเดียวหลายเล่มได้) แล้วระบบจับคู่กับรถที่รอรับเล่ม
// VIN ตรง = ติ๊กให้ · อ่าน VIN ไม่ได้แต่ทะเบียนตรงคันเดียว = ติ๊กให้ · อื่นๆ เสนอให้เลือก ไม่ติ๊กให้ · AI ไม่บันทึกเอง
// VIN ไม่ซ้ำกันเลย จึงไม่ต้องแยกแท็บรถยนต์/มอเตอร์ไซค์เหมือนป้าย

interface Choice {
  vehicleId: string; // "" = ยังไม่เลือก
  checked: boolean;
}

const bookKey = (photoId: string, index: number) => `${photoId}:${index}`;
const vehiclePlate = (v: BookPhotoVehicle) => (v.plateCategory || v.plateNumber ? `${v.plateCategory ?? "?"} ${v.plateNumber ?? "?"}` : "ยังไม่มีทะเบียน");
const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "ดำเนินการไม่สำเร็จ");

// ค่าเริ่มต้น: ตรงติ๊กให้ (ยกเว้นทะเบียนในเล่มไม่ตรงกับที่บันทึก), ใกล้เคียงคันเดียวเลือกคันให้แต่ไม่ติ๊ก
function defaultChoice(book: BookPhotoBook): Choice {
  const { kind, vehicleIds, plateMismatch } = book.match;
  if (kind === "exact") return { vehicleId: vehicleIds[0], checked: !plateMismatch };
  if (kind === "close" && vehicleIds.length === 1) return { vehicleId: vehicleIds[0], checked: false };
  return { vehicleId: "", checked: false };
}

const STATUS = {
  ok: { color: "#23825f", background: "#edf8f3" },
  warn: { color: "#bb8527", background: "#fff8e6" },
  bad: { color: "#b43434", background: "#fdeeee" },
  info: { color: "#5a6b87", background: "#f3f5f9" },
};

export function BookPhotoPanel({ onConfirmed, compact }: { onConfirmed?: () => void; compact?: boolean }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<BookPhotoList>({ photos: [], vehicles: [] });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  // วันที่รับเล่ม: เหมือนหน้ารับป้าย - เติมอัตโนมัติเป็นวันที่บันทึก (วันนี้) null = ยังไม่แก้เอง พนักงานแก้เป็นวันอื่นได้
  const [editedDate, setEditedDate] = useState<string | null>(null);
  const dateText = editedDate ?? isoToDisplayDate(todayIso());
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // รวมผลใหม่เข้ากับที่มีอยู่ - คงตัวเลือกที่พนักงานแก้ไว้แล้ว ใส่ค่าเริ่มต้นให้เฉพาะเล่มที่เพิ่งมา
  function merge(next: BookPhotoList, replace: boolean) {
    setData((prev) => {
      // ไม่ replace: รูปเดิมอัปเดตที่ตำแหน่งเดิม (ผลอ่านเบื้องหลังเข้ามาแล้วการ์ดไม่กระโดด) รูปใหม่ต่อท้าย
      const nextById = new Map(next.photos.map((p) => [p.id, p]));
      const photos = replace
        ? next.photos
        : [...prev.photos.map((p) => nextById.get(p.id) ?? p), ...next.photos.filter((n) => !prev.photos.some((p) => p.id === n.id))];
      const vehicles = [...new Map([...(replace ? [] : prev.vehicles), ...next.vehicles].map((v) => [v.id, v])).values()];
      return { photos, vehicles };
    });
    setChoices((prev) => {
      const out = replace ? {} : { ...prev };
      for (const photo of next.photos) {
        photo.books.forEach((book, i) => {
          const key = bookKey(photo.id, i);
          out[key] = (!replace && prev[key]) || defaultChoice(book);
        });
      }
      return out;
    });
  }

  async function load() {
    try {
      merge(await api.listOpenBookPhotos(), true);
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ถ่ายจากกล้อง (ทีละรูป) = อ่านทันที เห็นผลตอนของยังอยู่ตรงหน้า
  async function handleCamera(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setMessage({ text: "" });
    setProgress("กำลังอ่านเล่มทะเบียน…");
    try {
      const image = await compressReceiptImage(file);
      merge(await api.uploadBookPhoto(image, compressedFileName(file)), false);
    } catch (err) {
      setMessage({ text: `ส่งไม่สำเร็จ - ${errorText(err)}`, error: true });
    }
    setProgress("");
    if (cameraRef.current) cameraRef.current.value = "";
  }

  // เลือกหลายรูปจากเครื่อง = ส่งพร้อมกันแบบไม่รอ AI - รูปขึ้นเป็น "กำลังอ่าน" แล้วผลทยอยเข้ามา (usePolling ด้านล่าง)
  async function handleGallery(files: FileList | null) {
    if (!files || files.length === 0) return;
    setMessage({ text: "" });
    const list = Array.from(files);
    const failed: string[] = [];
    setProgress(`กำลังส่งรูป 0/${list.length}…`);
    await uploadAllInBackground(
      list,
      (image, fileName) => api.uploadBookPhoto(image, fileName, true),
      (res) => merge(res, false),
      (file, err) => failed.push(`${file.name}: ${errorText(err)}`),
      (done) => setProgress(`กำลังส่งรูป ${done}/${list.length}…`),
    );
    setProgress("");
    setMessage(
      failed.length
        ? { text: `ส่งไม่สำเร็จ ${failed.length} รูป - ${failed.join(" · ")}`, error: true }
        : { text: `ส่งครบ ${list.length} รูปแล้ว - ระบบกำลังอ่านเล่มทะเบียน ไปทำอย่างอื่นก่อนแล้วค่อยกลับมายืนยันได้` },
    );
    if (galleryRef.current) galleryRef.current.value = "";
  }

  // รูปที่ยังรออ่าน: ถามถาดใหม่ทุก 3 วินาที แล้วรับเฉพาะรูปที่อ่านเสร็จ (ไม่ทับรูปอื่นที่พนักงานกำลังติ๊กอยู่)
  const pendingIds = data.photos.filter((p) => p.readPending).map((p) => p.id);
  usePolling(pendingIds.length > 0, async () => {
    const next = await api.listOpenBookPhotos();
    const read = next.photos.filter((p) => pendingIds.includes(p.id) && !p.readPending);
    if (read.length) merge({ photos: read, vehicles: next.vehicles }, false);
  });

  const vehicleById = new Map(data.vehicles.map((v) => [v.id, v]));

  // รถที่จะยืนยัน (ไม่ซ้ำคัน - ถ่ายเล่มเดียวกันซ้ำนับครั้งเดียว ใช้รูปแรกเป็นหลักฐาน)
  const selected = new Map<string, string>(); // vehicleId -> photoId
  for (const photo of data.photos) {
    photo.books.forEach((_, i) => {
      const c = choices[bookKey(photo.id, i)];
      if (c?.checked && c.vehicleId && !selected.has(c.vehicleId)) selected.set(c.vehicleId, photo.id);
    });
  }

  // รูปที่ทุกเล่มจัดการแล้ว (ติ๊กยืนยัน หรือเป็นเล่มที่รับไปแล้ว) - ปิดออกจากถาดหลังยืนยัน
  const resolvedPhotoIds = data.photos
    .filter((photo) => photo.books.length > 0 && photo.books.every((b, i) => b.match.kind === "received" || choices[bookKey(photo.id, i)]?.checked))
    .map((p) => p.id);

  async function confirm() {
    const dateIso = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!dateIso) return setMessage({ text: "วันที่รับเล่มไม่ถูกต้อง", error: true });
    if (selected.size === 0) return setMessage({ text: "ยังไม่ได้ติ๊กรถที่จะยืนยัน", error: true });
    setProgress("กำลังบันทึก…");
    try {
      const items = [...selected].map(([vehicleId, photoId]) => ({ vehicleId, photoId }));
      const res = await api.confirmBookPhotos(dateIso, items, resolvedPhotoIds);
      await load();
      onConfirmed?.();
      setEditedDate(null); // รอบถัดไปกลับไปใช้วันที่บันทึกอัตโนมัติ
      setMessage(
        res.failed.length
          ? { text: `ยืนยันแล้ว ${res.succeeded.length} คัน · ไม่สำเร็จ ${res.failed.length} คัน - ${res.failed.map((f) => f.error).join(" · ")}`, error: true }
          : { text: `ยืนยันรับเล่มแล้ว ${res.succeeded.length} คัน` },
      );
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    } finally {
      setProgress("");
    }
  }

  async function hidePhoto(photoId: string) {
    try {
      await api.confirmBookPhotos(todayIso(), [], [photoId]);
      setData((prev) => ({ ...prev, photos: prev.photos.filter((p) => p.id !== photoId) }));
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  async function deletePhoto(photoId: string) {
    try {
      await api.deleteBookPhoto(photoId);
      setData((prev) => ({ ...prev, photos: prev.photos.filter((p) => p.id !== photoId) }));
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  const setChoice = (key: string, patch: Partial<Choice>) => setChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const busy = progress !== "";

  function renderBook(photoId: string, book: BookPhotoBook, index: number) {
    const key = bookKey(photoId, index);
    const choice = choices[key] ?? { vehicleId: "", checked: false };
    const { kind, vehicleIds, by, plateMismatch, provinceMismatch } = book.match;
    const plateRead = book.category || book.number ? `${book.category ?? "?"} ${book.number ?? "?"}${book.province ? ` ${book.province}` : ""}` : "—";
    const chosen = choice.vehicleId ? vehicleById.get(choice.vehicleId) : undefined;
    const duplicate = chosen && choice.checked && selected.get(chosen.id) !== photoId ? " (เห็นในรูปอื่นแล้ว)" : "";

    let style = STATUS.info;
    let status: string;
    if (kind === "exact") {
      style = plateMismatch || provinceMismatch || book.uncertain ? STATUS.warn : STATUS.ok;
      status = by === "chassis" ? "เลขตัวรถตรงกับรถที่รอรับเล่ม" : "ทะเบียนตรงกับรถที่รอรับเล่ม (อ่านเลขตัวรถไม่ได้)";
    } else if (kind === "close") {
      style = STATUS.warn;
      status = vehicleIds.length > 1 ? "ตรงได้หลายคัน - เลือกคันที่ถูก" : "อ่านได้ไม่ตรงเป๊ะ - ดูรูปแล้วติ๊กถ้าใช่คันนี้";
    } else if (kind === "received") {
      const v = vehicleById.get(vehicleIds[0]);
      style = STATUS.warn; // รูปซ้ำ - เล่มคันนี้ยืนยันรับไปแล้ว
      status = `⚠️ รูปซ้ำ: รับเล่มคันนี้ไปแล้ว${v?.bookReceivedDate ? ` (${isoToDisplayDate(v.bookReceivedDate)})` : ""}`;
    } else if (kind === "none") {
      style = STATUS.bad;
      status = "ไม่พบรถที่รอรับเล่มนี้ (ยังไม่ได้บันทึกใบเสร็จ หรือ AI อ่านผิด)";
    } else {
      style = STATUS.bad;
      status = "อ่านเลขตัวรถและทะเบียนไม่ออก - ถ่ายหน้ารายการจดทะเบียนใหม่ให้ชัดขึ้น";
    }

    const selectable = kind === "exact" || kind === "close";
    return (
      <div key={key} style={{ padding: "8px 10px", borderRadius: 8, background: style.background, fontSize: 14, lineHeight: 1.6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {selectable && (
            <input
              type="checkbox"
              checked={choice.checked}
              disabled={!choice.vehicleId || busy}
              onChange={(e) => setChoice(key, { checked: e.target.checked })}
              aria-label={`ยืนยันรับเล่ม ${book.chassis ?? plateRead}`}
              style={{ marginTop: 5 }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ wordBreak: "break-all" }}>
              <b>AI อ่านได้: เลขตัวรถ {book.chassis ?? "—"} · ทะเบียน {plateRead}</b>
              {book.uncertain && <span style={{ color: STATUS.warn.color }}> · AI ไม่มั่นใจ ดูรูปเทียบ</span>}
            </div>
            <div style={{ color: style.color }}>{status}</div>
            {kind === "close" && (
              <select
                value={choice.vehicleId}
                disabled={busy}
                onChange={(e) => setChoice(key, { vehicleId: e.target.value, checked: e.target.value !== "" && choice.checked })}
                style={{ marginTop: 4, maxWidth: "100%" }}
              >
                <option value="">— เลือกรถ —</option>
                {vehicleIds.map((id) => {
                  const v = vehicleById.get(id);
                  return v ? (
                    <option key={id} value={id}>
                      {v.chassis} · {vehiclePlate(v)} {v.registrationProvince ?? ""} · {v.customerName}
                    </option>
                  ) : null;
                })}
              </select>
            )}
            {kind === "exact" && chosen && (
              <div style={{ color: "#3c4a63", wordBreak: "break-all" }}>
                {chosen.chassis} · {vehiclePlate(chosen)} {chosen.registrationProvince ?? ""} · {chosen.customerName} · {chosen.body ?? "—"}
                {duplicate}
              </div>
            )}
            {plateMismatch && chosen && (
              <div style={{ color: STATUS.warn.color }}>
                ทะเบียนในเล่ม ({book.category} {book.number}) ไม่ตรงกับที่บันทึกไว้ตอนรับใบเสร็จ ({vehiclePlate(chosen)}) - ตรวจสอบก่อนติ๊กยืนยัน
              </div>
            )}
            {provinceMismatch && chosen && (
              <div style={{ color: STATUS.warn.color }}>
                จังหวัดในเล่ม ({book.province}) ไม่ตรงกับจังหวัดที่จดทะเบียนของรถ ({chosen.registrationProvince}) - ตรวจสอบก่อนยืนยัน
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="panel" style={{ marginTop: compact ? 0 : 20 }}>
      <div className="panel-head">
        <h2>ถ่ายรูปเล่มทะเบียน - ระบบอ่านและจับคู่ให้</h2>
      </div>
      <div style={{ padding: "0 23px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="customer-message" style={{ margin: 0 }}>
          เปิดเล่มที่หน้ารายการจดทะเบียน ถ่ายให้เห็นเลขตัวรถและเลขทะเบียนชัด ไม่สะท้อนแสง - วางหลายเล่มในรูปเดียวได้ ระบบจะจับคู่กับรถที่รอรับเล่มให้เอง
        </p>

        {/* capture="environment" = เปิดกล้องหลังทันทีบนมือถือ */}
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => handleCamera(e.target.files)} />
        <input ref={galleryRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleGallery(e.target.files)} />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => cameraRef.current?.click()}
            style={compact ? { width: "100%", justifyContent: "center", minHeight: 60, fontSize: 18 } : undefined}
          >
            {busy ? progress : "📷 ถ่ายรูปเล่มทะเบียน"}
          </button>
          <button type="button" className="text-button" disabled={busy} onClick={() => galleryRef.current?.click()}>
            เลือกรูปจากเครื่อง (หลายรูปได้)
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <span>วันที่รับเล่ม</span>
            <DateInput
              value={dateText}
              onChange={(value) => setEditedDate(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
              style={{ width: 120 }}
            />
          </label>
          {editedDate === null ? (
            <span className="customer-message">อัตโนมัติ = วันที่บันทึก (วันนี้)</span>
          ) : (
            <button type="button" className="text-button" onClick={() => setEditedDate(null)}>
              กลับไปใช้วันนี้
            </button>
          )}
        </div>

        {message.text && (
          <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
            {message.text}
          </div>
        )}

        {data.photos.length > 0 && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {data.photos.map((photo) => (
                <div key={photo.id} style={{ display: "flex", gap: 12, padding: 10, borderRadius: 10, border: "1px solid #dfe5f0", flexWrap: compact ? "wrap" : "nowrap" }}>
                  <div style={{ flexShrink: 0 }}>
                    <AuthedImage
                      src={bookPhotoImageUrl(photo.id)}
                      alt="รูปเล่มทะเบียน"
                      style={{ width: compact ? "100%" : 220, maxHeight: 220, objectFit: "contain", borderRadius: 6, display: "block", background: "#f3f5f9" }}
                    />
                  </div>
                  <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                    {photo.readPending ? (
                      <div style={{ ...STATUS.info, padding: "8px 10px", borderRadius: 8 }}>⏳ กำลังอ่านเล่มทะเบียน… ผลจะขึ้นเองเมื่ออ่านเสร็จ</div>
                    ) : photo.error ? (
                      <div style={{ ...STATUS.bad, padding: "8px 10px", borderRadius: 8 }}>{photo.error} - ลบแล้วถ่ายใหม่</div>
                    ) : photo.extractionSource === "NONE" ? (
                      <div style={{ ...STATUS.info, padding: "8px 10px", borderRadius: 8 }}>ยังไม่ได้เปิดใช้ AI (ไม่มี API key) - อ่านและจับคู่เล่มอัตโนมัติไม่ได้</div>
                    ) : photo.books.length === 0 ? (
                      <div style={{ ...STATUS.bad, padding: "8px 10px", borderRadius: 8 }}>ไม่พบเล่มทะเบียนในรูปนี้ - ลบแล้วถ่ายใหม่</div>
                    ) : (
                      photo.books.map((book, i) => renderBook(photo.id, book, i))
                    )}
                    <div style={{ display: "flex", gap: 12 }}>
                      <button type="button" className="text-button" disabled={busy} onClick={() => deletePhoto(photo.id)} style={{ paddingLeft: 0 }}>
                        ลบรูป
                      </button>
                      <button type="button" className="text-button" disabled={busy} onClick={() => hidePhoto(photo.id)}>
                        ซ่อนรูปนี้ (ไม่ต้องจับคู่แล้ว)
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", borderTop: "1px solid #dfe5f0", paddingTop: 12 }}>
              <span>วันที่รับเล่ม {dateText}</span>
              <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={confirm}>
                ยืนยันรับเล่ม {selected.size} คัน
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
