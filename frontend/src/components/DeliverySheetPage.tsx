"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, slipNoText, type DeliverySlip } from "@/lib/billing-api";
import { getCachedUser, type UserRole } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  canEditSheetRow,
  fetchDeliverySheet,
  groupSheetRows,
  NO_OWNER_ID,
  SHEET_SOURCE_LABEL,
  sheetOwnerLabels,
  type SheetCustomer,
  type SheetGroup,
  type SheetRow,
} from "@/lib/delivery-sheet";
import { downloadDeliverySheetPdf, printDeliverySheets } from "@/lib/delivery-sheet-print";
import { DateInput } from "@/components/DateInput";
import { DeliverySheetDateDialog } from "@/components/DeliverySheetDateDialog";
import { DeliverySlipEditDialog } from "@/components/DeliverySlipDialogs";
import { PageTabs } from "@/components/PageTabs";

// ใบส่งงานรวมทุกประเภท (ผู้ใช้ 2026-10-05): เลือกเจ้าของงาน + ช่วงวันที่ แล้วพิมพ์/บันทึก PDF ใบส่งงานของทุกประเภทงานที่ส่งแล้ว/เสร็จในช่วงนั้น
// 1 ใบ = เจ้าของงาน 1 ราย x 1 วัน แบ่งช่วงตามประเภท - อ่านอย่างเดียว ไม่มีราคา ไม่ใช่ใบ DL (ใบ DL บันทึกที่หน้า Delivery)
// ลงวันที่ผิดแก้ได้จากแถวเลย: ใบ DL ใช้หน้าต่างแก้ใบเดิม ประเภทอื่นแก้วันที่ของงานนั้น (ต้องมีเหตุผล บันทึกประวัติ)
const REPORT_PAGE = "/delivery/report";
const firstOfMonthIso = () => `${todayIso().slice(0, 8)}01`;
const YAMAHA_ID = "YAMAHA";

// แท็บของหน้ารายงานส่งงาน (แต่ละแท็บเป็น URL ของตัวเอง - ผู้ใช้ 2026-09-25)
export function DeliveryReportTabs({ current }: { current: "slips" | "sheet" }) {
  return (
    <PageTabs
      label="รายงานส่งงาน"
      style={{ marginTop: 14, marginBottom: 0 }}
      tabs={[
        { href: REPORT_PAGE, label: "ใบส่งงาน DL", selected: current === "slips" },
        { href: `${REPORT_PAGE}/sheet`, label: "ใบรวมทุกงาน", selected: current === "sheet" },
      ]}
    />
  );
}

type Editing = { kind: "slip"; slip: DeliverySlip } | { kind: "row"; row: SheetRow; ownerLabel: string };

