"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type OwnerType, type TaxBreakdown, type TaxCalculation, type Vehicle, type VehicleOwner } from "@/lib/api";
import { OWNER_TYPES } from "@/lib/vehicle-reference-data";
import { displayDateToIso, formatDateDigits, isoToDisplayDate } from "@/lib/date";

const OWNER_TYPE_LABEL: Record<OwnerType, string> = Object.fromEntries(OWNER_TYPES) as Record<OwnerType, string>;

function formatMoney(amount: number): string {
  return amount.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ผลคำนวณภาษี - ห้ามแสดง 0 บาทแทนกรณีคำนวณไม่ได้ (MISSING_INPUT/MISSING_VERIFIED_RULE)
function TaxResultView({ result }: { result: TaxBreakdown }) {
  if (result.amount === null) {
    return (
      <div className="customer-message error" role="status" style={{ marginTop: 12 }}>
        ยังคำนวณภาษีไม่ได้{result.reason ? ` - ${result.reason}` : ""}
      </div>
    );
  }
  return (
    <div className="customer-message success" role="status" style={{ marginTop: 12, lineHeight: 1.8 }}>
      ภาษีรถประจำปี: <strong>{formatMoney(result.amount)} บาท</strong>
      {result.baseAmount !== null && result.juristicMultiplier > 1 && (
        <>
          {" "}
          (ฐาน {formatMoney(result.baseAmount)} บาท × {result.juristicMultiplier} - {result.juristicReason})
        </>
      )}
      {result.discountPercent !== null && <> · ใช้สิทธิลดหย่อน EV {result.discountPercent}%</>}
    </div>
  );
}

export default function SubmitDocumentsPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [owners, setOwners] = useState<VehicleOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [isFactoryNew, setIsFactoryNew] = useState<"" | "true" | "false">("");
  const [dateText, setDateText] = useState("");
  const [history, setHistory] = useState<TaxCalculation[]>([]);

  const [showOwnerForm, setShowOwnerForm] = useState(false);
  const [newOwnerType, setNewOwnerType] = useState<OwnerType>("INDIVIDUAL");
  const [newOwnerName, setNewOwnerName] = useState("");
  const [newOwnerHirePurchase, setNewOwnerHirePurchase] = useState(false);
  const [newOwnerHirerType, setNewOwnerHirerType] = useState<OwnerType | "">("");
  const [ownerMessage, setOwnerMessage] = useState({ text: "", error: false });
  const [ownerSaving, setOwnerSaving] = useState(false);

  const [previewResult, setPreviewResult] = useState<TaxBreakdown | null>(null);
  const [previewMessage, setPreviewMessage] = useState({ text: "", error: false });
  const [previewLoading, setPreviewLoading] = useState(false);
  const [saveMessage, setSaveMessage] = useState({ text: "", error: false });
  const [saving, setSaving] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);

  async function loadAll() {
    setLoading(true);
    setLoadError("");
    try {
      const [vehiclesRes, ownersRes] = await Promise.all([api.listVehicles(), api.listVehicleOwners()]);
      setVehicles(vehiclesRes.vehicles);
      setOwners(ownersRes.owners);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadAll sets a loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, []);

  function openDetail(vehicle: Vehicle) {
    setSelected(vehicle);
    setOwnerId(vehicle.ownerId ?? "");
    setIsFactoryNew(vehicle.isFactoryNew === null ? "" : vehicle.isFactoryNew ? "true" : "false");
    setDateText(vehicle.firstRegistrationDate ? isoToDisplayDate(vehicle.firstRegistrationDate) : "");
    setShowOwnerForm(false);
    setPreviewResult(null);
    setPreviewMessage({ text: "", error: false });
    setSaveMessage({ text: "", error: false });
    setHistory([]);
    dialogRef.current?.showModal();
    api
      .listVehicleTaxCalculations(vehicle.id)
      .then((res) => setHistory(res.taxCalculations))
      .catch(() => {});
  }

  function handleDateTextChange(raw: string) {
    setDateText(formatDateDigits(raw.replace(/\D/g, "").slice(0, 8)));
  }

  function dateTextToIso(): string {
    return displayDateToIso(dateText.replace(/\D/g, ""));
  }

  async function handleAddOwner(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOwnerSaving(true);
    setOwnerMessage({ text: "", error: false });
    try {
      const { id } = await api.createVehicleOwner({
        name: newOwnerName.trim() || undefined,
        ownerType: newOwnerType,
        isHirePurchaseBusiness: newOwnerType === "JURISTIC" && newOwnerHirePurchase,
        hirerType: newOwnerType === "JURISTIC" && newOwnerHirePurchase && newOwnerHirerType ? newOwnerHirerType : null,
      });
      const ownersRes = await api.listVehicleOwners();
      setOwners(ownersRes.owners);
      setOwnerId(id);
      setShowOwnerForm(false);
      setNewOwnerName("");
      setNewOwnerHirePurchase(false);
      setNewOwnerHirerType("");
      setOwnerMessage({ text: "เพิ่มเจ้าของรถแล้ว", error: false });
    } catch (err) {
      setOwnerMessage({ text: err instanceof ApiError ? err.message : "เพิ่มเจ้าของรถไม่สำเร็จ", error: true });
    } finally {
      setOwnerSaving(false);
    }
  }

  function buildPreviewOwner() {
    if (!ownerId) return null;
    const owner = owners.find((o) => o.id === ownerId);
    if (!owner) return null;
    return { ownerType: owner.ownerType, isHirePurchaseBusiness: owner.isHirePurchaseBusiness, hirerType: owner.hirerType };
  }

  async function handlePreview() {
    if (!selected) return;
    setPreviewLoading(true);
    setPreviewMessage({ text: "", error: false });
    try {
      const result = await api.previewTax({
        body: selected.body,
        fuel: selected.fuel,
        cc: selected.cc,
        weight: selected.weight,
        firstRegistrationDate: dateTextToIso() || null,
        owner: buildPreviewOwner(),
      });
      setPreviewResult(result);
    } catch (err) {
      setPreviewMessage({ text: err instanceof ApiError ? err.message : "คำนวณตัวอย่างไม่สำเร็จ", error: true });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSave() {
    if (!selected) return;
    setSaving(true);
    setSaveMessage({ text: "", error: false });
    try {
      const { taxCalculation } = await api.updateVehicleTaxInput(selected.id, {
        ownerId: ownerId || null,
        isFactoryNew: isFactoryNew === "" ? null : isFactoryNew === "true",
        firstRegistrationDate: dateTextToIso() || null,
      });
      setSaveMessage({ text: "บันทึกและคำนวณภาษีแล้ว", error: false });
      setHistory((prev) => [taxCalculation, ...prev]);
      await loadAll();
    } catch (err) {
      setSaveMessage({ text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ยื่นเอกสารจดทะเบียนรถใหม่</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        ระบุเจ้าของรถตามทะเบียน วันที่จดทะเบียนครั้งแรก และรถใหม่จากโรงงานหรือไม่ เพื่อคำนวณภาษีรถประจำปี
        อัตราภาษีบางกลุ่ม (รย.1 รถไฟฟ้า, รย.2, รย.3, รย.12 รถไฟฟ้า) ยังไม่ได้รับการยืนยัน ระบบจะแจ้ง
        &quot;ยังคำนวณภาษีไม่ได้&quot; แทนการแสดง 0 บาท
      </p>

      <section className="panel">
        <div className="panel-head">
          <h2>รถที่บันทึกไว้</h2>
        </div>
        {loading ? (
          <div className="customer-message" role="status">
            กำลังโหลด...
          </div>
        ) : loadError ? (
          <div className="empty-customers" role="alert">
            {loadError}
          </div>
        ) : !vehicles.length ? (
          <div className="empty-customers">ยังไม่มีข้อมูลรถจดใหม่</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ประเภทรถ</th>
                  <th>เจ้าของรถ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td>{isoToDisplayDate(v.date) || v.date}</td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.body || "—"}</td>
                    <td>{v.ownerName ? `${v.ownerName} (${OWNER_TYPE_LABEL[v.ownerType as OwnerType]})` : v.ownerType ? OWNER_TYPE_LABEL[v.ownerType] : "ยังไม่ระบุ"}</td>
                    <td>
                      <button className="text-button" onClick={() => openDetail(v)}>
                        ยื่นเอกสาร / คำนวณภาษี
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
        style={{ width: "min(760px, 92vw)" }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        {selected && (
          <>
            <h2>ยื่นเอกสารจดทะเบียนรถใหม่ - {selected.chassis}</h2>
            <p className="muted">
              {selected.body || "ไม่ระบุประเภทรถ"} · {selected.fuel || "ไม่ระบุเชื้อเพลิง"}
              {selected.cc ? ` · ${selected.cc} cc` : ""}
              {selected.weight ? ` · ${selected.weight} กก.` : ""}
            </p>

            <div className="vehicle-fields" style={{ marginTop: 16 }}>
              <label className="field">
                เจ้าของรถตามทะเบียน
                <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                  <option value="">ยังไม่ระบุ</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {(o.name || "(ไม่มีชื่อ)") + ` - ${OWNER_TYPE_LABEL[o.ownerType]}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                วันที่จดทะเบียนครั้งแรก
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="วว/ดด/ปปปป"
                  value={dateText}
                  onChange={(e) => handleDateTextChange(e.target.value)}
                />
              </label>
              <label className="field">
                รถใหม่จากโรงงานหรือไม่
                <select value={isFactoryNew} onChange={(e) => setIsFactoryNew(e.target.value as "" | "true" | "false")}>
                  <option value="">ยังไม่ระบุ</option>
                  <option value="true">ใช่ - รถใหม่จากโรงงาน</option>
                  <option value="false">ไม่ใช่</option>
                </select>
              </label>
            </div>

            <div style={{ marginTop: 8 }}>
              <button type="button" className="text-button" onClick={() => setShowOwnerForm((v) => !v)}>
                + เพิ่มเจ้าของรถใหม่
              </button>
            </div>

            {showOwnerForm && (
              <div className="panel" style={{ marginTop: 12 }}>
                <form className="customer-form" onSubmit={handleAddOwner}>
                  <div className="vehicle-fields">
                    <label className="field">
                      ชื่อเจ้าของรถ
                      <input maxLength={250} value={newOwnerName} onChange={(e) => setNewOwnerName(e.target.value)} />
                    </label>
                    <label className="field">
                      ประเภทเจ้าของรถ
                      <select value={newOwnerType} onChange={(e) => setNewOwnerType(e.target.value as OwnerType)}>
                        {OWNER_TYPES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {newOwnerType === "JURISTIC" && (
                      <label className="field">
                        ประกอบธุรกิจเช่าซื้อหรือไม่
                        <select
                          value={newOwnerHirePurchase ? "true" : "false"}
                          onChange={(e) => {
                            setNewOwnerHirePurchase(e.target.value === "true");
                            if (e.target.value !== "true") setNewOwnerHirerType("");
                          }}
                        >
                          <option value="false">ไม่ใช่</option>
                          <option value="true">ใช่ - ประกอบธุรกิจเช่าซื้อ</option>
                        </select>
                      </label>
                    )}
                    {newOwnerType === "JURISTIC" && newOwnerHirePurchase && (
                      <label className="field">
                        ผู้เช่าซื้อรถคันนี้เป็น
                        <select value={newOwnerHirerType} onChange={(e) => setNewOwnerHirerType(e.target.value as OwnerType)} required>
                          <option value="">เลือก</option>
                          {OWNER_TYPES.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="form-actions">
                    <button className="primary" disabled={ownerSaving}>
                      บันทึกเจ้าของรถ
                    </button>
                    <span
                      className={`customer-message${ownerMessage.error ? " error" : ownerMessage.text ? " success" : ""}`}
                      role="status"
                    >
                      {ownerMessage.text}
                    </span>
                  </div>
                </form>
              </div>
            )}

            <div className="form-actions" style={{ marginTop: 20 }}>
              <button type="button" className="text-button" disabled={previewLoading} onClick={handlePreview}>
                คำนวณตัวอย่าง
              </button>
              <button type="button" className="primary" disabled={saving} onClick={handleSave}>
                บันทึกและคำนวณภาษี
              </button>
            </div>
            <span
              className={`customer-message${previewMessage.error ? " error" : ""}`}
              role="status"
            >
              {previewMessage.text}
            </span>
            {previewResult && <TaxResultView result={previewResult} />}
            <span
              className={`customer-message${saveMessage.error ? " error" : saveMessage.text ? " success" : ""}`}
              role="status"
            >
              {saveMessage.text}
            </span>

            {history.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h3>ประวัติการคำนวณ</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>วันที่คำนวณ</th>
                        <th>สถานะ</th>
                        <th>ภาษี</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((h) => (
                        <tr key={h.id}>
                          <td>{new Date(h.createdAt).toLocaleString("th-TH")}</td>
                          <td>{h.status}</td>
                          <td>{h.finalAmount !== null ? `${formatMoney(Number(h.finalAmount))} บาท` : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </dialog>
    </section>
  );
}
