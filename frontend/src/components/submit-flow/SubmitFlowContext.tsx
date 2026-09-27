"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  type BulkDocumentSubmissionEntry,
  type DocumentSubmissionPreviewResult,
  type FeePreview,
  type SubmitCandidate,
  type TaxBreakdown,
} from "@/lib/api";
import { displayDateToIso, isoToDisplayDate } from "@/lib/date";
import {
  defaultSettings,
  dutyAmount,
  grandTotalExcludingDuty,
  isOwnerUnspecified,
  ownerTypeForApi,
  plateMissing,
  useTodayIso,
  type EntrySettings,
} from "./shared";

// state ร่วมของทุกขั้นยื่นเอกสาร อยู่ใน submit/layout.tsx - เปลี่ยนหน้าระหว่างขั้น (รวมกดย้อนกลับ) ไม่หาย แต่รีเฟรช = เริ่มใหม่
// (ผู้ใช้ 2026-09-25 ให้ลบร่างที่เก็บในเครื่องทิ้ง) ค่าธรรมเนียม/ภาษีคำนวณที่นี่ที่เดียว ขั้นตั้งค่ากับขั้นตรวจทานใช้ตัวเลขชุดเดียวกัน

const PREVIEW_CHUNK_SIZE = 500;
// backend รับไม่เกิน 1,000 คันต่อคำขอ - แบ่งส่งทีละ 50 คำขอหนึ่งไม่นานเกินไป เน็ตหลุดกลางทางเสียแค่ชุดเล็กๆ
// และบอกความคืบหน้าได้ระหว่างชุด (พบ 2026-09-27)
const SUBMIT_CHUNK_SIZE = 50;
const LOOKUP_CHUNK_SIZE = 1000;
const PRICE_DELAY_MS = 250;

export interface SubmitResult {
  submitDate: string;
  succeeded: SubmitCandidate[];
  failed: Array<{ vehicle: SubmitCandidate; error: string }>;
}

export type SubmitOutcome = { ok: true; result: SubmitResult } | { ok: false; error: string };

interface Priced {
  sig: string; // ตัวเลือก + เจ้าของรถ ที่ใช้คำนวณ - ไม่ตรงกับปัจจุบัน = กำลังคำนวณใหม่
  fee?: FeePreview;
  tax?: TaxBreakdown;
  error?: string;
}

export type RowState =
  | { kind: "pending" }
  | { kind: "error"; message: string }
  | { kind: "ok"; fee: FeePreview; tax: TaxBreakdown | undefined; taxAmount: number | null; total: number };

export interface Checks {
  ownerMissingIds: string[];
  plateMissingIds: string[];
  errorIds: string[];
  problemIds: Set<string>;
  pendingCount: number;
  grandTotal: number;
  dutyTotal: number;
  taxPendingCount: number;
  ready: boolean; // ครบทุกคัน คำนวณเสร็จ และมีวันที่ยื่น - ไปตรวจทาน/ยื่นได้
}

function priceSig(vehicle: SubmitCandidate, settings: EntrySettings): string {
  return JSON.stringify([settings.options, ownerTypeForApi(vehicle, settings) ?? null]);
}

function toPriced(sig: string, r: DocumentSubmissionPreviewResult): Priced {
  return { sig, fee: r.fee, tax: r.tax, error: r.fee ? undefined : (r.error ?? "คำนวณค่าธรรมเนียมไม่สำเร็จ") };
}

// ยอดที่แสดงของคันนั้น - ใช้เทียบว่าคำนวณใหม่แล้วยอดเปลี่ยนไหม
function priceKey(p: Priced | undefined): string {
  if (!p) return "";
  if (!p.fee) return `error:${p.error ?? ""}`;
  return JSON.stringify([p.fee.billTotal, p.fee.noBillTotal, dutyAmount(p.fee), p.tax?.amount ?? null]);
}

// ยื่นสำเร็จหรือไม่ไม่แน่ชัด (เชื่อมต่อไม่ได้/ระบบขัดข้อง) - backend อาจบันทึกไปแล้วบางคัน
function isUncertain(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status === undefined || err.status >= 500;
}

