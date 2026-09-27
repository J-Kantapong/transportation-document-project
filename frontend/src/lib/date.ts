// Native <input type="date"> renders in the browser/OS locale format (often mm/dd/yyyy),
// which cannot be overridden via the lang attribute. Pages use a text input formatted as
// dd/mm/yyyy instead, converting to/from the ISO string the rest of the app expects.

export function todayIso(): string {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join(
    "-",
  );
}

export function isoToDisplayDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

export function formatDateDigits(digits: string): string {
  const d = digits.slice(0, 2);
  const m = digits.slice(2, 4);
  const y = digits.slice(4, 8);
  return [d, m, y].filter(Boolean).join("/");
}

// ช่องวันที่ที่พนักงานกรอกตามเอกสารราชการ (เช่น ใบเสร็จกรมขนส่งพิมพ์ 23 กันยายน 2569): พิมพ์ปี พ.ศ. ครบ 8 หลักแล้ว
// แปลงเป็น ค.ศ. ให้ทันที (ปีตั้งแต่ 2400 = พ.ศ. ลบ 543) - คืนค่าเป็นรูปแบบ วว/ดด/ปปปป เหมือน formatDateDigits
export function formatDateDigitsCe(digits: string): string {
  const year = Number(digits.slice(4, 8));
  if (digits.length === 8 && year >= 2400) return formatDateDigits(`${digits.slice(0, 4)}${year - 543}`);
  return formatDateDigits(digits);
}

// new Date(...).toISOString() throws on an out-of-range calendar date (e.g. month 17)
// instead of returning an invalid date, so callers must check getTime() first.
function isoIfValid(iso: string): string {
  const year = Number(iso.slice(0, 4));
  if (year < 1900 || year > 2100) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10) === iso ? iso : "";
}

export function displayDateToIso(digits: string): string {
  if (digits.length !== 8) return "";
  return isoIfValid(`${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`);
}

// Batch import cells arrive either as DD-MM-YYYY text (the documented file format) or,
// for real Excel date cells, already-ISO text (see the Date-cell branch in the file parser).
// ปี พ.ศ. (ตั้งแต่ 2400) แปลงเป็น ค.ศ. ให้ และรับ วว/ดด/ปปปป ด้วย (พบ 2026-09-27: เดิมไฟล์ที่ใส่ 25-09-2569 ไม่ผ่าน)
export function parseBatchDate(value: string): string {
  const ce = (year: string) => (Number(year) >= 2400 ? String(Number(year) - 543) : year);
  const ddmmyyyy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(value);
  if (ddmmyyyy) {
    const [, d, m, y] = ddmmyyyy;
    return isoIfValid(`${ce(y)}-${m}-${d}`);
  }
  const iso = /^(\d{4})-(\d{2}-\d{2})$/.exec(value);
  if (iso) {
    return isoIfValid(`${ce(iso[1])}-${iso[2]}`);
  }
  return "";
}

// เวลาเต็ม (ISO timestamp เช่น deletedAt / deliveryConfirmedAt) -> วว/ดด/ปปปป ตามวันในเครื่องผู้ใช้ (เวลาไทย)
// ห้ามใช้ slice(0, 10) กับเวลาเต็ม: ช่วง 00:00-07:00 จะได้วันเมื่อวาน (พบ 2026-09-27) - ใช้ slice ได้เฉพาะช่องที่เป็นวันที่ล้วน
export function timestampToDisplayDate(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return [String(date.getDate()).padStart(2, "0"), String(date.getMonth() + 1).padStart(2, "0"), date.getFullYear()].join("/");
}
