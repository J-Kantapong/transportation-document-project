// ป้ายแจ้งลอยมุมขวาบน หายเองใน 3.5 วินาที (ผู้ใช้ 2026-11-19) - ใช้บอก "บันทึกแล้ว" หลังกดปุ่มสำเร็จ
// ผิดพลาดให้ใช้ <Notice tone="error"> ในหน้า (ค้างไว้จนแก้) ไม่ใช้ toast · เรียกได้จากทุกที่ ไม่ต้องมี Provider
const ICON_OK = '<circle cx="12" cy="12" r="10"/><path d="m8.5 12 2.5 2.5 4.5-5"/>';
const ICON_INFO = '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>';

function region(): HTMLElement {
  let el = document.getElementById("toast-region");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast-region";
    el.className = "toast-region";
    el.setAttribute("aria-live", "polite");
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  return el;
}

function show(message: string, tone: "success" | "info") {
  if (typeof document === "undefined") return;
  const item = document.createElement("div");
  item.className = `toast toast--${tone}`;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = tone === "success" ? ICON_OK : ICON_INFO;
  const text = document.createElement("span");
  text.textContent = message;
  item.append(svg, text);
  region().append(item);
  const remove = () => {
    item.classList.add("toast--leaving");
    window.setTimeout(() => item.remove(), 200);
  };
  const timer = window.setTimeout(remove, 3500);
  item.addEventListener("click", () => {
    window.clearTimeout(timer);
    remove();
  });
}

export const toast = {
  success: (message: string) => show(message, "success"),
  info: (message: string) => show(message, "info"),
};
