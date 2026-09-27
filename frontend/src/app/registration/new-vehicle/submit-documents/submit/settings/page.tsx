"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { NewPlateOption, OwnerType, PlateNumberOption, SubmitCandidate } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { ChecksNote } from "@/components/submit-flow/ChecksNote";
import { CostLines } from "@/components/submit-flow/CostLines";
import { EligibilityNotice } from "@/components/submit-flow/EligibilityNotice";
import { SubmitDateField } from "@/components/submit-flow/SubmitDateField";
import {
  formatMoney,
  hasEntryOwner,
  isMotoBody,
  isOwnerUnspecified,
  isSwapPlateOption,
  jobTypeLabel,
  lastFailedLabel,
  ownerLabel,
  PICK_HREF,
  plateMissing,
  plateSwapPrefillMismatch,
  REVIEW_HREF,
  type EntrySettings,
} from "@/components/submit-flow/shared";

// ขั้น 2 ตั้งค่า (ผู้ใช้ 2026-09-25): ตารางเดียว ตั้งค่าแต่ละคันในแถว (เจ้าของรถ / ขอเลขทะเบียน / ทำป้ายใหม่ / ด่วน)
// แถบบนมีแค่งานด่วน/ไม่ด่วนทุกคัน ตัวเลือกเสริมเป็นช่องติ๊กในแถว ค่าใช้จ่ายรายบรรทัดเต็มอยู่ใต้แต่ละคัน
// (ขั้นตรวจทานเหลือแค่ยอดสรุป) คันที่กรอกไม่ครบขึ้นสีแดง ไปขั้นตรวจทานไม่ได้จนกว่าจะครบ
// "มีคนทำสลับเลขมาให้" (ผู้ใช้ 2026-09-27, รถยนต์เท่านั้น): ต้องกรอกหมวด+เลข ไม่มีค่าขอใช้เลข คิดค่าแผ่นป้ายตามปกติเสมอ
const CAR_PLATE_NUMBER_OPTIONS: PlateNumberOption[] = ["NONE", "NORMAL", "AUCTION", "SWAP_NORMAL", "SWAP_AUCTION"];
const MOTO_PLATE_NUMBER_OPTIONS: PlateNumberOption[] = ["NONE", "NORMAL"];
const PLATE_NUMBER_LABEL: Record<PlateNumberOption, string> = {
  NONE: "ไม่ขอ",
  NORMAL: "ไม่ใช่เลขประมูล (500)",
  AUCTION: "เลขประมูล (1,500)",
  SWAP_NORMAL: "มีคนทำสลับเลขมาให้ · ป้ายขาวดำ",
  SWAP_AUCTION: "มีคนทำสลับเลขมาให้ · ป้ายประมูล",
};
const MOTO_PLATE_NUMBER_LABEL: Record<PlateNumberOption, string> = { ...PLATE_NUMBER_LABEL, NORMAL: "ขอใช้เลขทะเบียน (500)" };
const NEW_PLATE_LABEL: Record<NewPlateOption, string> = { NONE: "ไม่ทำ", BLACKWHITE: "ป้ายขาวดำ (200)", AUCTION: "ป้ายประมูล (1,200)" };

export default function SubmitSettingsPage() {
  const router = useRouter();
  const { selected, settings, updateSettings, unselect, rowState, eligibilityOf, checks, retryPricing } = useSubmitFlow();

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
      <EligibilityNotice />
      <section className="panel">
        {/* แถบบนมีแค่งานด่วน/ไม่ด่วนทุกคัน (ผู้ใช้ 2026-09-25) - ตัวเลือกอื่นตั้งในแถวของแต่ละคัน */}
        <div className="review-toolbar">
          {/* เปลี่ยนวันที่ยื่นแล้วตรวจสิทธิ์ยื่นของทุกคันที่เลือกใหม่ ณ วันนั้น (ผู้ใช้ 2026-09-27) - คันที่ยื่นไม่ได้ขึ้นสีแดงพร้อมเหตุผล */}
          <SubmitDateField />
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
              const swapOption = isSwapPlateOption(s.options.plateNumberOption);
              const problem = checks.problemIds.has(v.id);
              const eligibility = eligibilityOf(v);
              return (
                <tbody key={v.id} className={`review-vehicle${problem ? " has-problem" : ""}`}>
                  <tr>
                    <td>
                      <strong>{v.chassis}</strong>
                      <div className="sub">
                        {v.customerName} · {v.brandName} · {v.body || "—"} · {jobTypeLabel(v)}
                      </div>
                      {v.lastFailedSubmission && <span className="badge warn">{lastFailedLabel(v.lastFailedSubmission)}</span>}
                      {/* ยื่นไม่ได้ ณ วันที่ยื่นที่ตั้งไว้ (เช่น ผลตรวจหมดอายุก่อนวันนั้น) - เปลี่ยนวันที่ยื่นหรือเอาออก (ผู้ใช้ 2026-09-27) */}
                      {eligibility.kind === "blocked" && (
                        <div className="field-error">
                          ยื่นไม่ได้ ณ วันที่ยื่นนี้: {eligibility.reason}
                          {v.inspectionValidUntil ? ` (ยื่นได้ถึง ${isoToDisplayDate(v.inspectionValidUntil)})` : ""}
                        </div>
                      )}
                      {eligibility.kind === "checking" && <div className="sub muted">กำลังตรวจสิทธิ์ยื่นตามวันที่ยื่น…</div>}
                      {/* รถใหม่รับ "ทะเบียนเก่า" ของรถเก่า (ผู้ใช้ยืนยัน 2026-09-27 - เดิมเติมทะเบียนใหม่ของรถเก่าผิดฝั่ง) */}
                      {v.plateSwap && (
                        <div className="sub" style={{ color: "#6b4fc8" }}>
                          งานสลับเลข: รับเลข {v.plateSwap.oldPlateCategory} {v.plateSwap.oldPlateNumber} จากรถของ {v.plateSwap.oldOwnerName}
                          {plateSwapPrefillMismatch(v, s) ? (
                            <span style={{ color: "#c2410c" }}> · ⚠ ทะเบียนที่กรอกไม่ตรงกับเลขนี้</span>
                          ) : (
                            " (เติมทะเบียนให้แล้ว)"
                          )}
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
                        onChange={(e) => {
                          const plateNumberOption = e.target.value as PlateNumberOption;
                          // เลขจากงานสลับเลขคิดค่าแผ่นป้ายเสมอ (backend บังคับเหมือนกัน) - ติ๊กรวมค่าแผ่นป้ายให้ตรงกัน
                          setOne(v, (cur) => ({
                            ...cur,
                            options: {
                              ...cur.options,
                              plateNumberOption,
                              includePlateFee: isSwapPlateOption(plateNumberOption) ? true : cur.options.includePlateFee,
                            },
                          }));
                        }}
                      >
                        {(isMoto ? MOTO_PLATE_NUMBER_OPTIONS : CAR_PLATE_NUMBER_OPTIONS).map((o) => (
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
                      {needPlate && <div className="field-error">{swapOption ? "กรอกหมวดและเลขที่ได้จากการสลับเลข" : "กรอกหมวดและเลขที่ขอ"}</div>}
                      {swapOption ? (
                        <div className="sub muted">ไม่มีค่าขอใช้เลข · รวมค่าแผ่นป้าย (200) เสมอ</div>
                      ) : s.options.plateNumberOption !== "NONE" && (
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
