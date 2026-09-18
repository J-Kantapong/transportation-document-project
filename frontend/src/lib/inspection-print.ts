import type { InspectionVehicle } from "@/lib/api";

export const DEFAULT_INSPECTION_PRINT_HEADER = "บริษัท เอส.พี.อินเตอร์เนชั่นแนล จำกัด";

// [หัวคอลัมน์, ความกว้าง (% ของความกว้างกระดาษ), ค่าในเซลล์] - รวมความกว้าง 100% ให้ตารางพอดี A4 เสมอ
const COLUMNS: Array<[string, number, (v: InspectionVehicle, index: number) => string]> = [
  ["ลำดับที่", 8, (_v, index) => String(index + 1)],
  ["ประเภทรถ", 20, (v) => v.body ?? ""],
  ["ยี่ห้อ", 10, (v) => v.brandName],
  ["เลขตัวถัง", 24, (v) => v.chassis],
  ["เลขเครื่อง", 28, (v) => v.engine ?? ""],
  ["สี", 10, (v) => v.color ?? ""],
];

const thaiCollator = new Intl.Collator("th", { numeric: true });

// เรียงแถวตามลำดับคอลัมน์: ประเภทรถ → ยี่ห้อ → เลขตัวถัง → เลขเครื่อง → สี (ลำดับที่รันใหม่หลังเรียง)
function sortVehicles(vehicles: InspectionVehicle[]): InspectionVehicle[] {
  const keys: Array<(v: InspectionVehicle) => string> = [
    (v) => v.body ?? "",
    (v) => v.brandName,
    (v) => v.chassis,
    (v) => v.engine ?? "",
    (v) => v.color ?? "",
  ];
  return [...vehicles].sort((a, b) => {
    for (const key of keys) {
      const diff = thaiCollator.compare(key(a), key(b));
      if (diff) return diff;
    }
    return 0;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function buildInspectionSheetHtml(title: string, header: string, subtitle: string, vehicles: InspectionVehicle[]): string {
  const cols = COLUMNS.map(([, width]) => `<col style="width:${width}%">`).join("");
  const head = COLUMNS.map(([label]) => `<th>${escapeHtml(label)}</th>`).join("");
  const body = sortVehicles(vehicles)
    .map((v, i) => `<tr>${COLUMNS.map(([, , get]) => `<td>${escapeHtml(get(v, i))}</td>`).join("")}</tr>`)
    .join("");

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; }
  body { font-family: "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif; color: #000; font-size: 10.5pt; }
  h1 { margin: 0 0 2mm; font-size: 16pt; text-align: center; }
  .subtitle { margin: 0 0 4mm; text-align: center; font-size: 12pt; }
  /* table-layout: fixed + <col> เป็น % = ตารางกว้างเท่าหน้ากระดาษพอดี ไม่ขยายตามข้อความยาว */
  table { width: 100%; table-layout: fixed; border-collapse: collapse; }
  /* เส้น 2px (1.5pt): Chrome ปัดความหนาเส้นเป็นจำนวนเต็ม px - เส้น 1px (0.75pt) บางกว่า 1 pixel จอ
     โปรแกรมเปิด PDF จึงวาดเป็นสีเทาจาง/ขาดช่วง โดยเฉพาะเส้นขอบนอกตาราง ส่วน 2px ทึบต่อเนื่องทุกระดับซูม */
  th, td { border: 2px solid #000; padding: 1.2mm 1.5mm; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #eee; text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  td:first-child { text-align: center; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
</style>
</head>
<body>
<h1>${escapeHtml(header)}</h1>
${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
<table><colgroup>${cols}</colgroup><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body>
</html>`;
}

// พิมพ์ผ่าน iframe ที่ซ่อนไว้ - ผู้ใช้เลือก "บันทึกเป็น PDF" ใน dialog พิมพ์ของเบราว์เซอร์
// (ใช้ print ของเบราว์เซอร์แทน library สร้าง PDF เพราะแสดงผลภาษาไทย/สระ/วรรณยุกต์ได้ถูกต้องโดยไม่ต้องฝังฟอนต์)
export function printInspectionSheet(options: {
  title: string;
  header: string;
  subtitle: string;
  vehicles: InspectionVehicle[];
}): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  // iframe ขนาดเท่ากระดาษ A4 วางไว้นอกจอ - ขนาด 0x0 ทำให้บางเบราว์เซอร์จัดหน้าพิมพ์เพี้ยน/ไม่พอดี A4
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  iframe.srcdoc = buildInspectionSheetHtml(options.title, options.header, options.subtitle, options.vehicles);

  iframe.onload = async () => {
    const win = iframe.contentWindow;
    if (!win) return;
    // รอฟอนต์ภาษาไทยโหลดก่อนพิมพ์ แต่ไม่เกิน 3 วินาที (ออฟไลน์จะใช้ฟอนต์สำรองของเครื่องแทน)
    await Promise.race([win.document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    win.addEventListener("afterprint", () => setTimeout(() => iframe.remove(), 0));
    win.focus();
    win.print();
  };

  document.body.appendChild(iframe);
}
