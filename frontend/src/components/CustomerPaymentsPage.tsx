"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api, ApiError, type Customer } from "@/lib/api";
import { ACCOUNT_LABEL } from "@/lib/billing-api";
import {
  customerPaymentsApi,
  parsePastedLines,
  type CustomerPayment,
  type MatchRow,
  type PaymentVehicleRow,
} from "@/lib/customer-payments-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, timestampToDisplayDate, todayIso } from "@/lib/date";
import { formatMoney, round2 } from "@/lib/invoice";
import { DateInput } from "@/components/DateInput";

// การจ่ายของลูกค้า (ผู้ใช้ 2026-09-27): SPI กำหนดเองว่าจ่ายคันไหนเท่าไร และราคายังตกลงกันอยู่ - บันทึกตามที่ลูกค้าจ่ายมาจริง
// (ยอดโอน + รายคันวางจาก Excel) แล้วดูตารางล้อกับรถที่ส่งงานแล้วว่าคันไหนได้เงินแล้ว/ยังไม่ได้ ไม่ผูกกับใบวางบิล
// ลูกค้าที่เลือกอยู่ใน URL (?customer=) ให้รีเฟรช/ย้อนกลับได้

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const moneyOf = (text: string): number | null => {
  const s = text.replace(/,/g, "").trim();
  if (s === "") return null;
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : Number.NaN;
};
const digits = (text: string) => text.replace(/\D/g, "").slice(0, 8);

// ตารางล้อเริ่มที่ 3 เดือนย้อนหลัง
function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}

export function CustomerPaymentsPage() {
  const router = useRouter();
  const pathname = usePathname();
  const customerParam = useSearchParams().get("customer") ?? "";
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadError, setLoadError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api
      .listCustomers()
      .then((r) => setCustomers(r.customers))
      .catch((err) => setLoadError(errorText(err, "โหลดรายชื่อลูกค้าไม่สำเร็จ")));
  }, []);

  const customer = customers.find((c) => c.id === customerParam) ?? null;
  const sorted = useMemo(() => [...customers].sort((a, b) => (a.company || a.name).localeCompare(b.company || b.name, "th")), [customers]);

  return (
    <section className="content">
      <h1 tabIndex={-1}>การจ่ายของลูกค้า</h1>
      <p>บันทึกเงินที่ลูกค้าโอนมาตามที่ลูกค้าแจ้งว่าจ่ายคันไหนเท่าไร แล้วดูตารางล้อกับรถที่ส่งงานแล้ว ว่าคันไหนได้เงินแล้วหรือยังไม่ได้</p>

      <section className="panel" style={{ marginTop: 16, padding: "16px 23px", overflow: "visible" }}>
        <label className="field" style={{ maxWidth: 420 }}>
          ลูกค้า
          <select
            value={customer?.id ?? ""}
            onChange={(e) => router.replace(e.target.value ? `${pathname}?customer=${encodeURIComponent(e.target.value)}` : pathname)}
          >
            <option value="">— เลือกลูกค้า —</option>
            {sorted.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company || c.name}
              </option>
            ))}
          </select>
        </label>
        {loadError && (
          <div className="customer-message error" role="alert">
            {loadError}
          </div>
        )}
      </section>

      {customer && (
        <Fragment key={customer.id}>
          <PaymentForm customerId={customer.id} onSaved={() => setReloadKey((n) => n + 1)} />
          <MirrorTable customerId={customer.id} reloadKey={reloadKey} />
          <PaymentHistory customerId={customer.id} reloadKey={reloadKey} onChanged={() => setReloadKey((n) => n + 1)} />
        </Fragment>
      )}
    </section>
  );
}

