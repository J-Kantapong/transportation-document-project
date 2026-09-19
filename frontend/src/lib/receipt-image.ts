// ย่อรูปใบเสร็จก่อนอัปโหลด: ด้านยาวไม่เกิน 1600px, JPEG คุณภาพ 0.8 (~150-300KB ต่อรูป) - ตัวหนังสือยังอ่านชัด
// รูปจากกล้องมือถือ (3-8MB) จึงอัปโหลดเร็วและเปลืองที่เก็บน้อย. หมุนรูปตาม EXIF ให้ตั้งตรงก่อนย่อ
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

export async function compressReceiptImage(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`เปิดไฟล์รูป ${file.name} ไม่ได้ (รองรับ JPEG, PNG, WebP)`);
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("เบราว์เซอร์นี้ย่อรูปไม่ได้");
  ctx.fillStyle = "#fff"; // PNG พื้นใส -> พื้นขาว
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("ย่อรูปไม่สำเร็จ"))), "image/jpeg", JPEG_QUALITY),
  );
}

// ชื่อไฟล์ที่ส่งไป backend - เปลี่ยนนามสกุลเป็น .jpg ตามไฟล์ที่ย่อแล้ว
export const compressedFileName = (file: File) => `${file.name.replace(/\.[^.]*$/, "") || "receipt"}.jpg`;
