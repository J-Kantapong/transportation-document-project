"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type InspectionVehicle, type Round2Vehicle } from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

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
  costText: string;
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

interface Round2RowState {
  selected: boolean;
  dateText: string;
  costText: string;
  saving: boolean;
  message: { text: string; error?: boolean };
}

function toSendRowState(): SendRowState {
  return {
    selectedType: null,
    dateText: "",
    costText: "",
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

// ลำดับข้อมูลหลักที่ใช้ร่วมกันทุกแถวในหน้านี้ อยู่บรรทัดเดียว: วันที่ - เลขตัวถัง - ยี่ห้อ - ประเภทรถ - เจ้าของงาน
function rowInfoLine(v: { date: string; chassis: string; brandName: string; body: string | null; customerName: string }): string {
  return `${isoToDisplayDate(v.date) || v.date} · ${v.chassis} · ${v.brandName} · ${v.body || "—"} · ${v.customerName}`;
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

function toResultRowState(vehicle: InspectionVehicle): ResultRowState {
  return {
    selectedResult: null,
    dateText: "",
    costText: vehicle.inspectionSentCost ?? vehicle.suggestedCost ?? "",
    remarkText: "",
    saving: false,
    message: { text: "" },
  };
}

function toRound2RowState(): Round2RowState {
  return { selected: false, dateText: "", costText: "", saving: false, message: { text: "" } };
}

function validateSendRow(row: SendRowState): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0");
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

function validateRound2Row(row: Round2RowState): { dateIso: string } {
  const digits = row.dateText.replace(/\D/g, "");
  const dateIso = digits ? displayDateToIso(digits) : "";
  if (digits && !dateIso) throw new Error("วันที่ไม่ถูกต้อง");
  if (row.costText && !/^\d+(\.\d+)?$/.test(row.costText)) throw new Error("ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0");
  return { dateIso };
}

const COMPLETED_DETAIL_FIELDS: Array<[string, (v: InspectionVehicle) => string]> = [
  ["วันที่รับงาน", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
  ["ประเภทการตรวจ", (v) => v.inspectionSentType ?? ""],
  ["วันที่ส่งตรวจ", (v) => (v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "")],
  ["ค่าใช้จ่าย (ส่งตรวจ)", (v) => (v.inspectionSentCost ? `${v.inspectionSentCost} บาท` : "")],
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
            <div className="inspect-row-checks">ประเภทการส่งตรวจ</div>
            <div className="inspect-row-field" style={{ width: 100 }}>
              วันที่
            </div>
            <div className="inspect-row-field" style={{ width: 80 }}>
              ค่าใช้จ่าย
            </div>
            <div style={{ width: 56 }} />
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
                    {row.message.text && (
                      <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11, marginTop: 6 }} role="status">
                        {row.message.text}
                      </div>
                    )}
                  </div>
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
                  <label className="inspect-row-field">
                    วันที่
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="วว/ดด/ปปปป"
                      value={row.dateText}
                      onChange={(e) =>
                        patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                      }
                      style={{ width: 100 }}
                    />
                  </label>
                  <label className="inspect-row-field">
                    ค่าใช้จ่าย
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={row.costText}
                      disabled={!row.selectedType}
                      onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                      style={{ width: 80 }}
                    />
                  </label>
                  <button
                    className="text-button"
                    disabled={!row.selectedType || row.saving || bulkSaving}
                    onClick={() => onSave(v.id)}
                  >
                    บันทึก
                  </button>
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
            <div className="inspect-row-checks">{panelResult}</div>
            <div className="inspect-row-field" style={{ width: 100 }}>
              วันที่
            </div>
            <div className="inspect-row-field" style={{ width: 80 }}>
              ค่าใช้จ่าย
            </div>
            {showRemark && (
              <div className="inspect-row-field" style={{ width: 180 }}>
                Remark
              </div>
            )}
            <div style={{ width: 56 }} />
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
                      {rowInfoLine(v)} <span>· ส่งตรวจแบบ {v.inspectionSentType || "—"}</span>
                    </div>
                    {row.message.text && (
                      <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11, marginTop: 6 }} role="status">
                        {row.message.text}
                      </div>
                    )}
                  </div>
                  <div className="inspect-row-checks">
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          const isChecked = e.target.checked;
                          patchRow(v.id, {
                            selectedResult: isChecked ? panelResult : null,
                            dateText: isChecked && !row.dateText ? isoToDisplayDate(todayIso()) : row.dateText,
                            // เอาติ๊กออก = เอาราคาออกด้วย - ติ๊กกลับให้คืนราคาแนะนำถ้าช่องว่างอยู่
                            costText: isChecked ? row.costText || v.inspectionSentCost || v.suggestedCost || "" : "",
                          });
                        }}
                      />
                      {panelResult}
                    </label>
                  </div>
                  <label className="inspect-row-field">
                    วันที่
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="วว/ดด/ปปปป"
                      value={row.dateText}
                      onChange={(e) =>
                        patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                      }
                      style={{ width: 100 }}
                    />
                  </label>
                  <label className="inspect-row-field">
                    ค่าใช้จ่าย
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={row.costText}
                      disabled={!checked}
                      onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                      style={{ width: 80 }}
                    />
                  </label>
                  {showRemark && (
                    <label className="inspect-row-field">
                      Remark
                      <input
                        type="text"
                        placeholder="เหตุผลที่ตรวจไม่ผ่าน"
                        value={row.remarkText}
                        onChange={(e) => patchRow(v.id, { remarkText: e.target.value })}
                        style={{ width: 180 }}
                      />
                    </label>
                  )}
                  <button className="text-button" disabled={!checked || row.saving || bulkSaving} onClick={() => onSave(v.id)}>
                    บันทึก
                  </button>
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

