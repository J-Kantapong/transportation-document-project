"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { billingApi, slipNoText, type DeliverySlip, type DeliverySlipItem } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

// แก้ / ยกเลิกใบส่งงานที่คีย์ผิด (ผู้ใช้ 2026-09-26) - ต้องมีเหตุผลเสมอ (เก็บในประวัติการแก้ไขของรถ)
// ยกเลิกแล้วรถกลับเข้าคิว Delivery ให้บันทึกใหม่ได้ ส่วนใบ/รายการที่ยกเลิกยังอยู่ในรายงานพร้อมเหตุผล (ไม่ลบ)

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);
// backend ตอบปฏิเสธ (มีคนแก้/ยกเลิก/ส่งไปก่อน ฯลฯ) = รายการในหน้าหลักอาจเก่า -> onRefused ให้หน้าหลักโหลดใหม่เบื้องหลัง (พบ 2026-09-27)
const refusedByServer = (err: unknown) => err instanceof ApiError && err.status !== undefined;

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return ref;
}

export function DeliverySlipEditDialog({
  slip,
  onClose,
  onSaved,
  onRefused,
}: {
  slip: DeliverySlip;
  onClose: () => void;
  onSaved: (slip: DeliverySlip) => void;
  onRefused?: () => void;
}) {
  const dialogRef = useModal();
  const [recipient, setRecipient] = useState(slip.recipient);
  const [dateText, setDateText] = useState(isoToDisplayDate(slip.date));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // บิลเก็บเฉพาะวันส่งเล่ม - รายการส่งป้ายตามทีหลังเปลี่ยนวันที่ได้แม้วางบิลแล้ว (ผู้ใช้ 2026-09-27)
  const billed = slip.items.filter((i) => !i.cancelledAt && i.book && i.invoiceNo);
  // ปิดงาน - วางบิลนอกระบบ ล็อกวันที่ส่งเล่มเหมือนวางบิลแล้ว (2026-09-27)
  const closed = slip.items.filter((i) => !i.cancelledAt && i.book && !i.invoiceNo && i.billingClosed);

  async function handleSave() {
    setError("");
    const date = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!recipient.trim()) return setError("ต้องใส่ชื่อผู้รับงาน");
    if (!date) return setError("วันที่ไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่แก้");
    setSaving(true);
    try {
      const saved = await billingApi.updateDeliverySlip(slip.id, { recipient: recipient.trim(), date, remark: remark.trim() });
      onSaved(saved);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "แก้ใบส่งงานไม่สำเร็จ"));
      if (refusedByServer(err)) onRefused?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แก้ใบส่งงาน {slipNoText(slip.slipNo)}</h2>
      <p className="muted">
        {slip.customer.displayName} · {slip.items.filter((i) => !i.cancelledAt).length} คัน
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        ผู้รับงาน *
        <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
      </label>
      <label className="field" style={{ marginTop: 12 }}>
        วันที่ส่ง *
        <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
      </label>
      {billed.length > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          มีรถวางบิลแล้ว {billed.length} คัน ({billed.map((i) => i.invoiceNo).join(", ")}) - เปลี่ยนวันที่ส่งไม่ได้ แก้ได้เฉพาะชื่อผู้รับ
          (ถ้าต้องเปลี่ยนวันที่ ให้ฝ่ายบัญชีเอารถออกจากบิลก่อนด้วย &quot;แก้ไขบิล&quot;)
        </p>
      )}
      {closed.length > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          มีรถปิดงาน - วางบิลนอกระบบแล้ว {closed.length} คัน - เปลี่ยนวันที่ส่งไม่ได้จนกว่า ADMIN เปิดงานกลับ แก้ได้เฉพาะชื่อผู้รับ
        </p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น พิมพ์ชื่อผู้รับผิด" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={handleSave} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "บันทึกการแก้"}
        </button>
      </div>
    </dialog>
  );
}

