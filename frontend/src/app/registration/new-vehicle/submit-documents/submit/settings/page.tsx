"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { NewPlateOption, OwnerType, PlateNumberOption, SubmitCandidate } from "@/lib/api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { ChecksNote } from "@/components/submit-flow/ChecksNote";
import { CostLines } from "@/components/submit-flow/CostLines";
import {
  formatMoney,
  hasEntryOwner,
  isMotoBody,
  isOwnerUnspecified,
  jobTypeLabel,
  lastFailedLabel,
  ownerLabel,
  PICK_HREF,
  plateMissing,
  REVIEW_HREF,
  type EntrySettings,
} from "@/components/submit-flow/shared";
import { DateInput } from "@/components/DateInput";

// ขั้น 2 ตั้งค่า (ผู้ใช้ 2026-09-25): ตารางเดียว ตั้งค่าแต่ละคันในแถว (เจ้าของรถ / ขอเลขทะเบียน / ทำป้ายใหม่ / ด่วน)
// แถบบนมีแค่งานด่วน/ไม่ด่วนทุกคัน ตัวเลือกเสริมเป็นช่องติ๊กในแถว ค่าใช้จ่ายรายบรรทัดเต็มอยู่ใต้แต่ละคัน
// (ขั้นตรวจทานเหลือแค่ยอดสรุป) คันที่กรอกไม่ครบขึ้นสีแดง ไปขั้นตรวจทานไม่ได้จนกว่าจะครบ
const PLATE_NUMBER_LABEL: Record<PlateNumberOption, string> = { NONE: "ไม่ขอ", NORMAL: "ไม่ใช่เลขประมูล (500)", AUCTION: "เลขประมูล (1,500)" };
const MOTO_PLATE_NUMBER_LABEL: Record<PlateNumberOption, string> = { NONE: "ไม่ขอ", NORMAL: "ขอใช้เลขทะเบียน (500)", AUCTION: "เลขประมูล (1,500)" };
const NEW_PLATE_LABEL: Record<NewPlateOption, string> = { NONE: "ไม่ทำ", BLACKWHITE: "ป้ายขาวดำ (200)", AUCTION: "ป้ายประมูล (1,200)" };

