"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api, type DocumentSubmission, type ReceiptCheckEntry, type ReceiptImage, type ReceiptSummary } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { ReceiptAttachButton, ReceiptBatchPanel, ReceiptThumbs, toReceiptSummary } from "./ReceiptPhotos";

// หน้ารับใบเสร็จ (Step 5) - ตรวจทีละ "ใบยื่น" ให้ตรงกับใบส่งงานที่ปริ้นออกไป (ดู SubmittedRecordsView/JobSheetPrintDialog):
// 1 ใบยื่น = วันที่ยื่น + กลุ่ม (รย.1 ธรรมดา/ด่วน, รย.2-3, มอเตอร์ไซค์ ธรรมดา/ด่วน) + เจ้าของงาน, เรียงตามลำดับที่บันทึกยื่น
// พนักงานรถยนต์/มอเตอร์ไซค์แยกแท็บกัน. แนบรูปใบเสร็จให้แต่ละคัน -> ระบบนับ ยื่นไป/ได้ใบเสร็จ/ขาด ให้เห็นทันที
// คันที่ขาด: รู้สาเหตุ = ยื่นไม่สำเร็จ (กลับไป Step 4 - กฎผู้ใช้ 2026-09-20), ยังไม่รู้ = ย้ายไป "ค้างจากใบก่อน"

type Tab = "car" | "moto";
const TAB_STORAGE_KEY = "receipt-check-tab";
const CARRIED_KEY = "__carried__";

// สาเหตุที่ยังไม่ได้ใบเสร็จ (ผู้ใช้กำหนด) - ทุกสาเหตุ = ยื่นไม่สำเร็จ
const MISSING_REASONS = [
  "บัตรประชาชนหมดอายุ",
  "เลขทะเบียนของกรมขนส่งยังไม่ถึง",
  "ใบเสร็จ/ใบกำกับผิด",
  "หนังสือรับรองถิ่นที่อยู่หมดอายุ",
  "อื่นๆ",
] as const;

function sheetGroup(s: DocumentSubmission): { tab: Tab; label: string } {
  const body = s.vehicle.body ?? "";
  if (body.startsWith("รย.12-")) return { tab: "moto", label: s.urgent ? "มอเตอร์ไซค์ แบบด่วน" : "มอเตอร์ไซค์ แบบธรรมดา" };
  if (body.startsWith("รย.1-")) return { tab: "car", label: s.urgent ? "รย.1 แบบด่วน" : "รย.1 แบบธรรมดา" };
  if (body.startsWith("รย.2-") || body.startsWith("รย.3-")) return { tab: "car", label: "รย.2 และ รย.3" };
  return { tab: "car", label: "ไม่ระบุประเภทรถ" };
}

const sheetKey = (s: DocumentSubmission) => `${s.submitDate.slice(0, 10)}|${sheetGroup(s).label}|${s.vehicle.customer.name}`;

interface Sheet {
  key: string;
  tab: Tab;
  date: string;
  label: string;
  owner: string;
  rows: DocumentSubmission[]; // ทุกคันในใบ เรียงตามลำดับในใบที่ปริ้น (createdAt)
}

// คันที่ต้องตรวจในใบนี้ = ยังรอใบเสร็จและยังไม่ถูกย้ายไปค้าง
const isOpen = (s: DocumentSubmission) => s.status === "PENDING" && !s.receiptCarriedAt;

interface RowInput {
  plateCategory: string;
  plateNumber: string;
  amountText: string;
  reason: string; // "" = ยังไม่รู้สาเหตุ (ค้างไว้)
  otherText: string;
}

const money = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
const billOf = (s: DocumentSubmission) => (s.taxAmount === null ? null : Number(s.billFeeTotal) + Number(s.taxAmount));
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

function CompareBadge({ s, amountText }: { s: DocumentSubmission; amountText: string }) {
  const text = amountText.trim();
  if (!text) return null;
  if (!AMOUNT_RE.test(text)) return <span className="badge warn">ตัวเลขไม่ถูกต้อง</span>;
  const bill = billOf(s);
  if (bill === null) return <span className="badge">เทียบไม่ได้ (ยังคำนวณภาษีไม่ได้)</span>;
  const diff = Math.round((Number(text) - bill) * 100) / 100;
  if (diff === 0) return <span className="badge done">ตรง Bill</span>;
  return (
    <span className="badge warn">
      ไม่ตรง Bill ({diff > 0 ? "+" : ""}
      {money(diff)})
    </span>
  );
}