export function DeliverySlipCancelDialog({
  slip,
  editable = () => true,
  onClose,
  onCancelled,
  onRefused,
}: {
  slip: DeliverySlip;
  // คันที่บัญชีนี้ยกเลิกได้ (ขอบเขตการแก้) - ใบเก่าที่รวมรถยนต์ + จักรยานยนต์ คันอีกประเภทติ๊กไม่ได้
  // backend ตรวจรายคันที่เลือกอยู่แล้ว (DeliveryService.cancelSlip) ไม่ส่ง = ทุกคัน
  editable?: (item: DeliverySlipItem) => boolean;
  onClose: () => void;
  onCancelled: (slip: DeliverySlip) => void;
  onRefused?: () => void;
}) {
  const dialogRef = useModal();
  const items = slip.items.filter((i) => !i.cancelledAt);
  // วางบิลแล้วล็อกเฉพาะรายการส่งเล่ม - ใบส่งป้ายตามทีหลังยกเลิกได้ (ผู้ใช้ 2026-09-27)
  const locked = (i: DeliverySlipItem) => i.book && (!!i.invoiceNo || i.billingClosed);
  const mine = items.filter(editable);
  const [picked, setPicked] = useState(() => new Set(mine.filter((i) => !locked(i)).map((i) => i.vehicleId)));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // ไม่มีคันที่ยกเลิกได้: [].every = true จึงต้องเช็กว่ามีคันก่อน (พบ 2026-09-27: ใบที่ยกเลิกครบทุกคันที่เห็นแล้วขึ้นว่า "วางบิลแล้วทุกคัน")
  const noneMine = mine.length === 0;
  const allBilled = !noneMine && mine.every(locked);
  const blocked = noneMine || allBilled;

  function toggle(vehicleId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(vehicleId)) next.delete(vehicleId);
      else next.add(vehicleId);
      return next;
    });
  }

  async function handleConfirm() {
    setError("");
    if (picked.size === 0) return setError("เลือกรถที่จะยกเลิกอย่างน้อย 1 คัน");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่ยกเลิก");
    setSaving(true);
    try {
      const saved = await billingApi.cancelDeliverySlip(slip.id, { vehicleIds: [...picked], remark: remark.trim() });
      onCancelled(saved);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "ยกเลิกไม่สำเร็จ"));
      if (refusedByServer(err)) onRefused?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(560px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ยกเลิกการส่งงาน {slipNoText(slip.slipNo)}</h2>
      <p className="muted">
        {isoToDisplayDate(slip.date)} · {slip.customer.displayName} · ผู้รับ {slip.recipient}
      </p>
      {noneMine ? (
        <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
          ไม่มีรถในใบนี้ที่บัญชีของคุณยกเลิกได้ - ให้ ADMIN หรือพนักงานประเภทรถนั้นยกเลิก
        </p>
      ) : allBilled ? (
        <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
          {mine.length < items.length ? "รถประเภทที่บัญชีนี้ดูแลในใบนี้" : "รถในใบนี้"}วางบิลแล้ว (หรือปิดงาน - วางบิลนอกระบบ) ทุกคัน ต้องให้ฝ่ายบัญชีเอารถออกจากบิล
          (&quot;แก้ไขบิล&quot; ติ๊ก &quot;เอาออกจากบิล&quot;) / ให้ ADMIN เปิดงานกลับก่อนจึงจะยกเลิกการส่งได้
        </p>
      ) : (
        <>
          <p style={{ marginTop: 12 }}>เลือกคันที่จะยกเลิก รถจะกลับเข้าคิว Delivery เพื่อบันทึกส่งใหม่ ใบนี้ยังเก็บไว้พร้อมเหตุผล</p>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {items.map((i) => {
              const other = !editable(i);
              return (
                <label key={i.vehicleId} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={picked.has(i.vehicleId)} disabled={other || locked(i)} onChange={() => toggle(i.vehicleId)} />
                  <span>
                    {i.plateText || "—"} · {i.chassis}
                    {i.book ? "" : " (ใบส่งป้าย)"}
                    {other ? (
                      <span className="muted"> · รถอีกประเภท - ให้ ADMIN หรือพนักงานประเภทนั้นยกเลิก</span>
                    ) : locked(i) ? (
                      <span className="muted">
                        {i.invoiceNo
                          ? ` · วางบิลแล้ว ${i.invoiceNo} ยกเลิกไม่ได้จนกว่าฝ่ายบัญชีเอารถออกจากบิล ("แก้ไขบิล")`
                          : " · ปิดงาน - วางบิลนอกระบบแล้ว ยกเลิกไม่ได้จนกว่า ADMIN เปิดงานกลับ"}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
          <label className="field" style={{ marginTop: 12 }}>
            เหตุผลที่ยกเลิก *
            <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ติ๊กผิดคัน" />
          </label>
        </>
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ไม่ยกเลิก
        </button>
        {!blocked && (
          <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
            {saving ? "กำลังยกเลิก..." : `ยืนยันยกเลิก ${picked.size} คัน`}
          </button>
        )}
      </div>
    </dialog>
  );
}

// ป้ายไปพร้อมเล่มแล้ว (ผู้ใช้ 2026-09-27): ใบส่งเล่มที่บันทึกว่าป้ายตามทีหลัง แต่จริงๆ ป้ายไปกับเล่ม (แนบรูปป้ายทีหลัง)
// ติ๊กป้ายในใบเดิม วันที่ส่งป้าย = วันที่ในใบ - หมายเหตุไม่บังคับ (ระบบบันทึกประวัติการแก้ไขให้เอง) ทำกับคันที่วางบิลแล้วได้
export function DeliveryAddPlateDialog({
  vehicle,
  slip,
  onClose,
  onSaved,
  onRefused,
}: {
  vehicle: { id: string; chassis: string; plateText: string; customerName: string };
  slip: { id: string; slipNo: number; date: string };
  onClose: () => void;
  onSaved: (slip: DeliverySlip) => void;
  onRefused?: () => void;
}) {
  const dialogRef = useModal();
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const slipText = `${slipNoText(slip.slipNo)} วันที่ ${isoToDisplayDate(slip.date)}`;

  async function handleConfirm() {
    setError("");
    setSaving(true);
    try {
      const saved = await api.addPlateToDeliverySlip(slip.id, { vehicleId: vehicle.id, remark: remark.trim() || undefined });
      onSaved(saved);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
      // เช่น อีกคนบันทึกส่งป้ายไปก่อน - แถวนี้และปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ในรายงานต้องเปลี่ยนตามข้อมูลจริง
      if (refusedByServer(err)) onRefused?.();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ป้ายไปพร้อมเล่มแล้ว</h2>
      <p className="muted">
        {vehicle.customerName} · {vehicle.plateText || "—"} · {vehicle.chassis}
      </p>
      <p style={{ marginTop: 12 }}>
        ป้ายของรถคันนี้ไปพร้อมเล่มใน <b>ใบส่งงาน {slipText}</b> แล้วใช่ไหม
      </p>
      <p className="muted" style={{ marginTop: 8 }}>
        ระบบจะติ๊กป้ายในใบ {slipNoText(slip.slipNo)} และบันทึกวันที่ส่งป้ายเป็น {isoToDisplayDate(slip.date)} (ถ้าวันที่รับป้ายที่บันทึกไว้หลังวันนั้น
        จะปรับวันที่รับป้ายเป็น {isoToDisplayDate(slip.date)} ด้วย) - ถ้าป้ายยังอยู่ที่ร้าน ให้กด
        &quot;บันทึกส่งป้าย&quot; แล้วบันทึกที่หน้า Delivery แทน
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        หมายเหตุ (ไม่บังคับ)
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น แนบรูปป้ายช้า" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ไม่ใช่
        </button>
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "ยืนยัน ป้ายไปพร้อมเล่มแล้ว"}
        </button>
      </div>
    </dialog>
  );
}
