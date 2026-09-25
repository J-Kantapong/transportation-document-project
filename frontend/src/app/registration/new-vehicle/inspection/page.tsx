"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { PageTabs } from "@/components/PageTabs";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { api, ApiError, type InspectionVehicle } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { DEFAULT_INSPECTION_PRINT_HEADER, printInspectionSheet } from "@/lib/inspection-print";
import { DateInput } from "@/components/DateInput";

// หัวกระดาษที่แก้ไขล่าสุดจำไว้ในเบราว์เซอร์นี้ - ถ้าอ่านไม่ได้ใช้ค่าเริ่มต้น
const PRINT_HEADER_STORAGE_KEY = "inspection-print-header";
const INSPECTION_HREF = "/registration/new-vehicle/inspection";

function loadPrintHeader(): string {
  try {
    return localStorage.getItem(PRINT_HEADER_STORAGE_KEY) || DEFAULT_INSPECTION_PRINT_HEADER;
  } catch {
    return DEFAULT_INSPECTION_PRINT_HEADER;
  }
}

function savePrintHeader(header: string) {
  try {
    if (header === DEFAULT_INSPECTION_PRINT_HEADER) localStorage.removeItem(PRINT_HEADER_STORAGE_KEY);
    else localStorage.setItem(PRINT_HEADER_STORAGE_KEY, header);
  } catch {
    // ไม่มี storage ก็ยังพิมพ์ได้ตามปกติ
  }
}

type SentType = "ส่งตรวจนอก" | "เอารถมาตรวจเอง";
type ResultType = "ผ่าน" | "ไม่ผ่าน";
type ProvinceFilter = "all" | "bangkok" | "other";

// ค่าตรวจรถลิ้งกับจังหวัดที่จดทะเบียน (registrationProvince) ตามที่ suggestInspectionCost ฝั่ง backend
// ใช้อยู่แล้ว: กทม. ใช้ตาราง FeeInspectionBangkok, จังหวัดอื่นๆ ใช้ FeeInspectionProvince (ยังไม่มีข้อมูลราคา
// ครบทุกจังหวัด - แนะนำราคาจะเป็นค่าว่างจนกว่าจะมีคนกรอกตาราง)
function matchesProvinceFilter(v: InspectionVehicle, filter: ProvinceFilter): boolean {
  if (filter === "bangkok") return v.registrationProvince === "กรุงเทพมหานคร";
  if (filter === "other") return v.registrationProvince !== "กรุงเทพมหานคร";
  return true;
}

interface SendRowState {
  selectedType: SentType | null;
  dateText: string;
  costText: string; // ราคาตรวจรถ (No bill)
  billCostText: string; // ค่าตรวจรถ (Bill) - เฉพาะรอบ 2
  saving: boolean;
  message: { text: string; error?: boolean };
}

// แก้ไขผลตรวจของรถที่ตรวจเสร็จไปแล้ว 1 คัน (เปิดทีละคันใน dialog)
interface EditResultState {
  vehicle: InspectionVehicle;
  result: ResultType;
  dateText: string;
  failRemarkText: string;
  remarkText: string; // เหตุผลที่แก้ไข - บังคับกรอก
}

