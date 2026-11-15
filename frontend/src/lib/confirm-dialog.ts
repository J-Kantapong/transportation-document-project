// กล่องยืนยันของระบบ ใช้แทน window.confirm / window.prompt (หน้าตาเดียวกับ <dialog> อื่นในแอป)
// สร้าง <dialog> ชั่วคราวใน body แล้ว showModal() - ระหว่างเปิด ส่วนอื่นของหน้ากดไม่ได้ (เหมือน confirm เดิม)
// Escape หรือ "ยกเลิก" = false / null · ข้อความขึ้นบรรทัดใหม่ด้วย \n ได้

type ConfirmOptions = { confirmLabel?: string; cancelLabel?: string; danger?: boolean };

function build(message: string, options: ConfirmOptions) {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("role", "alertdialog");
  const text = document.createElement("p");
  text.className = "confirm-dialog-text";
  text.id = `confirm-${Date.now()}`;
  text.textContent = message;
  dialog.setAttribute("aria-labelledby", text.id);
  const actions = document.createElement("div");
  actions.className = "confirm-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "confirm-dialog-cancel";
  cancel.textContent = options.cancelLabel ?? "ยกเลิก";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = options.danger ? "primary danger" : "primary";
  ok.textContent = options.confirmLabel ?? "ยืนยัน";
  actions.append(cancel, ok);
  dialog.append(text, actions);
  return { dialog, text, actions, cancel, ok };
}

export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  // ไม่มี DOM หรือเบราว์เซอร์เก่าที่ไม่มี showModal: ใช้ของเดิม
  if (typeof document === "undefined" || typeof HTMLDialogElement === "undefined") {
    return Promise.resolve(typeof window !== "undefined" ? window.confirm(message) : false);
  }
  return new Promise((resolve) => {
    const { dialog, cancel, ok } = build(message, options);
    const finish = (value: boolean) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}

// แจ้งข้อความ (แทน window.alert) - ปุ่มเดียว "ตกลง" · ไม่ต้อง await ก็ได้ เพราะไม่มีอะไรรอคำตอบ
export function alertDialog(message: string): Promise<void> {
  if (typeof document === "undefined" || typeof HTMLDialogElement === "undefined") {
    if (typeof window !== "undefined") window.alert(message);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const { dialog, cancel, ok } = build(message, { confirmLabel: "ตกลง" });
    cancel.remove();
    const finish = () => {
      dialog.close();
      dialog.remove();
      resolve();
    };
    ok.addEventListener("click", finish);
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish();
    });
    document.body.append(dialog);
    dialog.showModal();
    ok.focus();
  });
}

// ถามข้อความ (เช่น เหตุผล) - คืน null เมื่อยกเลิก
export function promptDialog(message: string, options: ConfirmOptions = {}): Promise<string | null> {
  if (typeof document === "undefined" || typeof HTMLDialogElement === "undefined") {
    return Promise.resolve(typeof window !== "undefined" ? window.prompt(message) : null);
  }
  return new Promise((resolve) => {
    const { dialog, text, actions, cancel, ok } = build(message, options);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "confirm-dialog-input";
    input.setAttribute("aria-labelledby", text.id);
    dialog.insertBefore(input, actions);
    const finish = (value: string | null) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => finish(null));
    ok.addEventListener("click", () => finish(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") finish(input.value);
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
  });
}
