"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  type BulkDocumentSubmissionEntry,
  type DocumentSubmission,
  type DocumentSubmissionOptionsInput,
  type FeePreview,
  type NewPlateOption,
  type OwnerType,
  type PlateNumberOption,
  type SubmitCandidate,
  type TaxBreakdown,
  type Vehicle,
} from "@/lib/api";
import { OWNER_TYPES } from "@/lib/vehicle-reference-data";
import { SubmittedRecordsView } from "@/components/SubmittedRecordsView";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

const OWNER_TYPE_LABEL: Record<OwnerType, string> = Object.fromEntries(OWNER_TYPES) as Record<OwnerType, string>;

// รายการที่บันทึกไว้ (ยังไม่ยื่นจริง) เก็บเป็นร่างในเบราว์เซอร์ - รีเฟรชหน้าแล้วไม่หาย ค่าธรรมเนียม/ภาษีคำนวณใหม่
// ตอนกู้คืนเสมอ ส่วนสิทธิ์การยื่นตรวจซ้ำที่ backend ตอนกดยืนยันยื่นอยู่แล้ว
const DRAFT_STORAGE_KEY = "submit-documents-draft-v1";
const QUEUE_PAGE_SIZE = 50;
const PREVIEW_CHUNK_SIZE = 500;

function formatMoney(amount: number): string {
  return amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

function isMotoBody(body: string | null): boolean {
  return !!body && body.startsWith("รย.12-");
}

function jobTypeLabel(vehicle: Vehicle): string {
  if (!vehicle.registrationProvince || !vehicle.ownerProvince) return "จดทะเบียนปกติ";
  if (vehicle.registrationProvince === vehicle.ownerProvince) return "จดทะเบียนปกติ";
  return `ขอใช้${vehicle.registrationProvince}`;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

function summarizeList(items: string[]): string {
  return `${items.slice(0, 10).join(", ")}${items.length > 10 ? " ..." : ""}`;
}

const DEFAULT_OPTIONS: DocumentSubmissionOptionsInput = {
  plateNumberOption: "NONE",
  includePlateFee: true,
  newPlateOption: "NONE",
  relocateAddon: false,
  stopUseRelocateOut: false,
  urgent: false,
};

// ประเภทเจ้าของรถ: ใช้ของเดิมถ้ารถมีบันทึกไว้แล้ว ไม่งั้นปล่อยว่าง ("ยังไม่ระบุ") ให้ผู้ใช้เลือกเอง - ระบบไม่เดาให้
// (ผู้ใช้เลือกแบบนี้ 2026-09-20) ยื่นไม่ได้จนกว่าจะระบุครบทุกคัน เพราะภาษี รย.1 นิติบุคคลคูณสอง
function existingOwnerType(vehicle: Vehicle): OwnerType | undefined {
  return vehicle.ownerType ?? undefined;
}

function isOwnerUnspecified(entry: { ownerType: OwnerType | undefined; vehicle: Vehicle }): boolean {
  return !entry.ownerType && !entry.vehicle.ownerType;
}

function lastFailedOf(vehicle: Vehicle): SubmitCandidate["lastFailedSubmission"] {
  return "lastFailedSubmission" in vehicle ? (vehicle as SubmitCandidate).lastFailedSubmission : null;
}

function lastFailedLabel(failed: NonNullable<SubmitCandidate["lastFailedSubmission"]>): string {
  return `ยื่นไม่สำเร็จ ${isoToDisplayDate(failed.submitDate)}: ${failed.failRemark || "—"}`;
}

type Phase = "menu" | "queue" | "bulk" | "form" | "batch" | "done" | "records";
type KindFilter = "all" | "car" | "moto";

interface BatchEntry {
  key: string;
  vehicle: Vehicle;
  options: DocumentSubmissionOptionsInput;
  plateCategory: string | null;
  plateNumber: string | null;
  // undefined = ไม่แก้ไขเจ้าของรถเดิม - ถ้ารถยังไม่มีเจ้าของด้วย = "ยังไม่ระบุ" ยื่นไม่ได้จนกว่าจะเลือก
  ownerType: OwnerType | undefined;
  submitDate: string; // ISO
  fee: FeePreview;
  taxAmount: number | null;
  grandTotal: number;
}

type DraftEntry = Omit<BatchEntry, "fee" | "taxAmount" | "grandTotal">;

function newDraft(vehicle: Vehicle, submitDate: string): DraftEntry {
  return {
    key: `${vehicle.id}-${Date.now()}-${Math.random()}`,
    vehicle,
    options: DEFAULT_OPTIONS,
    // รถที่มีเลขทะเบียนอยู่แล้ว (เช่น ยื่นรอบก่อนได้เลขมาแล้ว) แสดงไว้ให้เลย - ตอนยื่นส่งค่านี้กลับไป ไม่ล้างทิ้ง
    plateCategory: vehicle.plateCategory,
    plateNumber: vehicle.plateNumber,
    ownerType: existingOwnerType(vehicle),
    submitDate,
  };
}

function ownerLabel(entry: DraftEntry): string {
  if (entry.ownerType) return OWNER_TYPE_LABEL[entry.ownerType];
  return entry.vehicle.ownerType ? `${OWNER_TYPE_LABEL[entry.vehicle.ownerType]} (เดิม)` : "ยังไม่ระบุ";
}

function optionsLabel(entry: DraftEntry): string {
  const o = entry.options;
  const isMoto = isMotoBody(entry.vehicle.body);
  const parts: string[] = [];
  if (o.plateNumberOption === "NORMAL") parts.push(isMoto ? "ขอใช้เลขทะเบียน" : "เลขไม่ประมูล");
  if (o.plateNumberOption === "AUCTION") parts.push("เลขประมูล");
  if (!isMoto && o.newPlateOption === "BLACKWHITE") parts.push("ป้ายขาวดำ");
  if (!isMoto && o.newPlateOption === "AUCTION") parts.push("ป้ายประมูล");
  if (!isMoto && o.relocateAddon) parts.push("แจ้งย้ายออก");
  if (isMoto && o.stopUseRelocateOut) parts.push("หยุดใช้ย้ายออก");
  if (o.urgent) parts.push("ด่วน");
  return parts.length > 0 ? parts.join(" · ") : "—";
}

// คำนวณค่าธรรมเนียม + ภาษีของหลายรายการในคำขอเดียว (แบ่งชุดละ 500) - คันที่คำนวณไม่ได้คืนเป็นข้อความแยก
async function priceDrafts(drafts: DraftEntry[]): Promise<{ entries: BatchEntry[]; failed: string[] }> {
  const entries: BatchEntry[] = [];
  const failed: string[] = [];
  for (let i = 0; i < drafts.length; i += PREVIEW_CHUNK_SIZE) {
    const chunk = drafts.slice(i, i + PREVIEW_CHUNK_SIZE);
    const { results } = await api.previewDocumentSubmissionBulk(
      chunk.map((d) => ({ vehicleId: d.vehicle.id, ownerType: d.ownerType, ...d.options })),
    );
    results.forEach((result, index) => {
      const draft = chunk[index];
      if (!result.fee) {
        failed.push(`${draft.vehicle.chassis} (${result.error ?? "คำนวณไม่สำเร็จ"})`);
        return;
      }
      const taxAmount = result.tax?.amount ?? null;
      entries.push({
        ...draft,
        fee: result.fee,
        taxAmount,
        grandTotal: result.fee.billTotal + result.fee.noBillTotal + (taxAmount ?? 0),
      });
    });
  }
  return { entries, failed };
}

// ผลคำนวณภาษี - ห้ามแสดง 0 บาทแทนกรณีคำนวณไม่ได้ (MISSING_INPUT/MISSING_VERIFIED_RULE)
function TaxResultView({ result }: { result: TaxBreakdown }) {
  if (result.amount === null) {
    return (
      <div className="customer-message error" role="status" style={{ marginTop: 4 }}>
        ยังคำนวณภาษีไม่ได้{result.reason ? ` - ${result.reason}` : ""}
      </div>
    );
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
      <span style={{ fontSize: 14, fontWeight: 500, color: "#1c2130" }}>
        ค่าภาษี
        {result.baseAmount !== null && result.juristicMultiplier > 1 && (
          <span style={{ fontWeight: 400, color: "#8a90a2" }}> ({result.juristicReason})</span>
        )}
      </span>
      <span style={{ fontSize: 16, fontWeight: 500, color: "#2854d9" }}>{formatMoney(result.amount)} บาท</span>
    </div>
  );
}

function Pagination({ page, totalPages, onPageChange }: { page: number; totalPages: number; onPageChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <div className="inspect-pagination">
      <button className="text-button" disabled={page === 0} onClick={() => onPageChange(page - 1)}>
        ← ก่อนหน้า
      </button>
      <span className="muted">
        หน้า {page + 1} จาก {totalPages}
      </span>
      <button className="text-button" disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}>
        ถัดไป →
      </button>
    </div>
  );
}

export default function SubmitDocumentsPage() {
  const [phase, setPhase] = useState<Phase>("menu");
  const [sessionDateText, setSessionDateText] = useState(isoToDisplayDate(todayIso()));
  // "" = ยังกรอกวันที่ไม่ครบ/ไม่ถูกต้อง - ห้ามโหลดคิวหรือเพิ่มรถจนกว่าจะถูกต้อง (สิทธิ์ยื่นขึ้นกับวันที่ยื่น)
  const sessionSubmitDate = useMemo(() => displayDateToIso(sessionDateText.replace(/\D/g, "")), [sessionDateText]);

  // รายการที่บันทึกไว้ (ยังไม่ยื่นจริง)
  const [batch, setBatch] = useState<BatchEntry[]>([]);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchNotice, setBatchNotice] = useState("");
  const [applying, setApplying] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ succeeded: number; failed: Array<{ chassis: string; error: string }> } | null>(null);

  // ล็อกวันที่ยื่นเอกสารเมื่อมีรถในรายการแล้ว - ทุกคันในรายการต้องผ่านเงื่อนไขอายุผลตรวจ ณ วันเดียวกัน
  const sessionDateLocked = batch.length > 0 || phase === "form" || phase === "done";

  // คิวรอยื่นเอกสาร
  const [queue, setQueue] = useState<SubmitCandidate[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [queueReload, setQueueReload] = useState(0);
  const [passDateFilter, setPassDateFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [chassisFilter, setChassisFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [queuePage, setQueuePage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [queueNotice, setQueueNotice] = useState("");
  const [lookupResults, setLookupResults] = useState<SubmitCandidate[] | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  // วางเลขตัวถังหลายคันพร้อมกัน
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);

  // ฟอร์มคันที่กำลังกรอก (เพิ่มใหม่ หรือแก้ไขรายการที่บันทึกไว้ - editingKey)
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [options, setOptions] = useState<DocumentSubmissionOptionsInput>(DEFAULT_OPTIONS);
  const [plateCategory, setPlateCategory] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  // ประเภทเจ้าของรถ (ใช้คำนวณภาษีรถประจำปี) - ผู้ใช้เลือกแค่ประเภท ไม่ต้องจัดการเจ้าของรถรายชื่อเอง
  // (backend find-or-create VehicleOwner แบบไม่ระบุชื่อให้เองตอนบันทึกจริง) null = ยังไม่ได้เลือก บันทึกไม่ได้
  const [ownerType, setOwnerType] = useState<OwnerType | null>(null);

  const [feePreview, setFeePreview] = useState<FeePreview | null>(null);
  const [feeError, setFeeError] = useState("");
  const [taxPreview, setTaxPreview] = useState<TaxBreakdown | null>(null);
  const [formError, setFormError] = useState("");

  // ดูข้อมูลที่ยื่นแล้ว
  const [records, setRecords] = useState<DocumentSubmission[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);

  const confirmDialogRef = useRef<HTMLDialogElement>(null);

  const isMoto = isMotoBody(selectedVehicle?.body ?? null);

  // กู้คืนร่างรายการที่บันทึกไว้ครั้งเดียวตอนเปิดหน้า - กู้ไม่สำเร็จ (เช่นเน็ตหลุด) จะไม่ตั้ง draftRestored เพื่อไม่ให้
  // effect ด้านล่างเขียนทับร่างเดิมด้วยรายการว่าง
  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    } catch {
      raw = null;
    }
    let draft: { submitDate?: string; entries?: DraftEntry[] } | null = null;
    try {
      draft = raw ? JSON.parse(raw) : null;
    } catch {
      draft = null;
    }
    if (!draft?.entries?.length || !draft.submitDate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraftRestored(true);
      return;
    }
    const submitDate = draft.submitDate;
    const drafts = draft.entries;
    setSessionDateText(isoToDisplayDate(submitDate));
    priceDrafts(drafts)
      .then(({ entries, failed }) => {
        setBatch(entries);
        if (failed.length > 0) setBatchNotice(`กู้คืนรายการที่บันทึกไว้ไม่ได้ ${failed.length} คัน: ${summarizeList(failed)}`);
        setDraftRestored(true);
      })
      .catch(() => {
        setBatchNotice("กู้คืนรายการที่บันทึกไว้ไม่สำเร็จ - รีเฟรชหน้าเพื่อลองใหม่");
      });
  }, []);

  useEffect(() => {
    if (!draftRestored) return;
    try {
      if (batch.length === 0) {
        window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      } else {
        const entries: DraftEntry[] = batch.map(({ key, vehicle, options, plateCategory, plateNumber, ownerType, submitDate }) => ({
          key,
          vehicle,
          options,
          plateCategory,
          plateNumber,
          ownerType,
          submitDate,
        }));
        window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ submitDate: batch[0].submitDate, entries }));
      }
    } catch {
      // เก็บร่างไม่ได้ (private mode/พื้นที่เต็ม) - หน้ายังใช้งานได้ปกติ แค่รีเฟรชแล้วรายการหาย
    }
  }, [batch, draftRestored]);

  useEffect(() => {
    if (phase !== "queue" || !sessionSubmitDate) return;
    let cancelled = false;
    async function loadQueue() {
      setQueueLoading(true);
      try {
        const { vehicles } = await api.listSubmissionQueue(sessionSubmitDate);
        if (cancelled) return;
        setQueue(vehicles);
        setQueueError("");
      } catch (err) {
        if (!cancelled) setQueueError(err instanceof ApiError ? err.message : "โหลดคิวรอยื่นเอกสารไม่สำเร็จ");
      } finally {
        if (!cancelled) setQueueLoading(false);
      }
    }
    loadQueue();
    return () => {
      cancelled = true;
    };
  }, [phase, sessionSubmitDate, queueReload]);

  // ---- คิว: ตัวกรองแบบ faceted - ตัวเลือกของแต่ละตัวกรองนับจากรถที่ผ่านตัวกรองอื่นแล้ว ----
  const batchVehicleIds = useMemo(() => new Set(batch.map((e) => e.vehicle.id)), [batch]);
  const available = useMemo(() => queue.filter((v) => !batchVehicleIds.has(v.id)), [queue, batchVehicleIds]);

  type FacetKey = "date" | "brand" | "owner" | "kind";
  function matches(v: SubmitCandidate, except: FacetKey | null, f: { date: string; brand: string; owner: string; kind: KindFilter }) {
    if (except !== "date" && f.date && v.inspectionResultDate !== f.date) return false;
    if (except !== "brand" && f.brand && v.brandName !== f.brand) return false;
    if (except !== "owner" && f.owner && v.customerName !== f.owner) return false;
    if (except !== "kind" && f.kind !== "all" && (f.kind === "moto") !== isMotoBody(v.body)) return false;
    return true;
  }

  function countBy(rows: SubmitCandidate[], keyOf: (v: SubmitCandidate) => string | null): Map<string, number> {
    const counts = new Map<string, number>();
    for (const v of rows) {
      const key = keyOf(v);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  const rawFilters = { date: passDateFilter, brand: brandFilter, owner: ownerFilter, kind: kindFilter };
  const dateCounts = countBy(available.filter((v) => matches(v, "date", rawFilters)), (v) => v.inspectionResultDate);
  const brandCounts = countBy(available.filter((v) => matches(v, "brand", rawFilters)), (v) => v.brandName);
  const ownerCounts = countBy(available.filter((v) => matches(v, "owner", rawFilters)), (v) => v.customerName);
  const kindRows = available.filter((v) => matches(v, "kind", rawFilters));
  const motoCount = kindRows.filter((v) => isMotoBody(v.body)).length;
  // ค่าที่เลือกไว้แต่ไม่มีในคิวแล้ว (เช่นหลังเพิ่มรถเข้ารายการจนหมด) ถือว่าไม่ได้กรอง
  const filters = {
    date: dateCounts.has(passDateFilter) ? passDateFilter : "",
    brand: brandCounts.has(brandFilter) ? brandFilter : "",
    owner: ownerCounts.has(ownerFilter) ? ownerFilter : "",
    kind: kindFilter,
  };
  const chassisQuery = chassisFilter.trim().toLowerCase();
  const filteredQueue = available.filter((v) => matches(v, null, filters) && (!chassisQuery || v.chassis.toLowerCase().includes(chassisQuery)));
  const queueTotalPages = Math.max(1, Math.ceil(filteredQueue.length / QUEUE_PAGE_SIZE));
  const currentQueuePage = Math.min(queuePage, queueTotalPages - 1);
  const queuePageRows = filteredQueue.slice(currentQueuePage * QUEUE_PAGE_SIZE, (currentQueuePage + 1) * QUEUE_PAGE_SIZE);
  const selectedAvailable = available.filter((v) => selectedIds.has(v.id));
  const allFilteredSelected = filteredQueue.length > 0 && filteredQueue.every((v) => selectedIds.has(v.id));

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const v of filteredQueue) {
        if (allFilteredSelected) next.delete(v.id);
        else next.add(v.id);
      }
      return next;
    });
  }

  function onFilterChange(apply: () => void) {
    apply();
    setQueuePage(0);
  }

  async function addSelectedToBatch() {
    if (selectedAvailable.length === 0 || !sessionSubmitDate) return;
    setAdding(true);
    setQueueNotice("");
    try {
      const { entries, failed } = await priceDrafts(selectedAvailable.map((v) => newDraft(v, sessionSubmitDate)));
      setBatch((prev) => [...prev, ...entries]);
      setSelectedIds(new Set());
      const failedNotice = failed.length > 0 ? `คำนวณค่าธรรมเนียมไม่สำเร็จ ${failed.length} คัน (ไม่ได้เพิ่ม): ${summarizeList(failed)}` : "";
      if (entries.length > 0) {
        setBatchNotice(failedNotice);
        setSubmitResult(null);
        setPhase("batch");
      } else {
        setQueueNotice(failedNotice);
      }
    } catch (err) {
      setQueueNotice(err instanceof ApiError ? err.message : "เพิ่มเข้ารายการไม่สำเร็จ");
    } finally {
      setAdding(false);
    }
  }

  async function handleLookupOutsideQueue() {
    const query = chassisFilter.trim();
    if (!query || !sessionSubmitDate) return;
    setLookupLoading(true);
    setQueueNotice("");
    try {
      const { vehicles } = await api.searchVehiclesByChassis(query, sessionSubmitDate);
      setLookupResults(vehicles);
    } catch (err) {
      setLookupResults(null);
      setQueueNotice(err instanceof ApiError ? err.message : "ค้นหาไม่สำเร็จ");
    } finally {
      setLookupLoading(false);
    }
  }

  // ---- ฟอร์มรายคัน ----
  function resetForm() {
    setSelectedVehicle(null);
    setEditingKey(null);
    setOptions(DEFAULT_OPTIONS);
    setPlateCategory("");
    setPlateNumber("");
    setOwnerType(null);
    setFeePreview(null);
    setFeeError("");
    setTaxPreview(null);
    setFormError("");
  }

  function pickVehicle(vehicle: Vehicle) {
    resetForm();
    setSelectedVehicle(vehicle);
    setPlateCategory(vehicle.plateCategory ?? "");
    setPlateNumber(vehicle.plateNumber ?? "");
    setOwnerType(existingOwnerType(vehicle) ?? null);
    setPhase("form");
  }

  function editEntry(entry: BatchEntry) {
    resetForm();
    setEditingKey(entry.key);
    setSelectedVehicle(entry.vehicle);
    setOptions(entry.options);
    setPlateCategory(entry.plateCategory ?? "");
    setPlateNumber(entry.plateNumber ?? "");
    setOwnerType(entry.ownerType ?? existingOwnerType(entry.vehicle) ?? null);
    setPhase("form");
  }

  function leaveForm() {
    const backTo: Phase = editingKey ? "batch" : "queue";
    resetForm();
    setPhase(backTo);
  }

  // คำนวณค่าธรรมเนียมใหม่ทุกครั้งที่ตัวเลือกเปลี่ยน (ให้สรุปค่าใช้จ่ายอัปเดตแบบเรียลไทม์ตาม mockup)
  useEffect(() => {
    if (phase !== "form" || !selectedVehicle) return;
    let cancelled = false;
    api
      .previewDocumentSubmissionFee(selectedVehicle.id, options)
      .then((r) => {
        if (cancelled) return;
        setFeePreview(r);
        setFeeError("");
      })
      .catch((err) => {
        if (cancelled) return;
        setFeePreview(null);
        setFeeError(err instanceof ApiError ? err.message : "คำนวณค่าธรรมเนียมไม่สำเร็จ");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    phase,
    selectedVehicle,
    options.plateNumberOption,
    options.includePlateFee,
    options.newPlateOption,
    options.relocateAddon,
    options.stopUseRelocateOut,
    options.urgent,
  ]);

  useEffect(() => {
    if (phase !== "form" || !selectedVehicle || !ownerType) return;
    let cancelled = false;
    api
      .previewTax({
        body: selectedVehicle.body,
        fuel: selectedVehicle.fuel,
        cc: selectedVehicle.cc,
        weight: selectedVehicle.weight,
        firstRegistrationDate: null,
        owner: { ownerType, isHirePurchaseBusiness: false, hirerType: null },
      })
      .then((r) => {
        if (!cancelled) setTaxPreview(r);
      })
      .catch(() => {
        if (!cancelled) setTaxPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, selectedVehicle, ownerType]);

  function handleSaveToBatch() {
    setFormError("");
    if (!selectedVehicle || !sessionSubmitDate) return;
    if (batch.some((e) => e.vehicle.id === selectedVehicle.id && e.key !== editingKey)) {
      setFormError("รถคันนี้อยู่ในรายการที่บันทึกไว้แล้ว - แก้ไขรายการเดิมจากหน้ารายการที่บันทึกไว้แทนการเพิ่มซ้ำ");
      return;
    }
    if (!ownerType) {
      setFormError("กรุณาเลือกประเภทเจ้าของรถก่อนบันทึก");
      return;
    }
    if (options.plateNumberOption !== "NONE" && (!plateCategory.trim() || !plateNumber.trim())) {
      setFormError("กรุณากรอกหมวดทะเบียนและเลขทะเบียนที่ขอก่อนบันทึก");
      return;
    }
    if (!feePreview) {
      setFormError("กำลังคำนวณค่าธรรมเนียม กรุณารอสักครู่แล้วลองใหม่");
      return;
    }
    const taxAmount = taxPreview?.amount ?? null;
    const entry: BatchEntry = {
      key: editingKey ?? `${selectedVehicle.id}-${Date.now()}`,
      vehicle: selectedVehicle,
      options,
      plateCategory: plateCategory.trim() || null,
      plateNumber: plateNumber.trim() || null,
      ownerType,
      submitDate: sessionSubmitDate,
      fee: feePreview,
      taxAmount,
      grandTotal: feePreview.billTotal + feePreview.noBillTotal + (taxAmount ?? 0),
    };
    setBatch((prev) => (editingKey ? prev.map((e) => (e.key === editingKey ? entry : e)) : [...prev, entry]));
    setSubmitResult(null);
    resetForm();
    setPhase("batch");
  }

  // ---- รายการที่บันทึกไว้ ----
  function removeFromBatch(keys: Set<string>) {
    setBatch((prev) => prev.filter((e) => !keys.has(e.key)));
    setBatchSelected((prev) => new Set([...prev].filter((k) => !keys.has(k))));
  }

  function toggleBatchSelected(key: string) {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedBatchEntries = batch.filter((e) => batchSelected.has(e.key));
  const allBatchSelected = batch.length > 0 && batch.every((e) => batchSelected.has(e.key));

  // ตั้งค่าเดียวกันให้หลายคันที่เลือกพร้อมกัน แล้วคำนวณค่าธรรมเนียม/ภาษีใหม่ทั้งชุดในคำขอเดียว
  async function applyToSelected(change: (entry: BatchEntry) => DraftEntry) {
    if (selectedBatchEntries.length === 0) return;
    setApplying(true);
    setBatchNotice("");
    try {
      const { entries, failed } = await priceDrafts(selectedBatchEntries.map(change));
      const byKey = new Map(entries.map((e) => [e.key, e]));
      setBatch((prev) => prev.map((e) => byKey.get(e.key) ?? e));
      if (failed.length > 0) setBatchNotice(`ปรับไม่สำเร็จ ${failed.length} คัน (ใช้ค่าเดิม): ${summarizeList(failed)}`);
    } catch (err) {
      setBatchNotice(err instanceof ApiError ? err.message : "ปรับรายการที่เลือกไม่สำเร็จ");
    } finally {
      setApplying(false);
    }
  }

  // วางเลขตัวถังหลายคัน - ต้องเป็นรถที่ยื่นได้ ณ วันที่ยื่น (เงื่อนไขเดียวกับคิว) คันที่ยื่นไม่ได้แจ้งพร้อมเหตุผล
  async function handleBulkImport() {
    const lines = bulkText
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) {
      setBulkError("กรุณาวางเลขตัวถังอย่างน้อย 1 รายการ");
      return;
    }
    if (lines.length > 1000) {
      setBulkError(`รองรับไม่เกิน 1,000 คันต่อครั้ง (พบ ${lines.length} รายการ)`);
      return;
    }
    if (!sessionSubmitDate) {
      setBulkError("กรุณากรอกวันที่ยื่นเอกสารให้ถูกต้องก่อน");
      return;
    }
    setBulkLoading(true);
    setBulkError("");
    try {
      const { found: foundAll, notFound, blocked } = await api.lookupVehiclesByChassis(lines, sessionSubmitDate);
      const found = foundAll.filter((v) => !batchVehicleIds.has(v.id));
      const alreadyInBatch = foundAll.filter((v) => batchVehicleIds.has(v.id)).map((v) => v.chassis);

      const noticeParts: string[] = [];
      if (notFound.length > 0) noticeParts.push(`ไม่พบรถ ${notFound.length} รายการในระบบ (ข้ามไป): ${summarizeList(notFound)}`);
      if (blocked.length > 0) {
        noticeParts.push(`ยื่นไม่ได้ ${blocked.length} คัน (ข้ามไป): ${summarizeList(blocked.map((b) => `${b.chassis} - ${b.reason}`))}`);
      }
      if (alreadyInBatch.length > 0) {
        noticeParts.push(`อยู่ในรายการที่บันทึกไว้แล้ว ${alreadyInBatch.length} คัน (ข้ามไป): ${summarizeList(alreadyInBatch)}`);
      }
      if (found.length === 0) {
        setBulkError(noticeParts.join(" · ") || "ไม่มีรถที่ยื่นได้");
        return;
      }
      const { entries, failed } = await priceDrafts(found.map((v) => newDraft(v, sessionSubmitDate)));
      if (failed.length > 0) noticeParts.push(`คำนวณค่าธรรมเนียมไม่สำเร็จ ${failed.length} คัน (ไม่ได้เพิ่ม): ${summarizeList(failed)}`);
      setBatch((prev) => [...prev, ...entries]);
      setBatchNotice(noticeParts.join(" · "));
      if (entries.length > 0) {
        setBulkText("");
        setSubmitResult(null);
        setPhase("batch");
      } else {
        setBulkError(noticeParts.join(" · "));
      }
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : "นำเข้าไม่สำเร็จ");
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleConfirmSubmit() {
    if (batch.some(isOwnerUnspecified)) return;
    setSubmitting(true);
    try {
      const entries: BulkDocumentSubmissionEntry[] = batch.map((e) => ({
        vehicleId: e.vehicle.id,
        submitDate: e.submitDate,
        plateCategory: e.plateCategory,
        plateNumber: e.plateNumber,
        ownerType: e.ownerType,
        ...e.options,
      }));
      const result = await api.createDocumentSubmissionBulk(entries);
      const failedWithChassis = result.failed.map((f) => ({
        chassis: batch.find((e) => e.vehicle.id === f.vehicleId)?.vehicle.chassis ?? f.vehicleId,
        error: f.error,
      }));
      setSubmitResult({ succeeded: result.succeeded.length, failed: failedWithChassis });
      const succeededIds = new Set(result.succeeded.map((s) => s.vehicleId));
      setBatch((prev) => prev.filter((e) => !succeededIds.has(e.vehicle.id)));
      setBatchSelected(new Set());
      setBatchNotice("");
      setQueueReload((n) => n + 1);
      confirmDialogRef.current?.close();
      setPhase(failedWithChassis.length === 0 ? "done" : "batch");
    } catch (err) {
      setSubmitResult({ succeeded: 0, failed: [{ chassis: "-", error: err instanceof ApiError ? err.message : "ยื่นเอกสารไม่สำเร็จ" }] });
      confirmDialogRef.current?.close();
    } finally {
      setSubmitting(false);
    }
  }

  async function loadRecords() {
    setRecordsLoading(true);
    try {
      const r = await api.listDocumentSubmissions();
      setRecords(r.submissions);
    } catch {
      // ปล่อยรายการว่างไว้ - หน้านี้ไม่มีที่แสดง error message แยกสำหรับ records
    } finally {
      setRecordsLoading(false);
    }
  }

  useEffect(() => {
    if (phase !== "records") return;
    // Standard fetch-on-phase-enter; loadRecords sets a loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecords();
  }, [phase]);

  const batchGrandTotal = batch.reduce((sum, e) => sum + e.grandTotal, 0);
  const batchTaxPending = batch.filter((e) => e.taxAmount === null).length;
  const ownerUnspecifiedKeys = batch.filter(isOwnerUnspecified).map((e) => e.key);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ยื่นเอกสารจดทะเบียนรถใหม่</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        เลือกรถจากคิวที่แจ้งย้าย/ตัดบัญชีและตรวจรถผ่านแล้ว (ผลตรวจมีอายุ 90 วัน) กรองตามวันที่ตรวจ ยี่ห้อ เจ้าของงาน แล้วยืนยันยื่นเอกสาร
      </p>

      {phase === "menu" && (
        <section className="panel">
          <div className="choices" style={{ padding: 22 }}>
            {batch.length > 0 && (
              <div className="customer-message" role="status" style={{ marginBottom: 6 }}>
                มีรายการที่บันทึกไว้ยังไม่ได้ยื่น {batch.length} คัน (วันที่ยื่น {isoToDisplayDate(batch[0].submitDate)}) ·{" "}
                <button type="button" className="text-button" onClick={() => setPhase("batch")}>
                  ดูรายการ →
                </button>
              </div>
            )}
            <button
              onClick={() => {
                if (batch.length === 0) setSessionDateText(isoToDisplayDate(todayIso()));
                setPhase("queue");
              }}
            >
              <strong>ยื่นเอกสารจดทะเบียนรถ</strong>
              <div className="muted">เลือกรถจากคิวรถที่ตรวจผ่านแล้ว</div>
            </button>
            <button
              onClick={() => {
                setPhase("records");
              }}
            >
              <strong>ดูข้อมูลที่ยื่นแล้ว</strong>
              <div className="muted">ดูรายการที่ยื่นแล้ว แยกรถยนต์ / มอเตอร์ไซค์ ตามแบบใบส่งงาน</div>
            </button>
          </div>
        </section>
      )}

      {phase === "records" && (
        <>
          <button type="button" className="text-button" style={{ marginBottom: 14 }} onClick={() => setPhase("menu")}>
            ← กลับเมนู
          </button>
          <SubmittedRecordsView records={records} loading={recordsLoading} />
        </>
      )}

      {(phase === "queue" || phase === "bulk" || phase === "form" || phase === "batch" || phase === "done") && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          {sessionDateLocked ? (
            <span className="muted">
              วันที่ยื่นเอกสาร: {isoToDisplayDate(sessionSubmitDate)}
              {batch.length > 0 && phase !== "done" ? " (ล็อกไว้เพราะมีรถในรายการแล้ว)" : ""}
            </span>
          ) : (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#5b6172" }}>
              วันที่ยื่นเอกสาร
              <input
                value={sessionDateText}
                onChange={(e) => setSessionDateText(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
                placeholder="วว/ดด/ปปปป"
                aria-invalid={!sessionSubmitDate}
                style={{ width: 130, height: 34, border: "1px solid #d3d7e3", borderRadius: 8, padding: "0 10px", fontSize: 13 }}
              />
              {!sessionSubmitDate && <span className="customer-message error">วันที่ไม่ถูกต้อง</span>}
            </label>
          )}
          {batch.length > 0 && phase !== "batch" && phase !== "done" && (
            <button type="button" className="text-button" onClick={() => setPhase("batch")}>
              บันทึกไว้แล้ว {batch.length} คัน · ดูรายการทั้งหมด →
            </button>
          )}
        </div>
      )}

      {phase === "queue" && (
        <>
          <section className="panel" style={{ padding: 22, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ minWidth: 190 }}>
                วันที่ตรวจผ่าน
                <select value={filters.date} onChange={(e) => onFilterChange(() => setPassDateFilter(e.target.value))}>
                  <option value="">ทุกวันที่</option>
                  {Array.from(dateCounts.keys())
                    .sort()
                    .map((d) => (
                      <option key={d} value={d}>
                        {isoToDisplayDate(d)} ({dateCounts.get(d)} คัน)
                      </option>
                    ))}
                </select>
              </label>
              <label className="field" style={{ minWidth: 170 }}>
                ยี่ห้อ
                <select value={filters.brand} onChange={(e) => onFilterChange(() => setBrandFilter(e.target.value))}>
                  <option value="">ทุกยี่ห้อ</option>
                  {Array.from(brandCounts.keys())
                    .sort((a, b) => a.localeCompare(b, "th"))
                    .map((b) => (
                      <option key={b} value={b}>
                        {b} ({brandCounts.get(b)} คัน)
                      </option>
                    ))}
                </select>
              </label>
              <label className="field" style={{ minWidth: 210 }}>
                เจ้าของงาน
                <select value={filters.owner} onChange={(e) => onFilterChange(() => setOwnerFilter(e.target.value))}>
                  <option value="">ทุกเจ้าของงาน</option>
                  {Array.from(ownerCounts.keys())
                    .sort((a, b) => a.localeCompare(b, "th"))
                    .map((o) => (
                      <option key={o} value={o}>
                        {o} ({ownerCounts.get(o)} คัน)
                      </option>
                    ))}
                </select>
              </label>
              <label className="field" style={{ minWidth: 190 }}>
                ค้นหาเลขตัวถัง
                <input
                  value={chassisFilter}
                  onChange={(e) =>
                    onFilterChange(() => {
                      setChassisFilter(e.target.value);
                      setLookupResults(null);
                    })
                  }
                  placeholder="บางส่วนก็ได้"
                />
              </label>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(
                  [
                    ["all", `ทั้งหมด (${kindRows.length})`],
                    ["car", `รถยนต์ (${kindRows.length - motoCount})`],
                    ["moto", `มอเตอร์ไซค์ (${motoCount})`],
                  ] as Array<[KindFilter, string]>
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    className={`filter-chip${kindFilter === key ? " selected" : ""}`}
                    onClick={() => onFilterChange(() => setKindFilter(key))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" className="text-button" onClick={() => setPhase("bulk")}>
                วางเลขตัวถังหลายคัน →
              </button>
            </div>
          </section>

          {queueNotice && (
            <p className="customer-message error" role="alert" style={{ marginBottom: 12 }}>
              {queueNotice}
            </p>
          )}

          <section className="panel">
            <div
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "16px 22px" }}
            >
              <div>
                <strong style={{ fontSize: 15 }}>รถที่พร้อมยื่น {filteredQueue.length} คัน</strong>
                <span className="muted" role="status">
                  {queueLoading
                    ? " · กำลังโหลด..."
                    : ` · ในคิวทั้งหมด ${available.length} คัน${batchVehicleIds.size > 0 ? ` (ไม่รวมที่อยู่ในรายการแล้ว ${batchVehicleIds.size} คัน)` : ""}`}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                {selectedAvailable.length > 0 && (
                  <button type="button" className="text-button" onClick={() => setSelectedIds(new Set())}>
                    ล้างที่เลือก
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  disabled={selectedAvailable.length === 0 || adding || queueLoading || !sessionSubmitDate}
                  onClick={addSelectedToBatch}
                >
                  {adding ? "กำลังคำนวณ..." : `เพิ่มเข้ารายการ (${selectedAvailable.length} คัน)`}
                </button>
              </div>
            </div>

            {queueError && (
              <p className="customer-message error" role="alert" style={{ padding: "0 22px 16px" }}>
                {queueError}
              </p>
            )}

            {!sessionSubmitDate ? (
              <div className="empty-customers">กรอกวันที่ยื่นเอกสารให้ถูกต้องก่อน - รถที่ยื่นได้ขึ้นกับอายุผลตรวจ ณ วันที่ยื่น</div>
            ) : !queueLoading && filteredQueue.length === 0 ? (
              <div className="empty-customers">
                {chassisQuery ? (
                  <>
                    ไม่พบเลขตัวถังนี้ในคิวรอยื่น ·{" "}
                    <button type="button" className="text-button" disabled={lookupLoading} onClick={handleLookupOutsideQueue}>
                      {lookupLoading ? "กำลังค้นหา..." : "ตรวจสอบว่าทำไมไม่อยู่ในคิว"}
                    </button>
                  </>
                ) : available.length === 0 ? (
                  "ยังไม่มีรถที่พร้อมยื่น ณ วันที่ยื่นนี้ (ต้องแจ้งย้าย/ตัดบัญชีและตรวจรถผ่านภายใน 90 วัน)"
                ) : (
                  "ไม่มีรถตรงกับตัวกรอง"
                )}
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label="เลือกทุกคันที่ตรงกับตัวกรอง"
                          checked={allFilteredSelected}
                          onChange={toggleAllFiltered}
                        />
                      </th>
                      <th>วันที่ตรวจผ่าน</th>
                      <th>ยื่นได้ถึง</th>
                      <th>เจ้าของงาน</th>
                      <th>เลขตัวถัง</th>
                      <th>ยี่ห้อ</th>
                      <th>ประเภทรถ</th>
                      <th>ประเภทงาน</th>
                      <th>หมายเหตุ</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {queuePageRows.map((v) => {
                      const daysLeft = v.inspectionValidUntil && sessionSubmitDate ? daysBetween(sessionSubmitDate, v.inspectionValidUntil) : null;
                      return (
                        <tr key={v.id} onClick={() => toggleSelected(v.id)} style={{ cursor: "pointer" }}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`เลือก ${v.chassis}`}
                              checked={selectedIds.has(v.id)}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => toggleSelected(v.id)}
                            />
                          </td>
                          <td>{v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}</td>
                          <td>
                            {v.inspectionValidUntil ? isoToDisplayDate(v.inspectionValidUntil) : "—"}
                            {daysLeft !== null && (
                              <span className={daysLeft <= 7 ? "badge warn" : "muted"} style={{ marginLeft: 8 }}>
                                {daysLeft === 0 ? "วันสุดท้าย" : `อีก ${daysLeft} วัน`}
                              </span>
                            )}
                          </td>
                          <td>{v.customerName}</td>
                          <td>{v.chassis}</td>
                          <td>{v.brandName}</td>
                          <td>{v.body || "—"}</td>
                          <td>{jobTypeLabel(v)}</td>
                          <td>{v.lastFailedSubmission ? <span className="badge warn">{lastFailedLabel(v.lastFailedSubmission)}</span> : "—"}</td>
                          <td>
                            <button
                              type="button"
                              className="text-button"
                              onClick={(e) => {
                                e.stopPropagation();
                                pickVehicle(v);
                              }}
                            >
                              กรอกรายละเอียด
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination page={currentQueuePage} totalPages={queueTotalPages} onPageChange={setQueuePage} />
          </section>

          {lookupResults && (
            <section className="panel" style={{ marginTop: 16 }}>
              <p style={{ margin: 0, padding: "16px 22px", fontSize: 14, fontWeight: 500 }}>ผลค้นหาในระบบทั้งหมด</p>
              {lookupResults.length === 0 ? (
                <div className="empty-customers">ไม่พบข้อมูลรถเลขตัวถังนี้ในระบบ</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>เลขตัวถัง</th>
                        <th>เจ้าของงาน</th>
                        <th>วันที่ตรวจผ่าน</th>
                        <th>สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lookupResults.map((v) => (
                        <tr key={v.id}>
                          <td>{v.chassis}</td>
                          <td>{v.customerName}</td>
                          <td>{v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}</td>
                          <td>
                            {v.submitBlockReason ? (
                              <span className="badge warn">{v.submitBlockReason}</span>
                            ) : batchVehicleIds.has(v.id) ? (
                              <span className="badge">อยู่ในรายการแล้ว</span>
                            ) : (
                              <span className="badge done">ยื่นได้</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {phase === "bulk" && (
        <section className="panel" style={{ padding: 22 }}>
          <button type="button" className="text-button" style={{ marginBottom: 14 }} onClick={() => setPhase("queue")}>
            ← กลับไปคิว
          </button>
          <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 500 }}>วางเลขตัวถังหลายคันพร้อมกัน</p>
          <p className="muted" style={{ marginBottom: 14 }}>
            วางเลขตัวถัง 1 เลขต่อ 1 บรรทัด รองรับสูงสุด 1,000 คันต่อครั้ง - รับเฉพาะรถที่แจ้งย้าย/ตัดบัญชีและตรวจรถผ่านภายใน 90 วัน ณ
            วันที่ยื่น {sessionSubmitDate ? isoToDisplayDate(sessionSubmitDate) : "—"} ทุกคันใช้ค่าเริ่มต้น (ไม่ขอเลขทะเบียน, ไม่มีตัวเลือกเสริม)
            ประเภทเจ้าของรถใช้ของเดิมถ้ามี ไม่มีต้องเลือกเองในหน้ารายการที่บันทึกไว้ก่อนยื่น
          </p>
          <label className="field wide">
            รายการเลขตัวถัง
            <textarea
              value={bulkText}
              onChange={(e) => {
                setBulkText(e.target.value);
                setBulkError("");
              }}
              placeholder={"CHASSIS0001\nCHASSIS0002\nCHASSIS0003"}
              rows={8}
              style={{ fontFamily: "monospace" }}
            />
          </label>
          <p className="muted" style={{ margin: "8px 0" }}>
            พบ {bulkText.split("\n").map((l) => l.trim()).filter(Boolean).length} เลขตัวถัง
          </p>
          {bulkError && (
            <p className="customer-message error" role="alert">
              {bulkError}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="primary" disabled={bulkLoading} onClick={handleBulkImport}>
              {bulkLoading ? "กำลังตรวจสอบ..." : "นำเข้าเข้ารายการที่บันทึกไว้"}
            </button>
          </div>
        </section>
      )}

      {phase === "form" && selectedVehicle && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="panel" style={{ padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p className="muted" style={{ marginBottom: 6 }}>
                เลขตัวถัง{editingKey ? " (แก้ไขรายการที่บันทึกไว้)" : ""}
              </p>
              <p style={{ margin: "0 0 10px", fontSize: 16, fontWeight: 500 }}>{selectedVehicle.chassis}</p>
              <p className="muted">
                {selectedVehicle.customerName} · {selectedVehicle.brandName} · {selectedVehicle.body || "—"} · {selectedVehicle.fuel || "—"}
                {selectedVehicle.cc ? ` · ${selectedVehicle.cc} cc` : ""}
              </p>
              {lastFailedOf(selectedVehicle) && (
                <span className="badge warn" style={{ display: "inline-block", marginTop: 8 }}>
                  {lastFailedLabel(lastFailedOf(selectedVehicle)!)}
                </span>
              )}
            </div>
            <button type="button" className="text-button" onClick={leaveForm}>
              {editingKey ? "ยกเลิกการแก้ไข" : "กลับไปคิว"}
            </button>
          </section>

          <section className="panel" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 18 }}>
            <div className="vehicle-fields">
              <div>
                <p className="muted" style={{ marginBottom: 8 }}>
                  ประเภทเจ้าของรถ * (ใช้คำนวณภาษีรถประจำปี)
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    type="button"
                    className={`filter-chip${ownerType === "INDIVIDUAL" ? " selected" : ""}`}
                    onClick={() => setOwnerType("INDIVIDUAL")}
                  >
                    บุคคลธรรมดา
                  </button>
                  <button
                    type="button"
                    className={`filter-chip${ownerType === "JURISTIC" ? " selected" : ""}`}
                    onClick={() => setOwnerType("JURISTIC")}
                  >
                    นิติบุคคล
                  </button>
                </div>
              </div>
              <div>
                <p className="muted" style={{ marginBottom: 8 }}>
                  ประเภทงาน (ดึงอัตโนมัติจากจังหวัด)
                </p>
                <span className="badge">{jobTypeLabel(selectedVehicle)}</span>
                <p className="muted" style={{ marginTop: 6 }}>
                  จดทะเบียน {selectedVehicle.registrationProvince || "—"} · เจ้าของรถอยู่ {selectedVehicle.ownerProvince || "—"}
                </p>
              </div>
            </div>

            <div>
              <p className="muted" style={{ marginBottom: 8 }}>
                ขอใช้เลขทะเบียน
              </p>
              <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <label className="field" style={{ width: 130 }}>
                  {options.plateNumberOption !== "NONE" ? "หมวดทะเบียน * (เช่น 4กข)" : "หมวดทะเบียน (เช่น 4กข)"}
                  <input value={plateCategory} onChange={(e) => setPlateCategory(e.target.value.slice(0, 3))} maxLength={3} placeholder="4กข" />
                </label>
                <label className="field" style={{ width: 130 }}>
                  {options.plateNumberOption !== "NONE" ? "เลขทะเบียน * (เช่น 4444)" : "เลขทะเบียน (เช่น 4444)"}
                  <input
                    value={plateNumber}
                    onChange={(e) => setPlateNumber(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="4444"
                  />
                </label>
              </div>
              {options.plateNumberOption === "NONE" && (
                <p className="muted" style={{ marginBottom: 10 }}>
                  ยังไม่ทราบเลขก็เว้นว่างไว้ก่อนได้ - กรอกภายหลังตอนใบเสร็จกรมขนส่งออกเลขให้
                </p>
              )}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className={`filter-chip${options.plateNumberOption === "NONE" ? " selected" : ""}`}
                  onClick={() => setOptions((o) => ({ ...o, plateNumberOption: "NONE" as PlateNumberOption }))}
                >
                  ไม่ขอ
                </button>
                <button
                  className={`filter-chip${options.plateNumberOption === "NORMAL" ? " selected" : ""}`}
                  onClick={() => setOptions((o) => ({ ...o, plateNumberOption: "NORMAL" as PlateNumberOption }))}
                >
                  {isMoto ? "ขอใช้เลขทะเบียน (500 บาท)" : "ไม่ใช่เลขประมูล (500 บาท)"}
                </button>
                {!isMoto && (
                  <button
                    className={`filter-chip${options.plateNumberOption === "AUCTION" ? " selected" : ""}`}
                    onClick={() => setOptions((o) => ({ ...o, plateNumberOption: "AUCTION" as PlateNumberOption }))}
                  >
                    เลขประมูล (1,500 บาท)
                  </button>
                )}
              </div>
              {options.plateNumberOption !== "NONE" && (
                <button
                  className={`filter-chip${options.includePlateFee ? " selected" : ""}`}
                  style={{ marginTop: 8 }}
                  onClick={() => setOptions((o) => ({ ...o, includePlateFee: !o.includePlateFee }))}
                >
                  {options.includePlateFee ? "✓ " : ""}รวมค่าแผ่นป้ายทะเบียน ({isMoto ? 100 : 200} บาท)
                </button>
              )}
            </div>

            {!isMoto && (
              <div>
                <p className="muted" style={{ marginBottom: 8 }}>
                  ทำแผ่นป้ายทะเบียนใหม่
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className={`filter-chip${options.newPlateOption === "NONE" ? " selected" : ""}`}
                    onClick={() => setOptions((o) => ({ ...o, newPlateOption: "NONE" as NewPlateOption }))}
                  >
                    ไม่ทำ
                  </button>
                  <button
                    className={`filter-chip${options.newPlateOption === "BLACKWHITE" ? " selected" : ""}`}
                    onClick={() => setOptions((o) => ({ ...o, newPlateOption: "BLACKWHITE" as NewPlateOption }))}
                  >
                    ป้ายขาวดำ (200 บาท)
                  </button>
                  <button
                    className={`filter-chip${options.newPlateOption === "AUCTION" ? " selected" : ""}`}
                    onClick={() => setOptions((o) => ({ ...o, newPlateOption: "AUCTION" as NewPlateOption }))}
                  >
                    ป้ายประมูล (1,200 บาท)
                  </button>
                </div>
              </div>
            )}

            <div>
              <p className="muted" style={{ marginBottom: 8 }}>
                ตัวเลือกเพิ่มเติม
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!isMoto && (
                  <button
                    className={`filter-chip${options.relocateAddon ? " selected" : ""}`}
                    onClick={() => setOptions((o) => ({ ...o, relocateAddon: !o.relocateAddon }))}
                  >
                    {options.relocateAddon ? "✓ " : ""}แจ้งย้ายออกต่างจังหวัดพร้อมกัน (50 บาท)
                  </button>
                )}
                {isMoto && (
                  <button
                    className={`filter-chip${options.stopUseRelocateOut ? " selected" : ""}`}
                    onClick={() => setOptions((o) => ({ ...o, stopUseRelocateOut: !o.stopUseRelocateOut }))}
                  >
                    {options.stopUseRelocateOut ? "✓ " : ""}จดใหม่ หยุดใช้ย้ายออก (ลงขัน 250 บาท)
                  </button>
                )}
                <button className={`filter-chip${options.urgent ? " selected" : ""}`} onClick={() => setOptions((o) => ({ ...o, urgent: !o.urgent }))}>
                  {options.urgent ? "✓ " : ""}งานด่วน ({isMoto ? 50 : 100} บาท)
                </button>
              </div>
              {options.stopUseRelocateOut && (
                <p className="muted" style={{ marginTop: 8, color: "#c07a1e" }}>
                  * ค่าธรรมเนียมอื่นๆ ของรายการนี้ยังไม่มีข้อมูล (ตอนนี้ปรับเฉพาะลงขันเป็น 250 บาท)
                </p>
              )}
            </div>
          </section>

          <section className="panel" style={{ padding: 22 }}>
            <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 500 }}>สรุปค่าใช้จ่าย</p>
            {feeError && (
              <p className="customer-message error" role="alert">
                {feeError}
              </p>
            )}
            {feePreview && (
              <>
                <p className="muted" style={{ marginBottom: 8 }}>
                  รายการ Bill
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {feePreview.billItems.map((item, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#3a3f4d" }}>
                      <span>{item.label}</span>
                      <span>{formatMoney(item.amount)} บาท</span>
                    </div>
                  ))}
                </div>
                <div style={{ background: "#f4f7fd", borderRadius: 8, padding: "12px 14px", marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>รวมค่าธรรมเนียมทั้งหมด</span>
                    <span style={{ fontSize: 16, fontWeight: 500 }}>{formatMoney(feePreview.billTotal)} บาท</span>
                  </div>
                  {!ownerType ? (
                    <div className="customer-message error" role="status" style={{ marginTop: 4 }}>
                      เลือกประเภทเจ้าของรถก่อน จึงจะคำนวณภาษีได้
                    </div>
                  ) : (
                    taxPreview && <TaxResultView result={taxPreview} />
                  )}
                  <div
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderTop: "1px solid #dbe3f5", paddingTop: 8, marginTop: 2 }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600 }}>รวมค่า Bill ทั้งหมด</span>
                    <span style={{ fontSize: 18, fontWeight: 600, color: "#2854d9" }}>
                      {formatMoney(feePreview.billTotal + (taxPreview?.amount ?? 0))} บาท
                      {!ownerType || taxPreview?.amount === null ? " + ภาษี (รอข้อมูล)" : ""}
                    </span>
                  </div>
                </div>

                <p className="muted" style={{ margin: "16px 0 8px" }}>
                  รายการ No bill
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {feePreview.noBillItems.map((item, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#3a3f4d" }}>
                      <span>{item.label}</span>
                      <span>{formatMoney(item.amount)} บาท</span>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#8a90a2", marginTop: 6 }}>
                  <span>รวม No bill</span>
                  <span>{formatMoney(feePreview.noBillTotal)} บาท</span>
                </div>

                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginTop: 16,
                    paddingTop: 16,
                    borderTop: "1px solid #e3e6ee",
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 500 }}>รวมทั้งหมด</span>
                  <span style={{ fontSize: 22, fontWeight: 500, color: "#2854d9" }}>
                    {formatMoney(feePreview.billTotal + feePreview.noBillTotal + (taxPreview?.amount ?? 0))} บาท
                    {!ownerType || taxPreview?.amount === null ? " + ภาษี (รอข้อมูล)" : ""}
                  </span>
                </div>
              </>
            )}

            {formError && (
              <p className="customer-message error" role="alert" style={{ marginTop: 14 }}>
                {formError}
              </p>
            )}
            <div className="form-actions">
              <button type="button" className="primary" onClick={handleSaveToBatch}>
                {editingKey ? "บันทึกการแก้ไข" : "บันทึกรายการนี้"}
              </button>
            </div>
          </section>
        </div>
      )}

      {phase === "batch" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {batchNotice && (
            <div className="customer-message error" role="alert">
              {batchNotice}
            </div>
          )}
          {submitResult && (
            <div className={`customer-message${submitResult.failed.length > 0 ? " error" : " success"}`} role="status">
              บันทึกสำเร็จ {submitResult.succeeded} คัน
              {submitResult.failed.length > 0 && (
                <>
                  {" "}
                  · พลาด {submitResult.failed.length} คัน:{" "}
                  {submitResult.failed.map((f) => `${f.chassis} (${f.error})`).join(", ")}
                </>
              )}
            </div>
          )}
          {batch.length === 0 ? (
            <>
              <div className="empty-customers">ยังไม่มีรถในรายการ</div>
              <div className="form-actions">
                <button type="button" className="primary" onClick={() => setPhase("queue")}>
                  เลือกรถจากคิว
                </button>
              </div>
            </>
          ) : (
            <>
              <section className="panel">
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "16px 22px" }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
                    <strong style={{ fontSize: 15 }}>รายการที่บันทึกไว้ {batch.length} คัน</strong>
                    {ownerUnspecifiedKeys.length > 0 && (
                      <button type="button" className="text-button" onClick={() => setBatchSelected(new Set(ownerUnspecifiedKeys))}>
                        เลือกคันที่ยังไม่ระบุเจ้าของรถ ({ownerUnspecifiedKeys.length})
                      </button>
                    )}
                  </div>
                  {selectedBatchEntries.length > 0 ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="muted">ตั้งค่า {selectedBatchEntries.length} คันที่เลือก:</span>
                      <button
                        type="button"
                        className="filter-chip"
                        disabled={applying}
                        onClick={() => applyToSelected((e) => ({ ...e, ownerType: "INDIVIDUAL" }))}
                      >
                        บุคคลธรรมดา
                      </button>
                      <button
                        type="button"
                        className="filter-chip"
                        disabled={applying}
                        onClick={() => applyToSelected((e) => ({ ...e, ownerType: "JURISTIC" }))}
                      >
                        นิติบุคคล
                      </button>
                      <button
                        type="button"
                        className="filter-chip"
                        disabled={applying}
                        onClick={() => applyToSelected((e) => ({ ...e, options: { ...e.options, urgent: true } }))}
                      >
                        งานด่วน
                      </button>
                      <button
                        type="button"
                        className="filter-chip"
                        disabled={applying}
                        onClick={() => applyToSelected((e) => ({ ...e, options: { ...e.options, urgent: false } }))}
                      >
                        ไม่ด่วน
                      </button>
                      <button
                        type="button"
                        className="text-button"
                        style={{ color: "#c0392b" }}
                        disabled={applying}
                        onClick={() => removeFromBatch(new Set(selectedBatchEntries.map((e) => e.key)))}
                      >
                        ลบที่เลือก
                      </button>
                      {applying && <span className="muted">กำลังคำนวณ...</span>}
                    </div>
                  ) : (
                    <span className="muted">เลือกหลายคันเพื่อตั้งค่าเจ้าของรถ/งานด่วนพร้อมกัน · กด &quot;แก้ไข&quot; เพื่อขอเลขทะเบียน/ป้าย รายคัน</span>
                  )}
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}>
                          <input
                            type="checkbox"
                            aria-label="เลือกทุกคันในรายการ"
                            checked={allBatchSelected}
                            onChange={() => setBatchSelected(allBatchSelected ? new Set() : new Set(batch.map((e) => e.key)))}
                          />
                        </th>
                        <th>เลขตัวถัง</th>
                        <th>เจ้าของงาน</th>
                        <th>ประเภทรถ</th>
                        <th>เจ้าของรถ</th>
                        <th>ทะเบียนที่ขอ</th>
                        <th>ตัวเลือก</th>
                        <th style={{ textAlign: "right" }}>รวม (บาท)</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {batch.map((row) => (
                        <tr key={row.key}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`เลือก ${row.vehicle.chassis}`}
                              checked={batchSelected.has(row.key)}
                              onChange={() => toggleBatchSelected(row.key)}
                            />
                          </td>
                          <td>{row.vehicle.chassis}</td>
                          <td>{row.vehicle.customerName}</td>
                          <td>{row.vehicle.body || "—"}</td>
                          <td>{isOwnerUnspecified(row) ? <span className="badge warn">ยังไม่ระบุ</span> : ownerLabel(row)}</td>
                          <td>{row.plateCategory ? `${row.plateCategory} ${row.plateNumber}` : "—"}</td>
                          <td>{optionsLabel(row)}</td>
                          <td style={{ textAlign: "right", color: "#2854d9", fontWeight: 500 }}>
                            {formatMoney(row.grandTotal)}
                            {row.taxAmount === null && <div className="sub">+ ภาษี (รอข้อมูล)</div>}
                          </td>
                          <td>
                            <div style={{ display: "flex", gap: 12 }}>
                              <button type="button" className="text-button" onClick={() => editEntry(row)}>
                                แก้ไข
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                style={{ color: "#c0392b" }}
                                onClick={() => removeFromBatch(new Set([row.key]))}
                              >
                                ลบ
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <section className="panel" style={{ padding: 22, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>
                  รวมทั้งหมด ({batch.length} คัน){batchTaxPending > 0 ? ` · ${batchTaxPending} คันยังคำนวณภาษีไม่ได้` : ""}
                </span>
                <span style={{ fontSize: 22, fontWeight: 500, color: "#2854d9" }}>{formatMoney(batchGrandTotal)} บาท</span>
              </section>
              {ownerUnspecifiedKeys.length > 0 && (
                <p className="customer-message error" role="alert">
                  ยังไม่ระบุประเภทเจ้าของรถ {ownerUnspecifiedKeys.length} คัน - เลือกบุคคลธรรมดา/นิติบุคคลให้ครบก่อนยืนยันยื่นเอกสาร
                </p>
              )}
              <div className="form-actions">
                <button type="button" className="text-button" onClick={() => setPhase("queue")}>
                  + เพิ่มรถจากคิว
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={ownerUnspecifiedKeys.length > 0}
                  onClick={() => confirmDialogRef.current?.showModal()}
                >
                  ยืนยันยื่นเอกสารทั้งหมด
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === "done" && (
        <section className="panel empty-page">
          <p style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 500, color: "#18243c" }}>ยื่นเอกสารเรียบร้อยแล้ว</p>
          {submitResult && <p className="muted">ทั้งหมด {submitResult.succeeded} คัน</p>}
          <button
            type="button"
            className="primary"
            style={{ marginTop: 16 }}
            onClick={() => {
              setSubmitResult(null);
              setBatchNotice("");
              setPhase("menu");
            }}
          >
            ทำรายการใหม่
          </button>
        </section>
      )}

      <dialog ref={confirmDialogRef} onClick={(event) => event.target === event.currentTarget && confirmDialogRef.current?.close()}>
        <button className="close" aria-label="ปิด" onClick={() => confirmDialogRef.current?.close()}>
          ×
        </button>
        <h2>ยืนยันการยื่นเอกสาร</h2>
        <p>
          คุณแน่ใจหรือไม่ที่จะยื่นเอกสารจดทะเบียนทั้งหมด <strong>{batch.length} คัน</strong> ยอดรวม <strong>{formatMoney(batchGrandTotal)} บาท</strong>
        </p>
        <div className="form-actions">
          <button type="button" className="text-button" onClick={() => confirmDialogRef.current?.close()}>
            ยกเลิก
          </button>
          <button type="button" className="primary" disabled={submitting} onClick={handleConfirmSubmit}>
            ยืนยันยื่นเอกสาร
          </button>
        </div>
      </dialog>
    </section>
  );
}