interface SubmitFlowState {
  submitDateText: string;
  setSubmitDateText: (text: string) => void;
  submitDate: string; // ISO, "" = ยังกรอกไม่ครบ/ไม่ถูกต้อง
  today: string; // วันนี้ (ISO) - ขั้นตรวจทานเตือนเมื่อวันที่ยื่นไม่ใช่วันนี้
  selected: SubmitCandidate[]; // เรียงตามลำดับที่เลือก
  selectedIds: Set<string>;
  settings: Record<string, EntrySettings>;
  select: (vehicles: SubmitCandidate[]) => void;
  unselect: (ids: Iterable<string>) => void;
  clearSelection: () => void;
  refreshSelected: (fresh: SubmitCandidate[]) => void;
  updateSettings: (ids: Iterable<string>, change: (current: EntrySettings, vehicle: SubmitCandidate) => EntrySettings) => void;
  rowState: (vehicle: SubmitCandidate) => RowState;
  checks: Checks;
  retryPricing: () => void;
  verifyPrices: () => Promise<string[]>;
  submitting: boolean;
  submitProgress: { done: number; total: number } | null; // ระหว่างยื่น: ส่งไปแล้วกี่คัน (นับทีละชุด)
  submitSelected: () => Promise<SubmitOutcome>;
  result: SubmitResult | null;
  setResult: (result: SubmitResult | null) => void;
}

const SubmitFlowContext = createContext<SubmitFlowState | null>(null);

// ร่างแบบเดิม (ก่อน 2026-09-25) เก็บไว้ใน localStorage - ลบทิ้งครั้งเดียวไม่ให้ค้างในเครื่องพนักงาน
const OLD_DRAFT_STORAGE_KEY = "submit-documents-draft-v1";