interface ResultRowState {
  selectedResult: ResultType | null;
  dateText: string;
  costText: string;
  remarkText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

function toSendRowState(): SendRowState {
  return {
    selectedType: null,
    dateText: "",
    costText: "",
    billCostText: "",
    saving: false,
    message: { text: "" },
  };
}

// เอารถมาตรวจเอง = ไม่มีค่าใช้จ่าย (ตามข้อมูลรายการ "นำรถมาตรวจ" 0 บาทใน FeeInspectionBangkok) - ส่งตรวจนอกใช้ราคาแนะนำตามประเภทรถ/ยี่ห้อ
function costForSentType(type: SentType, suggestedCost: string | null): string {
  return type === "เอารถมาตรวจเอง" ? "0" : suggestedCost ?? "";
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// วันส่งตรวจเริ่มต้น = วันถัดไปของวันที่รับงาน - ส่งตรวจใหม่หลังตรวจไม่ผ่านใช้วันถัดไปของวันที่ทราบผลแทน
// ถึงกำหนดตรวจรอบ 2 ใช้วันนี้ (วันที่ผ่านรอบ 1 + 1 จะย้อนหลังไป 90 วัน)
function defaultSendDateIso(v: InspectionVehicle): string {
  if (v.round2Due) return todayIso();
  const base = v.inspectionResult === "ไม่ผ่าน" && v.inspectionResultDate ? v.inspectionResultDate : v.date;
  return addDaysIso(base, 1);
}


// หมายเหตุตามระบบในคิวส่งตรวจ: ถึงกำหนดตรวจรอบ 2 หรือตรวจไม่ผ่านต้องส่งตรวจใหม่ - ว่าง = ส่งตรวจครั้งแรก
function sendQueueNote(v: InspectionVehicle): string {
  if (v.round2Due) {
    return `ผลตรวจรอบ ${v.inspectionRound} ผ่าน (${v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}) ครบ 90 วันแล้วยังไม่ได้ยื่นเอกสาร — ตรวจรอบ 2`;
  }
  if (v.inspectionResult === "ไม่ผ่าน") {
    const round = v.inspectionRound === 2 ? "รอบ 2 " : "";
    const date = v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "";
    return `ตรวจ${round}ไม่ผ่าน ${date} · ${v.inspectionFailRemark || "—"} — ส่งตรวจใหม่`;
  }
  return "";
}

function roundLabel(v: InspectionVehicle): string {
  return v.inspectionRound === 2 ? "รอบ 2" : "รอบ 1";
}

// แบ่งหน้าละ 10 คัน ทุก panel ในหน้านี้ - select all/บันทึกทั้งหมด ยังทำงานกับทั้งลิสต์ ไม่ใช่แค่หน้าที่เห็น
const PAGE_SIZE = 10;

// วันสุดท้ายที่ยังยื่นเอกสารได้ (ตรวจผ่าน + 89 วัน) - ย้ายมาจากคิวหน้ายื่นเอกสาร (ผู้ใช้ 2026-09-25) เหลือ 7 วันขึ้นสีเตือน
function SubmitDeadline({ vehicle }: { vehicle: InspectionVehicle }) {
  if (vehicle.submitted) return <span className="badge done">ยื่นแล้ว</span>;
  if (!vehicle.submitDeadline) return <>—</>;
  const daysLeft = Math.round((Date.parse(`${vehicle.submitDeadline}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86_400_000);
  return (
    <>
      {isoToDisplayDate(vehicle.submitDeadline)}
      <span className={daysLeft <= 7 ? "badge warn" : "muted"} style={{ marginLeft: 8, whiteSpace: "nowrap" }}>
        {daysLeft < 0 ? "หมดอายุแล้ว" : daysLeft === 0 ? "วันสุดท้าย" : `อีก ${daysLeft} วัน`}
      </span>
    </>
  );
}

function usePagedList<T>(items: T[]): { pageItems: T[]; page: number; setPage: (p: number) => void; totalPages: number } {
  const [page, setPage] = useState(0);
  // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): พอรายการโหลดเสร็จครั้งแรก ข้ามไปหน้าที่มีรถคันนั้น (lib/vehicle-focus.ts)
  const [focusChecked, setFocusChecked] = useState(false);
  if (!focusChecked && items.length > 0) {
    setFocusChecked(true);
    const chassis = focusChassis();
    const index = chassis ? items.findIndex((item) => sameChassis((item as { chassis?: string }).chassis, chassis)) : -1;
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = items.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  return { pageItems, page: safePage, setPage, totalPages };
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

function toResultRowState(): ResultRowState {
  return {
    selectedResult: null,
    dateText: "",
    costText: "",
    remarkText: "",
    saving: false,
    message: { text: "" },
  };
}

function validateSendRow(row: SendRowState): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  return { dateIso };
}

function validateResultRow(row: ResultRowState, panelResult: ResultType): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  if (panelResult === "ไม่ผ่าน" && !row.remarkText.trim()) throw new Error("กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน");
  return { dateIso };
}

// ตรวจไม่ผ่าน = ไม่มีค่าใช้จ่ายตรวจ (ได้เงินคืน) - backend บังคับเป็น 0 ซ้ำอีกชั้น
// ค่าใช้จ่ายทั้งหน้าเป็นค่าคงที่ (แสดงอย่างเดียว) - backend คำนวณเองตอนบันทึก หน้าจอแสดงค่าเดียวกันให้เห็นก่อน
function bahtText(value: string): string {
  return value === "" ? "—" : `${value} บาท`;
}

// ค่าตรวจรถ (Bill) ตอนทราบผล: มีเฉพาะรอบ 2 - ผ่าน = Bill ตอนส่งตรวจ, ไม่ผ่าน = 0 (ได้เงินคืน)
function resultDefaultBillCost(v: InspectionVehicle, panelResult: ResultType): string {
  if (v.inspectionSentBillCost == null) return "";
  return panelResult === "ไม่ผ่าน" ? "0" : v.inspectionSentBillCost;
}

function resultDefaultCost(v: InspectionVehicle, panelResult: ResultType): string {
  if (panelResult === "ไม่ผ่าน") return "0";
  return v.inspectionSentCost ?? "";
}

const COMPLETED_DETAIL_FIELDS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
  ["รอบตรวจ", roundLabel],
  ["ประเภทการตรวจ", (v) => v.inspectionSentType ?? ""],
  ["วันที่ส่งตรวจ", (v) => (v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "")],
  ["ราคาตรวจรถ (No bill)", (v) => (v.inspectionSentCost ? `${v.inspectionSentCost} บาท` : "")],
  ["ค่าตรวจรถ (Bill)", (v) => (v.inspectionSentBillCost ? `${v.inspectionSentBillCost} บาท` : "")],
  ["ผลตรวจ", (v) => v.inspectionResult ?? ""],
  ["วันที่ตรวจเสร็จ", (v) => (v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "")],
  ["ราคาตรวจรถ (No bill) ผลตรวจ", (v) => (v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "")],
  ["ค่าตรวจรถ (Bill) ผลตรวจ", (v) => (v.inspectionResultBillCost ? `${v.inspectionResultBillCost} บาท` : "")],
  ["Remark (ตรวจไม่ผ่าน)", (v) => v.inspectionFailRemark ?? ""],
];

// Tab 1 - ส่งตรวจ: รายชื่อรถเดียว แต่ละแถวมี checkbox ส่งตรวจนอก/เอารถมาตรวจเอง วางข้างกัน (ไม่ใช่แยก panel)
// selectedType เป็น field เดียวต่อแถว - ติ๊กอันหนึ่งจะยกเลิกอีกอันให้อัตโนมัติ
function SendPanel({
  vehicles,
  rows,
  patchRow,
  onCheck,
  onSelectAll,
  onSave,
  onSaveAll,
  bulkSaving,
  bulkMessage,
  provinceFilter,
  onProvinceFilterChange,
  selectAllDateText,
  onSelectAllDateTextChange,
}: {
  vehicles: InspectionVehicle[];
  rows: Record<string, SendRowState>;
  patchRow: (id: string, patch: Partial<SendRowState>) => void;
  onCheck: (id: string, type: SentType, checked: boolean) => void;
  onSelectAll: (type: SentType, checked: boolean) => void;
  onSave: (id: string) => void;
  onSaveAll: () => void;
  bulkSaving: boolean;
  bulkMessage: { text: string; error?: boolean };
  provinceFilter: ProvinceFilter;
  onProvinceFilterChange: (filter: ProvinceFilter) => void;
  selectAllDateText: string;
  onSelectAllDateTextChange: (text: string) => void;
}) {
  const selectedCount = vehicles.filter((v) => rows[v.id]?.selectedType).length;
  const allOut = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedType === "ส่งตรวจนอก");
  const allSelf = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedType === "เอารถมาตรวจเอง");
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>รถที่ยังไม่ได้ตรวจ</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {bulkMessage.text && (
            <span className={`customer-message${bulkMessage.error ? " error" : " success"}`} role="status">
              {bulkMessage.text}
            </span>
          )}
          <button className="primary" disabled={bulkSaving || !selectedCount} onClick={onSaveAll}>
            บันทึกทั้งหมด
          </button>
        </div>
      </div>

      <div className="inspect-filter">
        <button className={`filter-chip${provinceFilter === "all" ? " selected" : ""}`} onClick={() => onProvinceFilterChange("all")}>
          ทั้งหมด
        </button>
        <button className={`filter-chip${provinceFilter === "bangkok" ? " selected" : ""}`} onClick={() => onProvinceFilterChange("bangkok")}>
          ตรวจรถ กทม.
        </button>
        <button className={`filter-chip${provinceFilter === "other" ? " selected" : ""}`} onClick={() => onProvinceFilterChange("other")}>
          จังหวัดอื่นๆ
        </button>
      </div>

      {!vehicles.length ? (
        <div className="empty-customers">ไม่มีรถที่ยังไม่ได้ตรวจตามตัวกรองนี้</div>
      ) : (
        <>
          <div className="inspect-select-all">
            <div className="inspect-select-all-info">
              <label>
                วันที่ (ใช้กับที่เลือกทั้งหมด)
                <DateInput
                  value={selectAllDateText}
                  onChange={(value) => onSelectAllDateTextChange(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
                  style={{ width: 100 }}
                />
              </label>
              <span className="muted">({vehicles.length} คัน)</span>
            </div>
            <div className="inspect-row-checks">
              <label>
                <input type="checkbox" checked={allOut} onChange={(e) => onSelectAll("ส่งตรวจนอก", e.target.checked)} />
                เลือกทั้งหมดเป็นส่งตรวจนอก
              </label>
              <label>
                <input type="checkbox" checked={allSelf} onChange={(e) => onSelectAll("เอารถมาตรวจเอง", e.target.checked)} />
                เลือกทั้งหมดเป็นเอารถมาตรวจเอง
              </label>
            </div>
          </div>
          {/* ตารางจริงแบบเดียวกับ "รถที่เพิ่งส่งตรวจ (รอผลตรวจ)" ด้านล่าง - คอลัมน์ข้อมูลตรงกันทุกแถว
              ช่องกรอกอยู่ท้ายแถว ตารางเลื่อนแนวนอนได้ (.table-wrap) ถ้าจอแคบ */}
          <div className="table-wrap">
            <table className="inspect-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>ประเภทรถ</th>
                  <th>จังหวัดที่จดทะเบียน</th>
                  <th>หมายเหตุ</th>
                  <th>ประเภทการส่งตรวจ</th>
                  <th>วันที่ส่งตรวจ</th>
                  <th>ราคาตรวจรถ (No bill)</th>
                  <th>ค่าตรวจรถ (Bill)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => {
                  const row = rows[v.id];
                  if (!row) return null;
                  const note = sendQueueNote(v);
                  return (
                    <tr key={v.id}>
                      <td>{isoToDisplayDate(v.date) || v.date}</td>
                      <td>{v.customerName}</td>
                      <td>{v.chassis}</td>
                      <td>{v.brandName}</td>
                      <td>{v.body || "—"}</td>
                      <td>{v.registrationProvince || "—"}</td>
                      <td className="inspect-note">{note ? <span className="customer-message error">{note}</span> : "—"}</td>
                      <td>
                        <div className="inspect-row-checks inspect-row-checks--stacked">
                          <label>
                            <input
                              type="checkbox"
                              checked={row.selectedType === "ส่งตรวจนอก"}
                              onChange={(e) => onCheck(v.id, "ส่งตรวจนอก", e.target.checked)}
                            />
                            ส่งตรวจนอก
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={row.selectedType === "เอารถมาตรวจเอง"}
                              onChange={(e) => onCheck(v.id, "เอารถมาตรวจเอง", e.target.checked)}
                            />
                            เอารถมาตรวจเอง
                          </label>
                        </div>
                      </td>
                      <td>
                        <DateInput
                          className="inspect-input inspect-input--date"
                          aria-label="วันที่ส่งตรวจ"
                          value={row.dateText}
                          onChange={(value) =>
                            patchRow(v.id, { dateText: formatDateDigits(value.replace(/\D/g, "").slice(0, 8)) })
                          }
                        />
                      </td>
                      {/* ค่าใช้จ่ายคงที่ แก้ไม่ได้ - ราคาตรวจรถ (No bill) ตามตาราง, ค่าตรวจรถ (Bill) เฉพาะรอบ 2 */}
                      <td>{row.selectedType ? bahtText(row.costText) : "—"}</td>
                      <td>{row.selectedType ? bahtText(row.billCostText) : "—"}</td>
                      <td>
                        <button
                          className="text-button"
                          disabled={!row.selectedType || row.saving || bulkSaving}
                          onClick={() => onSave(v.id)}
                        >
                          บันทึก
                        </button>
                        {row.message.text && (
                          <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11 }} role="status">
                            {row.message.text}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}

// Tab 2 - ผลตรวจ: ตารางเดียว แต่ละแถวติ๊กเลือก ผ่าน หรือ ไม่ผ่าน (เลือกได้อย่างเดียว - ติ๊กอันหนึ่งยกเลิกอีกอัน)
// ติ๊ก ไม่ผ่าน แล้วช่อง Remark จึงแสดง (บังคับกรอกก่อนบันทึก) และค่าใช้จ่ายเป็น 0 ล็อกไว้ (ได้เงินคืน)
function ResultPanel({
  vehicles,
  rows,
  patchRow,
  onCheck,
  onSelectAll,
  onSave,
  onSaveAll,
  bulkSaving,
  bulkMessage,
}: {
  vehicles: InspectionVehicle[];
  rows: Record<string, ResultRowState>;
  patchRow: (id: string, patch: Partial<ResultRowState>) => void;
  onCheck: (id: string, result: ResultType, checked: boolean) => void;
  onSelectAll: (result: ResultType, checked: boolean) => void;
  onSave: (id: string) => void;
  onSaveAll: () => void;
  bulkSaving: boolean;
  bulkMessage: { text: string; error?: boolean };
}) {
  const selectedCount = vehicles.filter((v) => rows[v.id]?.selectedResult).length;
  const allPass = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedResult === "ผ่าน");
  const allFail = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedResult === "ไม่ผ่าน");
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>รถที่รอผลตรวจ</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {bulkMessage.text && (
            <span className={`customer-message${bulkMessage.error ? " error" : " success"}`} role="status">
              {bulkMessage.text}
            </span>
          )}
          <button className="primary" disabled={bulkSaving || !selectedCount} onClick={onSaveAll}>
            บันทึกทั้งหมด
          </button>
        </div>
      </div>

      {!vehicles.length ? (
        <div className="empty-customers">ไม่มีรถที่ส่งตรวจรอผล</div>
      ) : (
        <>
          <div className="inspect-select-all">
            <span className="muted">({vehicles.length} คัน)</span>
            <div className="inspect-row-checks">
              <label>
                <input type="checkbox" checked={allPass} onChange={(e) => onSelectAll("ผ่าน", e.target.checked)} />
                เลือกทั้งหมดเป็นผ่าน
              </label>
              <label>
                <input type="checkbox" checked={allFail} onChange={(e) => onSelectAll("ไม่ผ่าน", e.target.checked)} />
                เลือกทั้งหมดเป็นไม่ผ่าน
              </label>
            </div>
          </div>
          <div className="table-wrap">
            <table className="inspect-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>ประเภทรถ</th>
                  <th>รอบตรวจ</th>
                  <th>ประเภทการส่งตรวจ</th>
                  <th>วันที่ส่งตรวจ</th>
                  <th>ผลตรวจ</th>
                  <th>วันที่ทราบผล</th>
                  <th>ราคาตรวจรถ (No bill)</th>
                  <th>ค่าตรวจรถ (Bill)</th>
                  <th>Remark</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => {
                  const row = rows[v.id];
                  if (!row) return null;
                  const selected = row.selectedResult;
                  return (
                    <tr key={v.id}>
                      <td>{isoToDisplayDate(v.date) || v.date}</td>
                      <td>{v.customerName}</td>
                      <td>{v.chassis}</td>
                      <td>{v.brandName}</td>
                      <td>{v.body || "—"}</td>
                      <td>{roundLabel(v)}</td>
                      <td>{v.inspectionSentType || "—"}</td>
                      <td>{v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "—"}</td>
                      <td>
                        <div className="inspect-row-checks inspect-row-checks--stacked">
                          <label>
                            <input
                              type="checkbox"
                              checked={selected === "ผ่าน"}
                              onChange={(e) => onCheck(v.id, "ผ่าน", e.target.checked)}
                            />
                            ผ่าน
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              checked={selected === "ไม่ผ่าน"}
                              onChange={(e) => onCheck(v.id, "ไม่ผ่าน", e.target.checked)}
                            />
                            ไม่ผ่าน
                          </label>
                        </div>
                      </td>
                      <td>
                        <DateInput
                          className="inspect-input inspect-input--date"
                          aria-label="วันที่ทราบผล"
                          value={row.dateText}
                          disabled={!selected}
                          onChange={(value) =>
                            patchRow(v.id, { dateText: formatDateDigits(value.replace(/\D/g, "").slice(0, 8)) })
                          }
                        />
                      </td>
                      {/* ค่าใช้จ่ายคงที่ แก้ไม่ได้ - ผ่าน = ราคาตอนส่งตรวจ, ไม่ผ่าน = 0 (ได้เงินคืน) */}
                      <td>{selected ? bahtText(row.costText) : "—"}</td>
                      <td>{selected ? bahtText(resultDefaultBillCost(v, selected)) : "—"}</td>
                      <td>
                        {selected === "ไม่ผ่าน" && (
                          <input
                            className="inspect-input inspect-input--remark"
                            type="text"
                            aria-label="Remark"
                            placeholder="เหตุผลที่ตรวจไม่ผ่าน"
                            value={row.remarkText}
                            onChange={(e) => patchRow(v.id, { remarkText: e.target.value })}
                          />
                        )}
                      </td>
                      <td>
                        <button className="text-button" disabled={!selected || row.saving || bulkSaving} onClick={() => onSave(v.id)}>
                          บันทึก
                        </button>
                        {row.message.text && (
                          <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11 }} role="status">
                            {row.message.text}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}

// อ้างอิงอย่างเดียว (ไม่มี action) - ใช้แสดง "รถที่เพิ่งส่งตรวจ (รอผลตรวจ)" ใน Tab 1
// - ตาราง <table> จริงแบบเดียวกับ "รถจดใหม่ที่บันทึกแล้ว" ในหน้า entry
// (คอลัมน์จัดแนวกันเองโดยธรรมชาติของ <table>, ไม่มี action/input ต่อแถวจึงไม่มีปัญหาแถวกว้างเกินไป)
function ReferencePanel<T extends { id: string }>({
  title,
  columns,
  vehicles,
  loading,
  error,
  action,
}: {
  title: string;
  columns: Array<[string, (v: T) => string]>;
  vehicles: T[];
  loading: boolean;
  error: string;
  action?: ReactNode;
}) {
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <section className="panel customer-list" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>{title}</h2>
        {action}
      </div>
      {loading ? (
        <div className="empty-customers">กำลังโหลดรายการ…</div>
      ) : error ? (
        <div className="empty-customers" role="alert">
          {error}
        </div>
      ) : !vehicles.length ? (
        <div className="empty-customers">ไม่มีรายการ</div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.map(([label]) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr key={v.id}>
                    {columns.map(([label, getValue]) => (
                      <td key={label}>{getValue(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}

const PENDING_RESULT_COLUMNS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body || "—"],
  ["รอบตรวจ", roundLabel],
  ["ประเภทการส่งตรวจ", (v) => v.inspectionSentType || "—"],
  ["วันที่ส่งตรวจ", (v) => (v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "—")],
  ["ราคาตรวจรถ (No bill)", (v) => (v.inspectionSentCost ? `${v.inspectionSentCost} บาท` : "—")],
  ["ค่าตรวจรถ (Bill)", (v) => (v.inspectionSentBillCost ? `${v.inspectionSentBillCost} บาท` : "—")],
];

// แสดงเป็นตารางล่าง "รถที่รอผลตรวจ" ใน Tab 2 - โครงเดียวกับ panel "ตัดบัญชีแล้วล่าสุด" ของหน้าแจ้งย้าย/ตัดบัญชี
function CompletedInspectionPanel({
  vehicles,
  loading,
  error,
  onOpenDetail,
  onEditResult,
}: {
  vehicles: InspectionVehicle[];
  loading: boolean;
  error: string;
  onOpenDetail: (v: InspectionVehicle) => void;
  onEditResult: (v: InspectionVehicle) => void;
}) {
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <section className="panel customer-list">
      <div className="panel-head">
        <h2>รายการรถที่ตรวจเสร็จเรียบร้อย</h2>
      </div>
      {!loading && !error && <p style={{ padding: "0 24px 12px", fontSize: 12 }}>แสดง {vehicles.length} รายการล่าสุด</p>}
      {loading ? (
        <div className="empty-customers">กำลังโหลดรายการ…</div>
      ) : error ? (
        <div className="empty-customers" role="alert">
          {error}
        </div>
      ) : !vehicles.length ? (
        <div className="empty-customers">ยังไม่มีรายการที่ตรวจเสร็จ</div>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>ประเภทรถ</th>
                  <th>รอบตรวจ</th>
                  <th>ผลตรวจ</th>
                  <th>วันที่เสร็จ</th>
                  <th>ยื่นได้ถึง</th>
                  <th>ราคาตรวจรถ (No bill)</th>
                  <th>ค่าตรวจรถ (Bill)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((v) => (
                  <tr key={v.id} className={v.inspectionResult === "ไม่ผ่าน" ? "row-failed" : undefined}>
                    <td>{isoToDisplayDate(v.date) || v.date}</td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.body || "—"}</td>
                    <td>{roundLabel(v)}</td>
                    <td>{v.inspectionResult || "—"}</td>
                    <td>{v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}</td>
                    <td>
                      <SubmitDeadline vehicle={v} />
                    </td>
                    <td>{v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "—"}</td>
                    <td>{v.inspectionResultBillCost ? `${v.inspectionResultBillCost} บาท` : "—"}</td>
                    <td>
                      <button className="text-button" onClick={() => onOpenDetail(v)}>
                        ดูข้อมูล
                      </button>
                      {/* บันทึกผลตรวจผิด (เช่น ผ่าน ทั้งที่จริงไม่ผ่าน) แก้ได้ที่นี่ - ต้องระบุเหตุผลที่แก้ */}
                      <button className="text-button" onClick={() => onEditResult(v)}>
                        แก้ไขผลตรวจ
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}

export default function InspectionPage() {
  // แท็บเป็น URL ของตัวเอง (ผู้ใช้ 2026-09-25): /inspection = ตรวจรถ, /inspection/result = ตรวจรถเรียบร้อย / ตรวจไม่ผ่าน
  const activeTab: "send" | "result" = usePathname().endsWith("/result") ? "result" : "send";

  // Tab 1: ผ่าน Step 2 แล้ว แต่ยังไม่ได้ส่งตรวจ
  const [pendingSendVehicles, setPendingSendVehicles] = useState<InspectionVehicle[]>([]);
  const [sendRows, setSendRows] = useState<Record<string, SendRowState>>({});
  const [sendLoading, setSendLoading] = useState(true);
  const [sendError, setSendError] = useState("");
  const [sendBulkSaving, setSendBulkSaving] = useState(false);
  const [sendBulkMessage, setSendBulkMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [sendProvinceFilter, setSendProvinceFilter] = useState<ProvinceFilter>("all");
  const filteredSendVehicles = pendingSendVehicles.filter((v) => matchesProvinceFilter(v, sendProvinceFilter));
  const [sendSelectAllDateText, setSendSelectAllDateText] = useState("");

  // Tab 2: ส่งตรวจแล้ว รอผล
  const [pendingResultVehicles, setPendingResultVehicles] = useState<InspectionVehicle[]>([]);
  const [resultRows, setResultRows] = useState<Record<string, ResultRowState>>({});
  const [resultLoading, setResultLoading] = useState(true);
  const [resultError, setResultError] = useState("");
  const [resultBulkSaving, setResultBulkSaving] = useState(false);
  const [resultBulkMessage, setResultBulkMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // ทราบผลแล้ว - แสดงเป็นตารางล่าง "รถที่รอผลตรวจ" ใน Tab 2
  const [completedVehicles, setCompletedVehicles] = useState<InspectionVehicle[]>([]);
  const [completedLoading, setCompletedLoading] = useState(true);
  const [completedError, setCompletedError] = useState("");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<InspectionVehicle | null>(null);

  // แก้ไขผลตรวจที่บันทึกไปแล้ว (ต้องระบุเหตุผลที่แก้ - backend เก็บลงประวัติการแก้ไขของรถคันนั้น)
  const editDialogRef = useRef<HTMLDialogElement>(null);
  const [editResult, setEditResult] = useState<EditResultState | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editMessage, setEditMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // พิมพ์ใบรายการรถส่งตรวจ (PDF) - เฉพาะรถส่งตรวจนอกที่รอผล รถที่เอามาตรวจเองไม่ต้องพิมพ์
  const sentOutPendingVehicles = pendingResultVehicles.filter((v) => v.inspectionSentType !== "เอารถมาตรวจเอง");
  const printDialogRef = useRef<HTMLDialogElement>(null);
  const [printHeader, setPrintHeader] = useState(DEFAULT_INSPECTION_PRINT_HEADER);
  const [printSentDate, setPrintSentDate] = useState<string>("all");
  const printSentDates = [...new Set(sentOutPendingVehicles.map((v) => v.inspectionSentDate).filter((d): d is string => !!d))].sort(
    (a, b) => b.localeCompare(a),
  );
  const printVehicles =
    printSentDate === "all" ? sentOutPendingVehicles : sentOutPendingVehicles.filter((v) => v.inspectionSentDate === printSentDate);

  async function loadPendingSend() {
    setSendLoading(true);
    setSendError("");
    try {
      const data = await api.listPendingInspectionSend();
      setPendingSendVehicles(data.vehicles);
      setSendRows(Object.fromEntries(data.vehicles.map((v) => [v.id, toSendRowState()])));
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setPendingSendVehicles([]);
      setSendRows({});
    } finally {
      setSendLoading(false);
    }
  }

  async function loadPendingResult() {
    setResultLoading(true);
    setResultError("");
    try {
      const data = await api.listPendingInspectionResult();
      setPendingResultVehicles(data.vehicles);
      setResultRows(Object.fromEntries(data.vehicles.map((v) => [v.id, toResultRowState()])));
    } catch (err) {
      setResultError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setPendingResultVehicles([]);
      setResultRows({});
    } finally {
      setResultLoading(false);
    }
  }

  async function loadCompleted() {
    setCompletedLoading(true);
    setCompletedError("");
    try {
      const data = await api.listRecentlyCompletedInspection();
      setCompletedVehicles(data.vehicles);
    } catch (err) {
      setCompletedError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setCompletedVehicles([]);
    } finally {
      setCompletedLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; load*() set their own loading flag before the first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPendingSend();
    loadPendingResult();
    loadCompleted();
  }, []);

  function patchSendRow(id: string, patch: Partial<SendRowState>) {
    setSendRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function patchResultRow(id: string, patch: Partial<ResultRowState>) {
    setResultRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function handleSendCheck(id: string, type: SentType, checked: boolean) {
    const row = sendRows[id];
    if (!row) return;
    const vehicle = pendingSendVehicles.find((v) => v.id === id);
    patchSendRow(id, {
      selectedType: checked ? type : null,
      // Default = วันถัดไปของวันที่รับงาน (ไม่ใช่วันนี้) - งานส่งตรวจปกติจะทำวันรุ่งขึ้น
      dateText: checked && !row.dateText && vehicle ? isoToDisplayDate(defaultSendDateIso(vehicle)) : row.dateText,
      // เอาติ๊กออก = เอาราคาออกด้วย (ช่องราคาจะถูก disable ต่อเมื่อไม่ได้ติ๊กอยู่แล้ว)
      costText: checked ? costForSentType(type, vehicle?.suggestedCost ?? null) : "",
      // ค่าตรวจรถ (Bill) เฉพาะรอบ 2 - backend ส่ง suggestedBillCost = null มาสำหรับรอบ 1
      billCostText: checked ? (vehicle?.suggestedBillCost ?? "") : "",
    });
  }

  function handleSelectAllSend(type: SentType, checked: boolean) {
    // ถ้ากรอกวันที่ในช่อง "เลือกทั้งหมด" ไว้ ใช้ค่านั้นกับทุกแถวเลย (เขียนทับของเดิม) -
    // ถ้าไม่กรอก แต่ละคันจะได้วันถัดไปของวันที่รับงานตัวเอง
    setSendRows((prev) => {
      const next = { ...prev };
      for (const v of filteredSendVehicles) {
        const row = next[v.id];
        if (!row) continue;
        if (checked) {
          next[v.id] = {
            ...row,
            selectedType: type,
            dateText: sendSelectAllDateText || isoToDisplayDate(defaultSendDateIso(v)),
            costText: costForSentType(type, v.suggestedCost),
            billCostText: v.suggestedBillCost ?? "",
          };
        } else if (row.selectedType === type) {
          next[v.id] = { ...row, selectedType: null, costText: "", billCostText: "" };
        }
      }
      return next;
    });
  }

  async function handleSaveSend(id: string) {
    const row = sendRows[id];
    if (!row || !row.selectedType) return;
    let dateIso: string;
    try {
      ({ dateIso } = validateSendRow(row));
    } catch (err) {
      patchSendRow(id, { message: { text: (err as Error).message, error: true } });
      return;
    }

    patchSendRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateInspectionSent(id, {
        sentType: row.selectedType,
        sentDate: dateIso || null,
      });
      await Promise.all([loadPendingSend(), loadPendingResult()]);
    } catch (err) {
      patchSendRow(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  async function handleSaveAllSend() {
    const selected = filteredSendVehicles.filter((v) => sendRows[v.id]?.selectedType);
    if (!selected.length) return;

    const parsed: Array<{ id: string; chassis: string; type: SentType; dateIso: string }> = [];
    for (const v of selected) {
      const row = sendRows[v.id];
      if (!row || !row.selectedType) continue;
      try {
        const { dateIso } = validateSendRow(row);
        parsed.push({ id: v.id, chassis: v.chassis, type: row.selectedType, dateIso });
      } catch (err) {
        setSendBulkMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setSendBulkSaving(true);
    setSendBulkMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) =>
          api.updateInspectionSent(p.id, {
            sentType: p.type,
            sentDate: p.dateIso || null,
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      setSendBulkMessage(
        failed
          ? { text: `บันทึกสำเร็จ ${parsed.length - failed} จาก ${parsed.length} รายการ · ล้มเหลว ${failed} รายการ`, error: true }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      await Promise.all([loadPendingSend(), loadPendingResult()]);
    } finally {
      setSendBulkSaving(false);
    }
  }

  // ผ่าน/ไม่ผ่าน เป็น field เดียวต่อแถว - ติ๊กอันหนึ่งจะยกเลิกอีกอันให้อัตโนมัติ
  function handleResultCheck(id: string, result: ResultType, checked: boolean) {
    const row = resultRows[id];
    const vehicle = pendingResultVehicles.find((v) => v.id === id);
    if (!row || !vehicle) return;
    patchResultRow(id, {
      selectedResult: checked ? result : null,
      // Default = วันที่ส่งตรวจ (ไม่ใช่วันนี้) - ทราบผลควรอ้างอิงวันที่ส่งไป
      dateText:
        checked && !row.dateText
          ? isoToDisplayDate(vehicle.inspectionSentDate ?? todayIso())
          : row.dateText,
      // เอาติ๊กออก = เอาราคาออกด้วย - ติ๊กให้ใช้ราคาตอนส่งตรวจ/ราคาแนะนำ, ตรวจไม่ผ่าน = 0 เสมอ (ได้เงินคืน)
      costText: checked ? resultDefaultCost(vehicle, result) : "",
    });
  }

  function handleSelectAllResult(panelResult: ResultType, checked: boolean) {
    setResultRows((prev) => {
      const next = { ...prev };
      for (const v of pendingResultVehicles) {
        const row = next[v.id];
        if (!row) continue;
        if (checked) {
          next[v.id] = {
            ...row,
            selectedResult: panelResult,
            // Default = วันที่ส่งตรวจ (ไม่ใช่วันนี้) - ทราบผลควรอ้างอิงวันที่ส่งไป
            dateText: row.dateText || (v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : isoToDisplayDate(todayIso())),
            costText: resultDefaultCost(v, panelResult),
          };
        } else if (row.selectedResult === panelResult) {
          next[v.id] = { ...row, selectedResult: null, costText: "" };
        }
      }
      return next;
    });
  }

  async function handleSaveResult(id: string) {
    const row = resultRows[id];
    if (!row || !row.selectedResult) return;
    let dateIso: string;
    try {
      ({ dateIso } = validateResultRow(row, row.selectedResult));
    } catch (err) {
      patchResultRow(id, { message: { text: (err as Error).message, error: true } });
      return;
    }

    patchResultRow(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateInspectionResult(id, {
        result: row.selectedResult,
        resultDate: dateIso || null,
        remark: row.selectedResult === "ไม่ผ่าน" ? row.remarkText : null,
      });
      // ตรวจไม่ผ่านกลับเข้าคิวส่งตรวจ จึงโหลดรายการรอส่งตรวจใหม่ด้วย
      await Promise.all([loadPendingSend(), loadPendingResult(), loadCompleted()]);
    } catch (err) {
      patchResultRow(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  async function handleSaveAllResult() {
    const selected = pendingResultVehicles.filter((v) => resultRows[v.id]?.selectedResult);
    if (!selected.length) return;

    const parsed: Array<{ id: string; result: ResultType; dateIso: string; remark: string }> = [];
    for (const v of selected) {
      const row = resultRows[v.id];
      if (!row?.selectedResult) continue;
      try {
        const { dateIso } = validateResultRow(row, row.selectedResult);
        parsed.push({ id: v.id, result: row.selectedResult, dateIso, remark: row.remarkText });
      } catch (err) {
        setResultBulkMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setResultBulkSaving(true);
    setResultBulkMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) =>
          api.updateInspectionResult(p.id, {
            result: p.result,
            resultDate: p.dateIso || null,
            remark: p.result === "ไม่ผ่าน" ? p.remark : null,
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      setResultBulkMessage(
        failed
          ? { text: `บันทึกสำเร็จ ${parsed.length - failed} จาก ${parsed.length} รายการ · ล้มเหลว ${failed} รายการ`, error: true }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      // ตรวจไม่ผ่านกลับเข้าคิวส่งตรวจ จึงโหลดรายการรอส่งตรวจใหม่ด้วย
      await Promise.all([loadPendingSend(), loadPendingResult(), loadCompleted()]);
    } finally {
      setResultBulkSaving(false);
    }
  }

  function openDetail(vehicle: InspectionVehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
  }

  function openEditResult(vehicle: InspectionVehicle) {
    setEditResult({
      vehicle,
      result: vehicle.inspectionResult === "ไม่ผ่าน" ? "ไม่ผ่าน" : "ผ่าน",
      dateText: vehicle.inspectionResultDate ? isoToDisplayDate(vehicle.inspectionResultDate) : "",
      failRemarkText: vehicle.inspectionFailRemark ?? "",
      remarkText: "",
    });
    setEditMessage({ text: "" });
    editDialogRef.current?.showModal();
  }

  function patchEditResult(patch: Partial<EditResultState>) {
    setEditResult((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function handleSaveEditResult() {
    if (!editResult) return;
    const digits = editResult.dateText.replace(/\D/g, "");
    const dateIso = digits ? displayDateToIso(digits) : "";
    if (!dateIso) {
      setEditMessage({ text: "วันที่ไม่ถูกต้อง", error: true });
      return;
    }
    if (editResult.result === "ไม่ผ่าน" && !editResult.failRemarkText.trim()) {
      setEditMessage({ text: "กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน", error: true });
      return;
    }
    if (!editResult.remarkText.trim()) {
      setEditMessage({ text: "กรุณาระบุเหตุผลที่แก้ไขผลตรวจ", error: true });
      return;
    }

    setEditSaving(true);
    setEditMessage({ text: "กำลังบันทึก…" });
    try {
      await api.correctInspectionResult(editResult.vehicle.id, {
        result: editResult.result,
        resultDate: dateIso,
        failRemark: editResult.result === "ไม่ผ่าน" ? editResult.failRemarkText.trim() : null,
        remark: editResult.remarkText.trim(),
      });
      editDialogRef.current?.close();
      setEditResult(null);
      // แก้เป็นไม่ผ่านแล้วรถกลับเข้าคิวส่งตรวจ จึงโหลดใหม่ทุกลิสต์
      await Promise.all([loadPendingSend(), loadPendingResult(), loadCompleted()]);
    } catch (err) {
      setEditMessage({ text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setEditSaving(false);
    }
  }

  function openPrintDialog() {
    setPrintHeader(loadPrintHeader());
    // ค่าเริ่มต้น = วันที่ส่งตรวจล่าสุด (รายการที่เพิ่งส่งไป) - เลือก "ทั้งหมด" ได้
    setPrintSentDate(printSentDates[0] ?? "all");
    printDialogRef.current?.showModal();
  }

  function handlePrint() {
    const header = printHeader.trim() || DEFAULT_INSPECTION_PRINT_HEADER;
    savePrintHeader(header);
    const dateLabel = printSentDate === "all" ? "" : isoToDisplayDate(printSentDate);
    printInspectionSheet({
      title: `ใบรายการส่งตรวจรถ${dateLabel ? ` ${dateLabel.replace(/\//g, "-")}` : ""}`,
      header,
      subtitle: dateLabel ? `วันที่ส่งตรวจ ${dateLabel}` : "",
      vehicles: printVehicles,
    });
    printDialogRef.current?.close();
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ตรวจรถ</h1>

      <PageTabs
        label="ขั้นตอนตรวจรถ"
        tabs={[
          { href: INSPECTION_HREF, label: "1. ตรวจรถ", selected: activeTab === "send" },
          { href: `${INSPECTION_HREF}/result`, label: "2. ตรวจรถเรียบร้อย / ตรวจไม่ผ่าน", selected: activeTab === "result" },
        ]}
      />

      {activeTab === "send" ? (
        <>
          {sendLoading ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers">กำลังโหลดรายการ…</div>
            </div>
          ) : sendError ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers" role="alert">
                {sendError}
              </div>
            </div>
          ) : (
            <SendPanel
              vehicles={filteredSendVehicles}
              rows={sendRows}
              patchRow={patchSendRow}
              onCheck={handleSendCheck}
              onSelectAll={handleSelectAllSend}
              onSave={handleSaveSend}
              onSaveAll={handleSaveAllSend}
              bulkSaving={sendBulkSaving}
              bulkMessage={sendBulkMessage}
              provinceFilter={sendProvinceFilter}
              onProvinceFilterChange={setSendProvinceFilter}
              selectAllDateText={sendSelectAllDateText}
              onSelectAllDateTextChange={setSendSelectAllDateText}
            />
          )}

          <ReferencePanel
            title="รถที่เพิ่งส่งตรวจ (รอผลตรวจ)"
            columns={PENDING_RESULT_COLUMNS}
            vehicles={pendingResultVehicles}
            loading={resultLoading}
            error={resultError}
            action={
              <button className="primary" disabled={resultLoading || !sentOutPendingVehicles.length} onClick={openPrintDialog}>
                พิมพ์รายการส่งตรวจ (PDF)
              </button>
            }
          />
        </>
      ) : (
        <>
          {resultLoading ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers">กำลังโหลดรายการ…</div>
            </div>
          ) : resultError ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers" role="alert">
                {resultError}
              </div>
            </div>
          ) : (
            <ResultPanel
              vehicles={pendingResultVehicles}
              rows={resultRows}
              patchRow={patchResultRow}
              onCheck={handleResultCheck}
              onSelectAll={handleSelectAllResult}
              onSave={handleSaveResult}
              onSaveAll={handleSaveAllResult}
              bulkSaving={resultBulkSaving}
              bulkMessage={resultBulkMessage}
            />
          )}

          <CompletedInspectionPanel
            vehicles={completedVehicles}
            loading={completedLoading}
            error={completedError}
            onOpenDetail={openDetail}
            onEditResult={openEditResult}
          />
        </>
      )}

      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        {detail && (
          <>
            <h2>รายการที่ตรวจเสร็จ</h2>
            <dl className="customer-detail">
              {COMPLETED_DETAIL_FIELDS.map(([label, getValue]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{getValue(detail) || "—"}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </dialog>

      {/* แก้ไขผลตรวจที่บันทึกไปแล้ว - ค่าใช้จ่ายคงที่ตามผลตรวจใหม่ (ไม่ผ่าน = 0 ได้เงินคืน) แก้จากหน้าจอไม่ได้ */}
      <dialog
        ref={editDialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) editDialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => editDialogRef.current?.close()}>
          ×
        </button>
        {editResult && (
          <>
            <h2>แก้ไขผลตรวจ</h2>
            <p className="muted" style={{ marginTop: -8, fontSize: 13 }}>
              {editResult.vehicle.chassis} · {editResult.vehicle.customerName} · {editResult.vehicle.brandName} · {roundLabel(editResult.vehicle)}
            </p>
            <div style={{ display: "grid", gap: 16 }}>
              <div className="inspect-row-checks">
                <label>
                  <input
                    type="checkbox"
                    checked={editResult.result === "ผ่าน"}
                    onChange={() => patchEditResult({ result: "ผ่าน" })}
                  />
                  ผ่าน
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={editResult.result === "ไม่ผ่าน"}
                    onChange={() => patchEditResult({ result: "ไม่ผ่าน" })}
                  />
                  ไม่ผ่าน
                </label>
              </div>
              <label className="field">
                วันที่ทราบผล
                <DateInput
                  value={editResult.dateText}
                  onChange={(value) => patchEditResult({ dateText: formatDateDigits(value.replace(/\D/g, "").slice(0, 8)) })}
                />
              </label>
              {editResult.result === "ไม่ผ่าน" && (
                <label className="field">
                  Remark (เหตุผลที่ตรวจไม่ผ่าน)
                  <input
                    type="text"
                    placeholder="เช่น เลขตัวรถผิด"
                    value={editResult.failRemarkText}
                    onChange={(e) => patchEditResult({ failRemarkText: e.target.value })}
                  />
                </label>
              )}
              <label className="field">
                เหตุผลที่แก้ไข (บังคับ)
                <input
                  type="text"
                  placeholder="เช่น บันทึกผลตรวจผิด"
                  value={editResult.remarkText}
                  onChange={(e) => patchEditResult({ remarkText: e.target.value })}
                />
              </label>
              <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                ราคาตรวจรถ (No bill) {bahtText(resultDefaultCost(editResult.vehicle, editResult.result))} · ค่าตรวจรถ (Bill){" "}
                {bahtText(resultDefaultBillCost(editResult.vehicle, editResult.result))}
                {editResult.result === "ไม่ผ่าน" && " — รถจะกลับเข้าคิวส่งตรวจใหม่"}
              </p>
              {editMessage.text && (
                <div className={`customer-message${editMessage.error ? " error" : " success"}`} role="status">
                  {editMessage.text}
                </div>
              )}
              <button className="primary" style={{ justifySelf: "end" }} disabled={editSaving} onClick={handleSaveEditResult}>
                บันทึกการแก้ไข
              </button>
            </div>
          </>
        )}
      </dialog>

      <dialog
        ref={printDialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) printDialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => printDialogRef.current?.close()}>
          ×
        </button>
        <h2>พิมพ์รายการส่งตรวจรถ</h2>
        <div style={{ display: "grid", gap: 16 }}>
          <label className="field">
            หัวกระดาษ
            <input type="text" value={printHeader} onChange={(e) => setPrintHeader(e.target.value)} />
          </label>
          <button
            type="button"
            className="text-button"
            style={{ justifySelf: "start", marginTop: -8 }}
            disabled={printHeader === DEFAULT_INSPECTION_PRINT_HEADER}
            onClick={() => setPrintHeader(DEFAULT_INSPECTION_PRINT_HEADER)}
          >
            ใช้ค่าเริ่มต้น
          </button>
          <label className="field">
            วันที่ส่งตรวจ
            <select value={printSentDate} onChange={(e) => setPrintSentDate(e.target.value)}>
              {printSentDates.map((d) => (
                <option key={d} value={d}>
                  {isoToDisplayDate(d)} ({sentOutPendingVehicles.filter((v) => v.inspectionSentDate === d).length} คัน)
                </option>
              ))}
              <option value="all">ทั้งหมด ({sentOutPendingVehicles.length} คัน)</option>
            </select>
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            พิมพ์เฉพาะรถส่งตรวจนอก (ไม่รวมรถที่นำมาตรวจเอง) · คอลัมน์: ลำดับที่ · ประเภทรถ · ยี่ห้อ · เลขตัวถัง · เลขเครื่อง · สี — เลือก &quot;บันทึกเป็น PDF&quot; ในหน้าต่างพิมพ์
          </p>
          <button className="primary" style={{ justifySelf: "end" }} disabled={!printVehicles.length} onClick={handlePrint}>
            พิมพ์ {printVehicles.length} คัน
          </button>
        </div>
      </dialog>
    </section>
  );
}
