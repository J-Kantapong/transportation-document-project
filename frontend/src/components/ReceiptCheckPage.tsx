"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type DocumentSubmission, type ReceiptCheckEntry, type ReceiptFieldsFixResult, type ReceiptImage, type ReceiptSummary } from "@/lib/api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { receiptDuplicateText } from "@/lib/receipt-duplicate";
import { useAutoRefresh, usePendingReceipts } from "@/lib/receipt-upload";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { ReceiptEditButton, ReceivedReceiptFixButton, type FieldFlags } from "./ReceiptEditDialog";
import { ReceiptAttachButton, ReceiptBatchPanel, ReceiptThumbs, toReceiptSummary, useCanEditReceipts } from "./ReceiptPhotos";
import { DateInput } from "@/components/DateInput";
import { customerDisplayNames, jobSheetGroup, jobSheetKey } from "@/lib/job-sheet";

// หน้ารับใบเสร็จ (Step 5) - ตรวจทีละ "ใบยื่น" ให้ตรงกับใบส่งงานที่ปริ้นออกไป (ดู SubmittedRecordsView/JobSheetPrintDialog):
// 1 ใบยื่น = วันที่ยื่น + กลุ่ม (รย.1 ธรรมดา/ด่วน, รย.2-3, มอเตอร์ไซค์ ธรรมดา/ด่วน) + เจ้าของงาน, เรียงตามลำดับที่บันทึกยื่น
// พนักงานรถยนต์/มอเตอร์ไซค์แยกแท็บกัน. แนบรูปใบเสร็จให้แต่ละคัน -> ระบบนับ ยื่นไป/ได้ใบเสร็จ/ขาด ให้เห็นทันที
// คันที่ขาด: รู้สาเหตุ = ยื่นไม่สำเร็จ (กลับไป Step 4 - กฎผู้ใช้ 2026-09-20), ยังไม่รู้ = ค้างไว้ (receiptCarriedAt)
// คันที่ค้างยังอยู่ในใบยื่นเดิม และใบนั้นขึ้นว่า "ยังขาด N คัน" (ผู้ใช้ 2026-09-25 - เดิมแยกไปกอง "ค้างจากใบก่อน" ดูยาก)
// ใบที่เปิดอยู่โหลดใหม่ทุก 15 วินาที + ตอนกลับมาที่แท็บ: เห็นรูปที่อีกเครื่องเพิ่งถ่าย/จับคู่ ไม่เผลอบันทึกยื่นไม่สำเร็จ/ค้างไว้ทับ
// (พบ 2026-09-27 - backend ก็ไม่ยอมให้บันทึก FAILED/CARRY ของแถวที่มีรูปแล้ว) ค่าที่พนักงานกรอกค้างไว้ไม่ถูกล้าง

export type ReceiptKind = "car" | "moto";
type Tab = ReceiptKind;
export const RECEIPT_KIND_LABEL: Record<ReceiptKind, string> = { car: "รถยนต์", moto: "มอเตอร์ไซค์" };

// สาเหตุที่ยังไม่ได้ใบเสร็จ (ผู้ใช้กำหนด) - ทุกสาเหตุ = ยื่นไม่สำเร็จ
const MISSING_REASONS = [
  "บัตรประชาชนหมดอายุ",
  "เลขทะเบียนของกรมขนส่งยังไม่ถึง",
  "ใบเสร็จ/ใบกำกับผิด",
  "หนังสือรับรองถิ่นที่อยู่หมดอายุ",
  "อื่นๆ",
] as const;

function sheetGroup(s: DocumentSubmission): { tab: Tab; label: string } {
  const g = jobSheetGroup(s.vehicle.body, s.urgent);
  return { tab: g.kind, label: g.label };
}

// เจ้าของงาน = รหัสลูกค้า ไม่ใช่ชื่อ (ผู้ใช้ 2026-09-27: กุญแจเดียวกับหน้ารับป้าย/รับเล่ม/Delivery/ใบส่งงาน - ชื่อซ้ำกันได้)
const sheetKey = (s: DocumentSubmission) => jobSheetKey(s.submitDate.slice(0, 10), sheetGroup(s).label, s.vehicle.customer.id);

interface Sheet {
  key: string;
  tab: Tab;
  date: string;
  label: string;
  owner: string; // ชื่อที่แสดง (customerDisplayNames - ชื่อซ้ำต่อบริษัท/สาขา)
  rows: DocumentSubmission[]; // ทุกคันในใบ เรียงตามลำดับในใบที่ปริ้น (createdAt)
}