export function SubmitFlowProvider({ children }: { children: ReactNode }) {
  // วันที่ยื่นที่ผู้ใช้กรอกเอง - null = ยังไม่แก้ ใช้วันนี้ (เปิดค้างข้ามคืนแล้วกลับมาได้วันใหม่ ไม่ยื่นด้วยวันเมื่อวาน - พบ 2026-09-27)
  const today = useTodayIso();
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  const submitDateText = dateEdit ?? isoToDisplayDate(today);
  const [selected, setSelected] = useState<SubmitCandidate[]>([]);
  const [settings, setSettings] = useState<Record<string, EntrySettings>>({});
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [priced, setPriced] = useState<Record<string, Priced>>({});
  const requested = useRef<Record<string, string>>({});
  const [retry, setRetry] = useState(0);
  // กำลังยื่นอยู่ - เก็บที่นี่ไม่ใช่ในหน้าตรวจทาน ออกจากหน้าแล้วกลับมาก็กดยื่นซ้ำระหว่างรอไม่ได้ (พบ 2026-09-27)
  const [submitting, setSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState<{ done: number; total: number } | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    try {
      window.localStorage.removeItem(OLD_DRAFT_STORAGE_KEY);
    } catch {}
  }, []);

  const settingsOf = (v: SubmitCandidate) => settings[v.id] ?? defaultSettings(v);
  const sigs = selected.map((v) => `${v.id}=${priceSig(v, settingsOf(v))}`).join("|");

  // คำนวณค่าธรรมเนียม + ภาษีใหม่เฉพาะคันที่ตัวเลือก/เจ้าของรถเปลี่ยน รวบเป็นคำขอเดียว (หน่วงนิดหนึ่งเผื่อกดติดกันหลายปุ่ม)
  // ผลที่ตอบกลับช้ากว่าการเปลี่ยนครั้งล่าสุดถูกทิ้ง (requested เก็บ sig ล่าสุดที่ส่งไปของแต่ละคัน)
  useEffect(() => {
    const stale = selected.filter((v) => requested.current[v.id] !== priceSig(v, settingsOf(v)));
    if (stale.length === 0) return;
    const timer = window.setTimeout(async () => {
      const jobs = stale.map((v) => ({ vehicle: v, settings: settingsOf(v), sig: priceSig(v, settingsOf(v)) }));
      for (const job of jobs) requested.current[job.vehicle.id] = job.sig;
      for (let i = 0; i < jobs.length; i += PREVIEW_CHUNK_SIZE) {
        const chunk = jobs.slice(i, i + PREVIEW_CHUNK_SIZE);
        try {
          const { results } = await api.previewDocumentSubmissionBulk(
            chunk.map((j) => ({ vehicleId: j.vehicle.id, ownerType: ownerTypeForApi(j.vehicle, j.settings), ...j.settings.options })),
          );
          setPriced((prev) => {
            const next = { ...prev };
            results.forEach((r, index) => {
              const job = chunk[index];
              if (requested.current[job.vehicle.id] !== job.sig) return;
              next[job.vehicle.id] = toPriced(job.sig, r);
            });
            return next;
          });
        } catch (err) {
          const message = err instanceof ApiError ? err.message : "คำนวณค่าธรรมเนียมไม่สำเร็จ";
          setPriced((prev) => {
            const next = { ...prev };
            for (const job of chunk) if (requested.current[job.vehicle.id] === job.sig) next[job.vehicle.id] = { sig: job.sig, error: message };
            return next;
          });
          // ให้ปุ่ม "คำนวณใหม่" ส่งคันเหล่านี้อีกรอบ
          for (const job of chunk) if (requested.current[job.vehicle.id] === job.sig) delete requested.current[job.vehicle.id];
        }
      }
    }, PRICE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // sigs รวมตัวเลือก+เจ้าของรถของทุกคันแล้ว
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sigs, retry]);

  const value = useMemo<SubmitFlowState>(() => {
    const settingsFor = (v: SubmitCandidate) => settings[v.id] ?? defaultSettings(v);
    const submitDate = displayDateToIso(submitDateText.replace(/\D/g, ""));
    const rowState = (v: SubmitCandidate): RowState => {
      const p = priced[v.id];
      if (!p || p.sig !== priceSig(v, settingsFor(v))) return { kind: "pending" };
      if (p.error || !p.fee) return { kind: "error", message: p.error ?? "คำนวณค่าธรรมเนียมไม่สำเร็จ" };
      const taxAmount = p.tax?.amount ?? null;
      return { kind: "ok", fee: p.fee, tax: p.tax, taxAmount, total: grandTotalExcludingDuty(p.fee, taxAmount) };
    };
    const states = selected.map((v) => rowState(v));
    const ownerMissingIds = selected.filter((v) => isOwnerUnspecified(v, settingsFor(v))).map((v) => v.id);
    const plateMissingIds = selected.filter((v) => plateMissing(settingsFor(v))).map((v) => v.id);
    const errorIds = selected.filter((_, i) => states[i].kind === "error").map((v) => v.id);
    const okStates = states.filter((s): s is Extract<RowState, { kind: "ok" }> => s.kind === "ok");
    const problemIds = new Set([...ownerMissingIds, ...plateMissingIds, ...errorIds]);
    const pendingCount = states.filter((s) => s.kind === "pending").length;
    const checks: Checks = {
      ownerMissingIds,
      plateMissingIds,
      errorIds,
      problemIds,
      pendingCount,
      grandTotal: okStates.reduce((sum, s) => sum + s.total, 0),
      dutyTotal: okStates.reduce((sum, s) => sum + dutyAmount(s.fee), 0),
      taxPendingCount: okStates.filter((s) => s.taxAmount === null).length,
      ready: selected.length > 0 && problemIds.size === 0 && pendingCount === 0 && !!submitDate,
    };
    const selectedIds = new Set(selected.map((v) => v.id));

    // เอารถออกจากที่เลือก + ล้างผลคำนวณ (เลือกกลับมาใหม่ = คำนวณใหม่จากข้อมูลล่าสุด - พบ 2026-09-27)
    const unselect = (ids: Iterable<string>) => {
      const drop = new Set(ids);
      for (const id of drop) delete requested.current[id];
      setSelected((prev) => prev.filter((v) => !drop.has(v.id)));
      setPriced((prev) => {
        const next = { ...prev };
        for (const id of drop) delete next[id];
        return next;
      });
    };

    // แทนข้อมูลรถที่เลือกไว้ด้วยข้อมูลล่าสุด (คิว/ค้นเลขตัวถัง) - เจ้าของรถที่เพิ่งกรอกในหน้าเพิ่มข้อมูลรถต้องไม่ถูกส่ง ownerType
    // ทับ (พบ 2026-09-27) เจ้าของรถเปลี่ยน = sig เปลี่ยน คำนวณใหม่เอง · คันที่ไม่อยู่ในข้อมูลใหม่คงของเดิม (backend ตรวจตอนยื่น)
    const refreshSelected = (fresh: SubmitCandidate[]) => {
      if (fresh.length === 0) return;
      const byId = new Map(fresh.map((v) => [v.id, v]));
      setSelected((prev) => (prev.some((v) => byId.has(v.id)) ? prev.map((v) => byId.get(v.id) ?? v) : prev));
    };

    // อ่านข้อมูลรถที่เลือกไว้ใหม่จาก backend (เลขตัวถัง ณ วันที่ยื่น) คืนรายการที่เลือกหลังแทนข้อมูลแล้ว - พลาดก็ใช้ของเดิม
    const reloadSnapshots = async (vehicles: SubmitCandidate[]): Promise<SubmitCandidate[]> => {
      const byId = new Map<string, SubmitCandidate>();
      try {
        for (let i = 0; i < vehicles.length; i += LOOKUP_CHUNK_SIZE) {
          const chassis = vehicles.slice(i, i + LOOKUP_CHUNK_SIZE).map((v) => v.chassis);
          const { found } = await api.lookupVehiclesByChassis(chassis, submitDate || today);
          for (const v of found) byId.set(v.id, v);
        }
      } catch {
        // ใช้ข้อมูลเดิม - ขั้นคำนวณ/ยื่นจะบอกเหตุผลเองถ้าข้อมูลไม่ตรง
      }
      const fresh = [...byId.values()];
      refreshSelected(fresh);
      return selected.map((v) => byId.get(v.id) ?? v);
    };

    // คำนวณใหม่ทุกคันจากข้อมูลรถล่าสุด ก่อนเปิดหน้าต่างยืนยันยื่น (พบ 2026-09-27: ข้อมูลรถถูกแก้ระหว่างนี้ ยอดที่ตรวจทานไม่ตรงกับที่บันทึก)
    // คืน id ของคันที่ยอด/สถานะเปลี่ยนจากที่แสดงอยู่ - โยน ApiError ถ้าคำนวณไม่ได้ทั้งชุด
    const verifyPrices = async (): Promise<string[]> => {
      const shown = priced;
      const vehicles = await reloadSnapshots(selected);
      const jobs = vehicles.map((v) => ({ vehicle: v, settings: settingsFor(v), sig: priceSig(v, settingsFor(v)) }));
      for (const job of jobs) requested.current[job.vehicle.id] = job.sig;
      const next: Record<string, Priced> = {};
      const changed: string[] = [];
      try {
        for (let i = 0; i < jobs.length; i += PREVIEW_CHUNK_SIZE) {
          const chunk = jobs.slice(i, i + PREVIEW_CHUNK_SIZE);
          const { results } = await api.previewDocumentSubmissionBulk(
            chunk.map((j) => ({ vehicleId: j.vehicle.id, ownerType: ownerTypeForApi(j.vehicle, j.settings), ...j.settings.options })),
          );
          results.forEach((r, index) => {
            const job = chunk[index];
            next[job.vehicle.id] = toPriced(job.sig, r);
            if (priceKey(shown[job.vehicle.id]) !== priceKey(next[job.vehicle.id])) changed.push(job.vehicle.id);
          });
        }
      } catch (err) {
        // คันที่ยังไม่ได้ผลใหม่ให้ขั้นคำนวณปกติส่งไปใหม่ - ต้องกระตุ้นให้คำนวณรอบใหม่ด้วย (พบ 2026-09-27: เจ้าของรถเปลี่ยนระหว่างนี้
        // sig ใหม่ถูกจองไว้แล้วตรงนี้ ขั้นคำนวณปกติจึงไม่ส่ง พอคำขอนี้พลาด แถวค้าง "กำลังคำนวณ…" ถาวร)
        for (const job of jobs) if (!next[job.vehicle.id] && requested.current[job.vehicle.id] === job.sig) delete requested.current[job.vehicle.id];
        setRetry((n) => n + 1);
        throw err;
      } finally {
        setPriced((prev) => {
          const merged = { ...prev };
          for (const [id, p] of Object.entries(next)) if (requested.current[id] === p.sig) merged[id] = p;
          return merged;
        });
      }
      return changed;
    };

    // ยื่นทุกคันที่เลือก แบ่งส่งทีละ 50 คัน (พบ 2026-09-27) - ยื่นซ้อนระหว่างที่คำขอเดิมยังไม่จบไม่ได้
    // เชื่อมต่อไม่ได้/ระบบขัดข้องกลางทาง: อ่านรายการยื่นของวันนั้นใหม่ คันที่มีรายการรอใบเสร็จแล้วนับว่ายื่นสำเร็จ (ไปพิมพ์ใบส่งงานได้)
    // ที่เหลือแจ้งว่ายังไม่ได้ยื่น/ไม่ทราบผล ยื่นซ้ำได้เพราะ backend ล็อกแถวรถและตรวจยื่นซ้ำก่อนบันทึก
    const submitSelected = async (): Promise<SubmitOutcome> => {
      if (submittingRef.current) return { ok: false, error: "กำลังยื่นเอกสารชุดนี้อยู่ - รอผลก่อน" };
      if (!submitDate || selected.length === 0) return { ok: false, error: "ยังไม่มีรถที่จะยื่นหรือวันที่ยื่นไม่ถูกต้อง" };
      submittingRef.current = true;
      setSubmitting(true);
      const date = submitDate;
      const byId = new Map(selected.map((v) => [v.id, v]));
      const entries: BulkDocumentSubmissionEntry[] = selected.map((v) => {
        const s = settingsFor(v);
        return {
          vehicleId: v.id,
          submitDate: date,
          plateCategory: s.plateCategory.trim() || null,
          plateNumber: s.plateNumber.trim() || null,
          ownerType: ownerTypeForApi(v, s),
          ...s.options,
        };
      });
      const succeededIds: string[] = [];
      const failed: SubmitResult["failed"] = [];
      const fail = (vehicleId: string, error: string) => {
        const vehicle = byId.get(vehicleId);
        if (vehicle) failed.push({ vehicle, error });
      };
      setSubmitProgress({ done: 0, total: entries.length });
      try {
        for (let i = 0; i < entries.length; i += SUBMIT_CHUNK_SIZE) {
          const chunk = entries.slice(i, i + SUBMIT_CHUNK_SIZE);
          try {
            const res = await api.createDocumentSubmissionBulk(chunk);
            succeededIds.push(...res.succeeded.map((s) => s.vehicleId));
            for (const f of res.failed) fail(f.vehicleId, f.error);
            setSubmitProgress({ done: i + chunk.length, total: entries.length });
            continue;
          } catch (err) {
            const message = err instanceof ApiError ? err.message : "ยื่นเอกสารไม่สำเร็จ";
            const rest = entries.slice(i);
            const nothingYet = succeededIds.length === 0 && failed.length === 0;
            if (!isUncertain(err)) {
              // backend ปฏิเสธทั้งคำขอ (เช่น ไม่มีสิทธิ์) - ชุดนี้และชุดถัดไปยังไม่ได้บันทึก
              if (nothingYet) return { ok: false, error: message };
              for (const e of rest) fail(e.vehicleId, `ยังไม่ได้ยื่น: ${message}`);
              break;
            }
            let saved: Set<string> | null = null;
            try {
              const { submissions } = await api.listDocumentSubmissions(date);
              saved = new Set(submissions.filter((s) => s.status === "PENDING").map((s) => s.vehicleId));
            } catch {
              saved = null;
            }
            if (!saved && nothingYet) {
              return { ok: false, error: `${message} - ไม่ทราบว่าบันทึกไปแล้วกี่คัน ตรวจที่หน้าดูข้อมูลที่ยื่นแล้วก่อนยื่นซ้ำ` };
            }
            const sent = new Set(chunk.map((e) => e.vehicleId));
            for (const e of rest) {
              if (saved?.has(e.vehicleId)) succeededIds.push(e.vehicleId);
              else if (!sent.has(e.vehicleId)) fail(e.vehicleId, "ยังไม่ได้ส่งไปยื่น (เชื่อมต่อระบบไม่ได้) - ยื่นใหม่ได้");
              else if (saved) fail(e.vehicleId, "เชื่อมต่อระบบไม่ได้ระหว่างยื่น และยังไม่พบรายการที่บันทึก - ยื่นใหม่ได้ (ระบบไม่ให้ยื่นซ้ำ)");
              else fail(e.vehicleId, "เชื่อมต่อระบบไม่ได้ ไม่ทราบว่าบันทึกแล้วหรือยัง - ตรวจที่หน้าดูข้อมูลที่ยื่นแล้ว หรือยื่นใหม่ (ระบบไม่ให้ยื่นซ้ำ)");
            }
            break;
          }
        }
        const nextResult: SubmitResult = {
          submitDate: date,
          succeeded: succeededIds.map((id) => byId.get(id)).filter((v): v is SubmitCandidate => !!v),
          failed,
        };
        setResult(nextResult);
        // คันที่ยื่นสำเร็จออกจากที่เลือก คันที่ไม่สำเร็จยังอยู่พร้อมการตั้งค่าเดิม ให้กลับไปแก้แล้วยื่นใหม่ได้
        unselect(succeededIds);
        return { ok: true, result: nextResult };
      } finally {
        submittingRef.current = false;
        setSubmitting(false);
        setSubmitProgress(null);
      }
    };

    return {
      submitDateText,
      setSubmitDateText: (text) => setDateEdit(text),
      submitDate,
      today,
      selected,
      selectedIds,
      settings,
      select: (vehicles) => {
        setSelected((prev) => {
          const have = new Set(prev.map((v) => v.id));
          return [...prev, ...vehicles.filter((v) => !have.has(v.id))];
        });
        // คันที่เคยตั้งค่าไว้แล้ว (เลือกออกแล้วเลือกกลับ) ใช้ค่าเดิม
        setSettings((prev) => {
          const next = { ...prev };
          for (const v of vehicles) next[v.id] ??= defaultSettings(v);
          return next;
        });
      },
      unselect,
      clearSelection: () => {
        requested.current = {};
        setSelected([]);
        setSettings({});
        setPriced({});
      },
      refreshSelected,
      updateSettings: (ids, change) => {
        const target = new Set(ids);
        setSettings((prev) => {
          const next = { ...prev };
          for (const v of selected) if (target.has(v.id)) next[v.id] = change(prev[v.id] ?? defaultSettings(v), v);
          return next;
        });
      },
      rowState,
      checks,
      // "ลองใหม่" / "คำนวณใหม่" ของคันที่คำนวณไม่ได้: อ่านข้อมูลรถใหม่ แล้วส่งคำนวณอีกรอบ (พบ 2026-09-27: เดิมกดแล้วไม่ส่งอะไรเลย
      // สำหรับ error รายคัน เพราะ sig ของคันนั้นยังตรงกับที่เคยส่ง)
      retryPricing: () => {
        const errorRows = selected.filter((v) => priced[v.id]?.error);
        for (const v of errorRows) delete requested.current[v.id];
        void reloadSnapshots(errorRows).finally(() => setRetry((n) => n + 1));
      },
      verifyPrices,
      submitting,
      submitProgress,
      submitSelected,
      result,
      setResult,
    };
  }, [submitDateText, today, selected, settings, priced, result, submitting, submitProgress]);

  return <SubmitFlowContext.Provider value={value}>{children}</SubmitFlowContext.Provider>;
}

export function useSubmitFlow(): SubmitFlowState {
  const state = useContext(SubmitFlowContext);
  if (!state) throw new Error("useSubmitFlow ต้องอยู่ใต้ SubmitFlowProvider (submit/layout.tsx)");
  return state;
}