type Ai = Extract<NonNullable<ReceiptSummary["extraction"]>, { reading: unknown }>;

// ผลอ่านล่าสุดของรถคันนี้ (รูปที่แนบทีหลังถือเป็นรูปที่ถูกต้องกว่า) - ไม่เอารูปที่เลขตัวถังเป็นของรถคันอื่น
// มากรอกทะเบียน/ยอดให้ ไม่งั้นรถจะได้ทะเบียนของคันอื่นถ้าพนักงานไม่ทันเห็นคำเตือน
function latestAi(list: ReceiptSummary[] | undefined): Ai | null {
  for (const r of [...(list ?? [])].reverse()) {
    if (r.extraction && "reading" in r.extraction && r.extraction.match !== "chassis-mismatch") return r.extraction as Ai;
  }
  return null;
}

// รูปที่แนบกับรถคันนี้แต่เลขตัวถังในใบเสร็จเป็นของคันอื่น - ต้องลบก่อนบันทึก
function wrongCarReceipts(list: ReceiptSummary[] | undefined): Ai[] {
  return (list ?? []).flatMap((r) => (r.extraction && "reading" in r.extraction && r.extraction.match === "chassis-mismatch" ? [r.extraction as Ai] : []));
}

function latestAiError(list: ReceiptSummary[] | undefined): string | null {
  const last = list?.[list.length - 1]?.extraction;
  return last && "error" in last ? last.error : null;
}

// ช่องที่ต้องให้คนเช็ก: AI บอกเองว่าไม่มั่นใจ หรือการตรวจอัตโนมัติไม่ผ่าน
function needsCheck(ai: Ai | null) {
  if (!ai) return { plate: false, total: false, chassis: false };
  const u = ai.reading.uncertainFields;
  return {
    plate: u.includes("plate") || !ai.checks.plateValid,
    total: u.includes("total") || u.includes("items") || !ai.checks.itemsSumMatchesTotal,
    chassis: u.includes("chassis") || !ai.checks.chassisValid,
  };
}

const CHECK_STYLE = { border: "2px solid #e0a31a", background: "#fff8e6" };

// เทียบรายการบนใบเสร็จกับ Bill ที่ระบบคำนวณ: แยกภาษีกับค่าธรรมเนียม + บอกสาเหตุที่น่าจะเป็น (แบบ ข - แก้ข้อมูลรถ)
function aiFindingLines(s: DocumentSubmission, ai: Ai | null, amountText: string, wrong: Ai[]): string[] {
  const lines: string[] = wrong.map((w) => `มีรูปใบเสร็จของรถคันอื่นแนบอยู่ (เลขตัวถัง ${w.reading.chassis}) - ลบรูปนั้นก่อนบันทึก`);
  if (!ai) return lines;
  // ทะเบียนที่กรอกไว้ตอนยื่น (Step 4) ไม่ตรงกับใบเสร็จ = พนักงานกรอกผิดตอนยื่น - บันทึกจะใช้ตามใบเสร็จ
  const r = ai.reading;
  const v = s.vehicle;
  if (v.plateCategory && v.plateNumber && r.plateCategory && r.plateNumber && (v.plateCategory !== r.plateCategory || v.plateNumber !== r.plateNumber)) {
    lines.push(`ทะเบียนตอนยื่น ${v.plateCategory} ${v.plateNumber} ไม่ตรงกับใบเสร็จ ${r.plateCategory} ${r.plateNumber} - บันทึกแล้วจะใช้ตามใบเสร็จ`);
  }
  const check = needsCheck(ai);
  const toCheck = [check.plate && "ทะเบียน", check.total && "ยอดเงิน", check.chassis && "เลขตัวถัง"].filter(Boolean);
  if (toCheck.length) lines.push(`เช็กกับรูปอีกครั้ง: ${toCheck.join(", ")}`);

  const amount = AMOUNT_RE.test(amountText.trim()) ? Number(amountText.trim()) : null;
  const bill = billOf(s);
  if (amount !== null && bill !== null && Math.round((amount - bill) * 100) !== 0) {
    const taxOnReceipt = ai.reading.items.filter((it) => it.label.includes("ภาษี")).reduce((sum, it) => sum + it.amount, 0);
    const feeOnReceipt = Math.round((amount - taxOnReceipt) * 100) / 100;
    const taxDiff = Math.round((taxOnReceipt - Number(s.taxAmount)) * 100) / 100;
    const feeDiff = Math.round((feeOnReceipt - Number(s.billFeeTotal)) * 100) / 100;
    const sign = (n: number) => `${n > 0 ? "+" : ""}${money(n)}`;
    lines.push(`ไม่ตรง Bill - ภาษี ${taxDiff === 0 ? "ตรง" : `ต่าง ${sign(taxDiff)}`} · ค่าธรรมเนียม ${feeDiff === 0 ? "ตรง" : `ต่าง ${sign(feeDiff)}`}`);
    // ขอใช้จังหวัดอื่น = ค่าคำขอเพิ่ม 5 + ธรรมเนียมอื่นๆ 20 (เห็นจากใบเสร็จจริง) - ตัดสินจากจังหวัดเจ้าของรถ
    const receiptOtherProvince = ai.reading.items.some((it) => it.label.includes("ธรรมเนียมอื่น"));
    const billOtherProvince = s.billItems.some((it) => it.label.includes("ขอใช้จังหวัดอื่น"));
    if (receiptOtherProvince !== billOtherProvince) {
      lines.push(
        receiptOtherProvince
          ? "ใบเสร็จเป็นการจดต่างจังหวัด แต่ระบบคิดเป็นจังหวัดเดียวกัน - ตรวจจังหวัดเจ้าของรถของคันนี้"
          : "ใบเสร็จเป็นการจดจังหวัดเดียวกัน แต่ระบบคิดเป็นต่างจังหวัด - ตรวจจังหวัดเจ้าของรถของคันนี้",
      );
    }
  }
  if (amount === null) lines.push("ยังไม่มียอดใบเสร็จ");
  else if (bill === null) lines.push("เทียบยอดไม่ได้ - ระบบยังคำนวณภาษีของคันนี้ไม่ได้");
  return lines;
}

