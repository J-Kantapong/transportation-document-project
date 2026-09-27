"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { canAccessPage, getCachedUser } from "@/lib/auth";
import { billingApi, slipNoText, type DeliveryRow } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { deliveryCustomerLabels, deliveryRowCustomer, downloadDeliverySlipPdf, printDeliverySlips } from "@/lib/delivery-print";
import { jobSheetGroup, jobSheetKey } from "@/lib/job-sheet";
import { comparePlate } from "@/lib/plate-order";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { DateInput } from "@/components/DateInput";

// ส่งงานลูกค้า (พนักงาน): หน้านี้ไม่มีราคา/ยอดบิล เรื่องวางบิลฝ่ายบัญชีทำต่อที่ /accounting/billing (ผู้ใช้ 2026-09-21)
// รถเข้าคิวเมื่อได้รับใบเสร็จ + เล่มแล้ว ป้ายตามทีหลังได้
// ผู้ใช้ 2026-09-26: งานเสร็จเป็น lot แต่บางทีเสร็จไม่หมด -> จัดเป็นการ์ดใบยื่นแบบหน้ารับป้าย/รับเล่ม แสดงทุกคันใน lot
// (คันที่ยังไม่พร้อมเป็นสีจาง ติ๊กไม่ได้) ส่งคันที่พร้อมไปก่อน คันที่เหลืออยู่ในการ์ดเดิมจนส่งครบ
// ติ๊กข้ามการ์ดได้ถ้าเป็นลูกค้าเดียวกันและรถประเภทเดียวกัน - บันทึก 1 ครั้ง = ใบส่งงาน DL 1 ใบของลูกค้ารายเดียว
// รถยนต์กับจักรยานยนต์ส่งคนละใบ (ผู้ใช้ 2026-09-27) - backend ตอบ 400 "ส่งรถยนต์กับจักรยานยนต์คนละใบ" อีกชั้น

type ItemState = { state: "sent" | "ready" | "waiting"; date?: string | null };
type Kind = "car" | "moto";