// ---------- บันทึกการจ่าย ----------
function PaymentForm({ customerId, onSaved }: { customerId: string; onSaved: () => void }) {
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [amountText, setAmountText] = useState("");
  const [whtText, setWhtText] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [pasted, setPasted] = useState("");
  const [matched, setMatched] = useState<{ text: string; rows: MatchRow[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  const parsed = useMemo(() => parsePastedLines(pasted), [pasted]);
  const badLines = parsed.filter((p) => p.amount === null);
  const linesTotal = round2(parsed.reduce((s, p) => s + (p.amount ?? 0), 0));
  const amount = moneyOf(amountText);
  const wht = moneyOf(whtText) ?? 0;
  // ยอดรายคันที่ลูกค้าแจ้งมักเป็นยอดก่อนหัก ณ ที่จ่าย: ยอดโอน + หัก ณ ที่จ่าย ควรเท่ากับยอดรวมรายคัน (เตือนเท่านั้น)
  const diff = amount !== null && Number.isFinite(amount) && parsed.length ? round2(amount + (Number.isFinite(wht) ? wht : 0) - linesTotal) : 0;
  const upToDate = matched?.text === pasted;

  async function handleCheck() {
    setMessage({ text: "" });
    if (!parsed.length) return setMessage({ text: "วางรายการรายคันก่อน", error: true });
    setBusy(true);
    try {
      const r = await customerPaymentsApi.match(
        customerId,
        parsed.map((p) => p.chassis),
      );
      setMatched({ text: pasted, rows: r.rows });
    } catch (err) {
      setMessage({ text: errorText(err, "ตรวจรายการไม่สำเร็จ"), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleSave() {
    const fail = (text: string) => setMessage({ text, error: true });
    const paidDate = displayDateToIso(digits(dateText));
    if (!paidDate) return fail("วันที่เงินเข้าไม่ถูกต้อง");
    if (amount === null || !Number.isFinite(amount) || amount <= 0) return fail("ใส่ยอดที่โอนเข้า");
    if (!Number.isFinite(wht)) return fail("ยอดหัก ณ ที่จ่ายไม่ถูกต้อง");
    if (badLines.length) return fail(`บรรทัดที่ ${badLines.map((b) => b.line).join(", ")} อ่านยอดไม่ได้ - แก้หรือลบก่อน`);
    if (parsed.length && !upToDate) return fail('กด "ตรวจรายการ" ก่อนบันทึก');
    setBusy(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const { payment } = await customerPaymentsApi.create({
        customerId,
        paidDate,
        amount,
        whtAmount: wht,
        reference: reference.trim() || null,
        note: note.trim() || null,
        lines: parsed.map((p) => ({ chassis: p.chassis, amount: p.amount! })),
      });
      setAmountText("");
      setWhtText("");
      setReference("");
      setNote("");
      setPasted("");
      setMatched(null);
      setMessage({ text: `บันทึกแล้ว ${formatMoney(payment.amount)} บาท${payment.lines.length ? ` · ${payment.lines.length} คัน` : ""} (${ACCOUNT_LABEL[payment.account]})` });
      onSaved();
    } catch (err) {
      fail(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20, padding: "20px 23px", overflow: "visible" }}>
      <h2 style={{ marginBottom: 14 }}>บันทึกการจ่าย</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14 }}>
        <label className="field">
          วันที่เงินเข้า
          <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigitsCe(digits(value)))} />
        </label>
        <label className="field">
          ยอดที่โอนเข้า (บาท) *
          <input type="text" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="25,000" />
        </label>
        <label className="field">
          หัก ณ ที่จ่าย (บาท)
          <input type="text" inputMode="decimal" value={whtText} onChange={(e) => setWhtText(e.target.value)} placeholder="เว้นว่าง = ไม่หัก" />
        </label>
        <label className="field">
          เลขที่อ้างอิง
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} placeholder="เช่น เลขที่เอกสารจ่ายของลูกค้า" />
        </label>
      </div>
      <label className="field" style={{ marginTop: 14 }}>
        หมายเหตุ
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      </label>
      <label className="field" style={{ marginTop: 14 }}>
        รายละเอียดรายคัน (ถ้าลูกค้าส่งมา)
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          ถ้าลูกค้าส่งรายการว่าจ่ายคันไหนเท่าไร ให้คัดลอก 2 คอลัมน์ (เลขตัวถัง กับ ยอดเงิน) จาก Excel มาวาง ระบบจะจับคู่กับรถในระบบให้ ไม่มีรายการก็เว้นว่าง บันทึกแค่ยอดโอนได้
        </span>
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={6}
          placeholder={"MR0AB12G300123456\t1,200\nMR0AB12G300123457\t1,200"}
          style={{ fontFamily: "monospace", fontSize: 13 }}
        />
      </label>
      {parsed.length > 0 && (
        <p style={{ fontSize: 13, marginTop: 6 }}>
          {parsed.length} คัน · รวมรายคัน {formatMoney(linesTotal)} บาท
          {diff !== 0 && (
            <span className="customer-message error" style={{ marginLeft: 8 }}>
              ยอดโอน + หัก ณ ที่จ่าย ต่างจากรวมรายคัน {formatMoney(diff)} บาท
            </span>
          )}
          {badLines.length > 0 && (
            <span className="customer-message error" style={{ marginLeft: 8 }}>
              อ่านยอดไม่ได้ บรรทัดที่ {badLines.map((b) => b.line).join(", ")}
            </span>
          )}
        </p>
      )}

      {matched && upToDate && <MatchTable parsed={parsed} rows={matched.rows} />}

      <div className="form-actions" style={{ marginTop: 14 }}>
        {parsed.length > 0 && (
          <button type="button" disabled={busy} onClick={handleCheck}>
            ตรวจรายการ
          </button>
        )}
        <button type="button" className="primary" disabled={busy} onClick={handleSave}>
          บันทึกการจ่าย
        </button>
        {message.text && (
          <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
            {message.text}
          </div>
        )}
      </div>
    </section>
  );
}

function MatchTable({ parsed, rows }: { parsed: ReturnType<typeof parsePastedLines>; rows: MatchRow[] }) {
  const notFound = rows.filter((r) => !r.vehicle).length;
  const paidBefore = rows.filter((r) => r.vehicle && r.vehicle.paidTotal > 0).length;
  return (
    <div style={{ marginTop: 12 }}>
      <p style={{ fontSize: 13 }}>
        เจอในระบบ {rows.length - notFound} คัน
        {notFound > 0 && <span className="customer-message error"> · ไม่พบ {notFound} คัน (ยังบันทึกได้ ระบบเก็บเลขตัวถังตามที่ลูกค้าแจ้ง)</span>}
        {paidBefore > 0 && <span className="customer-message error"> · เคยได้เงินแล้ว {paidBefore} คัน</span>}
      </p>
      <div className="table-wrap" style={{ maxHeight: 360, overflow: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>บรรทัด</th>
              <th>เลขตัวถัง (ลูกค้าแจ้ง)</th>
              <th>รถในระบบ</th>
              <th>วันที่ส่งงาน</th>
              <th style={{ textAlign: "right" }}>ยอดครั้งนี้</th>
              <th style={{ textAlign: "right" }}>เคยได้แล้ว</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{parsed[i]?.line}</td>
                <td style={{ fontFamily: "monospace" }}>{r.chassis}</td>
                <td>{r.vehicle ? `${r.vehicle.plateText || "ยังไม่มีทะเบียน"} · ${r.vehicle.brandName}` : <span className="customer-message error">ไม่พบ</span>}</td>
                <td>{r.vehicle?.deliveredDate ? isoToDisplayDate(r.vehicle.deliveredDate) : r.vehicle ? "ยังไม่ส่งงาน" : ""}</td>
                <td style={{ textAlign: "right" }}>{parsed[i]?.amount === null ? "—" : formatMoney(parsed[i]?.amount ?? 0)}</td>
                <td style={{ textAlign: "right" }}>{r.vehicle && r.vehicle.paidTotal > 0 ? <span className="customer-message error">{formatMoney(r.vehicle.paidTotal)}</span> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- ตารางล้อ ----------
type StatusFilter = "" | "unpaid" | "paid";

function MirrorTable({ customerId, reloadKey }: { customerId: string; reloadKey: number }) {
  const [fromText, setFromText] = useState(isoToDisplayDate(monthsAgoIso(3)));
  // ไม่จำกัดวันสุดท้าย: วันที่ส่งงานบางคันถูกคีย์เป็นวันถัดไป (พบในข้อมูลจริง 2026-09-27) - ตั้งถึงวันนี้แล้วคันเหล่านั้นหาย
  const [toText, setToText] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [data, setData] = useState<{ vehicles: PaymentVehicleRow[]; truncated: boolean } | null>(null);
  const [error, setError] = useState("");
  const from = displayDateToIso(digits(fromText));
  const to = displayDateToIso(digits(toText));

  useEffect(() => {
    let alive = true;
    customerPaymentsApi
      .vehicles({ customerId, from: from || undefined, to: to || undefined, status: status || undefined })
      .then((r) => {
        if (!alive) return;
        setData(r);
        setError("");
      })
      .catch((err) => alive && setError(errorText(err, "โหลดตารางไม่สำเร็จ")));
    return () => {
      alive = false;
    };
  }, [customerId, from, to, status, reloadKey]);

  const vehicles = data?.vehicles ?? [];
  const paidCount = vehicles.filter((v) => v.paidTotal > 0).length;
  const paidSum = round2(vehicles.reduce((s, v) => s + v.paidTotal, 0));

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>ตารางล้อ: รถที่ส่งงานแล้ว</h2>
        <span className="muted">
          {vehicles.length} คัน · ได้เงินแล้ว {paidCount} · ยังไม่ได้ {vehicles.length - paidCount} · รวมที่ได้ {formatMoney(paidSum)} บาท
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "end", padding: "0 23px 14px" }}>
        <label className="field">
          ส่งงานตั้งแต่
          <DateInput value={fromText} onChange={(value) => setFromText(formatDateDigitsCe(digits(value)))} />
        </label>
        <label className="field">
          ถึง
          <DateInput value={toText} onChange={(value) => setToText(formatDateDigitsCe(digits(value)))} />
        </label>
        <div className="inspect-filter" style={{ padding: 0 }}>
          {(
            [
              ["", "ทั้งหมด"],
              ["unpaid", "ยังไม่ได้เงิน"],
              ["paid", "ได้เงินแล้ว"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} className={`filter-chip${status === key ? " selected" : ""}`} onClick={() => setStatus(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <div className="customer-message error" role="alert" style={{ padding: "0 23px 14px" }}>
          {error}
        </div>
      )}
      {data?.truncated && (
        <div className="customer-message error" role="status" style={{ padding: "0 23px 14px" }}>
          แสดง 1,000 คันแรก - ย่อช่วงวันที่เพื่อดูครบ
        </div>
      )}
      {!data ? (
        <div className="empty-customers">กำลังโหลด...</div>
      ) : vehicles.length === 0 ? (
        <div className="empty-customers">ไม่มีรถในช่วงนี้</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ส่งงาน</th>
                <th>ทะเบียน</th>
                <th>เลขตัวถัง</th>
                <th>ยี่ห้อ</th>
                <th>เลขที่ใบเสร็จ</th>
                <th style={{ textAlign: "right" }}>ค่าใบเสร็จ</th>
                <th style={{ textAlign: "right" }}>ลูกค้าจ่ายแล้ว</th>
                <th>จ่ายล่าสุด</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => (
                <tr key={v.id}>
                  <td>{v.deliveredDate ? isoToDisplayDate(v.deliveredDate) : "—"}</td>
                  <td>{v.plateText || "—"}</td>
                  <td style={{ fontFamily: "monospace" }}>{v.chassis}</td>
                  <td>{v.brandName}</td>
                  <td>{v.receiptNo ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{v.receiptAmount === null ? "—" : formatMoney(v.receiptAmount)}</td>
                  <td style={{ textAlign: "right" }}>
                    {v.paidTotal > 0 ? formatMoney(v.paidTotal) : "—"}
                    {v.paymentCount > 1 && <span className="muted"> ({v.paymentCount} ครั้ง)</span>}
                  </td>
                  <td>{v.lastPaidDate ? isoToDisplayDate(v.lastPaidDate) : "—"}</td>
                  <td>
                    {v.paidTotal > 0 ? "ได้เงินแล้ว" : <span className="customer-message error">ยังไม่ได้</span>}
                    {v.invoiceNo && <span className="muted"> · บิล {v.invoiceNo}</span>}
                    {v.billingClosed && <span className="muted"> · ปิดงาน</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- ประวัติการจ่าย ----------
function PaymentHistory({ customerId, reloadKey, onChanged }: { customerId: string; reloadKey: number; onChanged: () => void }) {
  const [payments, setPayments] = useState<CustomerPayment[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<CustomerPayment | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    customerPaymentsApi
      .list(customerId)
      .then((r) => {
        if (!alive) return;
        setPayments(r.payments);
        setHasMore(r.hasMore);
      })
      .catch((err) => alive && setError(errorText(err, "โหลดประวัติไม่สำเร็จ")));
    return () => {
      alive = false;
    };
  }, [customerId, reloadKey]);

  async function loadMore() {
    try {
      const r = await customerPaymentsApi.list(customerId, payments?.length ?? 0);
      setPayments((prev) => [...(prev ?? []), ...r.payments]);
      setHasMore(r.hasMore);
    } catch (err) {
      setError(errorText(err, "โหลดเพิ่มไม่สำเร็จ"));
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>ประวัติการจ่าย</h2>
      </div>
      {error && (
        <div className="customer-message error" role="alert" style={{ padding: "0 23px 14px" }}>
          {error}
        </div>
      )}
      {!payments ? (
        <div className="empty-customers">กำลังโหลด...</div>
      ) : payments.length === 0 ? (
        <div className="empty-customers">ยังไม่มีการจ่ายที่บันทึกไว้</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>วันที่เงินเข้า</th>
                <th>บัญชี</th>
                <th style={{ textAlign: "right" }}>ยอดโอน</th>
                <th style={{ textAlign: "right" }}>หัก ณ ที่จ่าย</th>
                <th style={{ textAlign: "right" }}>รายคัน</th>
                <th>อ้างอิง / หมายเหตุ</th>
                <th>ผู้บันทึก</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <Fragment key={p.id}>
                  <tr style={p.cancelledAt ? { opacity: 0.55, textDecoration: "line-through" } : undefined}>
                    <td>{p.paidDate ? isoToDisplayDate(p.paidDate) : "—"}</td>
                    <td>{ACCOUNT_LABEL[p.account]}</td>
                    <td style={{ textAlign: "right" }}>{formatMoney(p.amount)}</td>
                    <td style={{ textAlign: "right" }}>{p.whtAmount ? formatMoney(p.whtAmount) : "—"}</td>
                    <td style={{ textAlign: "right" }}>{p.lines.length ? `${p.lines.length} คัน · ${formatMoney(p.linesTotal)}` : "ยอดรวมอย่างเดียว"}</td>
                    <td>{[p.reference, p.note].filter(Boolean).join(" · ") || "—"}</td>
                    <td>
                      {p.createdBy ?? "—"}
                      <span className="muted"> · {timestampToDisplayDate(p.createdAt)}</span>
                    </td>
                    <td style={{ whiteSpace: "nowrap", textDecoration: "none" }}>
                      {p.lines.length > 0 && (
                        <button className="text-button" onClick={() => setOpen(open === p.id ? null : p.id)}>
                          {open === p.id ? "ซ่อนรายคัน" : "ดูรายคัน"}
                        </button>
                      )}
                      {!p.cancelledAt && (
                        <button className="text-button" onClick={() => setCancelling(p)}>
                          ยกเลิก
                        </button>
                      )}
                    </td>
                  </tr>
                  {p.cancelledAt && (
                    <tr>
                      <td colSpan={8} className="muted" style={{ fontSize: 12 }}>
                        ยกเลิกแล้ว{p.cancelledBy ? ` โดย ${p.cancelledBy}` : ""} · {p.cancelReason}
                      </td>
                    </tr>
                  )}
                  {open === p.id && (
                    <tr>
                      <td colSpan={8} style={{ background: "#f8f9fc" }}>
                        <table>
                          <tbody>
                            {p.lines.map((l) => (
                              <tr key={l.id}>
                                <td style={{ fontFamily: "monospace" }}>{l.chassis}</td>
                                <td>{l.vehicleId ? `${l.plateText || "ยังไม่มีทะเบียน"} · ${l.brandName ?? ""}` : <span className="customer-message error">ไม่พบในระบบ</span>}</td>
                                <td style={{ textAlign: "right" }}>{formatMoney(l.amount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasMore && (
        <div style={{ padding: "12px 23px" }}>
          <button className="text-button" onClick={loadMore}>
            โหลดเพิ่ม
          </button>
        </div>
      )}
      {cancelling && (
        <CancelPaymentDialog
          payment={cancelling}
          onClose={() => setCancelling(null)}
          onDone={() => {
            setCancelling(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function CancelPaymentDialog({ payment, onClose, onDone }: { payment: CustomerPayment; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function handleConfirm() {
    if (!remark.trim()) return setError("ใส่เหตุผลที่ยกเลิก");
    setSaving(true);
    setError("");
    try {
      await customerPaymentsApi.cancel(payment.id, remark.trim());
      onDone();
    } catch (err) {
      setError(errorText(err, "ยกเลิกไม่สำเร็จ"));
      setSaving(false);
    }
  }

  return (
    <dialog ref={ref} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => ref.current?.close()}>
        ×
      </button>
      <h2>ยกเลิกการจ่าย</h2>
      <p className="muted">
        {payment.paidDate ? isoToDisplayDate(payment.paidDate) : ""} · {formatMoney(payment.amount)} บาท{payment.lines.length ? ` · ${payment.lines.length} คัน` : ""}
      </p>
      <p style={{ fontSize: 13, marginTop: 8 }}>ใช้เมื่อบันทึกผิด รายการยังอยู่ในประวัติแบบขีดฆ่า และยอดรายคันหลุดจากตารางล้อ</p>
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผล *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} placeholder="เช่น คีย์ยอดผิด" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => ref.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "ยกเลิกการจ่าย"}
        </button>
      </div>
    </dialog>
  );
}
