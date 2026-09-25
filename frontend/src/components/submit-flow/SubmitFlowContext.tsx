"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type FeePreview, type SubmitCandidate, type TaxBreakdown } from "@/lib/api";
import { displayDateToIso, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  defaultSettings,
  dutyAmount,
  grandTotalExcludingDuty,
  isOwnerUnspecified,
  ownerTypeForApi,
  plateMissing,
  type EntrySettings,
} from "./shared";

// state ร่วมของทุกขั้นยื่นเอกสาร อยู่ใน submit/layout.tsx - เปลี่ยนหน้าระหว่างขั้น (รวมกดย้อนกลับ) ไม่หาย แต่รีเฟรช = เริ่มใหม่
// (ผู้ใช้ 2026-09-25 ให้ลบร่างที่เก็บในเครื่องทิ้ง) ค่าธรรมเนียม/ภาษีคำนวณที่นี่ที่เดียว ขั้นตั้งค่ากับขั้นตรวจทานใช้ตัวเลขชุดเดียวกัน

const PREVIEW_CHUNK_SIZE = 500;
const PRICE_DELAY_MS = 250;

export interface SubmitResult {
  submitDate: string;
  succeeded: SubmitCandidate[];
  failed: Array<{ vehicle: SubmitCandidate; error: string }>;
}

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

interface SubmitFlowState {
  submitDateText: string;
  setSubmitDateText: (text: string) => void;
  submitDate: string; // ISO, "" = ยังกรอกไม่ครบ/ไม่ถูกต้อง
  selected: SubmitCandidate[]; // เรียงตามลำดับที่เลือก
  selectedIds: Set<string>;
  settings: Record<string, EntrySettings>;
  select: (vehicles: SubmitCandidate[]) => void;
  unselect: (ids: Iterable<string>) => void;
  clearSelection: () => void;
  updateSettings: (ids: Iterable<string>, change: (current: EntrySettings, vehicle: SubmitCandidate) => EntrySettings) => void;
  rowState: (vehicle: SubmitCandidate) => RowState;
  checks: Checks;
  retryPricing: () => void;
  result: SubmitResult | null;
  setResult: (result: SubmitResult | null) => void;
}

const SubmitFlowContext = createContext<SubmitFlowState | null>(null);

// ร่างแบบเดิม (ก่อน 2026-09-25) เก็บไว้ใน localStorage - ลบทิ้งครั้งเดียวไม่ให้ค้างในเครื่องพนักงาน
const OLD_DRAFT_STORAGE_KEY = "submit-documents-draft-v1";

export function SubmitFlowProvider({ children }: { children: ReactNode }) {
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const [selected, setSelected] = useState<SubmitCandidate[]>([]);
  const [settings, setSettings] = useState<Record<string, EntrySettings>>({});
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [priced, setPriced] = useState<Record<string, Priced>>({});
  const requested = useRef<Record<string, string>>({});
  const [retry, setRetry] = useState(0);

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
              next[job.vehicle.id] = { sig: job.sig, fee: r.fee, tax: r.tax, error: r.fee ? undefined : (r.error ?? "คำนวณค่าธรรมเนียมไม่สำเร็จ") };
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
    return {
      submitDateText,
      setSubmitDateText,
      submitDate,
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
      unselect: (ids) => {
        const drop = new Set(ids);
        setSelected((prev) => prev.filter((v) => !drop.has(v.id)));
      },
      clearSelection: () => {
        setSelected([]);
        setSettings({});
      },
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
      retryPricing: () => setRetry((n) => n + 1),
      result,
      setResult,
    };
  }, [submitDateText, selected, settings, priced, result]);

  return <SubmitFlowContext.Provider value={value}>{children}</SubmitFlowContext.Provider>;
}

export function useSubmitFlow(): SubmitFlowState {
  const state = useContext(SubmitFlowContext);
  if (!state) throw new Error("useSubmitFlow ต้องอยู่ใต้ SubmitFlowProvider (submit/layout.tsx)");
  return state;
}