// Tab 4 - ตรวจรถรอบ 2: ผ่านตรวจครั้งแรกแล้วครบ 90 วัน ต้องตรวจใหม่ - action เดียว (ไม่มีตรวจนอก/เอารถมาตรวจเองแยก)
// ราคาแนะนำ = No bill ตามตารางเดิม + Bill 50 บาท (คำนวณจาก backend แล้วส่งมาเป็น suggestedRound2Cost)
function Round2Panel({
  vehicles,
  rows,
  patchRow,
  onCheck,
  onSelectAll,
  onSave,
  onSaveAll,
  bulkSaving,
  bulkMessage,
  selectAllDateText,
  onSelectAllDateTextChange,
}: {
  vehicles: Round2Vehicle[];
  rows: Record<string, Round2RowState>;
  patchRow: (id: string, patch: Partial<Round2RowState>) => void;
  onCheck: (id: string, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onSave: (id: string) => void;
  onSaveAll: () => void;
  bulkSaving: boolean;
  bulkMessage: { text: string; error?: boolean };
  selectAllDateText: string;
  onSelectAllDateTextChange: (text: string) => void;
}) {
  const selectedCount = vehicles.filter((v) => rows[v.id]?.selected).length;
  const allSelected = vehicles.length > 0 && vehicles.every((v) => rows[v.id]?.selected);
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <div className="panel" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>รถที่ครบกำหนดตรวจรอบ 2 (90 วันหลังผ่านตรวจครั้งแรก)</h2>
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
        <div className="empty-customers">ไม่มีรถที่ครบกำหนดตรวจรอบ 2</div>
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
                <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} />
                เลือกทั้งหมด
              </label>
            </div>
          </div>
          <div className="inspect-row-header">
            <div className="inspect-row-body">วันที่ · เลขตัวถัง · ยี่ห้อ · ประเภทรถ · เจ้าของงาน · วันที่ผ่านตรวจครั้งแรก</div>
            <div className="inspect-row-checks">ตรวจรอบ 2</div>
            <div className="inspect-row-field" style={{ width: 100 }}>
              วันที่
            </div>
            <div className="inspect-row-field" style={{ width: 80 }}>
              ค่าใช้จ่าย
            </div>
            <div style={{ width: 56 }} />
          </div>
          <div className="inspect-rows">
            {pageItems.map((v) => {
              const row = rows[v.id];
              if (!row) return null;
              return (
                <div className="inspect-row" key={v.id}>
                  <div className="inspect-row-body">
                    <div className="inspect-row-title">
                      {rowInfoLine(v)}{" "}
                      <span>· ผ่านตรวจครั้งแรก {v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"}</span>
                    </div>
                    {row.message.text && (
                      <div className={`customer-message${row.message.error ? " error" : " success"}`} style={{ fontSize: 11, marginTop: 6 }} role="status">
                        {row.message.text}
                      </div>
                    )}
                  </div>
                  <div className="inspect-row-checks">
                    <label>
                      <input type="checkbox" checked={row.selected} onChange={(e) => onCheck(v.id, e.target.checked)} />
                      ตรวจรอบ 2 เรียบร้อย
                    </label>
                  </div>
                  <label className="inspect-row-field">
                    วันที่
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="วว/ดด/ปปปป"
                      value={row.dateText}
                      onChange={(e) =>
                        patchRow(v.id, { dateText: formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)) })
                      }
                      style={{ width: 100 }}
                    />
                  </label>
                  <label className="inspect-row-field">
                    ค่าใช้จ่าย
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={row.costText}
                      disabled={!row.selected}
                      onChange={(e) => patchRow(v.id, { costText: e.target.value })}
                      style={{ width: 80 }}
                    />
                  </label>
                  <button className="text-button" disabled={!row.selected || row.saving || bulkSaving} onClick={() => onSave(v.id)}>
                    บันทึก
                  </button>
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

const renderRound2CompletedExtra = (v: Round2Vehicle) =>
  `ผ่านครั้งแรก ${v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"} · ตรวจรอบ 2 ${
    v.inspectionRound2Date ? isoToDisplayDate(v.inspectionRound2Date) : "—"
  } · ${v.inspectionRound2Cost ? `${v.inspectionRound2Cost} บาท` : "—"}`;

// อ้างอิงอย่างเดียว (ไม่มี action) - ใช้แสดง "รถที่ยังไม่ได้ส่งตรวจ" ใน Tab 2, "รถที่เพิ่งส่งตรวจ" ใน Tab 1,
// และ "ตรวจรอบ 2 เสร็จแล้ว" ใน Tab 4 - generic เพราะ InspectionVehicle/Round2Vehicle มีฟิลด์ของ rowInfoLine ร่วมกัน
function ReferencePanel<
  T extends { id: string; date: string; chassis: string; brandName: string; body: string | null; customerName: string },
>({
  title,
  extraLabel,
  vehicles,
  loading,
  error,
  renderExtra,
}: {
  title: string;
  extraLabel: string;
  vehicles: T[];
  loading: boolean;
  error: string;
  renderExtra: (v: T) => string;
}) {
  const { pageItems, page, setPage, totalPages } = usePagedList(vehicles);

  return (
    <section className="panel customer-list" style={{ marginBottom: 24 }}>
      <div className="panel-head">
        <h2>{title}</h2>
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
          <div className="inspect-row-header">
            <div className="inspect-row-body">วันที่ · เลขตัวถัง · ยี่ห้อ · ประเภทรถ · เจ้าของงาน · {extraLabel}</div>
          </div>
          <div className="inspect-rows">
            {pageItems.map((v) => (
              <div className="inspect-row" key={v.id}>
                <div className="inspect-row-body">
                  <div className="inspect-row-title">
                    {rowInfoLine(v)} <span>· {renderExtra(v)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}

const renderPendingSendExtra = (v: InspectionVehicle) => v.registrationProvince || "—";

const renderPendingResultExtra = (v: InspectionVehicle) =>
  `ส่งตรวจแบบ ${v.inspectionSentType || "—"} วันที่ ${
    v.inspectionSentDate ? isoToDisplayDate(v.inspectionSentDate) : "—"
  } · ${v.inspectionSentCost ? `${v.inspectionSentCost} บาท` : "—"}`;

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
          <div className="inspect-row-header">
            <div className="inspect-row-body">วันที่ · เลขตัวถัง · ยี่ห้อ · ประเภทรถ · เจ้าของงาน · ผลตรวจ / วันที่เสร็จ / ค่าใช้จ่าย</div>
            <div style={{ width: 56 }} />
          </div>
          <div className="inspect-rows">
            {pageItems.map((v) => (
              <div className={`inspect-row${v.inspectionResult === "ไม่ผ่าน" ? " row-failed" : ""}`} key={v.id}>
                <div className="inspect-row-body">
                  <div className="inspect-row-title">
                    {rowInfoLine(v)}{" "}
                    <span>
                      · ผล: {v.inspectionResult || "—"} · เสร็จ {v.inspectionResultDate ? isoToDisplayDate(v.inspectionResultDate) : "—"} ·{" "}
                      {v.inspectionResultCost ? `${v.inspectionResultCost} บาท` : "—"}
                    </span>
                  </div>
                </div>
                <button className="text-button" onClick={() => onOpenDetail(v)}>
                  ดูข้อมูล
                </button>
              </div>
            ))}
          </div>
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage} />
        </>
      )}
    </section>
  );
}

export default function InspectionPage() {
  const [activeTab, setActiveTab] = useState<"send" | "result" | "round2" | "completed">("send");

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
  const [pendingRound2Vehicles, setPendingRound2Vehicles] = useState<Round2Vehicle[]>([]);
  const [round2Rows, setRound2Rows] = useState<Record<string, Round2RowState>>({});
  const [round2Loading, setRound2Loading] = useState(true);
  const [round2Error, setRound2Error] = useState("");
  const [round2BulkSaving, setRound2BulkSaving] = useState(false);
  const [round2BulkMessage, setRound2BulkMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [round2SelectAllDateText, setRound2SelectAllDateText] = useState("");

  const [completedRound2Vehicles, setCompletedRound2Vehicles] = useState<Round2Vehicle[]>([]);
  const [completedRound2Loading, setCompletedRound2Loading] = useState(true);
  const [completedRound2Error, setCompletedRound2Error] = useState("");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<InspectionVehicle | null>(null);

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
      setResultRows(Object.fromEntries(data.vehicles.map((v) => [v.id, toResultRowState(v)])));
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

  async function loadPendingRound2() {
    setRound2Loading(true);
    setRound2Error("");
    try {
      const data = await api.listPendingInspectionRound2();
      setPendingRound2Vehicles(data.vehicles);
      setRound2Rows(Object.fromEntries(data.vehicles.map((v) => [v.id, toRound2RowState()])));
    } catch (err) {
      setRound2Error(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setPendingRound2Vehicles([]);
      setRound2Rows({});
    } finally {
      setRound2Loading(false);
    }
  }

  async function loadCompletedRound2() {
    setCompletedRound2Loading(true);
    setCompletedRound2Error("");
    try {
      const data = await api.listRecentlyCompletedInspectionRound2();
      setCompletedRound2Vehicles(data.vehicles);
    } catch (err) {
      setCompletedRound2Error(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setCompletedRound2Vehicles([]);
    } finally {
      setCompletedRound2Loading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; load*() set their own loading flag before the first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPendingSend();
    loadPendingResult();
    loadCompleted();
    loadPendingRound2();
    loadCompletedRound2();
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
      dateText: checked && !row.dateText && vehicle ? isoToDisplayDate(addDaysIso(vehicle.date, 1)) : row.dateText,
      // เอาติ๊กออก = เอาราคาออกด้วย (ช่องราคาจะถูก disable ต่อเมื่อไม่ได้ติ๊กอยู่แล้ว)
      costText: checked ? costForSentType(type, vehicle?.suggestedCost ?? null) : "",
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
            dateText: sendSelectAllDateText || isoToDisplayDate(addDaysIso(v.date, 1)),
            costText: costForSentType(type, v.suggestedCost),
          };
        } else if (row.selectedType === type) {
          next[v.id] = { ...row, selectedType: null, costText: "" };
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
      await api.updateInspectionSent(id, { sentType: row.selectedType, sentDate: dateIso || null, cost: row.costText || null });
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

    const parsed: Array<{ id: string; chassis: string; type: SentType; dateIso: string; cost: string }> = [];
    for (const v of selected) {
      const row = sendRows[v.id];
      if (!row || !row.selectedType) continue;
      try {
        const { dateIso } = validateSendRow(row);
        parsed.push({ id: v.id, chassis: v.chassis, type: row.selectedType, dateIso, cost: row.costText });
      } catch (err) {
        setSendBulkMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setSendBulkSaving(true);
    setSendBulkMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) => api.updateInspectionSent(p.id, { sentType: p.type, sentDate: p.dateIso || null, cost: p.cost || null })),
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
    const today = isoToDisplayDate(todayIso());
    setResultRows((prev) => {
      const next = { ...prev };
      for (const v of pendingResultVehicles) {
        const row = next[v.id];
        if (!row) continue;
        if (checked) {
          next[v.id] = {
            ...row,
            selectedResult: panelResult,
            dateText: row.dateText || today,
            costText: row.costText || v.inspectionSentCost || v.suggestedCost || "",
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
      await Promise.all([loadPendingResult(), loadCompleted()]);
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
      await Promise.all([loadPendingResult(), loadCompleted()]);
    } finally {
      setSaving(false);
    }
  }

  function patchRound2Row(id: string, patch: Partial<Round2RowState>) {
    setRound2Rows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function handleRound2Check(id: string, checked: boolean) {
    const row = round2Rows[id];
    if (!row) return;
    const vehicle = pendingRound2Vehicles.find((v) => v.id === id);
    patchRound2Row(id, {
      selected: checked,
      dateText: checked && !row.dateText ? isoToDisplayDate(todayIso()) : row.dateText,
      // เอาติ๊กออก = เอาราคาออกด้วย
      costText: checked ? row.costText || vehicle?.suggestedRound2Cost || "" : "",
    });
  }

  function handleSelectAllRound2(checked: boolean) {
    setRound2Rows((prev) => {
      const next = { ...prev };
      for (const v of pendingRound2Vehicles) {
        const row = next[v.id];
        if (!row) continue;
        if (checked) {
          next[v.id] = {
            ...row,
            selected: true,
            dateText: round2SelectAllDateText || isoToDisplayDate(todayIso()),
            costText: row.costText || v.suggestedRound2Cost || "",
          };
        } else {
          next[v.id] = { ...row, selected: false, costText: "" };
        }
      }
      return next;
    });
  }

  async function handleSaveRound2(id: string) {
    const row = round2Rows[id];
    if (!row || !row.selected) return;
    let dateIso: string;
    try {
      ({ dateIso } = validateRound2Row(row));
    } catch (err) {
      patchRound2Row(id, { message: { text: (err as Error).message, error: true } });
      return;
    }

    patchRound2Row(id, { saving: true, message: { text: "กำลังบันทึก…" } });
    try {
      await api.updateInspectionRound2(id, { done: true, date: dateIso || null, cost: row.costText || null });
      await Promise.all([loadPendingRound2(), loadCompletedRound2()]);
    } catch (err) {
      patchRound2Row(id, {
        saving: false,
        message: { text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true },
      });
    }
  }

  async function handleSaveAllRound2() {
    const selected = pendingRound2Vehicles.filter((v) => round2Rows[v.id]?.selected);
    if (!selected.length) return;

    const parsed: Array<{ id: string; dateIso: string; cost: string }> = [];
    for (const v of selected) {
      const row = round2Rows[v.id];
      if (!row) continue;
      try {
        const { dateIso } = validateRound2Row(row);
        parsed.push({ id: v.id, dateIso, cost: row.costText });
      } catch (err) {
        setRound2BulkMessage({ text: `แถวเลขตัวถัง ${v.chassis}: ${(err as Error).message}`, error: true });
        return;
      }
    }

    setRound2BulkSaving(true);
    setRound2BulkMessage({ text: "กำลังบันทึกทั้งหมด…" });
    try {
      const results = await Promise.allSettled(
        parsed.map((p) => api.updateInspectionRound2(p.id, { done: true, date: p.dateIso || null, cost: p.cost || null })),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      setRound2BulkMessage(
        failed
          ? { text: `บันทึกสำเร็จ ${parsed.length - failed} จาก ${parsed.length} รายการ · ล้มเหลว ${failed} รายการ`, error: true }
          : { text: `บันทึกแล้ว ${parsed.length} รายการ` },
      );
      await Promise.all([loadPendingRound2(), loadCompletedRound2()]);
    } finally {
      setRound2BulkSaving(false);
    }
  }

  function openDetail(vehicle: InspectionVehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
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
        <button
          className={`vehicle-tab${activeTab === "round2" ? " selected" : ""}`}
          role="tab"
          aria-selected={activeTab === "round2"}
          onClick={() => setActiveTab("round2")}
        >
          4. ตรวจรถรอบ 2 (ครบ 90 วัน)
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
            extraLabel="ประเภทการส่งตรวจ / วันที่ส่ง / ค่าใช้จ่าย"
            vehicles={pendingResultVehicles}
            loading={resultLoading}
            error={resultError}
            renderExtra={renderPendingResultExtra}
          />
        </>
      ) : activeTab === "result" ? (
        <>
          <ReferencePanel
            title="รถที่ยังไม่ได้ส่งตรวจ"
            extraLabel="จังหวัดที่จดทะเบียน"
            vehicles={pendingSendVehicles}
            loading={sendLoading}
            error={sendError}
            renderExtra={renderPendingSendExtra}
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
      ) : activeTab === "completed" ? (
        <CompletedInspectionPanel vehicles={completedVehicles} loading={completedLoading} error={completedError} onOpenDetail={openDetail} />
      ) : (
        <>
          {round2Loading ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers">กำลังโหลดรายการ…</div>
            </div>
          ) : round2Error ? (
            <div className="panel" style={{ marginBottom: 24 }}>
              <div className="empty-customers" role="alert">
                {round2Error}
              </div>
            </div>
          ) : (
            <Round2Panel
              vehicles={pendingRound2Vehicles}
              rows={round2Rows}
              patchRow={patchRound2Row}
              onCheck={handleRound2Check}
              onSelectAll={handleSelectAllRound2}
              onSave={handleSaveRound2}
              onSaveAll={handleSaveAllRound2}
              bulkSaving={round2BulkSaving}
              bulkMessage={round2BulkMessage}
              selectAllDateText={round2SelectAllDateText}
              onSelectAllDateTextChange={setRound2SelectAllDateText}
            />
          )}
          <ReferencePanel
            title="รายการที่ตรวจรอบ 2 เสร็จแล้ว"
            extraLabel="วันที่ผ่านครั้งแรก / วันที่ตรวจรอบ 2 / ค่าใช้จ่าย"
            vehicles={completedRound2Vehicles}
            loading={completedRound2Loading}
            error={completedRound2Error}
            renderExtra={renderRound2CompletedExtra}
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
    </section>
  );
}
