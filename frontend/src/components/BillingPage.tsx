"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type BillingCustomer, type BillingVehicle, type Invoice } from "@/lib/billing-api";
import { BillingInvoiceList } from "@/components/BillingInvoiceList";
import { BillingRatesEditor, BillingTermsEditor } from "@/components/BillingCustomerSettings";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { computeTotals, formatMoney, round2, termsSummary } from "@/lib/invoice";
import { buildInvoiceHtml, printInvoice, type PrintableInvoice } from "@/lib/invoice-print";
import { comparePlate } from "@/lib/plate-order";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";

// พื้นที่ทำงานบัญชี: วางบิลในนามบริษัท - รถที่พนักงานบันทึกส่งงานแล้วมารอที่นี่ บัญชีเลือกคัน ตรวจค่าดำเนินการ แล้วออกใบวางบิล
// (ผู้ใช้ 2026-09-21) ทุกรายการที่ไม่ใช่ค่าใบเสร็จกรมขนส่งคิด VAT + หัก ณ ที่จ่าย, เลขที่ IV พิมพ์เองเพราะยังรันเลขร่วมกับ Google Sheet
// ค่าขอใช้เลข 500 บาทที่ลูกค้าชำระเองแล้ว ยังอยู่ในใบเสร็จที่เรียกเก็บเต็ม จึงหักคืนจากค่าดำเนินการของคันนั้น
const PLATE_REQUEST_DEDUCTION = 500;
const PLATE_REQUEST_NOTE = "ลูกค้าชำระค่าขอใช้เลขเอง";

interface RowState {
  checked: boolean;
  receiptText: string;
  serviceText: string;
  label: string;
  deduct: boolean;
}

interface ExtraState {
  label: string;
  amountText: string;
}