const KIND_LABEL: Record<Kind, string> = { car: "รถยนต์", moto: "จักรยานยนต์" };
const plateText = (r: DeliveryRow) => (r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—");
const groupLabel = (r: DeliveryRow) => jobSheetGroup(r.body, r.urgent).label;
const kindOf = (r: DeliveryRow): Kind => (isMotorcycleBody(r.body) ? "moto" : "car");
// ใบยื่น = วันที่ยื่น + กลุ่ม + รหัสลูกค้า (ชื่อใช้แสดงอย่างเดียว - ผู้ใช้ 2026-09-27 ทุกหน้าแบ่งใบยื่นด้วยรหัสลูกค้า)
// กลุ่มแยกรถยนต์/จักรยานยนต์อยู่แล้ว การ์ดหนึ่งจึงเป็นรถประเภทเดียว
const lotKeyOf = (r: DeliveryRow) => jobSheetKey(r.submitDate ?? "", groupLabel(r), r.customerId);
const fullyDelivered = (r: DeliveryRow) => !!r.deliveredDate && !!r.plateDeliveredDate;

// คันที่ยังเลือกค้างไว้ได้หลังโหลดคิวใหม่: ยังอยู่ในคิวและติ๊กได้ + ลูกค้าเดียวกันและประเภทรถเดียวกันกับคันแรก (ลำดับคิว ตรงกับ lockReason)
// พบ 2026-09-27: บันทึกไม่ผ่านเพราะมีคนแก้ลูกค้า/ประเภทรถของคันที่ติ๊กไว้ (F21 แก้ได้หลังเตือน) - เดิมเก็บชุดที่ปนกันไว้ทั้งหมด
// คันที่ติ๊กแล้วไม่ถูกล็อก จึงบันทึกไม่ผ่านซ้ำจนกว่าจะหาคันนั้นเจอเอง
function keepSelectable(queue: DeliveryRow[], ids: Set<string>): Set<string> {
  const kept = queue.filter((v) => ids.has(v.id) && v.kind !== "WAITING_PLATE");
  const first = kept[0];
  if (!first) return new Set();
  return new Set(kept.filter((v) => v.customerId === first.customerId && kindOf(v) === kindOf(first)).map((v) => v.id));
}

// สถานะแยก ใบเสร็จ / เล่ม / ป้าย ของแต่ละคัน
// ใบเสร็จไม่ได้ส่งไปกับงาน (ไปพร้อมใบวางบิล ผู้ใช้ 2026-09-26) -> บอกแค่ว่าได้กลับมาแล้วหรือยัง (ต้องมีก่อนจึงส่งได้) ไม่ขึ้น "ส่งแล้ว"
function itemsOf(r: DeliveryRow): { receipt: ItemState; book: ItemState; plate: ItemState } {
  const docs = (have: boolean): ItemState => (r.deliveredDate ? { state: "sent", date: r.deliveredDate } : { state: have ? "ready" : "waiting" });
  return {
    receipt: { state: r.receiptReceived ? "ready" : "waiting" },
    book: docs(r.bookReceived),
    plate: r.plateDeliveredDate ? { state: "sent", date: r.plateDeliveredDate } : { state: r.plateReceived ? "ready" : "waiting" },
  };
}

const WAIT_TEXT = { receipt: "รอใบเสร็จ", book: "รอเล่ม", plate: "รอป้าย" } as const;

function ItemCell({ item, kind }: { item: ItemState; kind: keyof typeof WAIT_TEXT }) {
  if (item.state === "sent") return <span className="delivery-item sent">ส่งแล้ว {item.date ? isoToDisplayDate(item.date).slice(0, 5) : ""}</span>;
  if (item.state === "ready") return <span className="delivery-item ready">✓ มีแล้ว</span>;
  return <span className="delivery-item waiting">⏳ {WAIT_TEXT[kind]}</span>;
}

interface Lot {
  key: string;
  date: string;
  label: string;
  kind: Kind;
  customerId: string;
  customerName: string;
  rows: DeliveryRow[];
}

export function DeliveryPage() {
  const [queue, setQueue] = useState<DeliveryRow[]>([]);
  const [lotOthers, setLotOthers] = useState<DeliveryRow[]>([]);
  const [recent, setRecent] = useState<DeliveryRow[]>([]);
  const focusApplied = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openLots, setOpenLots] = useState<Set<string>>(new Set());
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  // ใบส่งงานของการบันทึกครั้งล่าสุด - พิมพ์ให้ผู้รับเซ็นได้ทันที (ใบเก่าพิมพ์ซ้ำได้ที่หน้ารายงานส่งงาน)
  const [lastSlip, setLastSlip] = useState<{ id: string; slipNo: number } | null>(null);
  const [printing, setPrinting] = useState(false);
  // ป๊อปอัปยืนยัน: วันที่ส่ง (YYYY-MM-DD) + คันที่เลือกตอนเปิด - บันทึกส่งชนิดงานของชุดนี้ไปให้ backend ตรวจ (ตรงกับที่ผู้ใช้เห็น)
  const [confirm, setConfirm] = useState<{ dateIso: string; rows: DeliveryRow[] } | null>(null);
  // ลิงก์กลับเมนูจดทะเบียนรถใหม่ - บทบาท DELIVERY อย่างเดียวเปิดหน้านั้นไม่ได้ (กดแล้วเด้งกลับมาที่นี่) จึงไม่แสดง (พบ 2026-09-27)
  const [canOpenMenu, setCanOpenMenu] = useState(false);
  const loadSeq = useRef(0);
  const lastRefresh = useRef(0);
  // ตัวกรองแบบหน้ารับป้าย/รับเล่ม
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [receiptQuery, setReceiptQuery] = useState("");
  const [chassisQuery, setChassisQuery] = useState("");
  const [plateQuery, setPlateQuery] = useState("");
  const [sortMode, setSortMode] = useState<"submit" | "plate">("submit");

  // quiet = โหลดเบื้องหลัง ไม่ขึ้น "กำลังโหลด" / keepSelection = เก็บคันที่เลือกไว้ถ้ายังติ๊กได้ (หลังบันทึกไม่ผ่าน / กดโหลดใหม่)
  // โหลดซ้อนกันได้ ผลของครั้งล่าสุดเท่านั้นที่ใช้ (ผลเก่าที่มาช้าไม่ทับข้อมูลใหม่)
  // คืนคิวที่โหลดได้ = โหลดสำเร็จและใช้ผลนี้แล้ว, null = ไม่สำเร็จ/มีการโหลดที่ใหม่กว่า
  async function loadAll(options: { quiet?: boolean; keepSelection?: boolean } = {}): Promise<DeliveryRow[] | null> {
    const seq = ++loadSeq.current;
    if (!options.quiet) setLoading(true);
    try {
      const [q, r] = await Promise.all([billingApi.deliveryQueue(), billingApi.deliveryRecent()]);
      if (seq !== loadSeq.current) return null;
      setQueue(q.vehicles);
      setLotOthers(q.lotVehicles ?? []);
      setRecent(r.vehicles);
      // ลูกค้าที่กรองไว้ส่งครบแล้ว (ไม่มีในคิวแล้ว) -> กลับเป็นทุกราย ไม่งั้นรายการว่างโดยที่ตัวเลือกไม่มีชื่อนั้นให้เห็น
      setOwnerFilter((prev) => (prev && !q.vehicles.some((v) => v.customerId === prev && v.kind !== "WAITING_PLATE") ? "" : prev));
      if (options.keepSelection) {
        // ป๊อปอัปยืนยันนับชนิดงานใหม่จากข้อมูลล่าสุดทุกครั้ง คันที่ยังเลือกค้างไว้จึงไม่บันทึกผิดจากที่เห็น
        setSelected((prev) => keepSelectable(q.vehicles, prev));
      } else {
        setSelected(new Set());
      }
      // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): กางการ์ดของรถคันนั้นให้ - ครั้งแรกที่โหลดเท่านั้น (lib/vehicle-focus.ts)
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const target = chassis ? q.vehicles.find((v) => sameChassis(v.chassis, chassis)) : undefined;
        if (target) setOpenLots(new Set([lotKeyOf(target)]));
      }
      return q.vehicles;
    } catch (err) {
      if (seq === loadSeq.current) setMessage({ text: err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ", error: true });
      return null;
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadAll sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
    setCanOpenMenu(canAccessPage("/registration/new-vehicle", getCachedUser()?.roles ?? []));
  }, []);

  // หน้าเปิดค้างไว้นาน (พบ 2026-09-27): กลับมาที่แท็บนี้แล้วโหลดคิวใหม่เบื้องหลัง - เฉพาะตอนยังไม่ได้ติ๊กคันไหน (ไม่ล้างที่เลือกไว้)
  // focus กับ visibilitychange มักมาคู่กัน - เว้นระยะ 2 วินาที
  const idle = selected.size === 0 && !saving && !confirm;
  useEffect(() => {
    if (!idle) return;
    function refresh() {
      if (document.visibilityState !== "visible" || Date.now() - lastRefresh.current < 2000) return;
      lastRefresh.current = Date.now();
      loadAll({ quiet: true, keepSelection: true }); // ติ๊กระหว่างรอผล คันที่ติ๊กไม่หาย
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [idle]);

  const queueIds = new Set(queue.map((r) => r.id));
  const pickable = (r: DeliveryRow) => queueIds.has(r.id) && r.kind !== "WAITING_PLATE";

  // ชื่อเจ้าของงานที่แสดงตามรหัสลูกค้า (F47 ผู้ใช้ 2026-09-27): ลูกค้าชื่อซ้ำกัน (เช่นคนละสาขา) ต่อชื่อผู้ติดต่อ · สาขา
  // ใช้ทั้งหัวการ์ด ตัวเลือกเจ้าของงาน แถบบันทึก ป๊อปอัปยืนยัน และตารางส่งแล้วล่าสุด - ไม่งั้นเห็นชื่อเหมือนกันแยกไม่ออกว่าส่งให้รายไหน
  const allRows = [...queue, ...lotOthers];
  const ownerNames = deliveryCustomerLabels([...allRows, ...recent].map(deliveryRowCustomer));
  const ownerName = (r: DeliveryRow) => ownerNames.get(r.customerId) ?? r.customerName;

  // การ์ด = ใบยื่น (วันที่ยื่น + กลุ่ม + ลูกค้า) ที่มีอย่างน้อย 1 คันพร้อมส่ง
  const lotMap = new Map<string, Lot>();
  for (const r of allRows) {
    const key = lotKeyOf(r);
    const lot = lotMap.get(key) ?? {
      key,
      date: r.submitDate ?? "",
      label: groupLabel(r),
      kind: kindOf(r),
      customerId: r.customerId,
      customerName: ownerName(r),
      rows: [],
    };
    lot.rows.push(r);
    lotMap.set(key, lot);
  }
  const allLots = [...lotMap.values()]
    .filter((lot) => lot.rows.some(pickable))
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.label.localeCompare(b.label, "th") || a.customerName.localeCompare(b.customerName, "th"));

  // ช่องวันที่ที่ยังพิมพ์ไม่ครบ = ยังไม่กรอง
  const fromIso = displayDateToIso(fromText.replace(/\D/g, ""));
  const toIso = displayDateToIso(toText.replace(/\D/g, ""));
  const receiptNeedle = receiptQuery.replace(/\s/g, "");
  const chassisNeedle = chassisQuery.replace(/\s/g, "").toUpperCase();
  const plateNeedle = plateQuery.replace(/\s/g, "");
  const searching = !!(receiptNeedle || chassisNeedle || plateNeedle);
  const filtering = !!(fromIso || toIso || searching || ownerFilter);
  // เจ้าของงานเลือกตามรหัสลูกค้า (ลูกค้าชื่อซ้ำกันคนละรายไม่ปนกัน - ผู้ใช้ 2026-09-27)
  const owners = [...new Map(allLots.map((lot) => [lot.customerId, lot.customerName])).entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "th"));
  const rowMatches = (r: DeliveryRow) =>
    (!receiptNeedle || (r.receiptNo ?? "").includes(receiptNeedle)) &&
    (!chassisNeedle || r.chassis.toUpperCase().includes(chassisNeedle)) &&
    (!plateNeedle || `${r.plateCategory ?? ""}${r.plateNumber ?? ""}`.replace(/\s/g, "").includes(plateNeedle));
  const lots = allLots.filter(
    (lot) =>
      (!fromIso || lot.date >= fromIso) &&
      (!toIso || lot.date <= toIso) &&
      (!ownerFilter || lot.customerId === ownerFilter) &&
      (!searching || lot.rows.some(rowMatches)),
  );
  const orderRows = (rows: DeliveryRow[]) =>
    [...rows].sort(
      sortMode === "plate" ? comparePlate : (a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.chassis.localeCompare(b.chassis),
    );

  // ติ๊กได้เฉพาะลูกค้าเดียวกันและรถประเภทเดียวกันกับคันแรกที่ติ๊ก (ใบส่งงาน 1 ใบ = ลูกค้า 1 ราย รถประเภทเดียว ผู้ใช้ 2026-09-27)
  const selectedRows = allRows.filter((r) => selected.has(r.id));
  const selectedCustomerId = selectedRows[0]?.customerId ?? "";
  const selectedCustomerName = selectedRows[0] ? ownerName(selectedRows[0]) : "";
  const selectedKind: Kind | null = selectedRows[0] ? kindOf(selectedRows[0]) : null;
  const lotCount = new Set(selectedRows.map(lotKeyOf)).size;
  // เหตุผลที่ติ๊กไม่ได้ (ขึ้นเป็น title ของช่องติ๊ก) - null = ติ๊กได้
  const lockReason = (customerId: string, kind: Kind): string | null => {
    if (selectedCustomerId && customerId !== selectedCustomerId) return `เลือก ${selectedCustomerName} ไว้อยู่ ส่งได้ครั้งละ 1 ลูกค้า`;
    if (selectedKind && kind !== selectedKind) return `เลือก${KIND_LABEL[selectedKind]}ไว้อยู่ ส่งรถยนต์กับจักรยานยนต์คนละใบ`;
    return null;
  };

  function setMany(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setLastSlip(null);
    setMessage({ text: "" });
  }

  function toggleLot(key: string) {
    setOpenLots((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function outputSlip(id: string, as: "print" | "pdf") {
    setPrinting(true);
    try {
      const slip = await billingApi.deliverySlip(id);
      if (as === "pdf") await downloadDeliverySlipPdf(slip);
      else printDeliverySlips([slip]);
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "สร้างใบส่งงานไม่สำเร็จ", error: true });
    } finally {
      setPrinting(false);
    }
  }

  // กดบันทึก -> ตรวจฟอร์มแล้วเปิดป๊อปอัปยืนยัน (วันที่ / ลูกค้า / จำนวนคัน) ก่อนบันทึกจริง (ผู้ใช้ 2026-09-26: คีย์ผิดส่วนใหญ่คือวันที่)
  function handleSubmit() {
    const fail = (text: string) => setMessage({ text, error: true });
    if (selected.size === 0) return fail("ติ๊กรถที่ส่งแล้วอย่างน้อย 1 คัน");
    const dateIso = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!dateIso) return fail("วันที่ส่งไม่ถูกต้อง");
    if (!recipient.trim()) return fail("ใส่ชื่อผู้รับงาน");
    setMessage({ text: "" });
    setConfirm({ dateIso, rows: selectedRows });
  }

  async function saveDelivery(dateIso: string, rows: DeliveryRow[]) {
    const fail = (text: string) => setMessage({ text, error: true });
    setConfirm(null);
    setSaving(true);
    setLastSlip(null);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      // ส่งชนิดงานที่ป๊อปอัปแสดง - รถเปลี่ยนสถานะไปแล้ว (เพิ่งรับป้าย / มีคนส่งไปก่อน) backend ไม่บันทึกทั้งชุด
      const items = rows.map((r) => ({ vehicleId: r.id, kind: r.kind }));
      const result = await api.submitDelivery({ items, date: dateIso, recipient, note });
      const parts = [
        result.delivered ? `ส่งงาน ${result.delivered} คัน ส่งต่อให้บัญชีรอวางบิล` : "",
        result.plateOnly ? `ส่งป้าย ${result.plateOnly} คัน` : "",
        result.platePending ? `ป้ายค้างส่ง ${result.platePending} คัน` : "",
      ].filter(Boolean);
      setRecipient("");
      setNote("");
      await loadAll();
      setLastSlip({ id: result.slipId, slipNo: result.slipNo });
      setMessage({ text: `บันทึกแล้ว ใบส่งงาน ${slipNoText(result.slipNo)}: ${parts.join(" · ")}` });
    } catch (err) {
      const text = err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ";
      fail(text);
      // บันทึกไม่ผ่านส่วนใหญ่เพราะข้อมูลในหน้านี้เก่า - โหลดคิวใหม่ทันที เก็บคันที่เลือกไว้ถ้ายังส่งได้ (พบ 2026-09-27)
      const reloaded = await loadAll({ quiet: true, keepSelection: true });
      // บอกว่ารายการล่าสุดโหลดให้แล้ว ไม่ต้องกด F5 (ผู้รับ/หมายเหตุ/คันที่ติ๊กไว้จะหาย) - พบ 2026-09-27
      // คันที่ส่งแล้ว / ลูกค้าหรือประเภทรถเปลี่ยนไปจากคันแรก ถูกเอาออกจากที่เลือก - บอกจำนวนให้ตรวจก่อนกดบันทึกอีกครั้ง
      if (reloaded && err instanceof ApiError && (err.status === 409 || err.status === 400)) {
        const dropped = rows.length - keepSelectable(reloaded, new Set(rows.map((r) => r.id))).size;
        fail(`${text} - โหลดรายการล่าสุดให้แล้ว${dropped > 0 ? ` (เอาคันที่ส่งรวมในใบนี้ไม่ได้แล้วออกจากที่เลือก ${dropped} คัน)` : ""}`);
      }
    } finally {
      setSaving(false);
    }
  }

  const recentRows = recent.filter((r) => !ownerFilter || r.customerId === ownerFilter);

  return (
    <section className="content">
      {canOpenMenu && (
        <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
          ← จดทะเบียนรถใหม่
        </Link>
      )}
      <h1 tabIndex={-1}>Delivery</h1>
      <p>ติ๊กคันที่ส่งให้ลูกค้าแล้ว ใส่วันที่ส่งและผู้รับ แล้วกดบันทึก รถที่ส่งแล้วจะไปรอฝ่ายบัญชีวางบิลต่อ ใบยื่นที่ยังไม่พร้อมทุกคัน ส่งคันที่พร้อมไปก่อนได้</p>
      <Link href="/registration/new-vehicle/delivery/report" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        รายงานส่งงาน / พิมพ์ใบส่งงานย้อนหลัง →
      </Link>

      {message.error && selected.size === 0 && !lastSlip && (
        <div className="customer-message error" role="alert" style={{ marginTop: 16 }}>
          {message.text}
        </div>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>รอส่ง ({filtering ? `${lots.length} จาก ${allLots.length}` : allLots.length} ใบยื่น)</h2>
          <span>
            {filtering && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setFromText("");
                  setToText("");
                  setOwnerFilter("");
                  setReceiptQuery("");
                  setChassisQuery("");
                  setPlateQuery("");
                }}
              >
                ล้างตัวกรอง
              </button>
            )}
            {/* คิวเปลี่ยนได้ตลอด (อีกคนส่งไปแล้ว / ป้ายเพิ่งรับเข้ามา) - โหลดใหม่เองได้ คันที่เลือกไว้ยังอยู่ถ้ายังส่งได้ */}
            <button type="button" className="text-button" disabled={loading || saving} onClick={() => loadAll({ keepSelection: true })}>
              ↻ โหลดใหม่
            </button>
          </span>
        </div>
        {!loading && allLots.length > 0 && (
          <>
            <div className="queue-filter">
              <label className="field">
                <span>วันที่ยื่น ตั้งแต่</span>
                <DateInput value={fromText} onChange={(v) => setFromText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} />
              </label>
              <label className="field">
                <span>ถึง</span>
                <DateInput value={toText} onChange={(v) => setToText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} />
              </label>
              <label className="field">
                <span>เจ้าของงาน</span>
                <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                  <option value="">ทุกราย</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>เลขที่ใบเสร็จ</span>
                <input type="text" inputMode="numeric" value={receiptQuery} onChange={(e) => setReceiptQuery(e.target.value.replace(/[^\d/]/g, ""))} placeholder="เช่น 0035" />
              </label>
              <label className="field">
                <span>เลขตัวรถ</span>
                <input type="text" value={chassisQuery} onChange={(e) => setChassisQuery(e.target.value)} placeholder="บางส่วนก็ได้" />
              </label>
              <label className="field">
                <span>ทะเบียน</span>
                <input type="text" value={plateQuery} onChange={(e) => setPlateQuery(e.target.value)} placeholder="เช่น 9กข 1148" />
              </label>
            </div>
            <div className="queue-toolbar">
              <span className="queue-toolbar-group">
                <span className="queue-sort" role="group" aria-label="ลำดับรถ">
                  <button type="button" className={sortMode === "submit" ? "active" : undefined} aria-pressed={sortMode === "submit"} onClick={() => setSortMode("submit")}>
                    ลำดับที่ยื่น
                  </button>
                  <button type="button" className={sortMode === "plate" ? "active" : undefined} aria-pressed={sortMode === "plate"} onClick={() => setSortMode("plate")}>
                    เรียงตามหมวด
                  </button>
                </span>
                <button type="button" className="text-button" onClick={() => setOpenLots(new Set(lots.map((lot) => lot.key)))}>
                  ขยายทั้งหมด
                </button>
                <button type="button" className="text-button" onClick={() => setOpenLots(new Set())}>
                  พับทั้งหมด
                </button>
              </span>
              {selected.size > 0 && (
                <button type="button" className="text-button" onClick={() => setSelected(new Set())}>
                  ล้างที่เลือก ({selected.size} คัน)
                </button>
              )}
            </div>
          </>
        )}

        {loading ? (
          <div className="customer-message" role="status" style={{ padding: "0 23px 20px" }}>
            กำลังโหลด...
          </div>
        ) : allLots.length === 0 ? (
          <div className="empty-customers">ไม่มีรถที่รอส่ง (ต้องได้รับใบเสร็จและเล่มทะเบียนก่อน)</div>
        ) : (
          <div className="queue-sheets">
            {lots.length === 0 && <div className="empty-customers">ไม่มีใบยื่นที่ตรงกับตัวกรอง</div>}
            {lots.map((lot) => {
              const open = searching || openLots.has(lot.key);
              const ready = lot.rows.filter(pickable);
              const done = lot.rows.filter(fullyDelivered).length;
              const notReady = lot.rows.length - ready.length - done;
              const pickedHere = ready.filter((r) => selected.has(r.id)).length;
              const lockText = lockReason(lot.customerId, lot.kind);
              const locked = !!lockText;
              const rows = orderRows(lot.rows);
              return (
                <div key={lot.key} className={`queue-sheet${notReady > 0 ? " warn" : ""}${open ? " open" : ""}`}>
                  <div
                    className="queue-sheet-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => toggleLot(lot.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleLot(lot.key);
                      }
                    }}
                  >
                    <span className="queue-sheet-title">
                      <input
                        type="checkbox"
                        className="queue-check"
                        checked={pickedHere > 0 && pickedHere === ready.length}
                        ref={(el) => {
                          if (el) el.indeterminate = pickedHere > 0 && pickedHere < ready.length;
                        }}
                        disabled={locked}
                        title={lockText ?? "เลือกคันที่พร้อมส่งทั้งใบ"}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        onChange={(e) => setMany(ready.map((r) => r.id), e.target.checked)}
                        aria-label="เลือกคันที่พร้อมส่งทั้งใบ"
                      />
                      <span className="queue-caret">{open ? "▾" : "▸"}</span>
                      {lot.date ? isoToDisplayDate(lot.date) : "ไม่ทราบวันที่ยื่น"} · {lot.label} · {lot.customerName}
                    </span>
                    <span className="queue-sheet-counts">
                      {lot.rows.length} คัน · <b style={{ color: "#1f7a4d", margin: "0 4px" }}>พร้อมส่ง {ready.length}</b>
                      {done > 0 && ` · ส่งครบแล้ว ${done}`}
                      {pickedHere > 0 && <span className="badge done queue-warn">เลือกแล้ว {pickedHere}</span>}
                      {notReady > 0 && <span className="badge warn queue-warn">⚠ ยังไม่พร้อม {notReady}</span>}
                    </span>
                  </div>
                  {open && (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}>ลำดับ</th>
                            <th style={{ width: 40 }}>ส่ง</th>
                            <th>เลขตัวถัง</th>
                            <th>ทะเบียน</th>
                            <th>เลขที่ใบเสร็จ</th>
                            <th>ใบเสร็จ</th>
                            <th>เล่ม</th>
                            <th>ป้าย</th>
                            <th>ยี่ห้อ / ประเภทรถ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => {
                            const can = pickable(r);
                            const items = itemsOf(r);
                            // ตรวจรายคันด้วย (ไม่พึ่งแค่การ์ด) - คันที่ติ๊กไว้แล้วเอาออกได้เสมอ
                            const rowLock = selected.has(r.id) ? null : lockReason(r.customerId, kindOf(r));
                            return (
                              <tr key={r.id} className={can ? undefined : "delivery-row-muted"}>
                                <td>{i + 1}</td>
                                <td>
                                  {can ? (
                                    <input
                                      type="checkbox"
                                      checked={selected.has(r.id)}
                                      disabled={!!rowLock}
                                      title={rowLock ?? undefined}
                                      onChange={(e) => setMany([r.id], e.target.checked)}
                                      aria-label={`ส่งแล้ว ${r.chassis}`}
                                    />
                                  ) : null}
                                </td>
                                <td>{r.chassis}</td>
                                <td>{plateText(r)}</td>
                                <td>{r.receiptNo || "—"}</td>
                                <td>
                                  <ItemCell item={items.receipt} kind="receipt" />
                                </td>
                                <td>
                                  <ItemCell item={items.book} kind="book" />
                                </td>
                                <td>
                                  <ItemCell item={items.plate} kind="plate" />
                                </td>
                                <td>
                                  {r.brandName}
                                  <div className="muted">{r.body || "—"}</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>ส่งแล้วล่าสุด ({recentRows.length})</h2>
        </div>
        {recentRows.length === 0 ? (
          <div className="empty-customers">ยังไม่มีรายการที่ส่งแล้ว</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ส่ง</th>
                  <th>ชื่อลูกค้า</th>
                  <th>ทะเบียน</th>
                  <th>เลขตัวถัง</th>
                  <th>ผู้รับ</th>
                  <th>ป้าย</th>
                  <th>วางบิล</th>
                  <th>หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {recentRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.deliveredDate ? isoToDisplayDate(r.deliveredDate) : "—"}</td>
                    <td>{ownerName(r)}</td>
                    <td>{plateText(r)}</td>
                    <td>{r.chassis}</td>
                    <td>{r.recipient || "—"}</td>
                    <td>
                      {r.plateDeliveredDate ? <span className="badge done">ส่งแล้ว {isoToDisplayDate(r.plateDeliveredDate)}</span> : <span className="badge warn">ค้างส่ง</span>}
                    </td>
                    <td>{r.invoiceNo ? <span className="badge done">{r.invoiceNo}</span> : <span className="badge">อยู่ที่บัญชี</span>}</td>
                    <td>{r.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* แถบบันทึกค้างล่างจอ: มีคันที่เลือก = ฟอร์มบันทึก, เพิ่งบันทึก = ปุ่มพิมพ์ใบส่งงาน */}
      {(selected.size > 0 || lastSlip) && (
        <div className="delivery-bar" role="region" aria-label="บันทึกการส่ง">
          {selected.size > 0 ? (
            <>
              <div className="delivery-bar-summary">
                <b>เลือก {selected.size} คัน</b>
                <span className="muted">
                  {selectedCustomerName}
                  {selectedKind ? ` · ${KIND_LABEL[selectedKind]}` : ""}
                  {lotCount > 1 ? ` · จาก ${lotCount} ใบยื่น` : ""}
                </span>
              </div>
              <label className="field">
                <span>วันที่ส่ง</span>
                <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} style={{ width: 130 }} />
              </label>
              <label className="field">
                <span>ผู้รับงาน</span>
                <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="ชื่อผู้รับที่ลูกค้า" />
              </label>
              <label className="field">
                <span>หมายเหตุ</span>
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button className="primary" disabled={saving} onClick={handleSubmit}>
                {saving ? "กำลังบันทึก…" : `บันทึกส่งงาน ${selected.size} คัน`}
              </button>
              {message.text && (
                <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ flexBasis: "100%" }}>
                  {message.text}
                </div>
              )}
            </>
          ) : (
            lastSlip && (
              <>
                <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ flex: 1 }}>
                  {message.text}
                </div>
                <button className="primary" disabled={printing} onClick={() => outputSlip(lastSlip.id, "print")}>
                  {printing ? "กำลังเตรียม…" : `พิมพ์ใบส่งงาน ${slipNoText(lastSlip.slipNo)}`}
                </button>
                <button className="primary" disabled={printing} onClick={() => outputSlip(lastSlip.id, "pdf")}>
                  บันทึก PDF
                </button>
                <button className="text-button" onClick={() => setLastSlip(null)}>
                  ปิด
                </button>
              </>
            )
          )}
        </div>
      )}
      {confirm && (
        <DeliveryConfirmDialog
          dateIso={confirm.dateIso}
          customerName={confirm.rows[0] ? ownerName(confirm.rows[0]) : selectedCustomerName}
          recipient={recipient.trim()}
          rows={confirm.rows}
          onClose={() => setConfirm(null)}
          onConfirm={() => saveDelivery(confirm.dateIso, confirm.rows)}
        />
      )}
    </section>
  );
}

// ป๊อปอัปยืนยันก่อนบันทึกส่งงาน: วันที่ส่ง (เตือนสีส้มถ้าไม่ใช่วันนี้ - วันอนาคตคีย์ได้ตามปกติ), ลูกค้า, ผู้รับ, จำนวนคันแยกตามสิ่งที่ส่ง
function DeliveryConfirmDialog({
  dateIso,
  customerName,
  recipient,
  rows,
  onClose,
  onConfirm,
}: {
  dateIso: string;
  customerName: string;
  recipient: string;
  rows: DeliveryRow[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);
  const today = todayIso();
  const days = Math.round((Date.parse(dateIso) - Date.parse(today)) / 86_400_000);
  const dayNote = days === 0 ? "วันนี้" : days < 0 ? `ย้อนหลัง ${-days} วัน` : `ล่วงหน้า ${days} วัน`;
  const count = (kind: DeliveryRow["kind"]) => rows.filter((r) => r.kind === kind).length;
  const parts = [
    [count("FULL"), "เล่ม + ป้าย"],
    [count("NO_PLATE"), "เล่ม (ป้ายตามทีหลัง)"],
    [count("PLATE_ONLY"), "ส่งป้ายอย่างเดียว"],
  ].filter(([n]) => n) as Array<[number, string]>;

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(480px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ยืนยันบันทึกส่งงาน</h2>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        <div>
          วันที่ส่ง: <b style={{ fontSize: 20, color: days === 0 ? undefined : "#bb6a00" }}>{isoToDisplayDate(dateIso)}</b>{" "}
          <span className={days === 0 ? "badge done" : "badge warn"}>{dayNote}</span>
        </div>
        <div>ลูกค้า: {customerName}</div>
        <div>ผู้รับ: {recipient}</div>
        <div>
          <b>{rows.length} คัน</b>
          {parts.map(([n, label]) => (
            <div key={label} className="muted">
              · {label} {n} คัน
            </div>
          ))}
        </div>
      </div>
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()}>
          กลับไปแก้
        </button>
        <button type="button" className="primary" onClick={onConfirm} autoFocus>
          ยืนยันบันทึก
        </button>
      </div>
    </dialog>
  );
}
