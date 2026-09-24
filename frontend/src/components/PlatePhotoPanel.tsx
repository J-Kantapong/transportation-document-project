"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api, platePhotoImageUrl, type PlateKind, type PlatePhotoList, type PlatePhotoPlate, type PlatePhotoVehicle } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { getCachedUser, vehicleScopeFor } from "@/lib/auth";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { uploadAllInBackground, usePolling } from "@/lib/receipt-upload";

// ถ่ายรูปป้ายทะเบียนเพื่อยืนยันการรับป้าย (Step 6): AI อ่านเลขทะเบียนในรูป (รูปเดียวหลายแผ่นได้) แล้วระบบจับคู่
// กับรถที่รอรับป้ายจากทะเบียนที่รู้แล้วใน Step 5 - พนักงานไม่ต้องไล่จับคู่เอง แค่ดูแล้วกดยืนยันทีเดียว
// ตรงเป๊ะ = ติ๊กให้ · ต่างกัน 1 ตัว = เสนอให้เลือก ไม่ติ๊กให้ · AI ไม่บันทึกเอง ต้องกดยืนยันเสมอ
// ใช้ทั้งบนหน้ารับป้าย (คอม) และหน้าถ่ายจากมือถือ - เป็นการ์ดเรียงลงล่างเพื่อให้ใช้บนจอแคบได้

interface Choice {
  vehicleId: string; // "" = ยังไม่เลือก
  checked: boolean;
}

const plateKey = (photoId: string, index: number) => `${photoId}:${index}`;
const plateLabel = (p: { category: string | null; number: string | null }) => `${p.category ?? "?"} ${p.number ?? "?"}`;
const vehiclePlate = (v: PlatePhotoVehicle) => `${v.plateCategory ?? "?"} ${v.plateNumber ?? "?"}`;
const errorText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : "ดำเนินการไม่สำเร็จ");

// ค่าเริ่มต้น: ตรงเป๊ะติ๊กให้ (ยกเว้น AI ว่าเป็นป้ายอีกประเภท), ใกล้เคียงคันเดียวเลือกคันให้แต่ไม่ติ๊ก
function defaultChoice(plate: PlatePhotoPlate): Choice {
  const { kind, vehicleIds, typeMismatch } = plate.match;
  if (kind === "exact") return { vehicleId: vehicleIds[0], checked: !typeMismatch };
  if (kind === "close" && vehicleIds.length === 1) return { vehicleId: vehicleIds[0], checked: false };
  return { vehicleId: "", checked: false };
}

const STATUS = {
  ok: { color: "#23825f", background: "#edf8f3" },
  warn: { color: "#bb8527", background: "#fff8e6" },
  bad: { color: "#b43434", background: "#fdeeee" },
  info: { color: "#5a6b87", background: "#f3f5f9" },
};

export const PLATE_KIND_LABEL: Record<PlateKind, string> = { car: "รถยนต์", moto: "มอเตอร์ไซค์" };
const KIND_STORAGE_KEY = "plate-photo-kind";

// แท็บที่บทบาทนี้ล็อกไว้: STAFF_CAR = รถยนต์เท่านั้น / STAFF_MOTO = มอเตอร์ไซค์เท่านั้น (ผู้ใช้ 2026-09-22) - backend กันอีกชั้น
export function lockedPlateKind(): PlateKind | null {
  const scope = vehicleScopeFor(getCachedUser()?.roles ?? []);
  return scope === "CAR" ? "car" : scope === "MOTO" ? "moto" : null;
}

// จำแท็บล่าสุดไว้ในเครื่อง (คนถ่ายรถยนต์กับมอเตอร์ไซค์มักเป็นคนละคน) - อ่านไม่ได้ก็เริ่มที่รถยนต์
export function loadPlateKind(): PlateKind {
  const locked = lockedPlateKind();
  if (locked) return locked;
  try {
    return window.localStorage.getItem(KIND_STORAGE_KEY) === "moto" ? "moto" : "car";
  } catch {
    return "car";
  }
}

export function savePlateKind(kind: PlateKind) {
  try {
    window.localStorage.setItem(KIND_STORAGE_KEY, kind);
  } catch {}
}

// รถยนต์ = ทุกประเภทยกเว้น รย.12 (มอเตอร์ไซค์) - ตรงกับ isMotorcycle ฝั่ง backend
export const isMotorcycleBody = (body: string | null) => Boolean(body?.startsWith("รย.12-"));

