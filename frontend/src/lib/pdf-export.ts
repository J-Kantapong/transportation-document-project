// บันทึกเอกสาร HTML (ชุดเดียวกับที่ใช้พิมพ์) เป็นไฟล์ PDF โดยตรง (ผู้ใช้ 2026-09-25)
// วาดหน้าเอกสารใน iframe ที่ซ่อนไว้เป็นรูป (html2canvas-pro) แล้ววางลง PDF ทีละหน้า A4 (jspdf) - ภาษาไทยจึงออกเหมือน
// ที่เบราว์เซอร์แสดงทุกอย่าง (สระ/วรรณยุกต์ไม่เพี้ยน) แลกกับข้อความในไฟล์เป็นรูป เลือก/ค้นหาข้อความไม่ได้
// ตัดหน้าตรงขอบล่างของแถว/หัวข้อ ไม่ให้แถวขาดครึ่ง และขึ้นหน้าใหม่ทุก section.slip (ใบส่งงานหลายใบในไฟล์เดียว)
// library ทั้งสองโหลดเฉพาะตอนกดบันทึก PDF (dynamic import) ไม่เพิ่มขนาดหน้าเว็บปกติ

const PX_PER_MM = 96 / 25.4;
const SCALE = 2; // ความละเอียดรูป 2 เท่า - ตัวหนังสือคมพอสำหรับพิมพ์
// เพดานขนาดรูปต่อการวาด 1 ครั้ง (px ของรูป): Firefox ยาวได้ไม่เกิน 32,767 ต่อด้าน, Safari บน iPhone/iPad พื้นที่ราว 16.7 ล้าน px
// เกินแล้วเบราว์เซอร์ไม่ error แต่ได้รูปว่าง (พบ 2026-09-27: รายงานยาวได้ PDF หน้าขาวทุกหน้า) -> วาดทีละช่วง ช่วงละหลายหน้า
const MAX_CANVAS_SIDE = 16_000;
const MAX_CANVAS_AREA = 16_000_000;
const BREAK_AFTER = "tr, h1, h2, p, .head, .info, .sign, .tail";
// .tail = กลุ่มที่ห้ามตัดกลาง (ท้ายใบส่งงาน: หมายเหตุ + ช่องลงชื่อ) - จุดตัดข้างในไม่นับ ตัดได้แค่หลังทั้งกลุ่ม
const KEEP_TOGETHER = ".tail";

export interface PdfPageSetup {
  orientation: "portrait" | "landscape";
  marginMm: number;
}