const money = (text: string): number | null => {
  const n = Number.parseFloat(text.replace(/,/g, ""));
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

const plateText = (v: BillingVehicle) => (v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : "");

const newRow = (v: BillingVehicle): RowState => ({
  checked: false,
  receiptText: v.receiptAmount === null ? "" : formatMoney(v.receiptAmount),
  serviceText: v.suggestedServiceFee === null ? "" : formatMoney(v.suggestedServiceFee),
  label: "",
  deduct: false,
});

function defaultJobLabel(vehicles: BillingVehicle[]): string {
  if (vehicles.length > 0 && vehicles.every((v) => v.isMoto)) return "จดทะเบียนรถจักรยานยนต์";
  if (vehicles.length > 0 && vehicles.every((v) => !v.isMoto)) return "จดทะเบียนรถยนต์";
  return "จดทะเบียนรถ";
}

export function BillingPage() {
  const [customers, setCustomers] = useState<BillingCustomer[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [customerId, setCustomerId] = useState("");
  const focusApplied = useRef(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [extras, setExtras] = useState<ExtraState[]>([]);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [issueDateText, setIssueDateText] = useState(isoToDisplayDate(todayIso()));
  const [jobLabelEdit, setJobLabelEdit] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<"" | "terms" | "rates">("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  async function loadAll(keepInvoiceNo = false) {
    setLoading(true);
    try {
      const [q, inv] = await Promise.all([billingApi.billingQueue(), billingApi.listInvoices()]);
      setCustomers(q.customers);
      setInvoices(inv.invoices);
      // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): เลือกลูกค้าของรถคันนั้นให้ - ครั้งแรกที่โหลดเท่านั้น (lib/vehicle-focus.ts)
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const owner = chassis ? q.customers.find((c) => c.vehicles.some((v) => sameChassis(v.chassis, chassis))) : undefined;
        if (owner) setCustomerId(owner.id);
      }
      setRows(Object.fromEntries(q.customers.flatMap((c) => c.vehicles.map((v) => [v.id, newRow(v)]))));
      setExtras([]);
      setJobLabelEdit(null);
      if (!keepInvoiceNo) setInvoiceNo(q.suggestedInvoiceNo);
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ", error: true });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadAll sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, []);

  const customer = customers.find((c) => c.id === customerId) ?? customers[0] ?? null;
  const vehicles = useMemo(
    () => (customer ? [...customer.vehicles].sort((a, b) => a.deliveredDate.localeCompare(b.deliveredDate) || comparePlate(a, b)) : []),
    [customer],
  );
  const selected = vehicles.filter((v) => rows[v.id]?.checked);
  const issueDateIso = displayDateToIso(issueDateText.replace(/\D/g, ""));
  const jobLabel = jobLabelEdit ?? defaultJobLabel(selected.length ? selected : vehicles);

  const serviceFeeOf = (v: BillingVehicle): number | null => {
    const row = rows[v.id];
    const base = row ? money(row.serviceText) : null;
    if (base === null) return null;
    const fee = round2(base - (row.deduct ? PLATE_REQUEST_DEDUCTION : 0));
    return fee >= 0 ? fee : null;
  };

  const draftLines = selected.map((v) => ({
    vehicle: v,
    receiptAmount: money(rows[v.id].receiptText),
    serviceFee: serviceFeeOf(v),
    serviceLabel: rows[v.id].label.trim() || null,
    deduction: rows[v.id].deduct ? PLATE_REQUEST_DEDUCTION : 0,
  }));
  const draftExtras = extras.map((e) => ({ label: e.label.trim(), amount: money(e.amountText) }));
  const totals = customer
    ? computeTotals(
        draftLines.map((l) => ({ receiptAmount: l.receiptAmount ?? 0, serviceFee: l.serviceFee ?? 0 })),
        draftExtras.map((e) => ({ amount: e.amount ?? 0 })),
        customer.terms,
        issueDateIso || todayIso(),
      )
    : null;

  const preview: PrintableInvoice | null =
    customer && totals && selected.length > 0
      ? {
          invoiceNo,
          issueDate: issueDateIso || todayIso(),
          customer: { name: customer.company || customer.name, branch: customer.branch, address: customer.address, taxId: customer.taxId },
          jobLabel,
          extras: draftExtras.filter((e) => e.label && e.amount !== null).map((e) => ({ label: e.label, amount: e.amount! })),
          vatRate: totals.vatRate,
          whtRate: totals.whtRate,
          feeTotal: totals.feeTotal,
          serviceTotal: totals.serviceTotal,
          vatAmount: totals.vatAmount,
          whtAmount: totals.whtAmount,
          netTotal: totals.netTotal,
          lines: draftLines.map((l) => ({
            id: l.vehicle.id,
            vehicleId: l.vehicle.id,
            chassis: l.vehicle.chassis,
            brandName: l.vehicle.brandName,
            body: l.vehicle.body,
            plateText: plateText(l.vehicle),
            receiptNo: l.vehicle.receiptNo,
            deliveredDate: l.vehicle.deliveredDate,
            receiptAmount: l.receiptAmount ?? 0,
            serviceFee: l.serviceFee ?? 0,
            serviceLabel: l.serviceLabel,
            deduction: l.deduction,
            deductionNote: l.deduction ? PLATE_REQUEST_NOTE : null,
          })),
        }
      : null;

  function patchRow(id: string, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  function setChecked(ids: string[], checked: boolean) {
    setRows((prev) => ({ ...prev, ...Object.fromEntries(ids.map((id) => [id, { ...prev[id], checked }])) }));
  }

  function chooseCustomer(id: string) {
    setChecked(vehicles.map((v) => v.id), false);
    setCustomerId(id);
    setExtras([]);
    setJobLabelEdit(null);
    setSettingsOpen("");
    setMessage({ text: "" });
  }

  function patchCustomer(patch: Partial<BillingCustomer>) {
    if (!customer) return;
    setCustomers((prev) => prev.map((c) => (c.id === customer.id ? { ...c, ...patch } : c)));
  }

  async function handleIssue() {
    if (!customer) return;
    const fail = (text: string) => setMessage({ text, error: true });
    if (selected.length === 0) return fail("เลือกรถอย่างน้อย 1 คัน");
    if (!invoiceNo.trim()) return fail("ใส่เลขที่บิล");
    if (!issueDateIso) return fail("วันที่ออกบิลไม่ถูกต้อง");
    if (!jobLabel.trim()) return fail("ใส่ชื่องานที่จะแสดงบนบิล");
    for (const l of draftLines) {
      const name = plateText(l.vehicle) || l.vehicle.chassis;
      if (l.receiptAmount === null) return fail(`ใส่ค่าใบเสร็จของ ${name}`);
      if (l.serviceFee === null) return fail(`ค่าดำเนินการของ ${name} ไม่ถูกต้อง`);
    }
    for (const e of draftExtras) {
      if (!e.label) return fail("ค่าใช้จ่ายอื่นๆ ต้องมีชื่อรายการ");
      if (e.amount === null) return fail(`ใส่จำนวนเงินของ "${e.label}"`);
    }

    setSaving(true);
    setMessage({ text: "กำลังออกบิล…" });
    try {
      const { invoice } = await billingApi.createInvoice({
        customerId: customer.id,
        invoiceNo: invoiceNo.trim(),
        issueDate: issueDateIso,
        jobLabel: jobLabel.trim(),
        lines: draftLines.map((l) => ({
          vehicleId: l.vehicle.id,
          receiptAmount: l.receiptAmount!,
          serviceFee: l.serviceFee!,
          serviceLabel: l.serviceLabel,
          deduction: l.deduction,
          deductionNote: l.deduction ? PLATE_REQUEST_NOTE : null,
        })),
        extras: draftExtras.map((e) => ({ label: e.label, amount: e.amount! })),
      });
      await loadAll();
      setMessage({ text: `ออก ${invoice.invoiceNo} แล้ว ${invoice.lines.length} คัน ยอด ${formatMoney(invoice.netTotal)} บาท` });
      printInvoice(invoice);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "ออกบิลไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const dates = [...new Set(vehicles.map((v) => v.deliveredDate))];

  return (
    <section className="content">
      <h1 tabIndex={-1}>วางบิล</h1>
      <p>รถที่พนักงานบันทึกส่งงานแล้วจะมารอที่นี่ เลือกคันที่จะรวมในบิล ตรวจค่าดำเนินการ แล้วออกใบวางบิลพร้อมเอกสารแนบรายคัน</p>

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : !customer ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="empty-customers">ไม่มีรถรอวางบิล (รถจะเข้าคิวเมื่อพนักงานบันทึกส่งงานในหน้า Delivery)</div>
          {message.text && (
            <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ padding: "0 23px 20px" }}>
              {message.text}
            </div>
          )}
        </section>
      ) : (
        <>
          <div className="inspect-filter" style={{ padding: "20px 0 0" }}>
            {customers.map((c) => (
              <button key={c.id} className={`filter-chip${c.id === customer.id ? " selected" : ""}`} onClick={() => chooseCustomer(c.id)}>
                {c.company || c.name} · รอวางบิล {c.vehicles.length}
              </button>
            ))}
          </div>

          <section className="panel" style={{ marginTop: 16, padding: "16px 23px", overflow: "visible" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", alignItems: "center", justifyContent: "space-between", fontSize: 14 }}>
              <div>
                <b style={{ fontWeight: 600 }}>เงื่อนไขวางบิล:</b> {termsSummary(customer.terms, todayIso())}
                <span className="muted" style={{ marginLeft: 12 }}>
                  ตารางค่าดำเนินการ {customer.rates.length} แถว
                </span>
              </div>
              <div>
                <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "terms" ? "" : "terms")}>
                  แก้เงื่อนไข
                </button>
                <button className="text-button" onClick={() => setSettingsOpen(settingsOpen === "rates" ? "" : "rates")}>
                  แก้ตารางค่าดำเนินการ
                </button>
              </div>
            </div>
            {settingsOpen === "terms" && (
              <BillingTermsEditor
                key={customer.id}
                customerId={customer.id}
                terms={customer.terms}
                onSaved={(terms) => {
                  patchCustomer({ terms });
                  setSettingsOpen("");
                }}
              />
            )}
            {settingsOpen === "rates" && (
              <BillingRatesEditor
                key={customer.id}
                customerId={customer.id}
                rates={customer.rates}
                onSaved={() => {
                  setSettingsOpen("");
                  loadAll(true); // ราคาที่เสนอรายคันคำนวณฝั่ง backend - โหลดคิวใหม่ให้ราคาใหม่มีผล
                }}
              />
            )}
          </section>

          <div className="lower" style={{ marginTop: 16, gridTemplateColumns: "minmax(0,1fr) 330px" }}>
            <section className="panel">
              <div className="panel-head">
                <h2>ส่งงานแล้ว รอวางบิล ({vehicles.length})</h2>
                <div>
                  <button className="text-button" onClick={() => setChecked(vehicles.map((v) => v.id), true)}>
                    เลือกทั้งหมด
                  </button>
                  <button className="text-button" onClick={() => setChecked(vehicles.map((v) => v.id), false)}>
                    ไม่เลือกเลย
                  </button>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ลงบิลนี้</th>
                      <th>ทะเบียน</th>
                      <th>เลขตัวถัง</th>
                      <th>ยี่ห้อ / ประเภทรถ</th>
                      <th>เลขที่ใบเสร็จ</th>
                      <th>ค่าใบเสร็จ</th>
                      <th>ค่าดำเนินการ</th>
                      <th>ข้อความต่อท้ายบนบิล</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dates.map((date) => {
                      const group = vehicles.filter((v) => v.deliveredDate === date);
                      return (
                        <Fragment key={date}>
                          <tr>
                            <td colSpan={8} style={{ background: "#f5f7fb", padding: "8px 20px", fontSize: 12, color: "#576781" }}>
                              ส่งเมื่อ <b>{isoToDisplayDate(date)}</b> · {group.length} คัน · ผู้รับ {group[0].recipient || "—"}
                              <button className="text-button" onClick={() => setChecked(group.map((v) => v.id), true)}>
                                เลือกทั้งวันนี้
                              </button>
                            </td>
                          </tr>
                          {group.map((v) => {
                            const row = rows[v.id];
                            if (!row) return null;
                            const fee = serviceFeeOf(v);
                            return (
                              <tr key={v.id}>
                                <td>
                                  <input type="checkbox" checked={row.checked} onChange={(e) => patchRow(v.id, { checked: e.target.checked })} aria-label={`ลงบิล ${plateText(v) || v.chassis}`} />
                                </td>
                                <td>
                                  {plateText(v) || "—"}
                                  {!v.plateDelivered && <div className="muted">ป้ายค้างส่ง</div>}
                                </td>
                                <td>{v.chassis}</td>
                                <td>
                                  {v.brandName}
                                  <div className="muted">
                                    {v.body || "—"}
                                    {v.cc !== null ? ` · ${v.cc} cc` : ""}
                                  </div>
                                </td>
                                <td>{v.receiptNo || "—"}</td>
                                <td>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={row.receiptText}
                                    onChange={(e) => patchRow(v.id, { receiptText: e.target.value })}
                                    style={{ width: 100, textAlign: "right" }}
                                    aria-label={`ค่าใบเสร็จ ${plateText(v) || v.chassis}`}
                                  />
                                  {v.receiptAmountSource === "BILL_ESTIMATE" && <div className="muted">ยอดจากระบบ ตรวจกับใบเสร็จ</div>}
                                  {v.receiptAmountSource === "NONE" && <div className="customer-message error" style={{ fontSize: 11 }}>ไม่มียอดใบเสร็จ</div>}
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    inputMode="decimal"
                                    value={row.serviceText}
                                    onChange={(e) => patchRow(v.id, { serviceText: e.target.value })}
                                    style={{ width: 100, textAlign: "right" }}
                                    aria-label={`ค่าดำเนินการ ${plateText(v) || v.chassis}`}
                                  />
                                  {v.suggestedServiceFee === null && row.serviceText === "" && <div className="muted">ไม่มีราคาในตาราง</div>}
                                  {v.requestedPlateNumber && (
                                    <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12, marginTop: 4, color: row.deduct ? "#b43434" : "#576781" }}>
                                      <input type="checkbox" checked={row.deduct} onChange={(e) => patchRow(v.id, { deduct: e.target.checked })} />
                                      {PLATE_REQUEST_NOTE} −{PLATE_REQUEST_DEDUCTION}
                                      {row.deduct && fee !== null ? ` = ${formatMoney(fee)}` : ""}
                                    </label>
                                  )}
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    value={row.label}
                                    onChange={(e) => patchRow(v.id, { label: e.target.value })}
                                    placeholder="เช่น (ขอใช้ต่างภูมิลำเนา)"
                                    style={{ width: 190 }}
                                    aria-label={`ข้อความต่อท้ายบนบิล ${plateText(v) || v.chassis}`}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ padding: "16px 23px", borderTop: "1px solid #f0f2f6", display: "grid", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <h2 style={{ fontSize: 15 }}>ค่าใช้จ่ายอื่นๆ ของบิลนี้</h2>
                  <button className="text-button" onClick={() => setExtras((prev) => [...prev, { label: "", amountText: "" }])}>
                    + เพิ่มรายการ
                  </button>
                </div>
                {extras.map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 8 }}>
                    <input
                      type="text"
                      value={e.label}
                      placeholder="ชื่อรายการ"
                      onChange={(ev) => setExtras((prev) => prev.map((x, n) => (n === i ? { ...x, label: ev.target.value } : x)))}
                      style={{ flex: 1, minWidth: 0 }}
                      aria-label="ชื่อรายการ"
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      value={e.amountText}
                      placeholder="จำนวนเงิน"
                      onChange={(ev) => setExtras((prev) => prev.map((x, n) => (n === i ? { ...x, amountText: ev.target.value } : x)))}
                      style={{ width: 120, textAlign: "right" }}
                      aria-label="จำนวนเงิน"
                    />
                    <button className="text-button" onClick={() => setExtras((prev) => prev.filter((_, n) => n !== i))} aria-label="ลบรายการ">
                      ลบ
                    </button>
                  </div>
                ))}
                <p style={{ fontSize: 12 }}>ทุกรายการที่ไม่ใช่ค่าใบเสร็จกรมขนส่ง คิด VAT และหัก ณ ที่จ่ายเหมือนค่าดำเนินการ</p>
              </div>
            </section>

            <section className="panel" style={{ padding: "22px 23px", alignSelf: "start", overflow: "visible" }}>
              <h2 style={{ marginBottom: 16 }}>สรุปยอดบิล ({selected.length} คัน)</h2>
              <div style={{ display: "grid", gap: 12 }}>
                <label className="field">
                  เลขที่ IV (ล้อตาม Google Sheet)
                  <input type="text" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="IV2026-121" />
                </label>
                <label className="field">
                  วันที่ออกบิล
                  <DateInput
                    value={issueDateText}
                    onChange={(value) => setIssueDateText(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
                  />
                </label>
                <label className="field">
                  ชื่องานบนบิล
                  <input type="text" value={jobLabel} onChange={(e) => setJobLabelEdit(e.target.value)} />
                </label>
                {totals && (
                  <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
                    <SumLine label="ค่าธรรมเนียม (ตามใบเสร็จ)" value={totals.feeTotal} />
                    <SumLine label="ค่าดำเนินการ" value={totals.serviceTotal} />
                    <SumLine label={totals.vatRate ? `VAT ${totals.vatRate}%` : "VAT (ไม่มี)"} value={totals.vatAmount} />
                    <SumLine label={totals.whtRate ? `หัก ณ ที่จ่าย ${totals.whtRate}%` : "หัก ณ ที่จ่าย (ไม่มี)"} value={-totals.whtAmount} />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", background: "#edf2ff", color: "#2854d9", borderRadius: 10, padding: "12px 14px", fontWeight: 600, marginTop: 4 }}>
                      <span>จำนวนเงินทั้งสิ้น</span>
                      <span style={{ fontSize: 22 }}>{formatMoney(totals.netTotal)}</span>
                    </div>
                  </div>
                )}
                <button className="primary" style={{ justifyContent: "center" }} disabled={saving} onClick={handleIssue}>
                  ออกใบวางบิลและพิมพ์
                </button>
                {message.text && (
                  <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
                    {message.text}
                  </div>
                )}
              </div>
            </section>
          </div>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head">
              <h2>ตัวอย่างเอกสาร</h2>
              <span className="muted">ใบวางบิล/ใบแจ้งหนี้ ตามด้วยเอกสารแนบรายคัน</span>
            </div>
            {preview ? (
              <iframe title="ตัวอย่างใบวางบิล" srcDoc={buildInvoiceHtml(preview)} style={{ width: "100%", height: 760, border: 0, borderTop: "1px solid #f0f2f6", background: "white" }} />
            ) : (
              <div className="empty-customers">เลือกรถอย่างน้อย 1 คันเพื่อดูตัวอย่างเอกสาร</div>
            )}
          </section>
        </>
      )}

      <BillingInvoiceList invoices={invoices} onChanged={() => loadAll(true)} />
    </section>
  );
}

function SumLine({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: value < 0 ? "#b43434" : undefined }}>
      <span style={{ color: value < 0 ? undefined : "#576781" }}>{label}</span>
      <span>{formatMoney(value || 0)}</span>
    </div>
  );
}