export function PlateKindTabs({ kind, onChange }: { kind: PlateKind; onChange: (kind: PlateKind) => void }) {
  // บทบาทที่ดูแลประเภทเดียวไม่ต้องเลือกแท็บ - แสดงป้ายบอกแทน (อ่าน localStorage หลัง mount ให้ server/client render ตรงกัน)
  const [locked, setLocked] = useState<PlateKind | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่านบทบาทจาก localStorage หลัง mount
    setLocked(lockedPlateKind());
  }, []);
  if (locked) {
    return (
      <div style={{ marginTop: 14 }}>
        <span className="status-badge">ป้าย{PLATE_KIND_LABEL[locked]}เท่านั้น</span>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 14 }} role="group" aria-label="ประเภทป้าย">
      {(["car", "moto"] as PlateKind[]).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={kind === k ? "primary" : undefined}
          style={kind === k ? undefined : { border: "1px solid #dce2ec", background: "#fff", padding: "12px 20px", borderRadius: 8 }}
          aria-pressed={kind === k}
        >
          {PLATE_KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

// kind = แท็บที่เลือก: รูปที่ถ่ายผูกกับประเภทนี้และจับคู่เฉพาะรถประเภทนี้ (เปลี่ยนแท็บให้ remount ด้วย key={kind})
export function PlatePhotoPanel({ kind, onConfirmed, compact }: { kind: PlateKind; onConfirmed?: () => void; compact?: boolean }) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<PlatePhotoList>({ photos: [], vehicles: [] });
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  // วันที่รับป้าย: ผู้ใช้ 2026-09-21 ให้เติมอัตโนมัติเป็นวันที่บันทึก (วันนี้) - null = ยังไม่แก้เอง ใช้วันนี้เสมอ
  // (คำนวณใหม่ทุก render เปิดหน้าค้างข้ามคืนก็ยังเป็นวันที่กดบันทึกจริง) พนักงานแก้เป็นวันอื่นได้
  const [editedDate, setEditedDate] = useState<string | null>(null);
  const dateText = editedDate ?? isoToDisplayDate(todayIso());
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // รวมผลใหม่เข้ากับที่มีอยู่ - คงตัวเลือกที่พนักงานแก้ไว้แล้ว ใส่ค่าเริ่มต้นให้เฉพาะแผ่นที่เพิ่งมา
  function merge(next: PlatePhotoList, replace: boolean) {
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
        photo.plates.forEach((plate, i) => {
          const key = plateKey(photo.id, i);
          out[key] = (!replace && prev[key]) || defaultChoice(plate);
        });
      }
      return out;
    });
  }

  async function load() {
    // หน้าเริ่มที่แท็บรถยนต์ก่อนอ่านค่าที่จำไว้ - บทบาทที่ล็อกอีกประเภทไม่ต้องยิง (backend จะตอบ 403) รอ remount ด้วยแท็บที่ถูก
    const locked = lockedPlateKind();
    if (locked && locked !== kind) return;
    try {
      merge(await api.listOpenPlatePhotos(kind), true);
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
    setProgress("กำลังอ่านป้ายทะเบียน…");
    try {
      const image = await compressReceiptImage(file);
      merge(await api.uploadPlatePhoto(image, compressedFileName(file), kind), false);
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
      (image, fileName) => api.uploadPlatePhoto(image, fileName, kind, true),
      (res) => merge(res, false),
      (file, err) => failed.push(`${file.name}: ${errorText(err)}`),
      (done) => setProgress(`กำลังส่งรูป ${done}/${list.length}…`),
    );
    setProgress("");
    setMessage(
      failed.length
        ? { text: `ส่งไม่สำเร็จ ${failed.length} รูป - ${failed.join(" · ")}`, error: true }
        : { text: `ส่งครบ ${list.length} รูปแล้ว - ระบบกำลังอ่านป้ายทะเบียน ไปทำอย่างอื่นก่อนแล้วค่อยกลับมายืนยันได้` },
    );
    if (galleryRef.current) galleryRef.current.value = "";
  }

  // รูปที่ยังรออ่าน: ถามถาดใหม่ทุก 3 วินาที แล้วรับเฉพาะรูปที่อ่านเสร็จ (ไม่ทับรูปอื่นที่พนักงานกำลังติ๊กอยู่)
  const pendingIds = data.photos.filter((p) => p.readPending).map((p) => p.id);
  usePolling(pendingIds.length > 0, async () => {
    const next = await api.listOpenPlatePhotos(kind);
    const read = next.photos.filter((p) => pendingIds.includes(p.id) && !p.readPending);
    if (read.length) merge({ photos: read, vehicles: next.vehicles }, false);
  });

  const vehicleById = new Map(data.vehicles.map((v) => [v.id, v]));

  // รถที่จะยืนยัน (ไม่ซ้ำคัน - ป้ายหน้า/หลังของคันเดียวกันนับครั้งเดียว ใช้รูปแรกเป็นหลักฐาน)
  const selected = new Map<string, string>(); // vehicleId -> photoId
  const plateCount = new Map<string, number>(); // vehicleId -> จำนวนแผ่นที่เห็นและติ๊ก
  for (const photo of data.photos) {
    photo.plates.forEach((_, i) => {
      const c = choices[plateKey(photo.id, i)];
      if (!c?.checked || !c.vehicleId) return;
      if (!selected.has(c.vehicleId)) selected.set(c.vehicleId, photo.id);
      plateCount.set(c.vehicleId, (plateCount.get(c.vehicleId) ?? 0) + 1);
    });
  }

  // รูปที่ทุกแผ่นจัดการแล้ว (ติ๊กยืนยัน หรือเป็นป้ายที่รับไปแล้ว) - ปิดออกจากถาดหลังยืนยัน
  // รูปที่ยังมีแผ่นจับคู่ไม่ได้ค้างไว้ในถาด (อาจเป็นรถที่ยังไม่ได้บันทึกใบเสร็จ) - กด "ซ่อนรูปนี้" ได้เอง
  const resolvedPhotoIds = data.photos
    .filter((photo) => photo.plates.length > 0 && photo.plates.every((p, i) => p.match.kind === "received" || choices[plateKey(photo.id, i)]?.checked))
    .map((p) => p.id);

  async function confirm() {
    const dateIso = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!dateIso) return setMessage({ text: "วันที่รับป้ายไม่ถูกต้อง", error: true });
    if (selected.size === 0) return setMessage({ text: "ยังไม่ได้ติ๊กรถที่จะยืนยัน", error: true });
    setProgress("กำลังบันทึก…");
    try {
      const items = [...selected].map(([vehicleId, photoId]) => ({ vehicleId, photoId }));
      const res = await api.confirmPlatePhotos(dateIso, items, resolvedPhotoIds);
      await load();
      onConfirmed?.();
      setEditedDate(null); // รอบถัดไปกลับไปใช้วันที่บันทึกอัตโนมัติ
      setMessage(
        res.failed.length
          ? { text: `ยืนยันแล้ว ${res.succeeded.length} คัน · ไม่สำเร็จ ${res.failed.length} คัน - ${res.failed.map((f) => f.error).join(" · ")}`, error: true }
          : { text: `ยืนยันรับป้ายแล้ว ${res.succeeded.length} คัน` },
      );
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    } finally {
      setProgress("");
    }
  }

  async function hidePhoto(photoId: string) {
    try {
      await api.confirmPlatePhotos(todayIso(), [], [photoId]);
      setData((prev) => ({ ...prev, photos: prev.photos.filter((p) => p.id !== photoId) }));
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  async function deletePhoto(photoId: string) {
    try {
      await api.deletePlatePhoto(photoId);
      setData((prev) => ({ ...prev, photos: prev.photos.filter((p) => p.id !== photoId) }));
    } catch (err) {
      setMessage({ text: errorText(err), error: true });
    }
  }

  const setChoice = (key: string, patch: Partial<Choice>) => setChoices((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const busy = progress !== "";

  const photoKind = kind; // ในฟังก์ชันข้างล่าง kind คือผลจับคู่ (exact/close/...)

  function renderPlate(photoId: string, plate: PlatePhotoPlate, index: number) {
    const key = plateKey(photoId, index);
    const choice = choices[key] ?? { vehicleId: "", checked: false };
    const { kind, vehicleIds, provinceMismatch, typeMismatch } = plate.match;
    const read = `${plateLabel(plate)}${plate.province ? ` ${plate.province}` : ""}`;
    const chosen = choice.vehicleId ? vehicleById.get(choice.vehicleId) : undefined;
    const duplicate = chosen && choice.checked && selected.get(chosen.id) !== photoId ? " (เห็นในรูปอื่นแล้ว)" : "";

    let style = STATUS.info;
    let status: string;
    if (kind === "exact") {
      style = provinceMismatch || typeMismatch || plate.uncertain ? STATUS.warn : STATUS.ok;
      status = "ตรงกับรถที่รอรับป้าย";
    } else if (kind === "close") {
      style = STATUS.warn;
      status = vehicleIds.length > 1 ? "ทะเบียนนี้มีหลายคัน / ใกล้เคียงหลายคัน - เลือกคันที่ถูก" : "อ่านได้ไม่ตรงเป๊ะ (ต่างกัน 1 ตัว) - ดูรูปแล้วติ๊กถ้าใช่คันนี้";
    } else if (kind === "received") {
      const v = vehicleById.get(vehicleIds[0]);
      style = STATUS.warn; // รูปซ้ำ - ป้ายคันนี้ยืนยันรับไปแล้ว
      status = `⚠️ รูปซ้ำ: รับป้ายคันนี้ไปแล้ว${v?.plateReceivedDate ? ` (${isoToDisplayDate(v.plateReceivedDate)})` : ""}`;
    } else if (kind === "none") {
      style = STATUS.bad;
      status = "ไม่พบรถที่รอรับป้ายทะเบียนนี้ (ยังไม่ได้บันทึกใบเสร็จ หรือ AI อ่านผิด)";
    } else {
      style = STATUS.bad;
      status = "อ่านหมวด/เลขทะเบียนไม่ออก - ถ่ายใหม่ให้ชัดขึ้น";
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
              aria-label={`ยืนยันรับป้าย ${read}`}
              style={{ marginTop: 5 }}
            />
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div>
              <b>AI อ่านได้: {read}</b>
              {plate.uncertain && <span style={{ color: STATUS.warn.color }}> · AI ไม่มั่นใจ ดูรูปเทียบ</span>}
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
                      {vehiclePlate(v)} {v.registrationProvince ?? ""} · {v.customerName} · {v.chassis}
                    </option>
                  ) : null;
                })}
              </select>
            )}
            {kind === "exact" && chosen && (
              <div style={{ color: "#3c4a63", wordBreak: "break-all" }}>
                {vehiclePlate(chosen)} {chosen.registrationProvince ?? ""} · {chosen.customerName} · {chosen.body ?? "—"} · {chosen.chassis}
                {duplicate}
              </div>
            )}
            {typeMismatch && (
              <div style={{ color: STATUS.warn.color }}>
                AI ว่าแผ่นนี้เป็นป้าย{plate.plateType === "motorcycle" ? "มอเตอร์ไซค์" : "รถยนต์"} แต่ถ่ายในแท็บ{PLATE_KIND_LABEL[photoKind]} - ถ้าถ่ายผิดแท็บให้ลบรูปแล้วถ่ายใหม่ในแท็บที่ถูก
              </div>
            )}
            {provinceMismatch && chosen && (
              <div style={{ color: STATUS.warn.color }}>
                จังหวัดบนป้าย ({plate.province}) ไม่ตรงกับจังหวัดที่จดทะเบียนของรถ ({chosen.registrationProvince}) - ตรวจสอบก่อนยืนยัน
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
        <h2>ถ่ายรูปป้าย{PLATE_KIND_LABEL[kind]} - ระบบอ่านและจับคู่ให้</h2>
      </div>
      <div style={{ padding: "0 23px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="customer-message" style={{ margin: 0 }}>
          ถ่ายป้ายให้เห็นตัวอักษรชัด ไม่สะท้อนแสง - วางหลายแผ่นในรูปเดียวได้ ระบบจะอ่านทะเบียนแล้วจับคู่กับรถที่รอรับป้ายให้เอง
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
            {busy ? progress : `📷 ถ่ายรูปป้าย${PLATE_KIND_LABEL[kind]}`}
          </button>
          <button type="button" className="text-button" disabled={busy} onClick={() => galleryRef.current?.click()}>
            เลือกรูปจากเครื่อง (หลายรูปได้)
          </button>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <span>วันที่รับป้าย</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="วว/ดด/ปปปป"
              value={dateText}
              onChange={(e) => setEditedDate(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
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
                      src={platePhotoImageUrl(photo.id)}
                      alt="รูปป้ายทะเบียน"
                      style={{ width: compact ? "100%" : 220, maxHeight: 220, objectFit: "contain", borderRadius: 6, display: "block", background: "#f3f5f9" }}
                    />
                  </div>
                  <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                    {photo.readPending ? (
                      <div style={{ ...STATUS.info, padding: "8px 10px", borderRadius: 8 }}>⏳ กำลังอ่านป้ายทะเบียน… ผลจะขึ้นเองเมื่ออ่านเสร็จ</div>
                    ) : photo.error ? (
                      <div style={{ ...STATUS.bad, padding: "8px 10px", borderRadius: 8 }}>{photo.error} - ลบแล้วถ่ายใหม่</div>
                    ) : photo.extractionSource === "NONE" ? (
                      <div style={{ ...STATUS.info, padding: "8px 10px", borderRadius: 8 }}>ยังไม่ได้เปิดใช้ AI (ไม่มี API key) - ติ๊กรับป้ายในตารางด้านล่างเอง</div>
                    ) : photo.plates.length === 0 ? (
                      <div style={{ ...STATUS.bad, padding: "8px 10px", borderRadius: 8 }}>ไม่พบป้ายทะเบียนในรูปนี้ - ลบแล้วถ่ายใหม่</div>
                    ) : (
                      photo.plates.map((plate, i) => renderPlate(photo.id, plate, i))
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
              <span>วันที่รับป้าย {dateText}</span>
              <button type="button" className="primary" disabled={busy || selected.size === 0} onClick={confirm}>
                ยืนยันรับป้าย {selected.size} คัน
              </button>
              {[...plateCount.values()].some((n) => n > 1) && (
                <span className="customer-message">ป้ายหน้า-หลังของคันเดียวกันนับเป็น 1 คัน</span>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
