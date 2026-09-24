// บันทึกเอกสาร HTML (ชุดเดียวกับที่ใช้พิมพ์) เป็นไฟล์ PDF โดยตรง (ผู้ใช้ 2026-09-25)
// วาดหน้าเอกสารใน iframe ที่ซ่อนไว้เป็นรูป (html2canvas-pro) แล้ววางลง PDF ทีละหน้า A4 (jspdf) - ภาษาไทยจึงออกเหมือน
// ที่เบราว์เซอร์แสดงทุกอย่าง (สระ/วรรณยุกต์ไม่เพี้ยน) แลกกับข้อความในไฟล์เป็นรูป เลือก/ค้นหาข้อความไม่ได้
// ตัดหน้าตรงขอบล่างของแถว/หัวข้อ ไม่ให้แถวขาดครึ่ง และขึ้นหน้าใหม่ทุก section.slip (ใบส่งงานหลายใบในไฟล์เดียว)
// library ทั้งสองโหลดเฉพาะตอนกดบันทึก PDF (dynamic import) ไม่เพิ่มขนาดหน้าเว็บปกติ

const PX_PER_MM = 96 / 25.4;
const SCALE = 2; // ความละเอียดรูป 2 เท่า - ตัวหนังสือคมพอสำหรับพิมพ์
const BREAK_AFTER = "tr, h1, h2, p, .head, .info, .sign";

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
  const soft = [...doc.querySelectorAll(BREAK_AFTER)].map((el) => el.getBoundingClientRect().bottom - top);
  const forced = [...doc.querySelectorAll("section.slip")].slice(1).map((el) => el.getBoundingClientRect().top - top);
  const tables = [...doc.querySelectorAll("table")].flatMap((table) => {
    const head = table.querySelector("thead");
    if (!head) return [];
    const t = table.getBoundingClientRect();
    const h = head.getBoundingClientRect();
    return [{ top: t.top - top, bottom: t.bottom - top, headTop: h.top - top, headBottom: h.bottom - top }];
  });
  return { soft: soft.sort((a, b) => a - b), forced: forced.sort((a, b) => a - b), tables };
}

export async function downloadHtmlAsPdf(html: string, fileName: string, setup: PdfPageSetup): Promise<void> {
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
    const canvas = await html2canvas(doc.body, { scale: SCALE, backgroundColor: "#ffffff", logging: false });
    const totalH = canvas.height / SCALE;
    const { soft, forced, tables } = layoutOf(doc);

    const pdf = new jsPDF({ orientation: setup.orientation, unit: "mm", format: "a4", compress: true });
    let start = 0;
    let first = true;
    while (start < totalH - 1) {
      // หน้านี้เริ่มกลางตาราง (หลังหัวตาราง) -> วาดหัวตารางซ้ำก่อน แล้วเหลือที่ให้เนื้อหาน้อยลงเท่าความสูงหัวตาราง
      const table = first ? undefined : tables.find((t) => start >= t.headBottom - 1 && start < t.bottom - 1);
      const headH = table ? table.headBottom - table.headTop : 0;
      const limit = start + contentHpx - headH;
      const forcedHere = forced.find((y) => y > start + 1 && y <= limit);
      const softHere = soft.filter((y) => y > start + 1 && y <= limit).pop();
      const end = forcedHere ?? (limit >= totalH ? totalH : (softHere ?? limit));

      const slice = document.createElement("canvas");
      slice.width = canvas.width;
      slice.height = Math.ceil((headH + end - start) * SCALE);
      const ctx = slice.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, slice.width, slice.height);
      if (table) {
        const sy = Math.floor(table.headTop * SCALE);
        const sh = Math.ceil(headH * SCALE);
        ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, 0, canvas.width, sh);
      }
      const dy = Math.floor(headH * SCALE);
      const sy = Math.floor(start * SCALE);
      const sh = Math.min(canvas.height - sy, slice.height - dy);
      ctx.drawImage(canvas, 0, sy, canvas.width, sh, 0, dy, canvas.width, sh);
      if (!first) pdf.addPage();
      first = false;
      pdf.addImage(slice.toDataURL("image/jpeg", 0.92), "JPEG", setup.marginMm, setup.marginMm, contentWmm, slice.height / SCALE / PX_PER_MM);
      start = end;
    }
    pdf.save(fileName);
  } finally {
    iframe.remove();
  }
}