function loadInIframe(html: string, widthPx: number): Promise<HTMLIFrameElement> {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthPx}px;height:1200px;border:0`;
    iframe.onload = () => resolve(iframe);
    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}

// จุดตัดหน้า: ขอบบนของหน้าถัดไป (px ของเอกสาร) - forced = ต้องขึ้นหน้าใหม่ตรงนี้
// tables = ตารางที่มีหัวตาราง (thead) - หน้าที่เริ่มกลางตารางจะวาดหัวตารางซ้ำไว้บนสุดเหมือนตอนพิมพ์
interface Layout {
  soft: number[];
  forced: number[];
  tables: Array<{ top: number; bottom: number; headTop: number; headBottom: number }>;
}

function layoutOf(doc: Document): Layout {
  const top = doc.body.getBoundingClientRect().top;
  const soft = [...doc.querySelectorAll(BREAK_AFTER)]
    .filter((el) => !el.parentElement?.closest(KEEP_TOGETHER))
    .map((el) => el.getBoundingClientRect().bottom - top);
  // ขอบบนของกลุ่มที่ห้ามตัดกลาง = ตัดก่อนเริ่มกลุ่มได้ (ถ้าทั้งกลุ่มไม่พอในหน้านี้ จะขึ้นหน้าใหม่ทั้งกลุ่ม)
  soft.push(...[...doc.querySelectorAll(KEEP_TOGETHER)].map((el) => el.getBoundingClientRect().top - top));
  // section.page = เอกสารบัญชี (ใบกำกับ / ใบวางบิล) หลายใบในไฟล์เดียว ขึ้นหน้าใหม่ทุกใบเหมือน section.slip ของใบส่งงาน
  const forced = [...doc.querySelectorAll("section.slip, section.page")].slice(1).map((el) => el.getBoundingClientRect().top - top);
  const tables = [...doc.querySelectorAll("table")].flatMap((table) => {
    const head = table.querySelector("thead");
    if (!head) return [];
    const t = table.getBoundingClientRect();
    const h = head.getBoundingClientRect();
    return [{ top: t.top - top, bottom: t.bottom - top, headTop: h.top - top, headBottom: h.bottom - top }];
  });
  return { soft: soft.sort((a, b) => a - b), forced: forced.sort((a, b) => a - b), tables };
}

// สร้างไฟล์ PDF เป็น Blob (ไม่ดาวน์โหลดเอง) - ใช้ตอนต้องใส่ PDF ลงในชุดไฟล์ เช่น ชุดส่งบัญชีรายเดือน (ผู้ใช้ 2026-10-06)
export async function htmlToPdfBlob(html: string, setup: PdfPageSetup): Promise<Blob> {
  const [{ jsPDF }, { default: html2canvas }] = await Promise.all([import("jspdf"), import("html2canvas-pro")]);
  const pageW = setup.orientation === "portrait" ? 210 : 297;
  const pageH = setup.orientation === "portrait" ? 297 : 210;
  const contentWmm = pageW - setup.marginMm * 2;
  const contentHpx = (pageH - setup.marginMm * 2) * PX_PER_MM;

  const iframe = await loadInIframe(html, Math.round(contentWmm * PX_PER_MM));
  try {
    const doc = iframe.contentDocument!;
    await Promise.race([doc.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    iframe.style.height = `${doc.documentElement.scrollHeight}px`;
    const totalH = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    const docW = Math.max(doc.documentElement.scrollWidth, doc.body.scrollWidth);
    const { soft, forced, tables } = layoutOf(doc);

    // 1) วางหน้าก่อน (px ของเอกสาร): ตัดตรงขอบล่างของแถว/หัวข้อ, หน้าที่เริ่มกลางตาราง (หลังหัวตาราง) วาดหัวตารางซ้ำไว้บนสุด
    //    จึงเหลือที่ให้เนื้อหาน้อยลงเท่าความสูงหัวตาราง
    const pages: Array<{ start: number; end: number; table?: Layout["tables"][number] }> = [];
    let start = 0;
    while (start < totalH - 1) {
      const table = pages.length === 0 ? undefined : tables.find((t) => start >= t.headBottom - 1 && start < t.bottom - 1);
      const headH = table ? table.headBottom - table.headTop : 0;
      const limit = start + contentHpx - headH;
      const forcedHere = forced.find((y) => y > start + 1 && y <= limit);
      const softHere = soft.filter((y) => y > start + 1 && y <= limit).pop();
      const end = forcedHere ?? (limit >= totalH ? totalH : (softHere ?? limit));
      pages.push({ start, end, table });
      start = end;
    }

    // 2) วาดเป็นช่วง ช่วงละหลายหน้าเท่าที่ไม่เกินเพดานรูป แล้วตัดเป็นหน้า - หัวตารางวาดแยกครั้งเดียวต่อตาราง
    const render = async (y: number, height: number) => {
      const canvas = await html2canvas(doc.body, {
        scale: SCALE,
        backgroundColor: "#ffffff",
        logging: false,
        x: 0,
        y,
        width: docW,
        height: Math.max(1, Math.ceil(height)),
      });
      if (!canvas.width || !canvas.height) throw new Error("วาดหน้าเอกสารไม่สำเร็จ");
      return canvas;
    };
    const maxChunk = Math.floor(Math.min(MAX_CANVAS_SIDE, MAX_CANVAS_AREA / (docW * SCALE)) / SCALE);
    const heads = new Map<Layout["tables"][number], HTMLCanvasElement>();
    const pdf = new jsPDF({ orientation: setup.orientation, unit: "mm", format: "a4", compress: true });
    let chunk: { canvas: HTMLCanvasElement; top: number; bottom: number } | null = null;
    for (const [n, page] of pages.entries()) {
      if (!chunk || page.end > chunk.bottom + 0.5) {
        let bottom = page.end;
        for (const next of pages.slice(n + 1)) {
          if (next.end - page.start > maxChunk) break;
          bottom = next.end;
        }
        chunk = { canvas: await render(page.start, bottom - page.start), top: page.start, bottom };
      }
      const table = page.table;
      const headH = table ? table.headBottom - table.headTop : 0;
      let head = table ? heads.get(table) : undefined;
      if (table && !head) {
        head = await render(table.headTop, headH);
        heads.set(table, head);
      }

      const slice = document.createElement("canvas");
      slice.width = chunk.canvas.width;
      slice.height = Math.ceil((headH + page.end - page.start) * SCALE);
      const ctx = slice.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, slice.width, slice.height);
      if (head) ctx.drawImage(head, 0, 0);
      const dy = Math.floor(headH * SCALE);
      const sy = Math.floor((page.start - chunk.top) * SCALE);
      const sh = Math.min(chunk.canvas.height - sy, slice.height - dy);
      ctx.drawImage(chunk.canvas, 0, sy, chunk.canvas.width, sh, 0, dy, chunk.canvas.width, sh);
      // รูปใหญ่เกินที่เบราว์เซอร์รับได้ได้ "data:," - โยน error ให้หน้าเว็บบอกให้ใช้ปุ่มพิมพ์แทน ไม่บันทึกไฟล์หน้าว่าง
      const image = slice.toDataURL("image/jpeg", 0.92);
      if (!image.startsWith("data:image/")) throw new Error("สร้างรูปหน้าเอกสารไม่สำเร็จ");
      if (n > 0) pdf.addPage();
      pdf.addImage(image, "JPEG", setup.marginMm, setup.marginMm, contentWmm, slice.height / SCALE / PX_PER_MM);
    }
    return pdf.output("blob");
  } finally {
    iframe.remove();
  }
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadHtmlAsPdf(html: string, fileName: string, setup: PdfPageSetup): Promise<void> {
  downloadBlob(await htmlToPdfBlob(html, setup), fileName);
}
