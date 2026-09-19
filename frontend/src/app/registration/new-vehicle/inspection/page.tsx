"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type InspectionVehicle } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { DEFAULT_INSPECTION_PRINT_HEADER, printInspectionSheet } from "@/lib/inspection-print";

// หัวกระดาษที่แก้ไขล่าสุดจำไว้ในเบราว์เซอร์นี้ - ถ้าอ่านไม่ได้ใช้ค่าเริ่มต้น
const PRINT_HEADER_STORAGE_KEY = "inspection-print-header";

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

// ลำดับข้อมูลหลักที่ใช้ร่วมกันทุกแถวในหน้านี้ อยู่บรรทัดเดียว: วันที่ - เลขตัวถัง - ยี่ห้อ - ประเภทรถ - เจ้าของงาน
function rowInfoLine(v: { date: string; chassis: string; brandName: string; body: string | null; customerName: string }): string {
  return `${isoToDisplayDate(v.date) || v.date} · ${v.chassis} · ${v.brandName} · ${v.body || "—"} · ${v.customerName}`;
}

// หมายเหตุตามระบบในคิวส่งตรวจ: ถึงกำหนดตรวจรอบ 2 หรือตรวจไม่ผ่านต้องส่งตรวจใหม่ - ว่าง = ส่งตรวจครั้งแรก
function sendQueueNote(v: InspectionVehicle): string {
  if (v.round2Due) {
    return `ครบ 90 วันหลังผ่านตรวจรอบ 1 (${v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}) — ตรวจรอบ 2`;
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

function usePagedList<T>(items: T[]): { pageItems: T[]; page: number; setPage: (p: number) => void; totalPages: number } {
  const [page, setPage] = useState(0);
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
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ราคาตรวจรถ (No bill) ต้องเป็นตัวเลขตั้งแต่ 0");
  if (row.billCostText && !/^d+(.d+)?$/.test(row.billCostText)) throw new Error("ค่าตรวจรถ (Bill) ต้องเป็นตัวเลขตั้งแต่ 0");
  return { dateIso };
}

function validateResultRow(row: ResultRowState, panelResult: ResultType): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0");
  if (panelResult === "ไม่ผ่าน" && !row.remarkText.trim()) throw new Error("กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน");
  return { dateIso };
}

// ตรวจไม่ผ่าน = ไม่มีค่าใช้จ่ายตรวจ (ได้เงินคืน) - backend บังคับเป็น 0 ซ้ำอีกชั้น
function resultDefaultCost(v: InspectionVehicle, panelResult: ResultType): string {
  if (panelResult === "ไม่ผ่าน") return "0";
  return v.inspectionSentCost || v.suggestedCost || "";
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
  ["ค่าใช้จ่าย (ผลตรวจ)", (v) => (v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "")],
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
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="วว/ดด/ปปปป"
                  value={selectAllDateText}
                  onChange={(e) => onSelectAllDateTextChange(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
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
          <div className="inspect-row-header">
            <div className="inspect-row-body">วันที่ · เลขตัวถัง · ยี่ห้อ · ประเภทรถ · เจ้าของงาน · จังหวัดที่จดทะเบียน</div>
            <div className="inspect-row-controls inspect-row-controls--send">
              <div>ประเภทการส่งตรวจ</div>
              <div>วันที่</div>
              <div>ราคาตรวจรถ (No bill)</div>
              <div>ค่าตรวจรถ (Bill)</div>
              <div />
            </div>
          </div>
          <div className="inspect-rows">
            {pageItems.map((v) => {
              const row = rows[v.id];
              if (!row) return null;
              return (
                <div className="inspect-row" key={v.id}>
                  <div className="inspect-row-body">
                    <div className="inspect-row-title">
                      {rowInfoLine(v)} <span>· {v.registrationProvince || "—"}</span>
                    </div>
                    {sendQueueNote(v) && (
                      <div className="customer-message error" style={{ fontSize: 11, marginTop: 6 }}>
                        หมายเหตุ: {sendQueueNote(v)}
                      </div>
                    )}
                    {row.message.text && (
                      <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11, marginTop: 6 }} role="status">
                        {row.message.text}
                      </div>
                    )}
                  </div>
                  <div className="inspect-row-controls inspect-row-controls--send">
                    <div className="inspect-row-checks">
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
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="วันที่"
                      placeholder="วว/ดด/ปปปป"
                      value={row.dateText}
                      onChange={(e) =>
                        patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      step="any"
                      aria-label="ราคาตรวจรถ (No bill)"
                      value={row.costText}
                      disabled={!row.selectedType}
                      onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                    />
                    {/* ค่าตรวจรถ (Bill) มีเฉพาะรอบ 2 - รอบ 1 ปิดช่องไว้ */}
                    <input
                      type="number"
                      min={0}
                      step="any"
                      aria-label="ค่าตรวจรถ (Bill)"
                      placeholder={v.suggestedBillCost == null ? "—" : ""}
                      value={row.billCostText}
                      disabled={!row.selectedType || v.suggestedBillCost == null}
                      onChange={(e) => patchRow(v.id, { billCostText: e.target.value })}
                    />
                    <button
                      className="text-button"
                      disabled={!row.selectedType || row.saving || bulkSaving}
                      onClick={() => onSave(v.id)}
                    >
                      บันทึก
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}

// Tab 2 - ผลตรวจ: ตรวจรถเรียบร้อย/ตรวจไม่ผ่าน แบ่งเป็น 2 panel ที่อ่าน pool เดียวกัน (pendingResultVehicles)
// showRemark = true เฉพาะ panel "ตรวจไม่ผ่าน" - บังคับกรอกก่อนบันทึกได้
function ResultPanel({
  title,
  panelResult,
  showRemark,
  vehicles,
  rows,
  patchRow,
  onSelectAll,
  onSave,
  onSaveAll,
  bulkSaving,
  bulkMessage,
}: {
  title: string;
  panelResult: ResultType;
  showRemark: boolean;
  vehicles: InspectionVehicle[];
  rows: Record<string, ResultRowState>;
  patchRow: (id: string, patch: Partial<ResultRowState>) => void;
  onSelectAll: (checked: boolean) => void;
  onSave: (id: string) => void;
  onSaveAll: () => void;
  bulkSaving: boolean;
  bulkMessage: { text: string; error?: boolean };
}) {
  const selectedCount = vehicles.filter((v) => rows[v.id]?.selectedResult === panelResult).length;
  const allSelected = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selectedResult === panelResult);
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>{title}</h2>
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
          <label className="inspect-select-all">
            <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
            เลือกทั้งหมดเป็น {panelResult} ({vehicles.length} คัน)
          </label>
          <div className="inspect-row-header">
            <div className="inspect-row-body">วันที่ · เลขตัวถัง · ยี่ห้อ · ประเภทรถ · เจ้าของงาน · ประเภทการส่งตรวจ</div>
            <div className={`inspect-row-controls inspect-row-controls--${showRemark ? "result-remark" : "result"}`}>
              <div>{panelResult}</div>
              <div>วันที่</div>
              <div>ค่าใช้จ่าย</div>
              {showRemark && <div>Remark</div>}
              <div />
            </div>
          </div>
          <div className="inspect-rows">
            {pageItems.map((v) => {
              const row = rows[v.id];
              if (!row) return null;
              const checked = row.selectedResult === panelResult;
              return (
                <div className="inspect-row" key={v.id}>
                  <div className="inspect-row-body">
                    <div className="inspect-row-title">
                      {rowInfoLine(v)} <span>· {roundLabel(v)} · ส่งตรวจแบบ {v.inspectionSentType || "—"}</span>
                    </div>
                    {row.message.text && (
                      <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11, marginTop: 6 }} role="status">
                        {row.message.text}
                      </div>
                    )}
                  </div>
                  <div className={`inspect-row-controls inspect-row-controls--${showRemark ? "result-remark" : "result"}`}>
                    <div className="inspect-row-checks">
                      <label>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            const isChecked = e.target.checked;
                            patchRow(v.id, {
                              selectedResult: isChecked ? panelResult : null,
                              // Default = วันที่ส่งตรวจ (ไม่ใช่วันนี้) - ทราบผลควรอ้างอิงวันที่ส่งไป
                              dateText:
                                isChecked && !row.dateText
                                  ? v.inspectionSentDate
                                    ? isoToDisplayDate(v.inspectionSentDate)
                                    : isoToDisplayDate(todayIso())
                                  : row.dateText,
                              // เอาติ๊กออก = เอาราคาออกด้วย - ติ๊กให้ใช้ราคาตอนส่งตรวจ/ราคาแนะนำ
                              // ตรวจไม่ผ่าน = ไม่มีค่าใช้จ่าย (ได้เงินคืน) จึงเป็น 0 เสมอ
                              costText: isChecked ? resultDefaultCost(v, panelResult) : "",
                            });
                          }}
                        />
                        {panelResult}
                      </label>
                    </div>
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label="วันที่"
                      placeholder="วว/ดด/ปปปป"
                      value={row.dateText}
                      onChange={(e) =>
                        patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                      }
                    />
                    <input
                      type="number"
                      min={0}
                      step="any"
                      aria-label="ค่าใช้จ่าย"
                      value={row.costText}
                      disabled={!checked || panelResult === "ไม่ผ่าน"}
                      onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                    />
                    {showRemark && (
                      <input
                        type="text"
                        aria-label="Remark"
                        placeholder="เหตุผลที่ตรวจไม่ผ่าน"
                        value={row.remarkText}
                        onChange={(e) => patchRow(v.id, { remarkText: e.target.value })}
                      />
                    )}
                    <button className="text-button" disabled={!checked || row.saving || bulkSaving} onClick={() => onSave(v.id)}>
                      บันทึก
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}

// อ้างอิงอย่างเดียว (ไม่มี action) - ใช้แสดง "รถที่ยังไม่ได้ส่งตรวจ" ใน Tab 2, "รถที่เพิ่งส่งตรวจ" ใน Tab 1,
// และ "รถที่เพิ่งส่งตรวจ (รอผลตรวจ)" รอบ 2 ใน Tab 4 - ตาราง <table> จริงแบบเดียวกับ "รถจดใหม่ที่บันทึกแล้ว" ในหน้า entry
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

const PENDING_SEND_COLUMNS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body || "—"],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince || "—"],
  ["หมายเหตุ", (v) => sendQueueNote(v) || "—"],
];

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

// ใช้ร่วมกันท้าย Tab 1 และ Tab 2 - โครงเดียวกับ panel "ตัดบัญชีแล้วล่าสุด" ของหน้าแจ้งย้าย/ตัดบัญชี
function CompletedInspectionPanel({
  vehicles,
  loading,
  error,
  onOpenDetail,
}: {
  vehicles: InspectionVehicle[];
  loading: boolean;
  error: string;
  onOpenDetail: (v: InspectionVehicle) => void;
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
                  <th>ค่าใช้จ่าย</th>
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
                    <td>{v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "—"}</td>
                    <td>
                      <button className="text-button" onClick={() => onOpenDetail(v)}>
                        ดูข้อมูล
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
  const [activeTab, setActiveTab] = useState<"send" | "result" | "completed">("send");

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
  const [passSaving, setPassSaving] = useState(false);
  const [passMessage, setPassMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [failSaving, setFailSaving] = useState(false);
  const [failMessage, setFailMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  // ทราบผลแล้ว - แสดงท้ายทั้ง 2 tab
  const [completedVehicles, setCompletedVehicles] = useState<InspectionVehicle[]>([]);
  const [completedLoading, setCompletedLoading] = useState(true);
  const [completedError, setCompletedError] = useState("");

  // Tab 4: ผ่านตรวจครั้งแรกแล้ว ครบ 90 วัน ต้องตรวจรอบ 2

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<InspectionVehicle | null>(null);

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
        cost: row.costText || null,
        billCost: row.billCostText || null,
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

    const parsed: Array<{ id: string; chassis: string; type: SentType; dateIso: string; cost: string; billCost: string }> = [];
    for (const v of selected) {
      const row = sendRows[v.id];
      if (!row || !row.selectedType) continue;
      try {
        const { dateIso } = validateSendRow(row);
        parsed.push({ id: v.id, chassis: v.chassis, type: row.selectedType, dateIso, cost: row.costText, billCost: row.billCostText });
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
            cost: p.cost || null,
            billCost: p.billCost || null,
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
            // คงราคาที่แก้ไว้ถ้าแถวอยู่ panel นี้อยู่แล้ว (ยกเว้นตรวจไม่ผ่าน ที่เป็น 0 เสมอ)
            costText:
              row.selectedResult === panelResult && panelResult !== "ไม่ผ่าน" ? row.costText : resultDefaultCost(v, panelResult),
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
        cost: row.costText || null,
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

  async function handleSaveAllResult(
    panelResult: ResultType,
    setSaving: (v: boolean) => void,
    setMessage: (m: { text: string; error?: boolean }) => void,
  ) {
    const selected = pendingResultVehicles.filter((v) => resultRows[v.id]?.selectedResult === panelResult);
    if (!selected.length) return;

    const parsed: Array<{ id: string; dateIso: string; cost: string; remark: string }> = [];
    for (const v of selected) {
      const row = resultRows[v.id];
      if (!row) continue;
      try {
        const { dateIso } = validateResultRow(row, panelResult);
        parsed.push({ id: v.id, dateIso, cost: row.costText, remark: row.remarkText });
      } catch (err) {
        setMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setSaving(true);
    setMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) =>
          api.updateInspectionResult(p.id, {
            result: panelResult,
            resultDate: p.dateIso || null,
            cost: p.cost || null,
            remark: panelResult === "ไม่ผ่าน" ? p.remark : null,
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      setMessage(
        failed
          ? { text: `บันทึกสำเร็จ ${parsed.length - failed} จาก ${parsed.length} รายการ · ล้มเหลว ${failed} รายการ`, error: true }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      await Promise.all([loadPendingSend(), loadPendingResult(), loadCompleted()]);
    } finally {
      setSaving(false);
    }
  }

  function openDetail(vehicle: InspectionVehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
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

      <div className="vehicle-tabs" role="tablist" aria-label="ขั้นตอนตรวจรถ">
        <button
          className={`vehicle-tab${activeTab === "send" ? " selected" : ""}`}
          role="tab"
          aria-selected={activeTab === "send"}
          onClick={() => setActiveTab("send")}
        >
          1. ตรวจรถ
        </button>
        <button
          className={`vehicle-tab${activeTab === "result" ? " selected" : ""}`}
          role="tab"
          aria-selected={activeTab === "result"}
          onClick={() => setActiveTab("result")}
        >
          2. ตรวจรถเรียบร้อย / ตรวจไม่ผ่าน
        </button>
        <button
          className={`vehicle-tab${activeTab === "completed" ? " selected" : ""}`}
          role="tab"
          aria-selected={activeTab === "completed"}
          onClick={() => setActiveTab("completed")}
        >
          3. รายการที่ตรวจเสร็จล่าสุด
        </button>
      </div>

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
      ) : activeTab === "result" ? (
        <>
          <ReferencePanel
            title="รถที่ยังไม่ได้ส่งตรวจ"
            columns={PENDING_SEND_COLUMNS}
            vehicles={pendingSendVehicles}
            loading={sendLoading}
            error={sendError}
          />

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
            <div className="inspect-grid">
              <ResultPanel
                title="ตรวจรถเรียบร้อย"
                panelResult="ผ่าน"
                showRemark={false}
                vehicles={pendingResultVehicles}
                rows={resultRows}
                patchRow={patchResultRow}
                onSelectAll={(checked) => handleSelectAllResult("ผ่าน", checked)}
                onSave={handleSaveResult}
                onSaveAll={() => handleSaveAllResult("ผ่าน", setPassSaving, setPassMessage)}
                bulkSaving={passSaving}
                bulkMessage={passMessage}
              />
              <ResultPanel
                title="ตรวจไม่ผ่าน"
                panelResult="ไม่ผ่าน"
                showRemark
                vehicles={pendingResultVehicles}
                rows={resultRows}
                patchRow={patchResultRow}
                onSelectAll={(checked) => handleSelectAllResult("ไม่ผ่าน", checked)}
                onSave={handleSaveResult}
                onSaveAll={() => handleSaveAllResult("ไม่ผ่าน", setFailSaving, setFailMessage)}
                bulkSaving={failSaving}
                bulkMessage={failMessage}
              />
            </div>
          )}
        </>
      ) : (
        <CompletedInspectionPanel vehicles={completedVehicles} loading={completedLoading} error={completedError} onOpenDetail={openDetail} />
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