export function DeliverySheetPage() {
  const [fromText, setFromText] = useState(isoToDisplayDate(firstOfMonthIso()));
  const [toText, setToText] = useState("");
  const [range, setRange] = useState({ from: firstOfMonthIso(), to: "" });
  const [customerId, setCustomerId] = useState("");
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  // ตัวเลือกเจ้าของงานสะสมจากทุกครั้งที่โหลด - กรองเจ้าของงานฝั่ง server แล้วรายอื่นยังเลือกได้ (เหมือนหน้ารายงานส่งงาน)
  const [customerInfo, setCustomerInfo] = useState<Record<string, SheetCustomer>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [makingPdf, setMakingPdf] = useState(false);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [opening, setOpening] = useState("");
  const loadSeq = useRef(0);

  async function load(from: string, to: string, customer: string, options: { quiet?: boolean } = {}) {
    const seq = ++loadSeq.current;
    if (!options.quiet) {
      setLoading(true);
      setError("");
    }
    try {
      const result = await fetchDeliverySheet({ from, to, customerId: customer });
      if (seq !== loadSeq.current) return;
      setRows(result.rows);
      setTruncated(result.truncated);
      setRange({ from, to });
      setCustomerInfo((prev) => {
        const next = { ...prev };
        for (const r of result.rows) if (r.customer) next[r.customer.id] = r.customer;
        return next;
      });
    } catch (err) {
      if (seq === loadSeq.current) setError(err instanceof ApiError ? err.message : "โหลดใบส่งงานไม่สำเร็จ");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    // อ่านบทบาทหลัง mount เพื่อไม่ให้ hydration ไม่ตรง
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoles(getCachedUser()?.roles ?? []);
    load(firstOfMonthIso(), "", "");
  }, []);

  function applyRange() {
    const from = fromText ? displayDateToIso(fromText.replace(/\D/g, "")) : "";
    const to = toText ? displayDateToIso(toText.replace(/\D/g, "")) : "";
    if ((fromText && !from) || (toText && !to)) return setError("วันที่ไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (from && to && from > to) return setError("วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด");
    setNotice("");
    load(from, to, customerId);
  }

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setNotice("");
    load(range.from, range.to, id);
  }

  const labels = useMemo(() => sheetOwnerLabels(Object.values(customerInfo)), [customerInfo]);
  // ยามาฮ่า (ไม่มีเจ้าของงานในข้อมูล) ไม่ใช่ตัวเลือก - ออกในใบเมื่อเลือก "ทุกเจ้าของงาน"
  const owners = useMemo(
    () =>
      Array.from(labels, ([id, name]) => ({ id, name }))
        .filter((o) => o.id !== NO_OWNER_ID && o.id !== YAMAHA_ID)
        .sort((a, b) => a.name.localeCompare(b.name, "th")),
    [labels],
  );
  const activeOwner = owners.find((o) => o.id === customerId) ?? null;
  const groups = useMemo(() => groupSheetRows(rows, labels), [rows, labels]);
  const counts = useMemo(() => {
    const bySource = new Map<string, number>();
    for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
    return bySource;
  }, [rows]);

  async function savePdf(list: SheetGroup[]) {
    setMakingPdf(true);
    setError("");
    try {
      await downloadDeliverySheetPdf(list, range);
    } catch {
      setError("สร้างไฟล์ PDF ไม่สำเร็จ ลองใหม่อีกครั้ง หรือใช้ปุ่มพิมพ์แล้วเลือกบันทึกเป็น PDF");
    } finally {
      setMakingPdf(false);
    }
  }

  async function startEdit(row: SheetRow, ownerLabel: string) {
    setNotice("");
    setError("");
    if (row.slipId) {
      // ใบ DL: แก้ทั้งใบ (วันที่ส่ง + ผู้รับ) ด้วยหน้าต่างเดิมของรายงานส่งงาน
      setOpening(row.key);
      try {
        setEditing({ kind: "slip", slip: await billingApi.deliverySlip(row.slipId) });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "เปิดใบส่งงานไม่สำเร็จ");
      } finally {
        setOpening("");
      }
      return;
    }
    setEditing({ kind: "row", row, ownerLabel });
  }

  function saved(message: string) {
    setNotice(message);
    load(range.from, range.to, customerId, { quiet: true });
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>รายงานส่งงาน</h1>
      <p>ดูและพิมพ์ใบส่งงานตามเจ้าของงานและวันที่ รวมงานทุกประเภท (รถจดใหม่, สลับเลข, ต่อภาษี, ยกเลิกการใช้รถ, คัดป้าย, งานโอน, แจ้งย้ายยามาฮ่า)</p>
      <DeliveryReportTabs current="sheet" />

      <section className="panel" style={{ marginTop: 20, padding: "18px 23px", overflow: "visible" }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field">
            ตั้งแต่วันที่
            <DateInput value={fromText} onChange={(value) => setFromText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
          </label>
          <label className="field">
            ถึงวันที่
            <DateInput
              value={toText}
              onChange={(value) => setToText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
              placeholder="ไม่จำกัด"
            />
          </label>
          <label className="field">
            เจ้าของงาน
            <select value={activeOwner?.id ?? ""} onChange={(e) => chooseCustomer(e.target.value)}>
              <option value="">ทุกเจ้าของงาน</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={loading} onClick={applyRange}>
            แสดง
          </button>
          <button className="primary" disabled={loading || groups.length === 0} onClick={() => printDeliverySheets(groups)}>
            พิมพ์ทั้งหมด ({groups.length} ใบ)
          </button>
          <button className="primary" disabled={loading || makingPdf || groups.length === 0} onClick={() => savePdf(groups)}>
            {makingPdf ? "กำลังสร้าง PDF…" : "บันทึกเป็น PDF"}
          </button>
        </div>
        <p className="muted" style={{ margin: "12px 0 0", fontSize: 13 }}>
          วันที่ของแต่ละงาน: รถจดใหม่/สลับเลข = วันที่ส่งงาน (ใบ DL) · ต่อภาษี = วันที่คืนเอกสารให้ลูกค้า · ยกเลิกการใช้รถ/คัดป้าย/งานโอน =
          วันที่รับเอกสารกลับ · ยามาฮ่า = วันที่แจ้งย้าย (ไม่มีเจ้าของงาน จึงขึ้นเฉพาะตอนเลือก &quot;ทุกเจ้าของงาน&quot;)
        </p>
        {error && (
          <div className="customer-message error" role="status" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}
        {notice && (
          <div className="customer-message" role="status" style={{ marginTop: 14 }}>
            {notice}
          </div>
        )}
        {truncated && !loading && (
          <div className="customer-message" role="status" style={{ marginTop: 14, color: "#bb6a00" }}>
            ⚠ งานในช่วงนี้มีมากกว่าที่ระบบแสดงได้ครั้งเดียว - ใบที่พิมพ์ยังไม่ครบ เลือกช่วงวันที่ให้สั้นลงหรือเลือกเจ้าของงาน
          </div>
        )}
      </section>

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="stats" style={{ marginTop: 20 }}>
            <div className="stat">
              <div className="stat-top">ใบส่งงาน</div>
              <strong style={{ fontSize: 24 }}>{groups.length} ใบ</strong>
              <div className="muted" style={{ fontSize: 13 }}>
                {rows.length} รายการ
              </div>
            </div>
            {[...counts].map(([source, n]) => (
              <div className="stat" key={source}>
                <div className="stat-top">{SHEET_SOURCE_LABEL[source as keyof typeof SHEET_SOURCE_LABEL]}</div>
                <strong style={{ fontSize: 24 }}>{n}</strong>
              </div>
            ))}
          </div>

          {groups.length === 0 ? (
            <div className="empty-customers" style={{ marginTop: 20 }}>
              ไม่มีงานที่ส่งในช่วงนี้
            </div>
          ) : (
            groups.map((g) => (
              <section className="panel" style={{ marginTop: 20 }} key={g.key}>
                <div className="panel-head">
                  <h2>
                    {isoToDisplayDate(g.date)} · {g.ownerLabel} <span className="muted">· {g.count} รายการ</span>
                  </h2>
                  <span>
                    <button className="text-button" onClick={() => printDeliverySheets([g])}>
                      พิมพ์ใบนี้
                    </button>
                    <button className="text-button" disabled={makingPdf} onClick={() => savePdf([g])}>
                      บันทึก PDF
                    </button>
                  </span>
                </div>
                {g.sections.map((s) => (
                  <div className="table-wrap" key={s.source}>
                    <table>
                      <thead>
                        <tr>
                          <th colSpan={6} style={{ background: "#f5f7fb" }}>
                            {SHEET_SOURCE_LABEL[s.source]} ({s.rows.length}) <span className="muted">· {s.rows[0].dateLabel}</span>
                          </th>
                        </tr>
                        {s.source !== "YAMAHA" && (
                          <tr>
                            <th>ทะเบียน</th>
                            <th>เลขตัวถัง</th>
                            <th>ยี่ห้อ</th>
                            <th>{s.source === "TRANSFER" ? "ผู้รับโอน" : "ชื่อเจ้าของ"}</th>
                            <th>รายการ</th>
                            <th aria-label="แก้" />
                          </tr>
                        )}
                      </thead>
                      <tbody>
                        {s.rows.map((r) => (
                          <tr key={r.key}>
                            {r.source === "YAMAHA" ? (
                              <td colSpan={5}>{r.detail}</td>
                            ) : (
                              <>
                                <td>{r.plateText || "—"}</td>
                                <td>{r.chassis}</td>
                                <td>{r.brand || "—"}</td>
                                <td>{r.ownerName || "—"}</td>
                                <td>
                                  {r.detail}
                                  {r.slipNo !== null && <span className="muted"> · {slipNoText(r.slipNo)}</span>}
                                </td>
                              </>
                            )}
                            <td>
                              {canEditSheetRow(r, roles) && (
                                <button className="text-button" disabled={opening === r.key} onClick={() => startEdit(r, g.ownerLabel)}>
                                  ✎ แก้วันที่
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </section>
            ))
          )}
        </>
      )}

      {editing?.kind === "slip" && (
        <DeliverySlipEditDialog
          slip={editing.slip}
          onClose={() => setEditing(null)}
          onSaved={(updated) => saved(`แก้ใบส่งงาน ${slipNoText(updated.slipNo)} แล้ว`)}
          onRefused={() => load(range.from, range.to, customerId, { quiet: true })}
        />
      )}
      {editing?.kind === "row" && (
        <DeliverySheetDateDialog
          row={editing.row}
          ownerLabel={editing.ownerLabel}
          onClose={() => setEditing(null)}
          onSaved={saved}
          onRefused={() => load(range.from, range.to, customerId, { quiet: true })}
        />
      )}
    </section>
  );
}
