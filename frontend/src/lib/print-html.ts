// พิมพ์เอกสาร HTML ผ่าน iframe ที่ซ่อนไว้ - ผู้ใช้เลือกเครื่องพิมพ์หรือ "บันทึกเป็น PDF" ในหน้าต่างพิมพ์ของเบราว์เซอร์
// (แสดงภาษาไทยได้ถูกต้องโดยไม่ต้องฝังฟอนต์) ใช้กับใบส่งงานยื่นเอกสาร ใบส่งงาน Delivery และรายงานส่งงาน
export function printHtmlDocument(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0";
  iframe.srcdoc = html;

  iframe.onload = async () => {
    const win = iframe.contentWindow;
    if (!win) return;
    await Promise.race([win.document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 3000))]);
    win.addEventListener("afterprint", () => setTimeout(() => iframe.remove(), 0));
    win.focus();
    win.print();
  };

  document.body.appendChild(iframe);
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
