"use client";

import { useMemo, useState } from "react";
import type { DocumentSubmission } from "@/lib/api";
import { ownerDisplayLabel } from "@/lib/vehicle-owner";
import { isoToDisplayDate } from "@/lib/date";
import { JobSheetPrintDialog } from "@/components/JobSheetPrintDialog";
import { SubmissionCancelDialog } from "@/components/SubmissionCancelDialog";
import type { JobSheetKind } from "@/lib/job-sheet-print";

function formatMoney(amount: number): string {
  return amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

// แยกตามแบบใบส่งงานที่ต้องปริ้นให้เจ้าหน้าที่: แบบ 1 = รถยนต์ (รย.1 แยกเอง, รย.2 + รย.3 รวมกัน),
// แบบ 2 = มอเตอร์ไซค์ทั้งหมด (รย.12) - "unknown" คือรถที่ไม่ได้ระบุประเภทรถ แสดงแยกไว้เพื่อไม่ให้หายไปเงียบๆ
type Family = "car1" | "car23" | "moto" | "unknown";

function classify(body: string | null): Family {
  if (!body) return "unknown";
  if (body.startsWith("รย.12-")) return "moto";
  if (body.startsWith("รย.1-")) return "car1";
  if (body.startsWith("รย.2-") || body.startsWith("รย.3-")) return "car23";
  return "unknown";
}

type Tab = "car" | "moto" | "unknown";

function recordTotal(r: DocumentSubmission): number {
  return Number(r.billFeeTotal) + Number(r.noBillTotal) + Number(r.taxAmount ?? 0);
}

// ตารางตามแบบใบส่งงานมีแค่ PENDING/RECEIPT_RECEIVED - FAILED แยกไปอยู่ FailedTable
function StatusBadge({ status }: { status: DocumentSubmission["status"] }) {
  if (status === "PENDING") return <span className="badge warn">รอใบเสร็จ</span>;
  return <span className="badge done">ได้รับใบเสร็จแล้ว</span>;
}

function GroupTable({
  title,
  rows,
  showUrgent,
  onPrint,
  onCancel,
}: {
  title: string;
  rows: DocumentSubmission[];
  showUrgent: boolean;
  onPrint?: () => void;
  onCancel?: (record: DocumentSubmission) => void;
}) {
  const total = rows.reduce((sum, r) => sum + recordTotal(r), 0);
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {title} <span className="muted">· {rows.length} คัน</span>
        </h2>
        {onPrint && (
          <button type="button" className="text-button" disabled={rows.length === 0} onClick={onPrint}>
            ปริ้นใบส่งงาน
          </button>
        )}
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
                <th>เจ้าของรถ</th>
                {showUrgent && <th>ด่วน</th>}
                <th>เลขทะเบียนที่ขอ</th>
                <th>ยอดรวม</th>
                <th>สถานะ</th>
                {onCancel && <th aria-label="ยกเลิก" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id}>
                  <td>{i + 1}</td>
                  <td>{r.vehicle.chassis}</td>
                  <td>{r.vehicle.body || "—"}</td>
                  <td>{r.vehicle.customer.name}</td>
                  <td>
                    {/* ไฟแนนซ์: owner.name = ชื่อไฟแนนซ์ (เจ้าของตามทะเบียน) จึงแสดง "ประเภทผู้เช่าซื้อ · ไฟแนนซ์ ชื่อ" */}
                    {ownerDisplayLabel(r.vehicle.owner, r.vehicle.owner?.name) ?? "ยังไม่ระบุ"}
                  </td>
                  {showUrgent && <td>{r.urgent ? <span className="badge warn">ด่วน</span> : "—"}</td>}
                  <td>{r.vehicle.plateCategory ? `${r.vehicle.plateCategory} ${r.vehicle.plateNumber ?? ""}` : "—"}</td>
                  <td>{formatMoney(recordTotal(r))} บาท</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  {onCancel && (
                    <td>
                      {/* ยกเลิกได้เฉพาะที่ยังรอใบเสร็จ ทั้งรถยนต์และจักรยานยนต์ - backend เช็กซ้ำ */}
                      {r.status === "PENDING" && (
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
        <span style={{ fontSize: 14, fontWeight: 500 }}>รวม</span>
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
                <th>ยอดรวม</th>
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
                  <td>{formatMoney(recordTotal(r))} บาท</td>
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

export function SubmittedRecordsView({
  records,
  loading,
  canCancel = false,
  onRecordRemoved,
}: {
  records: DocumentSubmission[];
  loading: boolean;
  canCancel?: boolean;
  onRecordRemoved?: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("car");
  // รายการที่กำลังจะยกเลิก (เปิด SubmissionCancelDialog)
  const [cancelling, setCancelling] = useState<DocumentSubmission | null>(null);
  const onCancel = canCancel ? setCancelling : undefined;
  // undefined = ยังไม่ได้เลือก -> ใช้วันที่ล่าสุดที่มีข้อมูล, "" = ทุกวันที่
  const [dateChoice, setDateChoice] = useState<string | undefined>(undefined);
  const [ownerChoice, setOwnerChoice] = useState("");
  // ใบส่งงานที่กำลังจะพิมพ์ (เปิด dialog) - แบบรถยนต์/มอเตอร์ไซค์ตามตัวอย่างที่ผู้ใช้ให้มา
  const [printGroup, setPrintGroup] = useState<{
    kind: JobSheetKind;
    urgent: boolean;
    title: string;
    rows: DocumentSubmission[];
    note: string;
  } | null>(null);

  const dateCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of records) {
      const d = r.submitDate.slice(0, 10);
      map.set(d, (map.get(d) ?? 0) + 1);
    }
    return map;
  }, [records]);
  const dates = useMemo(() => Array.from(dateCounts.keys()).sort().reverse(), [dateCounts]);
  const date = dateChoice === undefined ? (dates[0] ?? "") : dateChoice;

  const inDate = useMemo(() => (date ? records.filter((r) => r.submitDate.slice(0, 10) === date) : records), [records, date]);
  const owners = useMemo(() => Array.from(new Set(inDate.map((r) => r.vehicle.customer.name))).sort((a, b) => a.localeCompare(b, "th")), [inDate]);
  const owner = owners.includes(ownerChoice) ? ownerChoice : "";
  const filtered = useMemo(() => (owner ? inDate.filter((r) => r.vehicle.customer.name === owner) : inDate), [inDate, owner]);

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
  const activeTab = tabs.some(([t]) => t === tab) ? tab : "car";

  return (
    <>
      <section className="panel" style={{ padding: 22, marginBottom: 20 }}>
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 220 }}>
            วันที่ยื่นเอกสาร
            <select value={date} onChange={(e) => setDateChoice(e.target.value)} disabled={loading}>
              <option value="">ทุกวันที่</option>
              {dates.map((d) => (
                <option key={d} value={d}>
                  {isoToDisplayDate(d) || d} ({dateCounts.get(d)} คัน)
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 220 }}>
            เจ้าของงาน
            <select value={owner} onChange={(e) => setOwnerChoice(e.target.value)} disabled={loading}>
              <option value="">ทุกเจ้าของงาน</option>
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
          <span className="muted" role="status">
            {loading ? "กำลังโหลด..." : `พบ ${filtered.length} คัน`}
          </span>
        </div>
      </section>

      {!loading && records.length === 0 ? (
        <p className="muted">ยังไม่มีข้อมูลที่ยื่นแล้ว</p>
      ) : (
        <>
          <div className="vehicle-tabs" role="tablist" aria-label="แบบใบส่งงาน" style={{ marginTop: 0, marginBottom: 20 }}>
            {tabs.map(([key, label]) => (
              <button
                key={key}
                className={`vehicle-tab${activeTab === key ? " selected" : ""}`}
                role="tab"
                aria-selected={activeTab === key}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>

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
                  onPrint={() => setPrintGroup({ kind: "moto", urgent: g.urgent, title: g.title, rows: g.rows, note: "" })}
                />
              ))}
              <FailedTable rows={failedByTab.moto} />
            </>
          )}
          {activeTab === "unknown" && (
            <>
              <GroupTable title="ไม่ระบุประเภทรถ" rows={byFamily.unknown} showUrgent onCancel={onCancel} />
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
