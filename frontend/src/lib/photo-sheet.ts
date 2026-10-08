// จัดรูปถ่ายหลายรูปลงกระดาษ A4 แล้วบันทึกเป็น PDF (ผู้ใช้ 2026-10-09: ลูกค้าส่งรูปตรวจนอกมาเป็นรูปๆ พนักงานต้องมาจัดหน้าเอง)
// ทำในเบราว์เซอร์ทั้งหมด ไม่ส่งรูปขึ้นเซิร์ฟเวอร์และไม่เก็บลงฐานข้อมูล - รูปถูกย่อและหมุนให้เรียบร้อยตั้งแต่ตอนเพิ่ม
// แล้วใช้รูปชุดเดียวกันทั้งตัวอย่างบนจอและใน PDF จึงออกมาตรงกัน
import { downloadBlob } from "./pdf-export";

export const PAGE_W_MM = 210;
export const PAGE_H_MM = 297;
const MARGIN_MM = 10;
const GAP_MM = 5;
const TITLE_H_MM = 12;
export const PHOTOS_PER_PAGE = 12;
const MAX_SIDE_PX = 1800; // ด้านยาวของรูปใน PDF - คมพอสำหรับพิมพ์ A4 และไฟล์ไม่ใหญ่เกิน
const JPEG_QUALITY = 0.86;

export interface SheetCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

// จำนวนคอลัมน์ต่อหน้า: 1-2 รูปเรียงลงมาคอลัมน์เดียว, 3-8 รูปสองคอลัมน์ (แบบใบตัวอย่าง 6 รูป), มากกว่านั้นสามคอลัมน์
function columnsFor(count: number): number {
  if (count <= 2) return 1;
  return count <= 8 ? 2 : 3;
}

// ช่องวางรูปของหนึ่งหน้า (มม. จากมุมบนซ้ายของกระดาษ) - ทุกรูปของหน้านั้นต้องลงในหน้าเดียว
export function pageCells(count: number, hasTitle: boolean): SheetCell[] {
  if (count <= 0) return [];
  const cols = columnsFor(count);
  const rows = Math.ceil(count / cols);
  const top = MARGIN_MM + (hasTitle ? TITLE_H_MM : 0);
  const w = (PAGE_W_MM - MARGIN_MM * 2 - GAP_MM * (cols - 1)) / cols;
  const h = (PAGE_H_MM - top - MARGIN_MM - GAP_MM * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: MARGIN_MM + (i % cols) * (w + GAP_MM),
    y: top + Math.floor(i / cols) * (h + GAP_MM),
    w,
    h,
  }));
}

// แบ่งรูปเป็นหน้า หน้าละไม่เกิน PHOTOS_PER_PAGE - หัวกระดาษอยู่ทุกหน้า
export function sheetPages(count: number, hasTitle: boolean): SheetCell[][] {
  const pages: SheetCell[][] = [];
  for (let done = 0; done < count; done += PHOTOS_PER_PAGE) {
    pages.push(pageCells(Math.min(PHOTOS_PER_PAGE, count - done), hasTitle));
  }
  return pages;
}

// วางรูปให้พอดีช่องโดยไม่บิดสัดส่วน อยู่กลางช่อง
export function fitInCell(cell: SheetCell, imageW: number, imageH: number): SheetCell {
  const scale = Math.min(cell.w / imageW, cell.h / imageH);
  const w = imageW * scale;
  const h = imageH * scale;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

export interface SheetPhoto {
  id: string;
  name: string;
  dataUrl: string; // JPEG ที่ย่อและหมุนแล้ว
  width: number;
  height: number;
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("เบราว์เซอร์นี้วาดรูปไม่ได้");
  return { canvas, ctx };
}

let nextId = 0;

// อ่านไฟล์รูป: หมุนตามที่กล้องบันทึกไว้ (EXIF) แล้วย่อให้ด้านยาวไม่เกิน MAX_SIDE_PX
export async function loadSheetPhoto(file: File): Promise<SheetPhoto> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    const { canvas, ctx } = canvasOf(bitmap.width * scale, bitmap.height * scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    nextId += 1;
    return { id: `p${nextId}`, name: file.name, dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: canvas.width, height: canvas.height };
  } finally {
    bitmap.close();
  }
}

function imageOf(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("เปิดรูปไม่ได้"));
    image.src = dataUrl;
  });
}

// หมุนรูป 90 องศาตามเข็มนาฬิกา
export async function rotateSheetPhoto(photo: SheetPhoto): Promise<SheetPhoto> {
  const image = await imageOf(photo.dataUrl);
  const { canvas, ctx } = canvasOf(photo.height, photo.width);
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(image, 0, 0);
  return { ...photo, dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: canvas.width, height: canvas.height };
}

// หัวกระดาษเป็นรูป เพราะฟอนต์ในตัว jsPDF ไม่มีอักษรไทย - วาดด้วยฟอนต์ของหน้าเว็บแล้ววางเป็นรูป
function titleImage(title: string, widthMm: number, heightMm: number): string {
  const pxPerMm = 12;
  const { canvas, ctx } = canvasOf(widthMm * pxPerMm, heightMm * pxPerMm);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  let size = 6 * pxPerMm;
  ctx.font = `700 ${size}px ${family}`;
  // ข้อความยาวเกินกระดาษ = ย่อตัวอักษรลงจนพอดี
  while (size > 2.5 * pxPerMm && ctx.measureText(title).width > canvas.width) {
    size -= 2;
    ctx.font = `700 ${size}px ${family}`;
  }
  ctx.fillText(title, canvas.width / 2, canvas.height / 2);
  return canvas.toDataURL("image/png");
}

export async function buildPhotoSheetPdf(photos: SheetPhoto[], title: string): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  const heading = title.trim();
  const titleW = PAGE_W_MM - MARGIN_MM * 2;
  const titleUrl = heading ? titleImage(heading, titleW, TITLE_H_MM - 2) : null;

  sheetPages(photos.length, Boolean(heading)).forEach((cells, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    if (titleUrl) doc.addImage(titleUrl, "PNG", MARGIN_MM, MARGIN_MM, titleW, TITLE_H_MM - 2);
    cells.forEach((cell, i) => {
      const photo = photos[pageIndex * PHOTOS_PER_PAGE + i];
      const at = fitInCell(cell, photo.width, photo.height);
      doc.addImage(photo.dataUrl, "JPEG", at.x, at.y, at.w, at.h);
    });
  });
  return doc.output("blob");
}

export async function downloadPhotoSheet(photos: SheetPhoto[], title: string): Promise<void> {
  const name = title.trim().replace(/[\\/:*?"<>|]+/g, " ").trim() || "รูปถ่ายรถ";
  downloadBlob(await buildPhotoSheetPdf(photos, title), `${name}.pdf`);
}
