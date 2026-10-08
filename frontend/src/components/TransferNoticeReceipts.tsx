"use client";

import { useRef, useState } from "react";
import { ApiError, type TransferNoticeVehicle } from "@/lib/api";
import { splitEvenly, transferReceiptsApi, type TransferReceiptDetail } from "@/lib/transfer-receipts-api";

// ใบเสร็จแจ้งย้ายในหน้าแจ้งย้าย/ตัดบัญชี (ผู้ใช้ 2026-10-08)
// - งานแจ้งย้าย (จดต่างจังหวัด) ต้องแนบใบเสร็จก่อนติ๊กดำเนินการแล้ว ยอดในใบเสร็จไปรวมในค่าธรรมเนียมของใบวางบิล
// - ใบเสร็จ 1 ใบผูกได้หลายคัน: ติ๊ก "เลือก" คันที่อยู่ในใบเดียวกัน แล้วแนบไฟล์ + กรอกยอดรวมครั้งเดียว ระบบหารเท่ากันต่อคัน
// - ถอดคันที่ติ๊กผิดออกจากใบ / แก้ยอดรวมของใบ ต้องมีเหตุผล

const money = (n: number) => n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const AMOUNT_RE = /^\d{1,7}(\.\d{1,2})?$/;

// ช่อง "ใบเสร็จแจ้งย้าย" ของแต่ละแถว
export function TransferReceiptCell({
  vehicle: v,
  canEdit,
  picked,
  onPick,
  onChanged,
}: {
  vehicle: TransferNoticeVehicle;
  canEdit: boolean;
  picked: boolean;
  onPick: (picked: boolean) => void;
  onChanged: () => void;
}) {
  const [error, setError] = useState("");
  if (!v.receiptRequired) return <span className="muted">ไม่ต้องแนบ</span>;
  if (!v.transferReceipt) {
    return (
      <div>
        <span className="badge warn">ยังไม่แนบ</span>
        {canEdit && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, fontSize: 12 }}>
            <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`เลือก ${v.chassis} เพื่อแนบใบเสร็จแจ้งย้าย`} />
            เลือกเพื่อแนบ
          </label>
        )}
      </div>
    );
  }
  const receipt = v.transferReceipt;
  return (
    <div style={{ fontSize: 12 }}>
      <div>
        <b>{v.transferBillCost === null || v.transferBillCost === undefined ? "—" : money(Number(v.transferBillCost))}</b> บาท
        {receipt.vehicleCount > 1 && <span className="muted"> · ใบรวม {receipt.vehicleCount} คัน ({money(Number(receipt.totalAmount))})</span>}
      </div>
      <button
        type="button"
        className="text-button"
        style={{ fontSize: 12, padding: 0 }}
        onClick={() => {
          setError("");
          transferReceiptsApi.openFile(receipt.id).catch((err) => setError(err instanceof ApiError ? err.message : "เปิดไฟล์ไม่สำเร็จ"));
        }}
      >
        ดูใบเสร็จ
      </button>
      {canEdit && (
        <>
          {" · "}
          <TransferReceiptManageButton receiptId={receipt.id} vehicle={v} onChanged={onChanged} />
        </>
      )}
      {error && (
        <div className="customer-message error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// ปุ่ม + หน้าต่างแนบใบเสร็จให้คันที่เลือกไว้ (1 ไฟล์ต่อ 1 ใบเสร็จ)
export function TransferReceiptAttachButton({ picked, onDone }: { picked: TransferNoticeVehicle[]; onDone: (message: string) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [totalText, setTotalText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [inputKey, setInputKey] = useState(0);

  function open() {
    setFile(null);
    setTotalText("");
    setError("");
    setInputKey((k) => k + 1);
    dialogRef.current?.showModal();
  }

  const total = AMOUNT_RE.test(totalText.trim()) ? Number(totalText.trim()) : null;
  const shares = total !== null && picked.length > 0 ? splitEvenly(total, picked.length) : null;

  async function save() {
    if (!file) return setError("เลือกไฟล์ใบเสร็จแจ้งย้าย (รูปหรือ PDF)");
    if (total === null) return setError("กรอกยอดรวมของใบเสร็จเป็นตัวเลข");
    setSaving(true);
    setError("");
    try {
      await transferReceiptsApi.attach(file, picked.map((v) => v.id), totalText.trim());
      dialogRef.current?.close();
      onDone(`แนบใบเสร็จแจ้งย้ายแล้ว ${picked.length} คัน - ติ๊กดำเนินการแล้วและบันทึกได้เลย`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "แนบใบเสร็จไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" className="primary" disabled={picked.length === 0} onClick={open}>
        แนบใบเสร็จแจ้งย้าย{picked.length > 0 ? ` (${picked.length} คัน)` : ""}
      </button>
      <dialog
        ref={dialogRef}
        style={{ width: "min(560px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !saving) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>แนบใบเสร็จแจ้งย้าย</h2>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          ใบเสร็จ 1 ใบต่อการแนบ 1 ครั้ง รถที่เลือกไว้ทั้งหมดต้องอยู่ในใบเสร็จใบนี้ ระบบหารยอดรวมเท่ากันต่อคัน
          ยอดนี้จะไปรวมในค่าธรรมเนียมของใบวางบิล
        </p>
        <div style={{ display: "grid", gap: 12 }}>
          <label className="field">
            ไฟล์ใบเสร็จ (รูปหรือ PDF) *
            <input key={inputKey} type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="field">
            ยอดรวมของใบเสร็จ (บาท) *
            <input
              type="text"
              inputMode="decimal"
              value={totalText}
              onChange={(e) => setTotalText(e.target.value.replace(/[^\d.]/g, ""))}
              style={{ width: 160 }}
            />
          </label>
          <div className="table-wrap" style={{ maxHeight: 220 }}>
            <table>
              <thead>
                <tr>
                  <th>เลขตัวถัง</th>
                  <th>ชื่อลูกค้า</th>
                  <th>จังหวัดที่จด</th>
                  <th style={{ textAlign: "right" }}>ยอดต่อคัน</th>
                </tr>
              </thead>
              <tbody>
                {picked.map((v, i) => (
                  <tr key={v.id}>
                    <td>{v.chassis}</td>
                    <td>{v.customerName}</td>
                    <td>{v.registrationProvince || "—"}</td>
                    <td style={{ textAlign: "right" }}>{shares ? money(shares[i]) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {error && (
          <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" className="primary" disabled={saving} onClick={save}>
            {saving ? "กำลังแนบ…" : `แนบกับ ${picked.length} คัน`}
          </button>
          <button type="button" className="text-button" disabled={saving} onClick={() => dialogRef.current?.close()}>
            ยกเลิก
          </button>
        </div>
      </dialog>
    </>
  );
}

// จัดการใบเสร็จที่แนบแล้ว: ดูว่าผูกกับคันไหนบ้าง แก้ยอดรวม (หารใหม่เท่ากัน) หรือถอดคันนี้ออกจากใบ - ต้องมีเหตุผล
function TransferReceiptManageButton({ receiptId, vehicle, onChanged }: { receiptId: string; vehicle: TransferNoticeVehicle; onChanged: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<TransferReceiptDetail | null>(null);
  const [totalText, setTotalText] = useState("");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function open() {
    setDetail(null);
    setRemark("");
    setError("");
    dialogRef.current?.showModal();
    try {
      const loaded = await transferReceiptsApi.get(receiptId);
      setDetail(loaded);
      setTotalText(String(loaded.totalAmount));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดใบเสร็จไม่สำเร็จ");
    }
  }

  async function run(action: () => Promise<unknown>) {
    if (!remark.trim()) return setError("ระบุเหตุผล");
    setSaving(true);
    setError("");
    try {
      await action();
      dialogRef.current?.close();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  function saveTotal() {
    if (!AMOUNT_RE.test(totalText.trim())) return setError("ยอดรวมของใบเสร็จต้องเป็นตัวเลข");
    void run(() => transferReceiptsApi.update(receiptId, { totalAmount: totalText.trim(), remark: remark.trim() }));
  }

  return (
    <>
      <button type="button" className="text-button" style={{ fontSize: 12, padding: 0 }} onClick={open}>
        จัดการ
      </button>
      <dialog
        ref={dialogRef}
        style={{ width: "min(560px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !saving) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>ใบเสร็จแจ้งย้าย</h2>
        {!detail ? (
          !error && <div className="empty-customers">กำลังโหลด…</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="table-wrap" style={{ maxHeight: 220 }}>
              <table>
                <thead>
                  <tr>
                    <th>เลขตัวถัง</th>
                    <th>ชื่อลูกค้า</th>
                    <th style={{ textAlign: "right" }}>ยอดต่อคัน</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.vehicles.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.chassis} {item.id === vehicle.id && <span className="badge warn">คันนี้</span>}
                      </td>
                      <td>{item.customerName}</td>
                      <td style={{ textAlign: "right" }}>{item.amount === null ? "—" : money(item.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label className="field">
              ยอดรวมของใบเสร็จ (บาท)
              <input
                type="text"
                inputMode="decimal"
                value={totalText}
                onChange={(e) => setTotalText(e.target.value.replace(/[^\d.]/g, ""))}
                style={{ width: 160 }}
              />
            </label>
            <label className="field">
              เหตุผล *
              <input type="text" maxLength={200} value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น พิมพ์ยอดผิด / ติ๊กผิดคัน" />
            </label>
            <p className="muted" style={{ fontSize: 12 }}>
              แก้ยอดรวม = ระบบหารใหม่เท่ากันทุกคันในใบ · ถอดคันนี้ = ยอดรวมคงเดิม หารใหม่ให้คันที่เหลือ (ถอดคันสุดท้าย = ลบใบเสร็จ)
              · คันที่ติ๊กดำเนินการแล้วต้องยกเลิกสถานะก่อนจึงถอดได้
            </p>
          </div>
        )}
        {error && (
          <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
          <button type="button" className="primary" disabled={saving || !detail} onClick={saveTotal}>
            บันทึกยอดรวม
          </button>
          <button
            type="button"
            className="text-button"
            disabled={saving || !detail}
            onClick={() => void run(() => transferReceiptsApi.detach(receiptId, { vehicleId: vehicle.id, remark: remark.trim() }))}
          >
            ถอดคันนี้ออกจากใบ
          </button>
          <button type="button" className="text-button" disabled={saving} onClick={() => dialogRef.current?.close()}>
            ปิด
          </button>
        </div>
      </dialog>
    </>
  );
}