export default function SubmitSettingsPage() {
  const router = useRouter();
  const {
    selected,
    settings,
    updateSettings,
    unselect,
    rowState,
    checks,
    retryPricing,
    submitDateText,
    setSubmitDateText,
    submitDate,
  } = useSubmitFlow();

  // วันที่ยื่นเอกสาร (ผู้ใช้ 2026-09-25: ย้ายมาอยู่ขั้นนี้ กรอกล่วงหน้าได้ ไม่ตรวจสิทธิ์ยื่นตามวันที่ที่หน้าจอ - backend ตรวจตอนยื่น)
  // ใช้วันที่ใหม่เมื่อกรอกครบและถูกต้องเท่านั้น ระหว่างพิมพ์วันที่เดิมยังใช้อยู่
  const [dateText, setDateText] = useState(submitDateText);
  const typedDate = displayDateToIso(dateText.replace(/\D/g, ""));

  function changeDate(raw: string) {
    const text = formatDateDigitsCe(raw.replace(/\D/g, "").slice(0, 8));
    setDateText(text);
    if (displayDateToIso(text.replace(/\D/g, ""))) {
      setSubmitDateText(text);
    }
  }

  const settingsOf = (v: SubmitCandidate) => settings[v.id];

  function setOne(v: SubmitCandidate, change: (s: EntrySettings) => EntrySettings) {
    updateSettings([v.id], (s) => change(s));
  }

  function setAllUrgent(urgent: boolean) {
    updateSettings(
      selected.map((v) => v.id),
      (s) => ({ ...s, options: { ...s.options, urgent } }),
    );
  }

  if (selected.length === 0) {
    return (
      <section className="panel empty-page">
        <p style={{ margin: "0 0 12px" }}>ยังไม่ได้เลือกรถที่จะยื่น</p>
        <Link href={PICK_HREF} className="primary" style={{ display: "inline-flex" }}>
          ← ไปเลือกรถ
        </Link>
      </section>
    );
  }

  const allUrgent = selected.every((v) => settingsOf(v).options.urgent);
  const noneUrgent = selected.every((v) => !settingsOf(v).options.urgent);

  return (
    <>
      <p className="muted" style={{ marginBottom: 16 }}>
        ตั้งค่าแต่ละคันในแถวของคันนั้น ค่าใช้จ่ายรายบรรทัดคำนวณใหม่ให้ทันที แล้วกด &quot;ถัดไป: ตรวจทาน&quot;
      </p>
      <section className="panel">
        {/* แถบบนมีแค่งานด่วน/ไม่ด่วนทุกคัน (ผู้ใช้ 2026-09-25) - ตัวเลือกอื่นตั้งในแถวของแต่ละคัน */}
        <div className="review-toolbar">
          <label className="submit-date-field">
            วันที่ยื่นเอกสาร
            <DateInput
              value={dateText}
              onChange={(value) => changeDate(value)}
              aria-invalid={!typedDate}
            />
          </label>
          {!typedDate ? (
            <span className="field-error">วันที่ไม่ถูกต้อง (ยังใช้ {isoToDisplayDate(submitDate)})</span>
          ) : null}
          <span className="review-toolbar-sep" aria-hidden="true" />
          <span>ทั้งหมด {selected.length} คัน</span>
          <button type="button" className={`filter-chip${allUrgent ? " selected" : ""}`} onClick={() => setAllUrgent(true)}>
            งานด่วนทุกคัน
          </button>
          <button type="button" className={`filter-chip${noneUrgent ? " selected" : ""}`} onClick={() => setAllUrgent(false)}>
            ไม่ด่วนทุกคัน
          </button>
        </div>

        <div className="table-wrap">
          <table className="review-table">
            <thead>
              <tr>
                <th>รถ</th>
                <th>เจ้าของรถ</th>
                <th>ขอเลขทะเบียน</th>
                <th>ทำป้ายใหม่</th>
                <th>ตัวเลือก</th>
                <th style={{ textAlign: "right" }}>รวม (บาท)</th>
                <th></th>
              </tr>
            </thead>
            {selected.map((v) => {
              const s = settingsOf(v);
              const isMoto = isMotoBody(v.body);
              const state = rowState(v);
              const ownerMissing = isOwnerUnspecified(v, s);
              const needPlate = plateMissing(s);
              const problem = checks.problemIds.has(v.id);
              return (
                <tbody key={v.id} className={`review-vehicle${problem ? " has-problem" : ""}`}>
                  <tr>
                    <td>
                      <strong>{v.chassis}</strong>
                      <div className="sub">
                        {v.customerName} · {v.brandName} · {v.body || "—"} · {jobTypeLabel(v)}
                      </div>
                      {v.lastFailedSubmission && <span className="badge warn">{lastFailedLabel(v.lastFailedSubmission)}</span>}
                      {v.plateSwap && (
                        <div className="sub" style={{ color: "#6b4fc8" }}>
                          งานสลับเลข: รับเลขจากรถของ {v.plateSwap.oldOwnerName}
                          {v.plateSwap.newPlateCategory && v.plateSwap.newPlateNumber ? " (เติมทะเบียนให้แล้ว)" : " - ยังไม่ได้เลขใหม่"}
                        </div>
                      )}
                    </td>
                    <td>
                      {hasEntryOwner(v) ? (
                        ownerLabel(v, s)
                      ) : (
                        <div className="review-choice" role="group" aria-label={`ประเภทเจ้าของรถ ${v.chassis}`}>
                          {(["INDIVIDUAL", "JURISTIC"] as OwnerType[]).map((type) => (
                            <button
                              key={type}
                              type="button"
                              className={`filter-chip${s.ownerType === type ? " selected" : ""}`}
                              onClick={() => setOne(v, (cur) => ({ ...cur, ownerType: type }))}
                            >
                              {type === "INDIVIDUAL" ? "บุคคลธรรมดา" : "นิติบุคคล"}
                            </button>
                          ))}
                          {ownerMissing && <div className="field-error">ต้องเลือก</div>}
                        </div>
                      )}
                    </td>
                    <td>
                      <select
                        aria-label={`ขอเลขทะเบียน ${v.chassis}`}
                        value={s.options.plateNumberOption}
                        onChange={(e) =>
                          setOne(v, (cur) => ({ ...cur, options: { ...cur.options, plateNumberOption: e.target.value as PlateNumberOption } }))
                        }
                      >
                        {(isMoto ? (["NONE", "NORMAL"] as PlateNumberOption[]) : (["NONE", "NORMAL", "AUCTION"] as PlateNumberOption[])).map((o) => (
                          <option key={o} value={o}>
                            {(isMoto ? MOTO_PLATE_NUMBER_LABEL : PLATE_NUMBER_LABEL)[o]}
                          </option>
                        ))}
                      </select>
                      <div className="review-plate">
                        <input
                          aria-label={`หมวดทะเบียน ${v.chassis}`}
                          placeholder="หมวด"
                          maxLength={3}
                          value={s.plateCategory}
                          aria-invalid={needPlate && !s.plateCategory.trim()}
                          onChange={(e) => setOne(v, (cur) => ({ ...cur, plateCategory: e.target.value.slice(0, 3) }))}
                        />
                        <input
                          aria-label={`เลขทะเบียน ${v.chassis}`}
                          placeholder="เลข"
                          inputMode="numeric"
                          maxLength={4}
                          value={s.plateNumber}
                          aria-invalid={needPlate && !s.plateNumber.trim()}
                          onChange={(e) => setOne(v, (cur) => ({ ...cur, plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                        />
                      </div>
                      {needPlate && <div className="field-error">กรอกหมวดและเลขที่ขอ</div>}
                      {s.options.plateNumberOption !== "NONE" && (
                        <label className="review-inline-check">
                          <input
                            type="checkbox"
                            checked={s.options.includePlateFee}
                            onChange={(e) => setOne(v, (cur) => ({ ...cur, options: { ...cur.options, includePlateFee: e.target.checked } }))}
                          />
                          รวมค่าแผ่นป้าย ({isMoto ? 100 : 200})
                        </label>
                      )}
                    </td>
                    <td>
                      {isMoto ? (
                        "—"
                      ) : (
                        <select
                          aria-label={`ทำป้ายใหม่ ${v.chassis}`}
                          value={s.options.newPlateOption ?? "NONE"}
                          onChange={(e) =>
                            setOne(v, (cur) => ({ ...cur, options: { ...cur.options, newPlateOption: e.target.value as NewPlateOption } }))
                          }
                        >
                          {(["NONE", "BLACKWHITE", "AUCTION"] as NewPlateOption[]).map((o) => (
                            <option key={o} value={o}>
                              {NEW_PLATE_LABEL[o]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {/* ตัวเลือกเสริมแสดงในแถวเลย ไม่มีปุ่ม "เพิ่มเติม" (ผู้ใช้ 2026-09-25) */}
                      <div className="review-checks">
                        <label className="review-inline-check">
                          <input
                            type="checkbox"
                            checked={s.options.urgent}
                            onChange={(e) => setOne(v, (cur) => ({ ...cur, options: { ...cur.options, urgent: e.target.checked } }))}
                          />
                          ด่วน (+{isMoto ? 50 : 100})
                        </label>
                        {isMoto ? (
                          <label className="review-inline-check">
                            <input
                              type="checkbox"
                              checked={s.options.stopUseRelocateOut}
                              onChange={(e) =>
                                setOne(v, (cur) => ({ ...cur, options: { ...cur.options, stopUseRelocateOut: e.target.checked } }))
                              }
                            />
                            หยุดใช้ย้ายออก (ลงขัน 250)
                          </label>
                        ) : (
                          <label className="review-inline-check">
                            <input
                              type="checkbox"
                              checked={s.options.relocateAddon}
                              onChange={(e) => setOne(v, (cur) => ({ ...cur, options: { ...cur.options, relocateAddon: e.target.checked } }))}
                            />
                            แจ้งย้ายออกต่างจังหวัด (+50)
                          </label>
                        )}
                        {isMoto && s.options.stopUseRelocateOut && (
                          <div className="sub" style={{ color: "#c07a1e" }}>
                            * ค่าธรรมเนียมอื่นของรายการนี้ยังไม่มีข้อมูล (ปรับเฉพาะลงขันเป็น 250)
                          </div>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {state.kind === "ok" ? (
                        <strong style={{ color: "#2854d9" }}>{formatMoney(state.total)}</strong>
                      ) : state.kind === "pending" ? (
                        <span className="muted">กำลังคำนวณ…</span>
                      ) : (
                        <span className="field-error" title={state.message}>
                          คำนวณไม่ได้{" "}
                          <button type="button" className="text-button" onClick={retryPricing}>
                            ลองใหม่
                          </button>
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="review-actions">
                        <button type="button" className="text-button danger" onClick={() => unselect([v.id])}>
                          เอาออก
                        </button>
                      </div>
                    </td>
                  </tr>
                  {/* ค่าใช้จ่ายรายบรรทัดเต็มอยู่ขั้นนี้ ข้างการแก้ไข (ผู้ใช้ 2026-09-25) - ขั้นตรวจทานเหลือแค่ยอดสรุป */}
                  <tr className="review-cost">
                    <td colSpan={7}>
                      {state.kind === "ok" ? (
                        <CostLines fee={state.fee} tax={state.tax} ownerMissing={ownerMissing} />
                      ) : state.kind === "pending" ? (
                        <span className="muted">กำลังคำนวณค่าใช้จ่าย…</span>
                      ) : (
                        <span className="field-error">
                          {state.message} ·{" "}
                          <button type="button" className="text-button" onClick={retryPricing}>
                            คำนวณใหม่
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              );
            })}
          </table>
        </div>
      </section>

      <div className="submit-footer">
        <ChecksNote checks={checks} count={selected.length} />
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <Link href={PICK_HREF} className="text-button">
            ← กลับไปเลือกรถ
          </Link>
          <button type="button" className="primary" disabled={!checks.ready} onClick={() => router.push(REVIEW_HREF)}>
            ถัดไป: ตรวจทาน →
          </button>
        </div>
      </div>
    </>
  );
}
