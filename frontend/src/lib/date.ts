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

export function displayDateToIso(digits: string): string {
  if (digits.length !== 8) return "";
  const iso = `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
  const year = Number(digits.slice(4, 8));
  if (year < 1900 || year > 2100) return "";
  return new Date(iso).toISOString().slice(0, 10) === iso ? iso : "";
}
