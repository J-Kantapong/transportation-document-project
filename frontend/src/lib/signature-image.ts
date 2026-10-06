// ทำรูปลายเซ็น (ถ่ายหรือสแกนจากกระดาษ) ให้สะอาดก่อนอัปโหลด (ผู้ใช้ 2026-10-06): ลบพื้นกระดาษให้โปร่งใส ลายเซ็นเป็นสีดำล้วน
// ตัดขอบว่างทิ้ง และย่อให้ไม่เกิน 600x240 พิกเซล - ผลเป็น PNG data URL เพื่อให้พิมพ์ขาวดำคมชัดและไฟล์เล็ก
// ทำงานในเบราว์เซอร์เท่านั้น (canvas) ฝั่ง backend ตรวจซ้ำว่าเป็น PNG ไม่เกิน 300 KB / 1200x600

const MAX_W = 600;
const MAX_H = 240;
const PAD = 6;

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("อ่านไฟล์รูปไม่ได้ ใช้ไฟล์ PNG หรือ JPG"));
    };
    img.src = url;
  });
}

export async function cleanSignatureImage(file: Blob): Promise<string> {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_W / img.naturalWidth, MAX_H / img.naturalHeight);
  const w = Math.max(20, Math.round(img.naturalWidth * scale));
  const h = Math.max(10, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("เบราว์เซอร์นี้ประมวลผลรูปไม่ได้");
  // รูปที่มีพื้นโปร่งใสอยู่แล้ว (PNG) วางบนพื้นขาวก่อน ให้ทุกกรณีเข้าสูตรเดียวกัน
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;

  // ความสว่างของแต่ละพิกเซล + หาความสว่างของพื้นกระดาษ (เปอร์เซ็นไทล์ที่ 85 - พื้นกระดาษมักเป็นส่วนใหญ่ของรูป)
  const lum = new Float32Array(w * h);
  const hist = new Uint32Array(256);
  for (let i = 0; i < w * h; i++) {
    const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    lum[i] = l;
    hist[Math.min(255, Math.round(l))]++;
  }
  let acc = 0;
  let bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= w * h * 0.85) {
      bg = Math.max(v, 120);
      break;
    }
  }

  // ยิ่งเข้มกว่าพื้นยิ่งทึบ: ต่ำกว่า 15% ของพื้น = โปร่งใส (ฝุ่น/เงา) เกิน 50% = ทึบเต็ม
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const darkness = (bg - lum[i]) / bg;
      const alpha = Math.max(0, Math.min(1, (darkness - 0.15) / 0.35));
      px[i * 4] = 0;
      px[i * 4 + 1] = 0;
      px[i * 4 + 2] = 0;
      px[i * 4 + 3] = Math.round(alpha * 255);
      if (alpha > 0.2) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error("ไม่พบลายเซ็นในรูป ลองใช้รูปที่เซ็นด้วยปากกาสีเข้มบนกระดาษขาว");
  ctx.putImageData(data, 0, 0);

  const cx = Math.max(0, minX - PAD);
  const cy = Math.max(0, minY - PAD);
  const cw = Math.min(w - cx, maxX - minX + 1 + PAD * 2);
  const ch = Math.min(h - cy, maxY - minY + 1 + PAD * 2);
  const out = document.createElement("canvas");
  out.width = Math.max(20, cw);
  out.height = Math.max(10, ch);
  out.getContext("2d")!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
  return out.toDataURL("image/png");
}