function AiFindings({ s, ai, amountText, wrong }: { s: DocumentSubmission; ai: Ai | null; amountText: string; wrong: Ai[] }) {
  const lines = aiFindingLines(s, ai, amountText, wrong);
  if (lines.length === 0) return <span className="badge done">AI ตรวจแล้ว ตรงทุกอย่าง</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {lines.map((text) => (
        <span key={text} style={{ fontSize: 12, color: "#b5651d" }}>
          ⚠ {text}
        </span>
      ))}
    </div>
  );
}

// ใบเสร็จคือข้อเท็จจริง: มีผลอ่านแล้วใช้ทะเบียน/ยอดตามใบเสร็จ (ช่องที่อ่านไม่ออกคงค่าเดิมไว้)
function withAi(input: RowInput, ai: Ai | null): RowInput {
  if (!ai) return input;
  const r = ai.reading;
  return {
    ...input,
    plateCategory: r.plateCategory ?? input.plateCategory,
    plateNumber: r.plateNumber ?? input.plateNumber,
    amountText: r.total !== null ? String(r.total) : input.amountText,
  };
}

function StatusText({ s }: { s: DocumentSubmission }) {
  if (s.status === "RECEIPT_RECEIVED") return <span className="badge done">ได้ใบเสร็จแล้ว</span>;
  if (s.status === "FAILED") return <span className="badge warn">ยื่นไม่สำเร็จ: {s.failRemark || "—"}</span>;
  return <span className="badge">ย้ายไปค้างจากใบก่อนแล้ว</span>;
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  const bg = tone === "ok" ? "#eaf7f2" : tone === "warn" ? "#fff6e7" : "#f4f6fa";
  const color = tone === "ok" ? "#23825f" : tone === "warn" ? "#bb8527" : "#576781";
  return (
    <div style={{ background: bg, borderRadius: 8, padding: "10px 14px", minWidth: 120 }}>
      <div style={{ fontSize: 12, color }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

export function ReceiptCheckPage() {
  const [tab, setTab] = useState<Tab>("car");
  const [pending, setPending] = useState<DocumentSubmission[]>([]);
  const [sheetRows, setSheetRows] = useState<DocumentSubmission[]>([]); // ทุกคันของวันที่ที่มีใบยื่นค้างตรวจ
  const [completed, setCompleted] = useState<DocumentSubmission[]>([]);
  const [receipts, setReceipts] = useState<Record<string, ReceiptSummary[]>>({});
  const [inputs, setInputs] = useState<Record<string, RowInput>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function loadAll() {
    setLoading(true);
    setError("");
    try {
      const [p, c] = await Promise.all([api.listDocumentSubmissions(undefined, "PENDING"), api.listDocumentSubmissions(undefined, "RECEIPT_RECEIVED")]);
      // ใบยื่นต้องแสดงครบทุกคันตามกระดาษ (รวมคันที่ได้ใบเสร็จ/ยื่นไม่สำเร็จไปแล้ว) - โหลดทุกสถานะของวันที่ที่ยังมีคันค้างตรวจ
      const dates = [...new Set(p.submissions.filter(isOpen).map((s) => s.submitDate.slice(0, 10)))];
      const byDate = await Promise.all(dates.map((d) => api.listDocumentSubmissions(d)));
      const all = [...byDate.flatMap((r) => r.submissions), ...p.submissions, ...c.submissions];
      setPending(p.submissions);
      setSheetRows(byDate.flatMap((r) => r.submissions));
      setCompleted(c.submissions);
      setReceipts(Object.fromEntries(all.map((s) => [s.id, s.receipts ?? []])));
      setInputs(
        Object.fromEntries(
          p.submissions.map((s) => [
            s.id,
            withAi(
              { plateCategory: s.vehicle.plateCategory ?? "", plateNumber: s.vehicle.plateNumber ?? "", amountText: "", reason: "", otherText: "" },
              latestAi(s.receipts),
            ),
          ]),
        ),
      );
      setRowErrors({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(TAB_STORAGE_KEY);
      if (saved === "car" || saved === "moto") setTab(saved);
    } catch {}
    loadAll();
  }, []);

  function switchTab(next: Tab) {
    setTab(next);
    setOpenKey(null);
    try {
      window.localStorage.setItem(TAB_STORAGE_KEY, next);
    } catch {}
  }

  const sheets = useMemo(() => {
    const map = new Map<string, Sheet>();
    for (const s of [...sheetRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const key = sheetKey(s);
      if (!map.has(key)) {
        const g = sheetGroup(s);
        map.set(key, { key, tab: g.tab, date: s.submitDate.slice(0, 10), label: g.label, owner: s.vehicle.customer.name, rows: [] });
      }
      map.get(key)!.rows.push(s);
    }
    return [...map.values()]
      .filter((sh) => sh.tab === tab && sh.rows.some(isOpen))
      .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label, "th") || a.owner.localeCompare(b.owner, "th"));
  }, [sheetRows, tab]);

  const carried = useMemo(
    () => pending.filter((s) => s.receiptCarriedAt && sheetGroup(s).tab === tab).sort((a, b) => a.submitDate.localeCompare(b.submitDate)),
    [pending, tab],
  );

  const openSheet: Sheet | null =
    openKey === CARRIED_KEY
      ? { key: CARRIED_KEY, tab, date: "", label: "ค้างจากใบก่อน", owner: "", rows: carried }
      : (sheets.find((sh) => sh.key === openKey) ?? null);

  // คันที่พนักงานต้องตัดสินในใบที่เปิดอยู่
  const activeRows = openSheet ? openSheet.rows.filter((s) => s.status === "PENDING" && (openSheet.key === CARRIED_KEY || !s.receiptCarriedAt)) : [];
  const hasPhoto = (id: string) => (receipts[id] ?? []).length > 0;
  const gotCount = openSheet ? openSheet.rows.filter((s) => s.status === "RECEIPT_RECEIVED" || (activeRows.includes(s) && hasPhoto(s.id))).length : 0;
  const missingRows = activeRows.filter((s) => !hasPhoto(s.id));
  // คันที่ AI อ่านใบเสร็จแล้ว - ตรงทุกอย่าง = พนักงานแค่เหลือบดู, ที่เหลือต้องเช็กตามที่ขึ้นเตือน
  const aiChecked = activeRows.filter((s) => latestAi(receipts[s.id]) || wrongCarReceipts(receipts[s.id]).length > 0);
  const aiAllGood = aiChecked.filter(
    (s) => aiFindingLines(s, latestAi(receipts[s.id]), inputs[s.id]?.amountText ?? "", wrongCarReceipts(receipts[s.id])).length === 0,
  ).length;

  function patchInput(id: string, patch: Partial<RowInput>) {
    setInputs((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
  }

  function addReceipt(receipt: ReceiptImage) {
    const id = receipt.submissionId;
    if (!id) return;
    setReceipts((prev) => ({ ...prev, [id]: [...(prev[id] ?? []), toReceiptSummary(receipt)] }));
    // รูปใหม่ที่ AI อ่านได้ -> กรอกทะเบียน/ยอดให้ตามใบเสร็จ (พนักงานแค่ตรวจ)
    const extraction = receipt.extraction;
    if (extraction && "reading" in extraction) setInputs((prev) => (prev[id] ? { ...prev, [id]: withAi(prev[id], extraction as Ai) } : prev));
  }

  async function removeReceipt(submissionId: string, receiptId: string) {
    if (!window.confirm("ลบรูปใบเสร็จนี้?")) return;
    try {
      await api.deleteReceipt(receiptId);
      setReceipts((prev) => ({ ...prev, [submissionId]: (prev[submissionId] ?? []).filter((r) => r.id !== receiptId) }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [submissionId]: err instanceof ApiError ? err.message : "ลบรูปไม่สำเร็จ" }));
    }
  }

  async function handleSave() {
    if (!openSheet) return;
    const receivedDate = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!receivedDate) return setMessage({ text: "วันที่รับใบเสร็จไม่ถูกต้อง", error: true });

    const entries: ReceiptCheckEntry[] = [];
    const errors: Record<string, string> = {};
    for (const s of activeRows) {
      const input = inputs[s.id];
      if (hasPhoto(s.id)) {
        if (wrongCarReceipts(receipts[s.id]).length > 0) errors[s.id] = "มีรูปใบเสร็จของรถคันอื่นแนบอยู่ - ลบรูปนั้นก่อนบันทึก";
        else if (!input.plateCategory.trim() || !input.plateNumber.trim()) errors[s.id] = "กรอกหมวดและเลขทะเบียนตามใบเสร็จ";
        else if (input.amountText.trim() && !AMOUNT_RE.test(input.amountText.trim())) errors[s.id] = "ยอดใบเสร็จต้องเป็นตัวเลข";
        else
          entries.push({
            submissionId: s.id,
            action: "RECEIVED",
            plateCategory: input.plateCategory.trim(),
            plateNumber: input.plateNumber.trim(),
            receiptAmount: input.amountText.trim() || undefined,
          });
      } else if (input.reason) {
        const remark = input.reason === "อื่นๆ" ? input.otherText.trim() : input.reason;
        if (!remark) errors[s.id] = "ระบุสาเหตุ";
        else entries.push({ submissionId: s.id, action: "FAILED", failRemark: input.reason === "อื่นๆ" ? `อื่นๆ: ${remark}` : remark });
      } else if (openSheet.key !== CARRIED_KEY) {
        entries.push({ submissionId: s.id, action: "CARRY" });
      }
    }
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      return setMessage({ text: `แก้ไข ${Object.keys(errors).length} คันที่ขึ้นสีแดงก่อนบันทึก`, error: true });
    }
    if (entries.length === 0) return setMessage({ text: "ยังไม่มีอะไรให้บันทึก - แนบรูปใบเสร็จหรือเลือกสาเหตุก่อน", error: true });

    const got = entries.filter((e) => e.action === "RECEIVED").length;
    const failed = entries.filter((e) => e.action === "FAILED").length;
    const carry = entries.filter((e) => e.action === "CARRY").length;
    const summary = [`ได้ใบเสร็จ ${got} คัน`, failed ? `ยื่นไม่สำเร็จ ${failed} คัน (กลับไป Step 4)` : "", carry ? `ค้างไว้ ${carry} คัน` : ""].filter(Boolean).join("\n");
    if (!window.confirm(`บันทึก${openSheet.key === CARRIED_KEY ? "รายการค้าง" : "ใบยื่นนี้"}?\n\n${summary}`)) return;

    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const res = await api.saveReceiptCheck(receivedDate, entries);
      if (res.failed.length > 0) {
        // โหลดใหม่แล้วแสดงเหตุผลของคันที่พลาดไว้ในแถว
        await loadAll();
        setRowErrors(Object.fromEntries(res.failed.map((f) => [f.submissionId, f.error])));
        setMessage({ text: `บันทึกแล้ว ${res.succeeded.length} คัน · ไม่สำเร็จ ${res.failed.length} คัน (ดูเหตุผลในแถว)`, error: true });
      } else {
        await loadAll();
        setOpenKey(null);
        setMessage({ text: `บันทึกแล้ว - ${summary.replace(/\n/g, " · ")}` });
      }
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSaving(false);
    }
  }

  const sheetTitle = (sh: Sheet) => `${isoToDisplayDate(sh.date)} · ${sh.label} · ${sh.owner}`;

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>รับใบเสร็จ</h1>

      <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center", flexWrap: "wrap" }}>
        {(
          [
            ["car", "รถยนต์"],
            ["moto", "มอเตอร์ไซค์"],
          ] as Array<[Tab, string]>
        ).map(([t, label]) => (
          <button
            key={t}
            type="button"
            onClick={() => switchTab(t)}
            className={tab === t ? "primary" : undefined}
            style={tab === t ? undefined : { border: "1px solid #dce2ec", background: "#fff", padding: "12px 20px", borderRadius: 8 }}
            aria-pressed={tab === t}
          >
            {label}
          </button>
        ))}
        <label className="field" style={{ marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 8 }}>
          วันที่รับใบเสร็จ
          <input
            type="text"
            inputMode="numeric"
            placeholder="วว/ดด/ปปปป"
            value={dateText}
            onChange={(e) => setDateText(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
            style={{ width: 120 }}
          />
        </label>
      </div>

      {message.text && (
        <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ marginTop: 12 }}>
          {message.text}
        </div>
      )}

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>ใบยื่นที่รอตรวจใบเสร็จ ({sheets.length})</h2>
        </div>
        {loading ? (
          <div className="customer-message" role="status" style={{ padding: "0 23px 20px" }}>
            กำลังโหลด...
          </div>
        ) : error ? (
          <div className="empty-customers" role="alert">
            {error}
          </div>
        ) : sheets.length === 0 && carried.length === 0 ? (
          <div className="empty-customers">ไม่มีใบยื่นที่รอใบเสร็จ</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 23px 20px" }}>
            {sheets.map((sh) => {
              const open = sh.rows.filter(isOpen);
              const withPhoto = open.filter((s) => hasPhoto(s.id)).length;
              return (
                <button
                  key={sh.key}
                  type="button"
                  onClick={() => setOpenKey(openKey === sh.key ? null : sh.key)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 12,
                    textAlign: "left",
                    padding: "12px 14px",
                    borderRadius: 8,
                    border: openKey === sh.key ? "2px solid #2854d9" : "1px solid #dfe5f0",
                    background: "#fff",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{sheetTitle(sh)}</span>
                  <span style={{ color: "#576781", whiteSpace: "nowrap" }}>
                    {sh.rows.length} คัน · รอตรวจ {open.length} · แนบรูปแล้ว {withPhoto}
                  </span>
                </button>
              );
            })}
            {carried.length > 0 && (
              <button
                type="button"
                onClick={() => setOpenKey(openKey === CARRIED_KEY ? null : CARRIED_KEY)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  textAlign: "left",
                  padding: "12px 14px",
                  borderRadius: 8,
                  border: openKey === CARRIED_KEY ? "2px solid #bb8527" : "1px solid #f0d9ae",
                  background: "#fffaf0",
                  cursor: "pointer",
                }}
              >
                <span style={{ fontWeight: 600 }}>ค้างจากใบก่อน</span>
                <span style={{ color: "#bb8527" }}>{carried.length} คัน</span>
              </button>
            )}
          </div>
        )}
      </section>

      {openSheet && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <h2>{openSheet.key === CARRIED_KEY ? "ค้างจากใบก่อน" : sheetTitle(openSheet)}</h2>
          </div>
          <div style={{ padding: "0 23px 20px" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <Metric label={openSheet.key === CARRIED_KEY ? "ค้างอยู่" : "ยื่นไป"} value={`${openSheet.rows.length} คัน`} />
              <Metric label="ได้ใบเสร็จ" value={`${gotCount} ใบ`} tone="ok" />
              <Metric label="ขาด" value={`${missingRows.length} คัน`} tone={missingRows.length > 0 ? "warn" : undefined} />
              {aiChecked.length > 0 && <Metric label="AI ตรวจแล้ว ตรงทุกอย่าง" value={`${aiAllGood} คัน`} tone="ok" />}
              {aiChecked.length - aiAllGood > 0 && <Metric label="ต้องให้คนเช็ก" value={`${aiChecked.length - aiAllGood} คัน`} tone="warn" />}
            </div>

            <ReceiptBatchPanel
              targets={activeRows.map((s) => ({
                id: s.id,
                label: `${openSheet.key === CARRIED_KEY ? isoToDisplayDate(s.submitDate.slice(0, 10)) : `ลำดับ ${openSheet.rows.indexOf(s) + 1}`} · ${s.vehicle.chassis}`,
              }))}
              onAssigned={addReceipt}
            />

            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table>
                <thead>
                  <tr>
                    <th>{openSheet.key === CARRIED_KEY ? "วันที่ยื่น" : "ลำดับ"}</th>
                    <th>เลขตัวรถ</th>
                    <th>รูปใบเสร็จ</th>
                    <th>เลขทะเบียน (หมวด / เลข)</th>
                    <th>Bill</th>
                    <th>ยอดใบเสร็จ</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {openSheet.rows.map((s, i) => {
                    const active = activeRows.includes(s);
                    const input = inputs[s.id];
                    const photo = hasPhoto(s.id);
                    const rowError = rowErrors[s.id];
                    const ai = latestAi(receipts[s.id]);
                    const wrong = wrongCarReceipts(receipts[s.id]);
                    const check = needsCheck(ai);
                    const aiError = photo && !ai ? latestAiError(receipts[s.id]) : null;
                    const bill = billOf(s);
                    return (
                      <tr key={s.id} style={active && !photo ? { background: "#fffaf0" } : !active ? { opacity: 0.6 } : undefined}>
                        <td>{openSheet.key === CARRIED_KEY ? isoToDisplayDate(s.submitDate.slice(0, 10)) : i + 1}</td>
                        <td>
                          <div style={{ fontFamily: "monospace" }}>{s.vehicle.chassis}</div>
                          <div style={{ fontSize: 11, color: "#8a94a6" }}>
                            {s.vehicle.brand.name}
                            {openSheet.key === CARRIED_KEY ? ` · ${s.vehicle.customer.name}` : ""}
                          </div>
                        </td>
                        <td>
                          <ReceiptThumbs receipts={receipts[s.id] ?? []} onDelete={active ? (rid) => removeReceipt(s.id, rid) : undefined} />
                          {active && ai && (
                            <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                              เลขที่ {ai.reading.receiptNo ?? "?"} · {ai.reading.date ? isoToDisplayDate(ai.reading.date) : "?"}
                              {ai.match === "chassis" && " · จับคู่ด้วยเลขตัวถัง"}
                            </div>
                          )}
                          {active && (
                            <ReceiptAttachButton
                              submissionId={s.id}
                              disabled={saving}
                              onUploaded={addReceipt}
                              onMessage={(text, err) => setRowErrors((prev) => ({ ...prev, [s.id]: err ? text : "" }))}
                            />
                          )}
                        </td>
                        <td>
                          {active && input ? (
                            <div style={{ display: "flex", gap: 6 }}>
                              <input
                                type="text"
                                placeholder="8ขก"
                                maxLength={3}
                                value={input.plateCategory}
                                onChange={(e) => patchInput(s.id, { plateCategory: e.target.value.slice(0, 3) })}
                                aria-label="หมวดทะเบียน"
                                style={{ width: 62, ...(check.plate ? CHECK_STYLE : {}) }}
                              />
                              <input
                                type="text"
                                inputMode="numeric"
                                placeholder="3484"
                                maxLength={4}
                                value={input.plateNumber}
                                onChange={(e) => patchInput(s.id, { plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                                aria-label="เลขทะเบียน"
                                style={{ width: 66, ...(check.plate ? CHECK_STYLE : {}) }}
                              />
                            </div>
                          ) : s.vehicle.plateCategory && s.vehicle.plateNumber ? (
                            `${s.vehicle.plateCategory} ${s.vehicle.plateNumber}`
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <div>{bill === null ? "—" : money(bill)}</div>
                          <div style={{ fontSize: 11, color: "#8a94a6" }}>
                            ค่าธรรมเนียม {money(Number(s.billFeeTotal))} + ภาษี {s.taxAmount === null ? "?" : money(Number(s.taxAmount))}
                          </div>
                        </td>
                        <td>
                          {active && input ? (
                            <>
                              <input
                                type="text"
                                inputMode="decimal"
                                placeholder="ยอดรวม"
                                value={input.amountText}
                                onChange={(e) => patchInput(s.id, { amountText: e.target.value })}
                                aria-label="ยอดใบเสร็จ"
                                style={{ width: 96, ...(check.total ? CHECK_STYLE : {}) }}
                              />
                              <div style={{ marginTop: 4 }}>
                                <CompareBadge s={s} amountText={input.amountText} />
                              </div>
                            </>
                          ) : s.receiptAmount !== null ? (
                            money(Number(s.receiptAmount))
                          ) : (
                            "—"
                          )}
                        </td>
                        <td style={{ minWidth: 210 }}>
                          {!active ? (
                            <StatusText s={s} />
                          ) : photo ? (
                            ai || wrong.length > 0 ? (
                              <AiFindings s={s} ai={ai} amountText={input?.amountText ?? ""} wrong={wrong} />
                            ) : aiError ? (
                              <span style={{ fontSize: 12, color: "#b43434" }}>{aiError} - ตรวจรูปแล้วกรอกเอง</span>
                            ) : (
                              <span className="badge done">ได้ใบเสร็จ (กรอกเอง)</span>
                            )
                          ) : (
                            <>
                              <select
                                value={input?.reason ?? ""}
                                onChange={(e) => patchInput(s.id, { reason: e.target.value })}
                                aria-label="สาเหตุที่ยังไม่ได้ใบเสร็จ"
                                style={{ width: "100%" }}
                              >
                                <option value="">{openSheet.key === CARRIED_KEY ? "ยังรอใบเสร็จ" : "ยังไม่ทราบ - ค้างไว้"}</option>
                                {MISSING_REASONS.map((r) => (
                                  <option key={r} value={r}>
                                    ยื่นไม่สำเร็จ: {r}
                                  </option>
                                ))}
                              </select>
                              {input?.reason === "อื่นๆ" && (
                                <input
                                  type="text"
                                  value={input.otherText}
                                  onChange={(e) => patchInput(s.id, { otherText: e.target.value })}
                                  placeholder="ระบุสาเหตุ"
                                  aria-label="ระบุสาเหตุอื่นๆ"
                                  style={{ width: "100%", marginTop: 6 }}
                                />
                              )}
                            </>
                          )}
                          {rowError && (
                            <div className="customer-message error" style={{ fontSize: 11 }} role="alert">
                              {rowError}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
              <span className="customer-message" style={{ fontSize: 13 }}>
                {openSheet.key === CARRIED_KEY
                  ? "คันที่ยังรอใบเสร็จจะอยู่ในรายการนี้ต่อ"
                  : "คันที่ไม่มีใบเสร็จและยังไม่ทราบสาเหตุ จะย้ายไป \"ค้างจากใบก่อน\""}
              </span>
              <button type="button" className="primary" disabled={saving} onClick={handleSave}>
                {saving ? "กำลังบันทึก…" : openSheet.key === CARRIED_KEY ? "บันทึกรายการค้าง" : `บันทึกใบยื่นนี้ (ได้ใบเสร็จ ${activeRows.filter((s) => hasPhoto(s.id)).length} คัน)`}
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>ได้ใบเสร็จแล้ว (ล่าสุด {completed.length})</h2>
        </div>
        {completed.length === 0 ? (
          <div className="empty-customers">ยังไม่มีรายการที่ได้ใบเสร็จ</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ยื่นเอกสาร</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ทะเบียน</th>
                  <th>วันที่รับใบเสร็จ</th>
                  <th>รูปใบเสร็จ</th>
                  <th>Bill</th>
                  <th>ยอดใบเสร็จ</th>
                </tr>
              </thead>
              <tbody>
                {completed
                  .filter((s) => sheetGroup(s).tab === tab)
                  .map((s) => {
                    const bill = billOf(s);
                    return (
                      <tr key={s.id}>
                        <td>{isoToDisplayDate(s.submitDate.slice(0, 10))}</td>
                        <td>{s.vehicle.customer.name}</td>
                        <td>{s.vehicle.chassis}</td>
                        <td>{s.vehicle.plateCategory && s.vehicle.plateNumber ? `${s.vehicle.plateCategory} ${s.vehicle.plateNumber}` : "—"}</td>
                        <td>{s.receiptReceivedDate ? isoToDisplayDate(s.receiptReceivedDate.slice(0, 10)) : "—"}</td>
                        <td>{(receipts[s.id] ?? []).length ? <ReceiptThumbs receipts={receipts[s.id]} /> : "—"}</td>
                        <td>{bill === null ? "—" : money(bill)}</td>
                        <td>
                          {s.receiptAmount === null ? "—" : money(Number(s.receiptAmount))}
                          {s.receiptAmount !== null && bill !== null && Number(s.receiptAmount) !== bill && (
                            <span className="badge warn" style={{ marginLeft: 6 }}>
                              ไม่ตรง
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