// คันที่ยังไม่ได้ตรวจเลย กับคันที่ตรวจแล้วแต่ยังไม่ได้ใบเสร็จ (ค้าง) - ทั้งคู่ยังรอใบเสร็จ
// ลำดับตาราง "ได้ใบเสร็จแล้ว" เหมือน backend (listByDate): วันที่รับใบเสร็จใหม่สุดก่อน (ไม่มีวันที่ขึ้นก่อน เหมือน Postgres) แล้ว createdAt, id
function compareReceived(a: DocumentSubmission, b: DocumentSubmission): number {
  const ra = a.receiptReceivedDate ?? "~";
  const rb = b.receiptReceivedDate ?? "~";
  if (ra !== rb) return ra < rb ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

const isOpen = (s: DocumentSubmission) => s.status === "PENDING" && !s.receiptCarriedAt;
const isCarried = (s: DocumentSubmission) => s.status === "PENDING" && !!s.receiptCarriedAt;

interface RowInput {
  plateCategory: string;
  plateNumber: string;
  amountText: string;
  receiptNo: string;
  // วันที่ในใบเสร็จ (วว/ดด/ปปปป) - วันที่ทางการ แยกจากวันที่รับใบเสร็จ (ผู้ใช้ 2026-09-25) AI กรอกให้ ว่าง = backend ใช้วันที่ยื่น
  receiptDate: string;
  reason: string; // "" = ยังไม่รู้สาเหตุ (ค้างไว้)
  otherText: string;
  reviewed: boolean; // พนักงานกดยืนยันใน popup แล้วว่าตรงกับรูป -> เลิก highlight ช่องที่ AI ไม่แน่ใจ
}

const money = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
const billOf = (s: DocumentSubmission) => (s.taxAmount === null ? null : Number(s.billFeeTotal) + Number(s.taxAmount));
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
// รูปแบบที่เห็นบนใบเสร็จจริง 69/0035358 - ไม่ล็อก prefix/จำนวนหลัก (ปี พ.ศ. เปลี่ยนทุกปี) แค่เตือน ไม่บล็อก
const RECEIPT_NO_RE = /^\d+\/\d+$/;
const toIso = (display: string) => displayDateToIso(display.replace(/\D/g, ""));

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

// ผลอ่านล่าสุดของรถคันนี้ (รูปที่แนบทีหลังถือเป็นรูปที่ถูกต้องกว่า) - เลือกรูปที่เลขตัวถังตรงก่อน
// มีแต่รูปที่เลขตัวถังไม่ตรง (AI มักอ่านตกไปหลักเดียว) ก็ใช้รูปนั้น - ตอนบันทึกจะให้พนักงานยืนยันอีกที
function latestAi(list: ReceiptSummary[] | undefined): Ai | null {
  const reads = [...(list ?? [])].reverse().flatMap((r) => (r.extraction && "reading" in r.extraction ? [r.extraction as Ai] : []));
  return reads.find((e) => e.match !== "chassis-mismatch") ?? reads[0] ?? null;
}

// รูปที่ให้ผลอ่านของ latestAi - เปลี่ยน = มีผลอ่านใหม่ (รูปใหม่ / AI เพิ่งอ่านเสร็จ) ต้องเติมค่าตามผลอ่านให้แถวนั้นอีกรอบ
function latestAiId(list: ReceiptSummary[] | undefined): string | null {
  const reads = [...(list ?? [])].reverse().filter((r) => r.extraction && "reading" in r.extraction);
  return (reads.find((r) => r.extraction?.match !== "chassis-mismatch") ?? reads[0])?.id ?? null;
}

const isReading = (list: ReceiptSummary[] | undefined) => (list ?? []).some((r) => r.readPending);

// รูปที่แนบกับรถคันนี้แต่เลขตัวถังในใบเสร็จเป็นของคันอื่น - ต้องลบก่อนบันทึก
function wrongCarReceipts(list: ReceiptSummary[] | undefined): Ai[] {
  return (list ?? []).flatMap((r) => (r.extraction && "reading" in r.extraction && r.extraction.match === "chassis-mismatch" ? [r.extraction as Ai] : []));
}

// รูปของรถคันนี้ที่ AI อ่านแล้วอาจซ้ำกับใบเสร็จที่มีอยู่ (เตือนอย่างเดียว)
function duplicateOf(list: ReceiptSummary[] | undefined) {
  return (list ?? []).map((r) => r.extraction?.duplicate).find(Boolean) ?? null;
}

// รูปที่ใช้เปิดใน popup: รูปที่ AI อ่าน (ตัวเดียวกับ latestAi) ไม่มีก็ใช้รูปล่าสุด
function latestAiImageId(list: ReceiptSummary[] | undefined): string | null {
  const all = list ?? [];
  const read = [...all].reverse().find((r) => r.extraction && "reading" in r.extraction && r.extraction.match !== "chassis-mismatch");
  return read?.id ?? all[all.length - 1]?.id ?? null;
}

function latestAiError(list: ReceiptSummary[] | undefined): string | null {
  const last = list?.[list.length - 1]?.extraction;
  return last && "error" in last ? last.error : null;
}

const NO_FLAGS: FieldFlags = { plate: null, total: null, chassis: null, receiptNo: null, date: null };

// ช่องที่ต้องให้คนเช็ก (ค่า = เหตุผลที่แสดงใน popup): AI อ่านไม่ออก, AI บอกเองว่าไม่มั่นใจ หรือการตรวจอัตโนมัติไม่ผ่าน
// พนักงานกดยืนยันใน popup แล้ว (reviewed) = เลิก highlight ของแถวนั้น
function needsCheck(s: DocumentSubmission, ai: Ai | null, reviewed = false): FieldFlags {
  if (!ai || reviewed) return NO_FLAGS;
  const submitDate = s.submitDate.slice(0, 10);
  const r = ai.reading;
  const u = r.uncertainFields;
  const reason = (unreadable: boolean, uncertain: boolean, checkFailed: string | null) =>
    unreadable ? "AI อ่านไม่ออก - กรอกตามรูป" : uncertain ? "AI ไม่แน่ใจ - เทียบกับรูป" : checkFailed;
  return {
    plate: reason(!r.plateCategory || !r.plateNumber, u.includes("plate"), ai.checks.plateValid ? null : "รูปแบบทะเบียนไม่ถูกต้อง"),
    total: reason(
      r.total === null,
      u.includes("total") || u.includes("items"),
      ai.checks.itemsSumMatchesTotal ? null : "รายการในใบเสร็จรวมกันไม่เท่ายอดรวม",
    ),
    chassis: reason(
      !r.chassis,
      u.includes("chassis"),
      ai.match === "chassis-near"
        ? `เลขตัวถังในใบเสร็จ (${r.chassis}) ต่างจากรถคันนี้เล็กน้อย - เทียบกับรูปว่าเป็นคันเดียวกัน`
        : ai.match === "chassis-mismatch"
          ? `เลขตัวถังในใบเสร็จ (${r.chassis}) ไม่ตรงกับรถคันนี้ - เทียบกับรูปว่าเป็นคันเดียวกัน`
          : ai.checks.chassisValid
          ? null
          : "เลขตัวถังไม่ผ่านการตรวจ check digit",
    ),
    receiptNo: reason(!r.receiptNo, u.includes("receiptNo"), ai.checks.receiptNoValid ? null : "รูปแบบไม่ใช่ ตัวเลข/ตัวเลข"),
    // กรมขนส่งออกใบเสร็จวันที่ยื่น (59/59 ใบ 2026-09-25) - ไม่ตรงวันที่ยื่นน่าจะ AI อ่านผิด
    date: reason(
      !r.date,
      u.includes("date"),
      r.date && r.date !== submitDate ? `ไม่ตรงกับวันที่ยื่น (${isoToDisplayDate(submitDate)}) - เทียบกับรูป` : null,
    ),
  };
}

const CHECK_STYLE = { border: "2px solid #e0a31a", background: "#fff8e6" };

// เทียบรายการบนใบเสร็จกับ Bill ที่ระบบคำนวณ: แยกภาษีกับค่าธรรมเนียม + บอกสาเหตุที่น่าจะเป็น (แบบ ข - แก้ข้อมูลรถ)
function aiFindingLines(s: DocumentSubmission, ai: Ai | null, amountText: string, wrong: Ai[], reviewed = false): string[] {
  const lines: string[] = wrong.map(
    (w) => `เลขตัวถังในใบเสร็จ (${w.reading.chassis}) ไม่ตรงกับรถคันนี้ (${s.vehicle.chassis}) - เทียบกับรูป AI อาจอ่านผิด ถ้าแนบผิดคันให้ลบรูป`,
  );
  if (!ai) return lines;
  // ทะเบียนที่กรอกไว้ตอนยื่น (Step 4) ไม่ตรงกับใบเสร็จ = พนักงานกรอกผิดตอนยื่น - บันทึกจะใช้ตามใบเสร็จ
  const r = ai.reading;
  const v = s.vehicle;
  if (v.plateCategory && v.plateNumber && r.plateCategory && r.plateNumber && (v.plateCategory !== r.plateCategory || v.plateNumber !== r.plateNumber)) {
    lines.push(`ทะเบียนตอนยื่น ${v.plateCategory} ${v.plateNumber} ไม่ตรงกับใบเสร็จ ${r.plateCategory} ${r.plateNumber} - บันทึกแล้วจะใช้ตามใบเสร็จ`);
  }
  const check = needsCheck(s, ai, reviewed);
  const toCheck = [
    check.plate && "ทะเบียน",
    check.receiptNo && "เลขที่ใบเสร็จ",
    check.date && "วันที่ในใบเสร็จ",
    check.total && "ยอดเงิน",
    check.chassis && "เลขตัวถัง",
  ].filter(Boolean);
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

function AiFindings({ s, ai, amountText, wrong, reviewed }: { s: DocumentSubmission; ai: Ai | null; amountText: string; wrong: Ai[]; reviewed: boolean }) {
  const lines = aiFindingLines(s, ai, amountText, wrong, reviewed);
  if (lines.length === 0) return <span className="badge done">{reviewed ? "ตรวจกับรูปแล้ว" : "AI ตรวจแล้ว ตรงทุกอย่าง"}</span>;
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

// ใบเสร็จคือข้อเท็จจริง: มีผลอ่านแล้วใช้ทะเบียน/เลขที่/ยอดตามใบเสร็จ (ช่องที่อ่านไม่ออกคงค่าเดิมไว้)
function withAi(input: RowInput, ai: Ai | null): RowInput {
  if (!ai) return input;
  const r = ai.reading;
  return {
    ...input,
    reviewed: false, // ผลอ่านใหม่ = ต้องเช็กใหม่
    plateCategory: r.plateCategory ?? input.plateCategory,
    plateNumber: r.plateNumber ?? input.plateNumber,
    amountText: r.total !== null ? String(r.total) : input.amountText,
    receiptNo: r.receiptNo ?? input.receiptNo,
    receiptDate: r.date ? isoToDisplayDate(r.date) : input.receiptDate,
  };
}

// ค่าเริ่มต้นของแถวที่รอใบเสร็จ: ทะเบียนที่กรอกตอนยื่น, วันที่ในใบเสร็จ = วันที่ยื่น แล้วเติมตามผลอ่าน AI (ถ้ามี)
const initialInput = (s: DocumentSubmission): RowInput =>
  withAi(
    {
      plateCategory: s.vehicle.plateCategory ?? "",
      plateNumber: s.vehicle.plateNumber ?? "",
      amountText: "",
      receiptNo: "",
      receiptDate: isoToDisplayDate(s.submitDate.slice(0, 10)),
      reason: "",
      otherText: "",
      reviewed: false,
    },
    latestAi(s.receipts),
  );

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

// รถยนต์กับมอเตอร์ไซค์แยกหน้ากัน (ผู้ใช้ 2026-09-25): /receive-receipt เป็นหน้าเลือกประเภท แล้วเข้า /car หรือ /moto
export function ReceiptCheckPage({ kind }: { kind: ReceiptKind }) {
  const tab = kind;
  // ACCOUNTANT / คนที่แก้ประเภทรถนี้ไม่ได้ = ดูอย่างเดียว ซ่อนปุ่มบันทึก/แนบ/ลบ (พบ 2026-09-27: เดิมกดได้แล้วขึ้น 403)
  const canEditState = useCanEditReceipts(kind);
  const canEdit = canEditState === true;
  const [sheetRows, setSheetRows] = useState<DocumentSubmission[]>([]); // ทุกคันของวันที่ที่มีใบยื่นค้างตรวจ
  const [completed, setCompleted] = useState<DocumentSubmission[]>([]);
  const [completedHasMore, setCompletedHasMore] = useState(false);
  const [completedQuery, setCompletedQuery] = useState("");
  const [completedLoading, setCompletedLoading] = useState(false);
  const [completedError, setCompletedError] = useState("");
  const completedRequest = useRef(0); // คำค้นเปลี่ยนเร็ว - ใช้ผลของคำขอล่าสุดเท่านั้น
  // แถวที่ยังแสดงอยู่ แต่แก้วันที่รับแล้วไปอยู่หลังช่วงที่โหลดไว้บน server - ไม่นับใน offset ของ "โหลดเพิ่ม" (ดู applyReceiptFix)
  const completedOutside = useRef(new Set<string>());
  const [receipts, setReceipts] = useState<Record<string, ReceiptSummary[]>>({});
  const receiptsRef = useRef(receipts);
  useEffect(() => {
    receiptsRef.current = receipts;
  });
  const [inputs, setInputs] = useState<Record<string, RowInput>>({});
  const [openKey, setOpenKey] = useState<string | null>(null);
  const focusApplied = useRef(false);
  // เพิ่มทุกครั้งที่โหลดทั้งหน้า/บันทึก - ผลโหลดเบื้องหลังที่เริ่มก่อนหน้านั้นถือว่าเก่า ทิ้งไป ไม่ทับข้อมูลหลังบันทึก
  const generation = useRef(0);
  // เพิ่มทุกครั้งที่แนบ/ลบ/จับคู่รูปในหน้านี้ - ผลโหลดเบื้องหลังที่เริ่มก่อนหน้านั้นยังเป็นรายการรูปก่อนเปลี่ยน ทิ้งไป
  // (แยกจาก generation ที่จะทิ้งการโหลดทั้งหน้าที่กำลังทำอยู่ด้วย) (พบ 2026-09-27: รูปที่เพิ่งแนบหายไปจนรอบโหลดถัดไป
  // แนบซ้ำแล้วได้ "อัพโหลดไปแล้ว" หรือรูปที่เพิ่งลบกลับมา)
  const localChange = useRef(0);
  // วันที่รับใบเสร็จ: เหมือนหน้ารับป้าย/รับเล่ม - เติมอัตโนมัติเป็นวันที่บันทึก (วันนี้) null = ยังไม่แก้เอง พนักงานแก้เป็นวันอื่นได้
  const [editedDate, setEditedDate] = useState<string | null>(null);
  const dateText = editedDate ?? isoToDisplayDate(todayIso());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // รูปของแถวเปลี่ยน (โหลดใหม่ / AI อ่านเสร็จ): แทนรายการรูป แถวใหม่ได้ค่าเริ่มต้น และแถวที่มีผลอ่านใหม่เติมค่าตามผลอ่าน
  // แถวที่ผลอ่านเหมือนเดิมไม่แตะ - ค่าที่พนักงานกรอก/แก้ค้างไว้ยังอยู่
  function applyReceiptLists(lists: Record<string, ReceiptSummary[]>, rows: DocumentSubmission[] = []) {
    const before = receiptsRef.current;
    const freshAi = Object.keys(lists).filter((id) => {
      const now = latestAiId(lists[id]);
      return now !== null && now !== latestAiId(before[id]);
    });
    setReceipts((prev) => ({ ...prev, ...lists }));
    setInputs((prev) => {
      const next = { ...prev };
      for (const s of rows) if (s.status === "PENDING" && !next[s.id]) next[s.id] = initialInput(s);
      for (const id of freshAi) if (next[id]) next[id] = withAi(next[id], latestAi(lists[id]));
      return next;
    });
  }

  // quiet = โหลดใหม่เบื้องหลัง (กลับมาที่แท็บ) ไม่ล้างค่าที่กรอกค้างไว้และไม่ขึ้น "กำลังโหลด"
  async function loadPending(quiet = false) {
    const gen = quiet ? generation.current : ++generation.current;
    const local = localChange.current;
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    try {
      const p = await api.listDocumentSubmissions(undefined, "PENDING", { kind });
      // ใบยื่นต้องแสดงครบทุกคันตามกระดาษ (รวมคันที่ได้ใบเสร็จ/ยื่นไม่สำเร็จไปแล้ว) - โหลดทุกสถานะของวันที่ที่ยังมีคันรอใบเสร็จ (รวมคันค้าง)
      const dates = [...new Set(p.submissions.map((s) => s.submitDate.slice(0, 10)))];
      const byDate = await Promise.all(dates.map((d) => api.listDocumentSubmissions(d, undefined, { kind })));
      if (gen !== generation.current || (quiet && local !== localChange.current)) return;
      // โหลดเบื้องหลังสำเร็จหลังจากครั้งก่อนพลาด: ล้าง error ไม่งั้นรายการที่โหลดได้ถูกบังด้วย error เก่า (พบ 2026-09-27)
      setError("");
      const rows = byDate.flatMap((r) => r.submissions);
      setSheetRows(rows);
      const lists = Object.fromEntries(rows.map((s) => [s.id, s.receipts ?? []]));
      if (quiet) return applyReceiptLists(lists, rows);
      setReceipts((prev) => ({ ...prev, ...lists }));
      setInputs(Object.fromEntries(p.submissions.map((s) => [s.id, initialInput(s)])));
      setRowErrors({});
      // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): เปิดใบยื่นที่มีรถคันนั้นให้ - ครั้งแรกที่โหลดเท่านั้น
      // (loadAll ถูกเรียกซ้ำหลังบันทึก ห้ามดึงพนักงานกลับไปใบเดิม) FocusVehicleRow เลื่อนไปที่แถวต่อเอง
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const target = chassis ? p.submissions.find((s) => sheetGroup(s).tab === tab && sameChassis(s.vehicle.chassis, chassis)) : undefined;
        if (target) setOpenKey(sheetKey(target));
      }
    } catch (err) {
      if (!quiet) setError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  // ตาราง "ได้ใบเสร็จแล้ว": server กรองประเภทรถ + ค้นหา แล้วโหลดทีละ 100 (พบ 2026-09-27: เดิมได้แค่ 100 ใบล่าสุด
  // รวมรถยนต์กับมอเตอร์ไซค์ ใบที่เก่ากว่านั้นแก้ข้อมูลไม่ได้)
  async function loadCompleted(query: string, offset = 0) {
    const request = ++completedRequest.current;
    setCompletedLoading(true);
    setCompletedError("");
    try {
      const res = await api.listDocumentSubmissions(undefined, "RECEIPT_RECEIVED", { kind, q: query, offset });
      if (request !== completedRequest.current) return;
      // หน้าถัดไปมีแถวที่ย้ายออกไปแล้วกลับมา = อยู่ในช่วงที่โหลดแล้ว · โหลดครบหรือโหลดใหม่ = ไม่มีแถวไหนอยู่นอกช่วง
      const outside = completedOutside.current;
      if (offset === 0 || !res.hasMore) outside.clear();
      else for (const s of res.submissions) outside.delete(s.id);
      setCompleted((prev) =>
        offset === 0 ? res.submissions : [...prev, ...res.submissions.filter((s) => !prev.some((c) => c.id === s.id))].sort(compareReceived),
      );
      setCompletedHasMore(Boolean(res.hasMore));
      setReceipts((prev) => ({ ...prev, ...Object.fromEntries(res.submissions.map((s) => [s.id, s.receipts ?? []])) }));
    } catch (err) {
      if (request === completedRequest.current) setCompletedError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      if (request === completedRequest.current) setCompletedLoading(false);
    }
  }

  async function loadAll() {
    await Promise.all([loadPending(), loadCompleted(completedQuery)]);
  }

  useEffect(() => {
    loadPending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // พิมพ์ค้นหาแล้วรอ 300 ms ค่อยโหลด (ครั้งแรก = คำค้นว่าง)
  useEffect(() => {
    const timer = window.setTimeout(() => loadCompleted(completedQuery), completedQuery ? 300 : 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedQuery]);

  const allSheets = useMemo(() => {
    const map = new Map<string, Sheet>();
    const ownerNames = customerDisplayNames(sheetRows.map((s) => s.vehicle.customer));
    for (const s of [...sheetRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const key = sheetKey(s);
      if (!map.has(key)) {
        const g = sheetGroup(s);
        const owner = ownerNames.get(s.vehicle.customer.id) ?? s.vehicle.customer.name;
        map.set(key, { key, tab: g.tab, date: s.submitDate.slice(0, 10), label: g.label, owner, rows: [] });
      }
      map.get(key)!.rows.push(s);
    }
    return [...map.values()]
      .filter((sh) => sh.tab === tab && sh.rows.some((s) => s.status === "PENDING"))
      .sort((a, b) => a.date.localeCompare(b.date) || a.label.localeCompare(b.label, "th") || a.owner.localeCompare(b.owner, "th"));
  }, [sheetRows, tab]);
  // ใบยื่นที่คีย์ล่วงหน้า (วันที่ยื่นยังไม่ถึง) ยังไม่มีใบเสร็จแน่นอน - ไม่ให้ปนในรายการรอตรวจ บอกไว้เป็นบรรทัดสรุปแทน
  const today = todayIso();
  const sheets = allSheets.filter((sh) => sh.date <= today);
  const futureSheets = allSheets.filter((sh) => sh.date > today);

  const openSheet: Sheet | null = allSheets.find((sh) => sh.key === openKey) ?? null;

  // คันที่พนักงานต้องตัดสินในใบที่เปิดอยู่ (รวมคันที่ค้างจากรอบก่อน)
  const activeRows = openSheet ? openSheet.rows.filter((s) => s.status === "PENDING") : [];
  const hasPhoto = (id: string) => (receipts[id] ?? []).length > 0;
  const gotCount = openSheet ? openSheet.rows.filter((s) => s.status === "RECEIPT_RECEIVED" || (activeRows.includes(s) && hasPhoto(s.id))).length : 0;
  const missingRows = activeRows.filter((s) => !hasPhoto(s.id));
  // คันที่ AI อ่านใบเสร็จแล้ว - ตรงทุกอย่าง = พนักงานแค่เหลือบดู, ที่เหลือต้องเช็กตามที่ขึ้นเตือน
  const aiChecked = activeRows.filter((s) => latestAi(receipts[s.id]) || wrongCarReceipts(receipts[s.id]).length > 0);
  const aiAllGood = aiChecked.filter(
    (s) => aiFindingLines(s, latestAi(receipts[s.id]), inputs[s.id]?.amountText ?? "", wrongCarReceipts(receipts[s.id]), inputs[s.id]?.reviewed).length === 0,
  ).length;

  // ใบที่เปิดอยู่: โหลดวันที่ของใบนั้นใหม่ทุก 15 วินาที + ตอนกลับมาที่แท็บ (รูปที่อีกเครื่องถ่าย/จับคู่ สถานะที่อีกคนบันทึก)
  // ไม่ได้เปิดใบไหน: โหลดรายการใบยื่นใหม่เฉพาะตอนกลับมาที่แท็บ
  async function refreshOpenSheet() {
    if (!openSheet) return;
    const gen = generation.current;
    const local = localChange.current;
    const date = openSheet.date;
    const { submissions } = await api.listDocumentSubmissions(date, undefined, { kind });
    if (gen !== generation.current || local !== localChange.current) return; // ระหว่างนั้นแนบ/ลบรูปในหน้านี้ = ผลนี้เก่าแล้ว
    setError("");
    setSheetRows((prev) => [...prev.filter((s) => s.submitDate.slice(0, 10) !== date), ...submissions]);
    applyReceiptLists(Object.fromEntries(submissions.map((s) => [s.id, s.receipts ?? []])), submissions);
  }
  useAutoRefresh(!!openSheet && !saving, refreshOpenSheet);
  useAutoRefresh(!openSheet && !saving && !loading, () => loadPending(true), 0);

  // รูปที่จับคู่ระหว่าง AI ยังอ่านอยู่: ถามผลจนอ่านเสร็จแล้วเติมค่าให้แถว (เดิมแถวค้าง "กรอกเอง" ไม่ได้ค่าจาก AI)
  const readingIds = activeRows.flatMap((s) => (receipts[s.id] ?? []).filter((r) => r.readPending).map((r) => r.id));
  usePendingReceipts(readingIds, (read, gone) => {
    const byId = new Map(read.map((r) => [r.id, r]));
    const lists: Record<string, ReceiptSummary[]> = {};
    for (const [submissionId, list] of Object.entries(receiptsRef.current)) {
      if (!list.some((r) => byId.has(r.id) || gone.includes(r.id))) continue;
      lists[submissionId] = list.flatMap((r) => {
        if (gone.includes(r.id)) return [];
        const fresh = byId.get(r.id);
        if (!fresh) return [r];
        return fresh.submissionId === submissionId ? [toReceiptSummary(fresh)] : [];
      });
    }
    applyReceiptLists(lists);
  });

  function patchInput(id: string, patch: Partial<RowInput>) {
    setInputs((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    setRowErrors((prev) => ({ ...prev, [id]: "" }));
  }

  function addReceipt(receipt: ReceiptImage) {
    const id = receipt.submissionId;
    if (!id) return;
    localChange.current++;
    setReceipts((prev) => ({ ...prev, [id]: [...(prev[id] ?? []).filter((r) => r.id !== receipt.id), toReceiptSummary(receipt)] }));
    // รูปใหม่ที่ AI อ่านได้ -> กรอกทะเบียน/ยอดให้ตามใบเสร็จ (พนักงานแค่ตรวจ)
    const extraction = receipt.extraction;
    if (extraction && "reading" in extraction) setInputs((prev) => (prev[id] ? { ...prev, [id]: withAi(prev[id], extraction as Ai) } : prev));
  }

  async function removeReceipt(submissionId: string, receiptId: string) {
    if (!window.confirm("ลบรูปใบเสร็จนี้?")) return;
    try {
      await api.deleteReceipt(receiptId);
      localChange.current++;
      setReceipts((prev) => ({ ...prev, [submissionId]: (prev[submissionId] ?? []).filter((r) => r.id !== receiptId) }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [submissionId]: err instanceof ApiError ? err.message : "ลบรูปไม่สำเร็จ" }));
    }
  }

  // แก้ข้อมูลใบเสร็จที่บันทึกแล้ว (✎ แก้ ในตาราง "ได้ใบเสร็จแล้ว") - อัปเดตแถวในตารางตามที่ backend ตอบ
  // แก้วันที่รับ = แถวย้ายที่บน server (เรียงด้วยวันที่รับ): จัดลำดับใหม่ และถ้ายังมีหน้าถัดไปแล้วแถวย้ายไปอยู่หลังแถวสุดท้าย
  // ของช่วงที่โหลดไว้ ไม่นับแถวนั้นใน offset ของ "โหลดเพิ่ม" (พบ 2026-09-27: offset = จำนวนแถวที่แสดง โหลดเพิ่มแล้วข้ามไป 1 แถว)
  function applyReceiptFix({ submission }: ReceiptFieldsFixResult) {
    setCompleted((prev) => {
      const before = prev.find((c) => c.id === submission.id);
      const next = prev.map((c) =>
        c.id === submission.id
          ? {
              ...c,
              receiptNo: submission.receiptNo,
              receiptAmount: submission.receiptAmount,
              receiptDate: submission.receiptDate,
              receiptReceivedDate: submission.receiptReceivedDate,
              vehicle: { ...c.vehicle, ...submission.vehicle },
            }
          : c,
      );
      if (!before || before.receiptReceivedDate === submission.receiptReceivedDate) return next;
      const sorted = [...next].sort(compareReceived);
      const outside = completedOutside.current;
      const loaded = sorted.filter((c) => c.id !== submission.id && !outside.has(c.id));
      const last = loaded[loaded.length - 1];
      const edited = sorted.find((c) => c.id === submission.id)!;
      if (completedHasMore && last && compareReceived(edited, last) > 0) outside.add(submission.id);
      else outside.delete(submission.id);
      return sorted;
    });
  }

  async function handleSave() {
    if (!openSheet) return;
    const receivedDate = toIso(dateText);
    if (!receivedDate) return setMessage({ text: "วันที่รับใบเสร็จไม่ถูกต้อง - ใส่เป็น DD/MM/YYYY เช่น 27/09/2026", error: true });
    // วันที่ยื่น <= วันที่ในใบเสร็จ <= วันที่รับใบเสร็จ <= วันนี้ - backend ตรวจซ้ำ (พบ 2026-09-27: เดิมตรวจแค่ตอนแก้ย้อนหลัง)
    if (activeRows.some((s) => hasPhoto(s.id))) {
      if (receivedDate < openSheet.date) {
        return setMessage({ text: `วันที่รับใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (${isoToDisplayDate(openSheet.date)})`, error: true });
      }
      if (receivedDate > todayIso()) return setMessage({ text: "วันที่รับใบเสร็จต้องไม่เกินวันนี้", error: true });
    }

    const entries: ReceiptCheckEntry[] = [];
    const errors: Record<string, string> = {};
    const mismatched: string[] = [];
    const stillReading: string[] = [];
    for (const s of activeRows) {
      const input = inputs[s.id];
      if (hasPhoto(s.id)) {
        // AI อ่านเลขตัวถังตกหล่น/เพี้ยนได้ - เตือนแล้วให้พนักงานยืนยัน ไม่บล็อก (เดิมบล็อกจนบันทึกไม่ได้เลย)
        const wrong = wrongCarReceipts(receipts[s.id]);
        if (wrong.length > 0) mismatched.push(`${s.vehicle.chassis} ← ใบเสร็จอ่านได้ ${wrong.map((w) => w.reading.chassis).join(", ")}`);
        const submitted = s.submitDate.slice(0, 10);
        const receiptIso = input.receiptDate.trim() ? toIso(input.receiptDate) : submitted;
        if (!input.plateCategory.trim() || !input.plateNumber.trim()) errors[s.id] = "กรอกหมวดและเลขทะเบียนตามใบเสร็จ";
        else if (input.amountText.trim() && !AMOUNT_RE.test(input.amountText.trim())) errors[s.id] = "ยอดใบเสร็จต้องเป็นตัวเลข";
        else if (!receiptIso) errors[s.id] = "วันที่ในใบเสร็จไม่ถูกต้อง - ใส่เป็น DD/MM/YYYY เช่น 23/09/2026";
        else if (receiptIso < submitted) errors[s.id] = `วันที่ในใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (${isoToDisplayDate(submitted)})`;
        else if (receiptIso > receivedDate) errors[s.id] = `วันที่ในใบเสร็จต้องไม่หลังวันที่รับใบเสร็จ (${isoToDisplayDate(receivedDate)})`;
        else {
          if (isReading(receipts[s.id])) stillReading.push(s.vehicle.chassis);
          entries.push({
            submissionId: s.id,
            action: "RECEIVED",
            plateCategory: input.plateCategory.trim(),
            plateNumber: input.plateNumber.trim(),
            receiptAmount: input.amountText.trim() || undefined,
            receiptNo: input.receiptNo.trim() || undefined,
            receiptDate: receiptIso,
          });
        }
      } else if (input.reason) {
        const remark = input.reason === "อื่นๆ" ? input.otherText.trim() : input.reason;
        if (!remark) errors[s.id] = "ระบุสาเหตุ";
        else entries.push({ submissionId: s.id, action: "FAILED", failRemark: input.reason === "อื่นๆ" ? `อื่นๆ: ${remark}` : remark });
      } else if (!s.receiptCarriedAt) {
        entries.push({ submissionId: s.id, action: "CARRY" });
      }
    }
    if (Object.keys(errors).length > 0) {
      setRowErrors(errors);
      return setMessage({ text: `แก้ไข ${Object.keys(errors).length} คันที่ขึ้นสีแดงก่อนบันทึก`, error: true });
    }
    if (entries.length === 0) return setMessage({ text: "ยังไม่มีอะไรให้บันทึก - แนบรูปใบเสร็จหรือเลือกสาเหตุก่อน", error: true });
    if (
      mismatched.length > 0 &&
      !window.confirm(
        `เลขตัวถังในใบเสร็จไม่ตรงกับรถ ${mismatched.length} คัน:\n\n${mismatched.join("\n")}\n\nเทียบกับรูปแล้วเป็นใบเสร็จของคันนั้นจริง (AI อ่านผิด) ใช่ไหม?`,
      )
    )
      return;

    const got = entries.filter((e) => e.action === "RECEIVED").length;
    const failed = entries.filter((e) => e.action === "FAILED").length;
    const carry = entries.filter((e) => e.action === "CARRY").length;
    const summary = [`ได้ใบเสร็จ ${got} คัน`, failed ? `ยื่นไม่สำเร็จ ${failed} คัน (กลับไป Step 4)` : "", carry ? `ยังขาด (ค้างไว้ในใบนี้) ${carry} คัน` : ""].filter(Boolean).join("\n");
    // AI ยังอ่านไม่เสร็จ = ค่าในแถวยังไม่ได้มาจากใบเสร็จ - บอกก่อนบันทึก ให้รอได้
    const readingNote = stillReading.length
      ? `\n\n⏳ AI ยังอ่านใบเสร็จไม่เสร็จ ${stillReading.length} คัน - ถ้าบันทึกตอนนี้จะใช้ค่าที่กรอกไว้ (รอสักครู่ระบบจะเติมให้)`
      : "";
    if (!window.confirm(`บันทึกใบยื่นนี้?\n\n${summary}${readingNote}`)) return;

    generation.current++; // ผลโหลดเบื้องหลังที่ค้างอยู่ใช้ไม่ได้แล้ว
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
        setEditedDate(null); // รอบถัดไปกลับไปใช้วันที่บันทึกอัตโนมัติ
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
    <section className="content content-wide">
      <Link href="/registration/new-vehicle/receive-receipt" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← เลือกประเภทรถ
      </Link>
      <h1 tabIndex={-1}>รับใบเสร็จ · {RECEIPT_KIND_LABEL[tab]}</h1>

      {canEditState === false && (
        <div className="customer-message" role="status" style={{ marginTop: 12 }}>
          ดูได้อย่างเดียว - บัญชีนี้บันทึกรับใบเสร็จ{RECEIPT_KIND_LABEL[tab]}ไม่ได้
        </div>
      )}

      {/* อยู่บนสุดให้เห็นเสมอ - คนถ่ายใบเสร็จไม่ต้องเปิดใบยื่นก่อน รูปที่ถ่ายจะจับคู่กับรถเอง หรือไปรอในถาดของใบยื่น */}
      {canEdit && (
        <Link
          href="/registration/new-vehicle/receive-receipt/capture"
          className="primary"
          style={{ display: "inline-flex", marginTop: 14, textDecoration: "none" }}
        >
          📷 ถ่ายใบเสร็จจากมือถือ
        </Link>
      )}

      {canEdit && (
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <span>วันที่รับใบเสร็จ</span>
            {/* พิมพ์ปี พ.ศ. ได้ แปลงเป็น ค.ศ. ให้ เหมือนช่องวันที่ในใบเสร็จ (พบ 2026-09-27) */}
            <DateInput
              value={dateText}
              onChange={(value) => setEditedDate(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
              style={{ width: 120 }}
            />
          </label>
          {editedDate === null ? (
            <span className="customer-message">อัตโนมัติ = วันที่บันทึก (วันนี้)</span>
          ) : (
            <button type="button" className="text-button" onClick={() => setEditedDate(null)}>
              กลับไปใช้วันนี้
            </button>
          )}
        </div>
      )}

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
        ) : sheets.length === 0 && futureSheets.length === 0 ? (
          <div className="empty-customers">ไม่มีใบยื่นที่รอใบเสร็จ</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "0 23px 20px" }}>
            {sheets.map((sh) => {
              const open = sh.rows.filter(isOpen).length;
              // ตรวจไปแล้วแต่ยังไม่ได้ใบเสร็จ - แนบรูปแล้ว (รอบันทึก) ไม่นับว่าขาด (พบ 2026-09-27)
              const short = sh.rows.filter((s) => isCarried(s) && !hasPhoto(s.id)).length;
              const got = sh.rows.filter((s) => s.status === "RECEIPT_RECEIVED").length;
              const withPhoto = sh.rows.filter((s) => s.status === "PENDING" && hasPhoto(s.id)).length;
              const selected = openKey === sh.key;
              return (
                <button
                  key={sh.key}
                  type="button"
                  onClick={() => setOpenKey(selected ? null : sh.key)}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 12,
                    textAlign: "left",
                    padding: "12px 14px",
                    borderRadius: 8,
                    border: selected ? `2px solid ${short ? "#bb8527" : "#2854d9"}` : `1px solid ${short ? "#f0d9ae" : "#dfe5f0"}`,
                    background: short ? "#fffaf0" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{sheetTitle(sh)}</span>
                  <span style={{ display: "inline-flex", gap: 10, alignItems: "center", color: "#576781", whiteSpace: "nowrap" }}>
                    {sh.rows.length} คัน{got > 0 && ` · ได้ใบเสร็จ ${got}`}
                    {open > 0 && ` · รอตรวจ ${open}`}
                    {withPhoto > 0 && ` · แนบรูปแล้ว ${withPhoto}`}
                    {short > 0 && (
                      <span className="badge warn" style={{ fontWeight: 600 }}>
                        ยังขาด {short} คัน
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            {futureSheets.length > 0 && (
              <div className="customer-message" style={{ fontSize: 13 }}>
                ยังไม่ถึงวันยื่น {futureSheets.length} ใบ (
                {futureSheets.map((sh) => `${isoToDisplayDate(sh.date)} ${sh.label} · ${sh.owner} ${sh.rows.length} คัน`).join(", ")}) - จะขึ้นให้ตรวจเมื่อถึงวันยื่น
              </div>
            )}
          </div>
        )}
      </section>

      {openSheet && (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="panel-head">
            <h2>{sheetTitle(openSheet)}</h2>
          </div>
          <div style={{ padding: "0 23px 20px" }}>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
              <Metric label="ยื่นไป" value={`${openSheet.rows.length} คัน`} />
              <Metric label="ได้ใบเสร็จ" value={`${gotCount} ใบ`} tone="ok" />
              <Metric label="ขาด" value={`${missingRows.length} คัน`} tone={missingRows.length > 0 ? "warn" : undefined} />
              {aiChecked.length > 0 && <Metric label="AI ตรวจแล้ว ตรงทุกอย่าง" value={`${aiAllGood} คัน`} tone="ok" />}
              {aiChecked.length - aiAllGood > 0 && <Metric label="ต้องให้คนเช็ก" value={`${aiChecked.length - aiAllGood} คัน`} tone="warn" />}
            </div>

            {canEdit && (
              <ReceiptBatchPanel
                targets={activeRows.map((s) => ({
                  id: s.id,
                  label: `ลำดับ ${openSheet.rows.indexOf(s) + 1} · ${s.vehicle.chassis}`,
                }))}
                onAssigned={addReceipt}
              />
            )}

            {/* ตารางแบบกระชับ (ผู้ใช้ 2026-09-25: ไม่ต้องเลื่อนขวา) - ข้อมูลเท่าเดิม แต่ซ้อนเป็นบรรทัดในช่องเดียวกัน */}
            <div className="table-wrap receipt-sheet-wrap" style={{ marginTop: 16 }}>
              <table className="receipt-check-table receipt-sheet-table">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>ลำดับ</th>
                    <th>รถ / รูปใบเสร็จ</th>
                    <th>ข้อมูลตามใบเสร็จ</th>
                    <th>ยอดเงิน</th>
                    <th>ตรวจ / แก้ไข</th>
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
                    const check = needsCheck(s, ai, input?.reviewed);
                    const aiError = photo && !ai ? latestAiError(receipts[s.id]) : null;
                    const bill = billOf(s);
                    const reading = photo && isReading(receipts[s.id]);
                    const editable = canEdit && active && input;
                    return (
                      <tr key={s.id} style={active && !photo ? { background: "#fffaf0" } : !active ? { opacity: 0.6 } : undefined}>
                        <td>{i + 1}</td>
                        <td>
                          <div style={{ fontFamily: "monospace" }}>{s.vehicle.chassis}</div>
                          <div style={{ fontSize: 11, color: "#8a94a6", marginBottom: 6 }}>
                            {s.vehicle.brand.name}
                          </div>
                          {isCarried(s) && (
                            <div style={{ marginBottom: 6 }}>
                              {photo ? (
                                <span className="badge">ค้างจากรอบก่อน - แนบรูปแล้ว รอบันทึก</span>
                              ) : (
                                <span className="badge warn">ยังขาด - ค้างจากรอบก่อน</span>
                              )}
                            </div>
                          )}
                          <ReceiptThumbs receipts={receipts[s.id] ?? []} onDelete={canEdit && active ? (rid) => removeReceipt(s.id, rid) : undefined} />
                          {active && (() => {
                            const dup = duplicateOf(receipts[s.id]);
                            return dup && <div style={{ fontSize: 11, color: "#b45309", fontWeight: 600, marginTop: 4 }}>⚠️ {receiptDuplicateText(dup)}</div>;
                          })()}
                          {active && ai && (
                            <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                              {ai.match === "chassis" && "จับคู่ด้วยเลขตัวถัง"}
                              {ai.match === "chassis-near" && "จับคู่ด้วยเลขตัวถังที่ใกล้เคียง"}
                            </div>
                          )}
                          {canEdit && active && (
                            <ReceiptAttachButton
                              submissionId={s.id}
                              disabled={saving}
                              onUploaded={addReceipt}
                              onMessage={(text, err) => setRowErrors((prev) => ({ ...prev, [s.id]: err ? text : "" }))}
                            />
                          )}
                        </td>
                        <td>
                          <div className="receipt-fields">
                            <span>ทะเบียน</span>
                            {editable ? (
                              <div style={{ display: "flex", gap: 6 }}>
                                <input
                                  type="text"
                                  maxLength={3}
                                  value={input.plateCategory}
                                  onChange={(e) => patchInput(s.id, { plateCategory: e.target.value.slice(0, 3) })}
                                  aria-label="หมวดทะเบียน"
                                  style={{ width: 58, ...(check.plate ? CHECK_STYLE : {}) }}
                                />
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  maxLength={4}
                                  value={input.plateNumber}
                                  onChange={(e) => patchInput(s.id, { plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                                  aria-label="เลขทะเบียน"
                                  style={{ width: 62, ...(check.plate ? CHECK_STYLE : {}) }}
                                />
                              </div>
                            ) : (
                              <span>{s.vehicle.plateCategory && s.vehicle.plateNumber ? `${s.vehicle.plateCategory} ${s.vehicle.plateNumber}` : "—"}</span>
                            )}
                            <span>เลขที่</span>
                            {editable ? (
                              <div>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  maxLength={30}
                                  value={input.receiptNo}
                                  onChange={(e) => patchInput(s.id, { receiptNo: e.target.value.replace(/[^\d/]/g, "") })}
                                  aria-label="เลขที่ใบเสร็จ"
                                  style={{ width: 126, ...(check.receiptNo ? CHECK_STYLE : {}) }}
                                />
                                {input.receiptNo.trim() && !RECEIPT_NO_RE.test(input.receiptNo.trim()) && (
                                  <div style={{ marginTop: 4 }}>
                                    <span className="badge warn">รูปแบบไม่ใช่ ตัวเลข/ตัวเลข</span>
                                  </div>
                                )}
                              </div>
                            ) : (
                              <span>{s.receiptNo || "—"}</span>
                            )}
                            <span>วันที่</span>
                            {editable ? (
                              <DateInput
                                value={input.receiptDate}
                                onChange={(value) => patchInput(s.id, { receiptDate: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)) })}
                                aria-label="วันที่ในใบเสร็จ"
                                style={{ width: 126, ...(check.date ? CHECK_STYLE : {}) }}
                              />
                            ) : (
                              <span>{s.receiptDate ? isoToDisplayDate(s.receiptDate.slice(0, 10)) : "—"}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <div className="receipt-fields">
                            <span>Bill</span>
                            <div>
                              <div>{bill === null ? "—" : money(bill)}</div>
                              <div style={{ fontSize: 11, color: "#8a94a6" }}>
                                ค่าธรรมเนียม {money(Number(s.billFeeTotal))} + ภาษี {s.taxAmount === null ? "?" : money(Number(s.taxAmount))}
                              </div>
                            </div>
                            <span>ใบเสร็จ</span>
                            {editable ? (
                              <div>
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
                              </div>
                            ) : (
                              <span>{s.receiptAmount !== null ? money(Number(s.receiptAmount)) : "—"}</span>
                            )}
                          </div>
                        </td>
                        <td style={{ minWidth: 200 }}>
                          {!active ? (
                            <StatusText s={s} />
                          ) : photo ? (
                            reading ? (
                              <span style={{ fontSize: 12, color: "#4a5a78", fontWeight: 600 }}>⏳ AI กำลังอ่านใบเสร็จ… (เติมค่าให้เมื่ออ่านเสร็จ)</span>
                            ) : ai || wrong.length > 0 ? (
                              <AiFindings s={s} ai={ai} amountText={input?.amountText ?? ""} wrong={wrong} reviewed={input?.reviewed ?? false} />
                            ) : aiError ? (
                              <span style={{ fontSize: 12, color: "#b43434" }}>{aiError} - ตรวจรูปแล้วกรอกเอง</span>
                            ) : (
                              <span className="badge done">ได้ใบเสร็จ (กรอกเอง)</span>
                            )
                          ) : !canEdit ? (
                            <span className="badge">{s.receiptCarriedAt ? "ยังรอใบเสร็จ (ค้างจากรอบก่อน)" : "รอใบเสร็จ"}</span>
                          ) : (
                            <>
                              <select
                                value={input?.reason ?? ""}
                                onChange={(e) => patchInput(s.id, { reason: e.target.value })}
                                aria-label="สาเหตุที่ยังไม่ได้ใบเสร็จ"
                                style={{ width: "100%" }}
                              >
                                <option value="">{s.receiptCarriedAt ? "ยังรอใบเสร็จ - ค้างไว้ต่อ" : "ยังไม่ทราบ - ค้างไว้"}</option>
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
                          {canEdit && active && photo && input && (
                            <div>
                              <ReceiptEditButton
                                submission={s}
                                receipts={receipts[s.id] ?? []}
                                imageId={latestAiImageId(receipts[s.id])}
                                values={input}
                                flags={needsCheck(s, ai)}
                                highlight={!input.reviewed}
                                aiChassis={ai?.reading.chassis ?? null}
                                aiDate={ai?.reading.date ?? null}
                                onSave={(values) => patchInput(s.id, { ...values, reviewed: true })}
                              />
                            </div>
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

            {/* ปุ่มบันทึกติดขอบล่างจอ - ตรวจแถวไหนอยู่ก็กดยืนยันได้โดยไม่ต้องเลื่อนลงไปท้ายตาราง */}
            {canEdit && (
              <div className="receipt-save-bar">
                <span className="customer-message" style={{ fontSize: 13 }}>
                  คันที่ไม่มีใบเสร็จและยังไม่ทราบสาเหตุ จะค้างอยู่ในใบนี้ และขึ้นว่า &quot;ยังขาด&quot; ในรายการด้านบน
                </span>
                <span style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <span>วันที่รับใบเสร็จ {dateText}</span>
                  <button type="button" className="primary" disabled={saving} onClick={handleSave}>
                    {saving ? "กำลังบันทึก…" : `บันทึกใบยื่นนี้ (ได้ใบเสร็จ ${activeRows.filter((s) => hasPhoto(s.id)).length} คัน)`}
                  </button>
                </span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ค้นหา + โหลดเพิ่ม: ใบที่รับไปนานแล้วก็หาเจอและแก้ได้ (✎ แก้ = ทะเบียน/เลขที่/ยอด/วันที่ พร้อมเหตุผล - ผู้ใช้ 2026-09-27) */}
      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>
            ได้ใบเสร็จแล้ว ({completed.length}
            {completedHasMore ? "+" : ""} รายการ{completedQuery.trim() ? " ที่ตรงคำค้น" : " ล่าสุด"})
          </h2>
          <input
            type="search"
            value={completedQuery}
            onChange={(e) => setCompletedQuery(e.target.value)}
            placeholder="ค้นหา เลขตัวถัง / ทะเบียน / ลูกค้า / เลขที่ใบเสร็จ"
            aria-label="ค้นหารายการที่ได้ใบเสร็จแล้ว"
            style={{ width: 320, maxWidth: "100%" }}
          />
        </div>
        {completedError ? (
          <div className="empty-customers" role="alert">
            {completedError}
          </div>
        ) : completed.length === 0 ? (
          <div className="empty-customers">
            {completedLoading ? "กำลังโหลด..." : completedQuery.trim() ? "ไม่พบรายการที่ตรงคำค้น" : "ยังไม่มีรายการที่ได้ใบเสร็จ"}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="receipt-check-table">
              <thead>
                <tr>
                  <th>วันที่ยื่นเอกสาร</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ทะเบียน</th>
                  <th>เลขที่ใบเสร็จ</th>
                  <th>วันที่ในใบเสร็จ</th>
                  <th>วันที่รับใบเสร็จ</th>
                  <th>รูปใบเสร็จ</th>
                  <th>Bill</th>
                  <th>ยอดใบเสร็จ</th>
                  {canEdit && <th>แก้ไข</th>}
                </tr>
              </thead>
              <tbody>
                {completed.map((s) => {
                    const bill = billOf(s);
                    return (
                      <tr key={s.id}>
                        <td>{isoToDisplayDate(s.submitDate.slice(0, 10))}</td>
                        <td>{s.vehicle.customer.name}</td>
                        <td>{s.vehicle.chassis}</td>
                        <td>{s.vehicle.plateCategory && s.vehicle.plateNumber ? `${s.vehicle.plateCategory} ${s.vehicle.plateNumber}` : "—"}</td>
                        <td>{s.receiptNo || "—"}</td>
                        <td>{s.receiptDate ? isoToDisplayDate(s.receiptDate.slice(0, 10)) : "—"}</td>
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
                        {canEdit && (
                          <td>
                            <ReceivedReceiptFixButton submission={s} receipts={receipts[s.id] ?? []} onSaved={applyReceiptFix} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
        {completedHasMore && (
          <div style={{ padding: "12px 23px 20px" }}>
            <button
              type="button"
              className="text-button"
              disabled={completedLoading}
              onClick={() => loadCompleted(completedQuery, completed.length - completedOutside.current.size)}
            >
              {completedLoading ? "กำลังโหลด…" : "โหลดเพิ่มอีก 100 รายการ"}
            </button>
          </div>
        )}
      </section>
    </section>
  );
}
