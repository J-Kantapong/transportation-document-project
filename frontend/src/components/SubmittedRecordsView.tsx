"use client";

import { useMemo, useState } from "react";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import type { DocumentSubmission } from "@/lib/api";
import { ownerDisplayLabel } from "@/lib/vehicle-owner";
import { isoToDisplayDate } from "@/lib/date";
import { usePathname, useSearchParams } from "next/navigation";
import { JobSheetPrintDialog } from "@/components/JobSheetPrintDialog";
import { PageTabs } from "@/components/PageTabs";
import { SubmissionBulkCancelDialog } from "@/components/SubmissionBulkCancelDialog";
import { SubmissionCancelDialog } from "@/components/SubmissionCancelDialog";
import { compareSubmittedOrder, dutyOfItems, savedTotalExcludingDuty, swapPlateLabel, useReadScope } from "@/components/submit-flow/shared";
import type { JobSheetKind } from "@/lib/job-sheet-print";
import { customerDisplayNames } from "@/lib/job-sheet";

function formatMoney(amount: number): string {
  return amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

// แยกตามแบบใบส่งงานที่ต้องปริ้นให้เจ้าหน้าที่: แบบ 1 = รถยนต์ (รย.1 แยกเอง, รย.2 + รย.3 รวมกัน),
// แบบ 2 = มอเตอร์ไซค์ทั้งหมด (รย.12) - "unknown" คือรถที่ไม่ได้ระบุประเภทรถ แสดงแยกไว้เพื่อไม่ให้หายไปเงียบๆ
type Family = "car1" | "car23" | "moto" | "unknown";

export function classify(body: string | null): Family {
  if (!body) return "unknown";
  if (isMotorcycleBody(body)) return "moto";
  if (body.startsWith("รย.1-")) return "car1";
  if (body.startsWith("รย.2-") || body.startsWith("รย.3-")) return "car23";
  return "unknown";
}

type Tab = "car" | "moto" | "unknown";

// ตารางตามแบบใบส่งงานมีแค่ PENDING/RECEIPT_RECEIVED - FAILED แยกไปอยู่ FailedTable
function StatusBadge({ status }: { status: DocumentSubmission["status"] }) {
  if (status === "PENDING") return <span className="badge warn">รอใบเสร็จ</span>;
  return <span className="badge done">ได้รับใบเสร็จแล้ว</span>;
}

// ยอดรวมไม่รวมค่าอากรแบบเดียวกับขั้นตรวจทานและใบส่งงาน (พบ 2026-09-27) - ภาษีคำนวณไม่ได้ขึ้น "ยังไม่รวมภาษี" ไม่ให้ดูเหมือนยอดครบ
function TotalCell({ record }: { record: DocumentSubmission }) {
  return (
    <td>
      {formatMoney(savedTotalExcludingDuty(record))} บาท
      {record.taxAmount === null && <div className="field-error">ยังไม่รวมภาษี</div>}
    </td>
  );
}

export function GroupTable({
  title,
  rows,
  showUrgent,
  onPrint,
  onCancel,
  canCancel,
  selected,
  onToggle,
  onBulkCancel,
}: {
  title: string;
  rows: DocumentSubmission[];
  showUrgent: boolean;
  onPrint?: () => void;
  onCancel?: (record: DocumentSubmission) => void;
  canCancel?: (record: DocumentSubmission) => boolean; // ไม่ส่ง = ทุกแถวที่รอใบเสร็จ
  // เลือกหลายคันแล้วยกเลิกรวม (ไม่ส่ง = ไม่มีช่องติ๊ก)
  selected?: Set<string>;
  onToggle?: (ids: string[], on: boolean) => void;
  onBulkCancel?: (rows: DocumentSubmission[]) => void;
}) {
  const cancellable = (r: DocumentSubmission) => r.status === "PENDING" && (canCancel?.(r) ?? true);
  const selectable = onCancel && selected && onToggle ? rows.filter(cancellable) : [];
  const picked = selectable.filter((r) => selected?.has(r.id));
  const total = rows.reduce((sum, r) => sum + savedTotalExcludingDuty(r), 0);
  const duty = rows.reduce((sum, r) => sum + dutyOfItems(r.noBillItems), 0);
  const taxMissing = rows.filter((r) => r.taxAmount === null).length;
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {title} <span className="muted">· {rows.length} คัน</span>
        </h2>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          {selectable.length > 0 && (
            <>
              <button
                type="button"
                className="text-button"
                onClick={() => onToggle?.(selectable.map((r) => r.id), picked.length !== selectable.length)}
              >
                {picked.length === selectable.length ? "ไม่เลือกทั้งหมด" : `เลือกทั้งหมด (${selectable.length})`}
              </button>
              <button
                type="button"
                className="text-button"
                style={{ color: "#c2410c" }}
                disabled={picked.length === 0}
                onClick={() => onBulkCancel?.(picked)}
              >
                ยกเลิกที่เลือก{picked.length > 0 ? ` (${picked.length})` : ""}
              </button>
            </>
          )}
          {onPrint && (
            <button type="button" className="text-button" disabled={rows.length === 0} onClick={onPrint}>
              ปริ้นใบส่งงาน
            </button>
          )}
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="empty-customers">ไม่มีรายการ</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {selectable.length > 0 && <th aria-label="เลือก" />}
                <th>#</th>
                <th>เลขตัวถัง</th>
                <th>ประเภทรถ</th>
                <th>เจ้าของงาน</th>
                <th>เจ้าของรถ</th>
                {showUrgent && <th>ด่วน</th>}
                <th>เลขทะเบียนที่ขอ</th>
                <th>ยอดรวม (ไม่รวมอากร)</th>
                <th>สถานะ</th>
                {onCancel && <th aria-label="ยกเลิก" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  {selectable.length > 0 && (
                    <td>
                      {cancellable(r) && (
                        <input
                          type="checkbox"
                          aria-label={`เลือก ${r.vehicle.chassis}`}
                          checked={selected?.has(r.id) ?? false}
                          onChange={(e) => onToggle?.([r.id], e.target.checked)}
                        />
                      )}
                    </td>
                  )}
                  <td>{i + 1}</td>
                  <td>{r.vehicle.chassis}</td>
                  <td>{r.vehicle.body || "—"}</td>
                  <td>{r.vehicle.customer.name}</td>
                  <td>
                    {/* ไฟแนนซ์: owner.name = ชื่อไฟแนนซ์ (เจ้าของตามทะเบียน) จึงแสดง "ประเภทผู้เช่าซื้อ · ไฟแนนซ์ ชื่อ" */}
                    {ownerDisplayLabel(r.vehicle.owner, r.vehicle.owner?.name) ?? "ยังไม่ระบุ"}
                  </td>
                  {showUrgent && <td>{r.urgent ? <span className="badge warn">ด่วน</span> : "—"}</td>}
                  <td>
                    {r.vehicle.plateCategory ? `${r.vehicle.plateCategory} ${r.vehicle.plateNumber ?? ""}` : "—"}
                    {/* เลขจากงานสลับเลขที่คนอื่นทำมาให้ (ผู้ใช้ 2026-09-27) - ไม่ใช่การขอใช้เลข แสดงให้เห็นชัด */}
                    {swapPlateLabel(r.plateNumberOption) && (
                      <div>
                        <span className="badge warn">{swapPlateLabel(r.plateNumberOption)}</span>
                      </div>
                    )}
                  </td>
                  <TotalCell record={r} />
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  {onCancel && (
                    <td>
                      {/* ยกเลิกได้เฉพาะที่ยังรอใบเสร็จ ในประเภทรถที่บัญชีนี้บันทึกได้ - backend เช็กซ้ำ */}
                      {cancellable(r) && (
                        <button type="button" className="text-button" style={{ color: "#c2410c" }} onClick={() => onCancel(r)}>
                          ยกเลิก
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "14px 23px", borderTop: "1px solid #eef0f6" }}>
        <span style={{ fontSize: 14, fontWeight: 500 }}>
          รวม (ไม่รวมอากร)
          {taxMissing > 0 && <span className="field-error"> ({taxMissing} คันยังไม่รวมภาษี)</span>}
          {duty > 0 && <span className="muted" style={{ fontWeight: 400 }}> · ค่าอากรแยกต่างหาก {formatMoney(duty)} บาท</span>}
        </span>
        <span style={{ fontSize: 16, fontWeight: 500, color: "#2854d9" }}>{formatMoney(total)} บาท</span>
      </div>
    </section>
  );
}

// รายการยื่นไม่สำเร็จ - แยกออกจากตารางตามแบบใบส่งงาน (ไม่ถูกนับยอดรวม/ไม่ถูกปริ้นในใบส่งงาน) แสดงไว้ล่างสุดของแต่ละแท็บ
// พร้อมเหตุผล รถคันนั้นกลับไปอยู่ในคิวรอยื่นเอกสารแล้ว
function FailedTable({ rows }: { rows: DocumentSubmission[] }) {
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          ยื่นไม่สำเร็จ <span className="muted">· {rows.length} คัน</span>
        </h2>
      </div>
      {rows.length === 0 ? (
        <div className="empty-customers">ไม่มีรายการ</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>เลขตัวถัง</th>
                <th>ประเภทรถ</th>
                <th>เจ้าของงาน</th>
                <th>วันที่ยื่นเอกสาร</th>
                <th>ด่วน</th>
                <th>ยอดรวม (ไม่รวมอากร)</th>
                <th>เหตุผลที่ยื่นไม่สำเร็จ</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>{r.vehicle.chassis}</td>
                  <td>{r.vehicle.body || "—"}</td>
                  <td>{r.vehicle.customer.name}</td>
                  <td>{isoToDisplayDate(r.submitDate.slice(0, 10))}</td>
                  <td>{r.urgent ? <span className="badge warn">ด่วน</span> : "—"}</td>
                  <TotalCell record={r} />
                  <td style={{ whiteSpace: "normal", minWidth: 200 }}>{r.failRemark || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// หน้าดูข้อมูลที่ยื่นแล้ว: เลือกวันที่จากรายการวันที่ทั้งหมด (dates) แล้วแสดงรายการของวันนั้น (records) - โหลดทีละวันที่หน้า records
// (พบ 2026-09-27: เดิมโหลด 2,000 รายการล่าสุดแล้วสร้างวันที่เอง วันเก่าหาย วันที่อยู่ขอบพิมพ์ใบส่งงานไม่ครบ)
export function SubmittedRecordsView({
  dates,
  date,
  onDateChange,
  records,
  loading,
  loadError = "",
  onRetry,
  truncated = false,
  canCancel,
  onRecordRemoved,
}: {
  dates: Array<{ date: string; count: number }>;
  date: string; // "" = ยังไม่มีวันที่ให้เลือก
  onDateChange: (date: string) => void;
  records: DocumentSubmission[];
  loading: boolean;
  loadError?: string;
  onRetry?: () => void;
  truncated?: boolean; // วันนั้นมีรายการเกินที่โหลดมา
  canCancel?: (record: DocumentSubmission) => boolean; // ไม่ส่ง = ไม่มีปุ่มยกเลิก
  onRecordRemoved?: (id: string) => void;
}) {
  // แท็บอยู่ใน URL (?tab=moto) ให้กดย้อนกลับ/ส่งลิงก์ได้ (ผู้ใช้ 2026-09-25) - เปลี่ยนแค่ query จึงไม่ล้างตัวกรองวันที่/เจ้าของงาน
  // บัญชีที่เห็นแต่มอเตอร์ไซค์เปิดมาเจอแท็บมอเตอร์ไซค์ (พบ 2026-09-27: เดิมเจอแท็บรถยนต์ที่ว่างเปล่าทุกครั้ง)
  const pathname = usePathname();
  const tabParam = useSearchParams().get("tab");
  const defaultTab: Tab = useReadScope() === "MOTO" ? "moto" : "car";
  const tab: Tab = tabParam === "car" || tabParam === "moto" || tabParam === "unknown" ? tabParam : defaultTab;
  // รายการที่กำลังจะยกเลิก (เปิด SubmissionCancelDialog)
  const [cancelling, setCancelling] = useState<DocumentSubmission | null>(null);
  const onCancel = canCancel ? setCancelling : undefined;
  // เลือกยกเลิกรวม: เก็บเป็น id (ข้ามกลุ่ม/แท็บได้) ล้างเมื่อเปลี่ยนวันที่ ส่วนรายการที่หายไปจากตารางถูกกรองทิ้งตอนใช้
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCancelling, setBulkCancelling] = useState<{ title: string; rows: DocumentSubmission[] } | null>(null);
  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });
  const bulkProps = (title: string) =>
    onCancel ? { selected, onToggle: toggle, onBulkCancel: (rows: DocumentSubmission[]) => setBulkCancelling({ title, rows }) } : {};
  const [ownerChoice, setOwnerChoice] = useState("");
  // ใบส่งงานที่กำลังจะพิมพ์ (เปิด dialog) - แบบรถยนต์/มอเตอร์ไซค์ตามตัวอย่างที่ผู้ใช้ให้มา
  const [printGroup, setPrintGroup] = useState<{
    kind: JobSheetKind;
    urgent: boolean;
    title: string;
    rows: DocumentSubmission[];
    note: string;
  } | null>(null);

  // เจ้าของงานเลือกตามรหัสลูกค้า (ผู้ใช้ 2026-09-27: ใบยื่นใช้รหัสลูกค้าทุกหน้า) - ชื่อซ้ำต่อบริษัท · สาขาให้แยกออก
  const owners = useMemo(
    () =>
      Array.from(customerDisplayNames(records.map((r) => r.vehicle.customer)), ([id, label]) => ({ id, label })).sort((a, b) =>
        a.label.localeCompare(b.label, "th"),
      ),
    [records],
  );
  const owner = owners.some((o) => o.id === ownerChoice) ? ownerChoice : "";
  // คันที่ยื่นก่อนอยู่บนสุด (ตาราง + ใบส่งงานที่ปริ้นใช้ลำดับเดียวกัน)
  const filtered = useMemo(
    () => (owner ? records.filter((r) => r.vehicle.customer.id === owner) : records).slice().sort(compareSubmittedOrder),
    [records, owner],
  );

  // ยื่นไม่สำเร็จ (FAILED) แยกออกจากตารางตามแบบใบส่งงาน ไปอยู่ตารางล่างสุดของแท็บตัวเอง
  const byFamily = useMemo(() => {
    const groups: Record<Family, DocumentSubmission[]> = { car1: [], car23: [], moto: [], unknown: [] };
    for (const r of filtered) if (r.status !== "FAILED") groups[classify(r.vehicle.body)].push(r);
    return groups;
  }, [filtered]);
  const failedByTab = useMemo(() => {
    const groups: Record<Tab, DocumentSubmission[]> = { car: [], moto: [], unknown: [] };
    for (const r of filtered) {
      if (r.status !== "FAILED") continue;
      const family = classify(r.vehicle.body);
      groups[family === "car1" || family === "car23" ? "car" : family].push(r);
    }
    return groups;
  }, [filtered]);

  const carCount = byFamily.car1.length + byFamily.car23.length;
  const failedNote = (n: number) => (n > 0 ? ` (ยื่นไม่สำเร็จ ${n})` : "");
  const tabs: Array<[Tab, string]> = [
    ["car", `รถยนต์ (แบบ 1) · ${carCount} คัน${failedNote(failedByTab.car.length)}`],
    ["moto", `มอเตอร์ไซค์ (แบบ 2) · ${byFamily.moto.length} คัน${failedNote(failedByTab.moto.length)}`],
  ];
  if (byFamily.unknown.length > 0 || failedByTab.unknown.length > 0) {
    tabs.push(["unknown", `ไม่ระบุประเภทรถ · ${byFamily.unknown.length} คัน${failedNote(failedByTab.unknown.length)}`]);
  }
  const activeTab = tabs.some(([t]) => t === tab) ? tab : defaultTab;

  return (
    <>
      <section className="panel" style={{ padding: 22, marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 220 }}>
            วันที่ยื่นเอกสาร
            <select
              value={date}
              onChange={(e) => {
                setSelected(new Set());
                onDateChange(e.target.value);
              }}
              disabled={dates.length === 0}
            >
              {dates.length === 0 && <option value="">—</option>}
              {dates.map((d) => (
                <option key={d.date} value={d.date}>
                  {isoToDisplayDate(d.date) || d.date} ({d.count} คัน)
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 220 }}>
            เจ้าของงาน
            <select value={owner} onChange={(e) => setOwnerChoice(e.target.value)} disabled={loading}>
              <option value="">ทุกเจ้าของงาน</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <span className="muted" role="status">
            {loading ? "กำลังโหลด..." : loadError ? "" : `พบ ${filtered.length} คัน`}
          </span>
        </div>
        {truncated && !loading && (
          <p className="customer-message error" role="alert" style={{ margin: "14px 0 0" }}>
            วันที่ยื่น {isoToDisplayDate(date) || date} มีรายการมากกว่าที่แสดง - ตารางและใบส่งงานของวันที่นี้ยังไม่ครบ
          </p>
        )}
      </section>

      {loadError ? (
        <div className="empty-customers" role="alert">
          <p className="customer-message error" style={{ marginBottom: 12 }}>
            โหลดรายการที่ยื่นไม่สำเร็จ: {loadError}
          </p>
          {onRetry && (
            <button type="button" className="primary" disabled={loading} onClick={onRetry}>
              {loading ? "กำลังโหลด…" : "ลองใหม่"}
            </button>
          )}
        </div>
      ) : loading && records.length === 0 ? (
        <p className="muted">กำลังโหลด...</p>
      ) : !loading && dates.length === 0 ? (
        <p className="muted">ยังไม่มีข้อมูลที่ยื่นแล้ว</p>
      ) : (
        <>
          <PageTabs
            label="แบบใบส่งงาน"
            style={{ marginTop: 0, marginBottom: 20 }}
            tabs={tabs.map(([key, label]) => ({
              href: key === defaultTab ? pathname : `${pathname}?tab=${key}`,
              label,
              selected: activeTab === key,
            }))}
          />

          {activeTab === "car" && (
            <>
              {[
                { title: "รย.1 แบบธรรมดา", rows: byFamily.car1.filter((r) => !r.urgent), showUrgent: false, note: "", urgent: false },
                { title: "รย.1 แบบด่วน", rows: byFamily.car1.filter((r) => r.urgent), showUrgent: false, note: "ด่วน", urgent: true },
                { title: "รย.2 และ รย.3", rows: byFamily.car23, showUrgent: true, note: "", urgent: false },
              ].map((g) => (
                <GroupTable
                  key={g.title}
                  title={g.title}
                  rows={g.rows}
                  showUrgent={g.showUrgent}
                  onCancel={onCancel}
                  canCancel={canCancel}
                  {...bulkProps(g.title)}
                  onPrint={() => setPrintGroup({ kind: "car", urgent: g.urgent, title: g.title, rows: g.rows, note: g.note })}
                />
              ))}
              <FailedTable rows={failedByTab.car} />
            </>
          )}
          {activeTab === "moto" && (
            <>
              {[
                { title: "มอเตอร์ไซค์ แบบธรรมดา", rows: byFamily.moto.filter((r) => !r.urgent), urgent: false },
                { title: "มอเตอร์ไซค์ แบบด่วน", rows: byFamily.moto.filter((r) => r.urgent), urgent: true },
              ].map((g) => (
                <GroupTable
                  key={g.title}
                  title={g.title}
                  rows={g.rows}
                  showUrgent={false}
                  onCancel={onCancel}
                  canCancel={canCancel}
                  {...bulkProps(g.title)}
                  onPrint={() => setPrintGroup({ kind: "moto", urgent: g.urgent, title: g.title, rows: g.rows, note: "" })}
                />
              ))}
              <FailedTable rows={failedByTab.moto} />
            </>
          )}
          {activeTab === "unknown" && (
            <>
              <GroupTable title="ไม่ระบุประเภทรถ" rows={byFamily.unknown} showUrgent onCancel={onCancel} canCancel={canCancel} {...bulkProps("ไม่ระบุประเภทรถ")} />
              <FailedTable rows={failedByTab.unknown} />
            </>
          )}
        </>
      )}
      {cancelling && (
        <SubmissionCancelDialog
          key={cancelling.id}
          record={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={(id) => onRecordRemoved?.(id)}
          onStale={onRetry}
        />
      )}
      {bulkCancelling && (
        <SubmissionBulkCancelDialog
          key={bulkCancelling.rows.map((r) => r.id).join()}
          title={bulkCancelling.title}
          records={bulkCancelling.rows}
          onClose={() => setBulkCancelling(null)}
          onCancelled={(id) => {
            toggle([id], false);
            onRecordRemoved?.(id);
          }}
          onStale={onRetry}
        />
      )}
      {printGroup && (
        <JobSheetPrintDialog
          key={printGroup.title}
          kind={printGroup.kind}
          urgent={printGroup.urgent}
          groupTitle={printGroup.title}
          rows={printGroup.rows}
          defaultNote={printGroup.note}
          onClose={() => setPrintGroup(null)}
        />
      )}
    </>
  );
}
