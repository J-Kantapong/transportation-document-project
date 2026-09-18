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
  type TaxBreakdown,
  type Vehicle,
} from "@/lib/api";
import { OWNER_TYPES } from "@/lib/vehicle-reference-data";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

const OWNER_TYPE_LABEL: Record<OwnerType, string> = Object.fromEntries(OWNER_TYPES) as Record<OwnerType, string>;

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

const DEFAULT_OPTIONS: DocumentSubmissionOptionsInput = {
  plateNumberOption: "NONE",
  includePlateFee: true,
  newPlateOption: "NONE",
  relocateAddon: false,
  stopUseRelocateOut: false,
  urgent: false,
};

type Phase = "menu" | "search" | "bulk" | "form" | "batch" | "done" | "records";

interface BatchEntry {
  key: string;
  vehicle: Vehicle;
  options: DocumentSubmissionOptionsInput;
  plateCategory: string | null;
  plateNumber: string | null;
  // undefined = ไม่ทราบเจ้าของรถ (มาจากนำเข้าหลายคันพร้อมกัน) - ไม่แตะ Vehicle.ownerId เดิมตอนบันทึกจริง
  ownerType: OwnerType | undefined;
  ownerLabel: string;
  submitDate: string; // ISO
  fee: FeePreview;
  taxAmount: number | null;
  grandTotal: number;
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

export default function SubmitDocumentsPage() {
  const [phase, setPhase] = useState<Phase>("menu");
  const [sessionDateText, setSessionDateText] = useState(isoToDisplayDate(todayIso()));
  const sessionSubmitDate = useMemo(() => displayDateToIso(sessionDateText.replace(/\D/g, "")) || todayIso(), [sessionDateText]);
  // ล็อกวันที่ยื่นเอกสารทันทีที่เริ่มค้นหา/กรอกรถคันแรก - แก้ไขได้เฉพาะตอนยังไม่ได้เลือกรถคันไหนเลย
  const sessionDateLocked = phase === "form" || phase === "batch" || phase === "done";

  // ค้นหารถ
  const [chassisQuery, setChassisQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Vehicle[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");

  // นำเข้าหลายคันพร้อมกัน
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [bulkLoading, setBulkLoading] = useState(false);
  // แจ้งเตือนรายการที่ไม่พบตอนนำเข้าหลายคันพร้อมกัน - ต้องอยู่รอดข้าม phase (bulk -> batch) เพราะ
  // นำเข้าสำเร็จแล้วเปลี่ยนหน้าไปเลย ถ้าใช้ bulkError (ซึ่งอยู่แค่หน้า bulk) ผู้ใช้จะไม่มีทางเห็นข้อความนี้
  const [bulkNotice, setBulkNotice] = useState("");

  // ฟอร์มคันที่กำลังกรอก
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null);
  const [options, setOptions] = useState<DocumentSubmissionOptionsInput>(DEFAULT_OPTIONS);
  const [plateCategory, setPlateCategory] = useState("");
  const [plateNumber, setPlateNumber] = useState("");
  // ประเภทเจ้าของรถ (ใช้คำนวณภาษีรถประจำปี) - ค่าเริ่มต้นบุคคลธรรมดา ผู้ใช้เลือกแค่ประเภท ไม่ต้องจัดการ
  // เจ้าของรถรายชื่อเอง (backend find-or-create VehicleOwner แบบไม่ระบุชื่อให้เองตอนบันทึกจริง)
  const [ownerType, setOwnerType] = useState<OwnerType>("INDIVIDUAL");

  const [feePreview, setFeePreview] = useState<FeePreview | null>(null);
  const [feeError, setFeeError] = useState("");
  const [taxPreview, setTaxPreview] = useState<TaxBreakdown | null>(null);
  const [formError, setFormError] = useState("");

  // รายการที่บันทึกไว้ (ยังไม่ยื่นจริง)
  const [batch, setBatch] = useState<BatchEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ succeeded: number; failed: Array<{ chassis: string; error: string }> } | null>(null);

  // ดูข้อมูลที่ยื่นแล้ว
  const [records, setRecords] = useState<DocumentSubmission[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [selectedRecordDate, setSelectedRecordDate] = useState<string | null>(null);
  const [updatingSubmissionId, setUpdatingSubmissionId] = useState<string | null>(null);
  const [recordStatusError, setRecordStatusError] = useState("");

  const confirmDialogRef = useRef<HTMLDialogElement>(null);

  const isMoto = isMotoBody(selectedVehicle?.body ?? null);

  function resetForm() {
    setSelectedVehicle(null);
    setOptions(DEFAULT_OPTIONS);
    setPlateCategory("");
    setPlateNumber("");
    setOwnerType("INDIVIDUAL");
    setFeePreview(null);
    setFeeError("");
    setTaxPreview(null);
    setFormError("");
    setChassisQuery("");
    setSearchResults([]);
    setSearchMessage("");
  }

  function pickVehicle(vehicle: Vehicle) {
    resetForm();
    setSelectedVehicle(vehicle);
    setPhase("form");
  }

  async function handleSearch() {
    if (!chassisQuery.trim()) {
      setSearchMessage("กรุณากรอกเลขตัวถังก่อนค้นหา");
      return;
    }
    setSearching(true);
    setSearchMessage("");
    try {
      const { vehicles } = await api.searchVehiclesByChassis(chassisQuery.trim());
      setSearchResults(vehicles);
      if (vehicles.length === 0) setSearchMessage("ไม่พบข้อมูลรถเลขตัวถังนี้ในระบบ");
    } catch (err) {
      setSearchMessage(err instanceof ApiError ? err.message : "ค้นหาไม่สำเร็จ");
    } finally {
      setSearching(false);
    }
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
    if (phase !== "form" || !selectedVehicle) return;
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
    if (options.plateNumberOption !== "NONE" && (!plateCategory.trim() || !plateNumber.trim())) {
      setFormError("กรุณากรอกหมวดทะเบียนและเลขทะเบียนที่ขอก่อนบันทึก");
      return;
    }
    if (!feePreview || !selectedVehicle) {
      setFormError("กำลังคำนวณค่าธรรมเนียม กรุณารอสักครู่แล้วลองใหม่");
      return;
    }
    const taxAmount = taxPreview?.amount ?? null;
    const entry: BatchEntry = {
      key: `${selectedVehicle.id}-${Date.now()}`,
      vehicle: selectedVehicle,
      options,
      plateCategory: plateCategory.trim() || null,
      plateNumber: plateNumber.trim() || null,
      ownerType,
      ownerLabel: OWNER_TYPE_LABEL[ownerType],
      submitDate: sessionSubmitDate,
      fee: feePreview,
      taxAmount,
      grandTotal: feePreview.billTotal + feePreview.noBillTotal + (taxAmount ?? 0),
    };
    setBatch((prev) => [...prev, entry]);
    resetForm();
    setPhase("batch");
  }

  function removeFromBatch(key: string) {
    setBatch((prev) => prev.filter((e) => e.key !== key));
  }

  // นำเข้าหลายคันพร้อมกัน - ทุกคันใช้ค่าเริ่มต้น (ไม่ขอเลขทะเบียน, ไม่มีตัวเลือกเสริม) เพราะตั้งค่าแยก
  // ทีละคันไม่ไหวจริงถ้ามีจำนวนมาก ไม่แตะ Vehicle.ownerId เดิม (ownerId: undefined) เพราะนำเข้าแบบนี้
  // ไม่ทราบเจ้าของรถจริง - แก้ไขรายคันทีหลังได้จากหน้ารายการที่บันทึกไว้
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
    setBulkLoading(true);
    setBulkError("");
    setBulkNotice("");
    try {
      const { found, notFound, pendingBlocked } = await api.lookupVehiclesByChassis(lines);
      const noticeParts: string[] = [];
      if (notFound.length > 0) {
        noticeParts.push(`ไม่พบรถ ${notFound.length} รายการในระบบ (ข้ามไป): ${notFound.slice(0, 10).join(", ")}${notFound.length > 10 ? " ..." : ""}`);
      }
      if (pendingBlocked.length > 0) {
        noticeParts.push(
          `ยื่นเอกสารไปแล้วและยังรอใบเสร็จอยู่ ${pendingBlocked.length} คัน (ข้ามไป): ${pendingBlocked.slice(0, 10).join(", ")}${pendingBlocked.length > 10 ? " ..." : ""}`,
        );
      }
      if (noticeParts.length > 0) {
        const notice = noticeParts.join(" · ");
        if (found.length > 0) {
          setBulkNotice(notice);
        } else {
          setBulkLoading(false);
          setBulkError(notice);
          return;
        }
      }
      const entries: BatchEntry[] = [];
      const CHUNK = 20;
      for (let i = 0; i < found.length; i += CHUNK) {
        const chunk = found.slice(i, i + CHUNK);
        const results = await Promise.all(
          chunk.map(async (vehicle) => {
            const fee = await api.previewDocumentSubmissionFee(vehicle.id, DEFAULT_OPTIONS);
            let taxAmount: number | null = null;
            try {
              const tax = await api.previewTax({
                body: vehicle.body,
                fuel: vehicle.fuel,
                cc: vehicle.cc,
                weight: vehicle.weight,
                firstRegistrationDate: null,
                owner: vehicle.ownerId && vehicle.ownerType ? { ownerType: vehicle.ownerType, isHirePurchaseBusiness: false, hirerType: null } : null,
              });
              taxAmount = tax.amount;
            } catch {
              taxAmount = null;
            }
            const entry: BatchEntry = {
              key: `${vehicle.id}-${Date.now()}-${Math.random()}`,
              vehicle,
              options: DEFAULT_OPTIONS,
              plateCategory: null,
              plateNumber: null,
              ownerType: undefined,
              ownerLabel: vehicle.ownerName ? `${vehicle.ownerName} (ที่มีอยู่)` : "ยังไม่ระบุ (ค่าเริ่มต้น)",
              submitDate: sessionSubmitDate,
              fee,
              taxAmount,
              grandTotal: fee.billTotal + fee.noBillTotal + (taxAmount ?? 0),
            };
            return entry;
          }),
        );
        entries.push(...results);
      }
      setBatch((prev) => [...prev, ...entries]);
      if (entries.length > 0) {
        setBulkText("");
        setPhase("batch");
      }
    } catch (err) {
      setBulkError(err instanceof ApiError ? err.message : "นำเข้าไม่สำเร็จ");
    } finally {
      setBulkLoading(false);
    }
  }

  async function handleConfirmSubmit() {
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

  // อัปเดตสถานะการยื่นเอกสาร (ได้รับใบเสร็จ/ยื่นไม่สำเร็จ) - ปลด block การยื่นซ้ำของรถคันนั้นทันที
  async function handleUpdateSubmissionStatus(submissionId: string, status: "RECEIPT_RECEIVED" | "FAILED") {
    setUpdatingSubmissionId(submissionId);
    setRecordStatusError("");
    try {
      await api.updateDocumentSubmissionStatus(submissionId, status);
      await loadRecords();
    } catch (err) {
      setRecordStatusError(err instanceof ApiError ? err.message : "อัปเดตสถานะไม่สำเร็จ");
    } finally {
      setUpdatingSubmissionId(null);
    }
  }

  useEffect(() => {
    if (phase !== "records") return;
    // Standard fetch-on-phase-enter; loadRecords sets a loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadRecords();
  }, [phase]);

  const recordsByDate = useMemo(() => {
    const map = new Map<string, DocumentSubmission[]>();
    for (const r of records) {
      const date = r.submitDate.slice(0, 10);
      if (!map.has(date)) map.set(date, []);
      map.get(date)!.push(r);
    }
    return map;
  }, [records]);
  const recordDates = useMemo(() => Array.from(recordsByDate.keys()).sort().reverse(), [recordsByDate]);
  const selectedRecordRows = selectedRecordDate ? recordsByDate.get(selectedRecordDate) ?? [] : [];
  const selectedRecordTotal = selectedRecordRows.reduce(
    (sum, r) => sum + Number(r.billFeeTotal) + Number(r.noBillTotal) + Number(r.taxAmount ?? 0),
    0,
  );

  const batchGrandTotal = batch.reduce((sum, e) => sum + e.grandTotal, 0);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ยื่นเอกสารจดทะเบียนรถใหม่</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        ค้นหารถด้วยเลขตัวถัง กรอกตัวเลือกค่าธรรมเนียม/เลขทะเบียนที่ขอ แล้วยืนยันยื่นเอกสาร
      </p>

      {phase === "menu" && (
        <section className="panel">
          <div className="choices" style={{ padding: 22 }}>
            <button
              onClick={() => {
                setSessionDateText(isoToDisplayDate(todayIso()));
                setPhase("search");
              }}
            >
              <strong>ยื่นเอกสารจดทะเบียนรถ</strong>
              <div className="muted">เริ่มยื่นเอกสารรถคันใหม่</div>
            </button>
            <button
              onClick={() => {
                setSelectedRecordDate(null);
                setPhase("records");
              }}
            >
              <strong>ดูข้อมูลที่ยื่นแล้ว</strong>
              <div className="muted">ดูรายการย้อนหลังตามวันที่ยื่น</div>
            </button>
          </div>
        </section>
      )}

      {phase === "records" && (
        <>
          <button type="button" className="text-button" style={{ marginBottom: 14 }} onClick={() => setPhase("menu")}>
            ← กลับเมนู
          </button>
          <section className="panel" style={{ padding: 22, marginBottom: 20 }}>
            <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 500, color: "#18243c" }}>เลือกวันที่ต้องการดู</p>
            {recordsLoading ? (
              <div className="customer-message" role="status">
                กำลังโหลด...
              </div>
            ) : recordDates.length === 0 ? (
              <p className="muted">ยังไม่มีข้อมูลที่ยื่นแล้ว</p>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {recordDates.map((date) => (
                  <button
                    key={date}
                    className={`filter-chip${selectedRecordDate === date ? " selected" : ""}`}
                    onClick={() => setSelectedRecordDate(date)}
                  >
                    {isoToDisplayDate(date) || date} ({recordsByDate.get(date)?.length ?? 0} คัน)
                  </button>
                ))}
              </div>
            )}
          </section>

          {selectedRecordDate && (
            <section className="panel" style={{ padding: 22 }}>
              <p style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 500 }}>รายการวันที่ {isoToDisplayDate(selectedRecordDate)}</p>
              {recordStatusError && (
                <p className="customer-message error" role="alert">
                  {recordStatusError}
                </p>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {selectedRecordRows.map((row) => (
                  <div
                    key={row.id}
                    style={{
                      border: "1px solid #eef0f6",
                      borderRadius: 8,
                      padding: "12px 16px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 10,
                    }}
                  >
                    <div>
                      <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 500 }}>
                        {row.vehicle.chassis} <span style={{ fontWeight: 400, color: "#8a90a2" }}>· {row.vehicle.body || "—"}</span>
                      </p>
                      <p className="muted">
                        {row.vehicle.customer.name} · เจ้าของรถ {row.vehicle.owner ? `${row.vehicle.owner.name || "(ไม่มีชื่อ)"} (${OWNER_TYPE_LABEL[row.vehicle.owner.ownerType]})` : "ยังไม่ระบุ"}
                        {row.vehicle.plateCategory ? ` · ทะเบียน ${row.vehicle.plateCategory} ${row.vehicle.plateNumber}` : ""}
                      </p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 15, fontWeight: 500, color: "#2854d9" }}>
                        {formatMoney(Number(row.billFeeTotal) + Number(row.noBillTotal) + Number(row.taxAmount ?? 0))} บาท
                      </span>
                      {row.status === "PENDING" && (
                        <>
                          <span className="badge warn">รอใบเสร็จ</span>
                          <button
                            type="button"
                            className="text-button"
                            disabled={updatingSubmissionId === row.id}
                            onClick={() => handleUpdateSubmissionStatus(row.id, "RECEIPT_RECEIVED")}
                          >
                            ได้รับใบเสร็จแล้ว
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            style={{ color: "#c0392b" }}
                            disabled={updatingSubmissionId === row.id}
                            onClick={() => handleUpdateSubmissionStatus(row.id, "FAILED")}
                          >
                            ยื่นไม่สำเร็จ
                          </button>
                        </>
                      )}
                      {row.status === "RECEIPT_RECEIVED" && <span className="badge done">ได้รับใบเสร็จแล้ว</span>}
                      {row.status === "FAILED" && <span className="badge" style={{ background: "#fdecec", color: "#b43434" }}>ยื่นไม่สำเร็จ</span>}
                    </div>
                  </div>
                ))}
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
                <span style={{ fontSize: 14, fontWeight: 500 }}>รวมวันนี้</span>
                <span style={{ fontSize: 20, fontWeight: 500, color: "#2854d9" }}>{formatMoney(selectedRecordTotal)} บาท</span>
              </div>
            </section>
          )}
        </>
      )}

      {(phase === "search" || phase === "bulk" || phase === "form" || phase === "batch" || phase === "done") && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
          {sessionDateLocked ? (
            <span className="muted">วันที่ยื่นเอกสาร: {isoToDisplayDate(sessionSubmitDate)}</span>
          ) : (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#5b6172" }}>
              วันที่ยื่นเอกสาร
              <input
                value={sessionDateText}
                onChange={(e) => setSessionDateText(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
                placeholder="วว/ดด/ปปปป"
                style={{ width: 130, height: 34, border: "1px solid #d3d7e3", borderRadius: 8, padding: "0 10px", fontSize: 13 }}
              />
            </label>
          )}
          {batch.length > 0 && phase !== "batch" && phase !== "done" && (
            <button type="button" className="text-button" onClick={() => setPhase("batch")}>
              บันทึกไว้แล้ว {batch.length} คัน · ดูรายการทั้งหมด →
            </button>
          )}
        </div>
      )}

      {phase === "search" && (
        <section className="panel empty-page">
          <p style={{ margin: "0 0 4px", fontSize: 16, fontWeight: 500, color: "#18243c" }}>ค้นหารถด้วยเลขตัวถัง</p>
          <p className="muted" style={{ marginBottom: 20 }}>
            รถต้องถูกบันทึกไว้แล้วในหน้า &quot;เพิ่มข้อมูลรถจดใหม่&quot; ก่อนจึงจะยื่นเอกสารได้
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 12 }}>
            <input
              value={chassisQuery}
              onChange={(e) => setChassisQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="เลขตัวถัง"
              style={{ flex: 1, maxWidth: 320, height: 42, border: "1px solid #d3d7e3", borderRadius: 8, padding: "0 14px", fontSize: 14 }}
            />
            <button type="button" className="primary" disabled={searching} onClick={handleSearch}>
              ค้นหา
            </button>
          </div>
          {searchMessage && (
            <p className="customer-message error" role="alert">
              {searchMessage}
            </p>
          )}
          {searchResults.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 12, textAlign: "left" }}>
              <table>
                <thead>
                  <tr>
                    <th>เลขตัวถัง</th>
                    <th>ชื่อลูกค้า</th>
                    <th>ประเภทรถ</th>
                    <th>ประเภทงาน</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((v) => (
                    <tr key={v.id}>
                      <td>{v.chassis}</td>
                      <td>{v.customerName}</td>
                      <td>{v.body || "—"}</td>
                      <td>{jobTypeLabel(v)}</td>
                      <td>
                        {v.pendingDocumentSubmission ? (
                          <span className="badge warn">ยื่นแล้ว รอใบเสร็จ</span>
                        ) : (
                          <button className="text-button" onClick={() => pickVehicle(v)}>
                            เลือก
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ marginTop: 24 }}>
            <button type="button" className="text-button" onClick={() => setPhase("bulk")}>
              นำเข้าหลายคันพร้อมกัน (Batch) →
            </button>
          </div>
        </section>
      )}

      {phase === "bulk" && (
        <section className="panel" style={{ padding: 22 }}>
          <button type="button" className="text-button" style={{ marginBottom: 14 }} onClick={() => setPhase("search")}>
            ← กลับ
          </button>
          <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 500 }}>นำเข้าเลขตัวถังหลายคันพร้อมกัน</p>
          <p className="muted" style={{ marginBottom: 14 }}>
            วางเลขตัวถัง 1 เลขต่อ 1 บรรทัด รองรับสูงสุด 1,000 คันต่อครั้ง - ต้องเป็นรถที่มีอยู่แล้วในระบบ ทุกคันจะใช้ค่าเริ่มต้น
            (ไม่ขอเลขทะเบียน, ไม่มีตัวเลือกเสริม, ไม่แก้ไขเจ้าของรถเดิม) วันที่ยื่นเอกสาร {isoToDisplayDate(sessionSubmitDate)} - แก้ไขรายคัน
            ทีหลังได้จากหน้ารายการที่บันทึกไว้
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
              นำเข้าเข้ารายการที่บันทึกไว้
            </button>
          </div>
        </section>
      )}

      {phase === "form" && selectedVehicle && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <section className="panel" style={{ padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p className="muted" style={{ marginBottom: 6 }}>
                เลขตัวถัง
              </p>
              <p style={{ margin: "0 0 10px", fontSize: 16, fontWeight: 500 }}>{selectedVehicle.chassis}</p>
              <p className="muted">
                {selectedVehicle.customerName} · {selectedVehicle.brandName} · {selectedVehicle.body || "—"} · {selectedVehicle.fuel || "—"}
                {selectedVehicle.cc ? ` · ${selectedVehicle.cc} cc` : ""}
              </p>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                resetForm();
                setPhase("search");
              }}
            >
              เปลี่ยนรถ
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
                  {taxPreview && <TaxResultView result={taxPreview} />}
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
                    {taxPreview?.amount === null ? " + ภาษี (รอข้อมูล)" : ""}
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
                บันทึกรายการนี้
              </button>
            </div>
          </section>
        </div>
      )}

      {phase === "batch" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {bulkNotice && (
            <div className="customer-message error" role="alert">
              {bulkNotice}
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
            <div className="empty-customers">ยังไม่มีรถในรายการ</div>
          ) : (
            <>
              <div className="customer-message" role="status">
                บันทึกรถแล้ว {batch.length} คัน - ค้นหารถคันถัดไปเพิ่มได้ หรือกดยืนยันยื่นเอกสารเมื่อครบแล้ว
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {batch.map((row) => (
                  <div
                    key={row.key}
                    className="panel"
                    style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                  >
                    <div>
                      <p style={{ margin: "0 0 4px", fontSize: 14, fontWeight: 500 }}>
                        {row.vehicle.chassis} <span style={{ fontWeight: 400, color: "#8a90a2" }}>· {row.vehicle.body || "—"}</span>
                      </p>
                      <p className="muted">
                        {jobTypeLabel(row.vehicle)} · เจ้าของรถ {row.ownerLabel}
                        {row.plateCategory ? ` · ทะเบียน ${row.plateCategory} ${row.plateNumber}` : ""} · ยื่นเอกสาร {isoToDisplayDate(row.submitDate)}
                      </p>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <span style={{ fontSize: 15, fontWeight: 500, color: "#2854d9" }}>{formatMoney(row.grandTotal)} บาท</span>
                      <button className="text-button" style={{ color: "#c0392b" }} onClick={() => removeFromBatch(row.key)}>
                        ลบ
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <section className="panel" style={{ padding: 22, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>รวมทั้งหมด ({batch.length} คัน)</span>
                <span style={{ fontSize: 22, fontWeight: 500, color: "#2854d9" }}>{formatMoney(batchGrandTotal)} บาท</span>
              </section>
              <div className="form-actions">
                <button type="button" className="text-button" onClick={() => setPhase("search")}>
                  + เพิ่มรถอีกคัน
                </button>
                <button type="button" className="primary" onClick={() => confirmDialogRef.current?.showModal()}>
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
              setBulkNotice("");
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
