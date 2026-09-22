"use client";

import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { authApi, type PortalVehicle } from "@/lib/auth-api";

// Portal ลูกค้า (เฟสแรก): รายการรถของบริษัทตัวเองพร้อมสถานะ 8 ขั้นตอน + ปุ่มยืนยันรับของ - ไม่แสดงราคาใดๆ

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function VehicleCard({ vehicle, onConfirmed }: { vehicle: PortalVehicle; onConfirmed: (v: PortalVehicle) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = vehicle.steps.filter((s) => s.state === "DONE").length;

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const { vehicle: updated } = await authApi.portalConfirmDelivery(vehicle.id);
      onConfirmed(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ยืนยันไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel portal-card">
      <div className="portal-head">
        <div>
          <div className="job" style={{ fontSize: 16 }}>
            {vehicle.brandName} {vehicle.body ? `· ${vehicle.body}` : ""} {vehicle.color ? `· ${vehicle.color}` : ""}
          </div>
          <div className="sub">
            เลขตัวถัง {vehicle.chassis}
            {vehicle.plate ? ` · ทะเบียน ${vehicle.plate}` : ""}
            {vehicle.registrationProvince ? ` · ${vehicle.registrationProvince}` : ""} · รับงาน {formatDate(vehicle.date)}
          </div>
        </div>
        <span className={`status-badge${vehicle.currentStep === "เสร็จสิ้น" ? " portal-badge-done" : ""}`}>
          {vehicle.currentStep === "เสร็จสิ้น" ? "เสร็จสิ้น" : `กำลัง: ${vehicle.currentStep}`}
        </span>
      </div>
      <ol className="portal-steps">
        {vehicle.steps.map((step, i) => (
          <li key={step.key} className={`portal-step portal-step--${step.state.toLowerCase()}`}>
            <span className="portal-step-dot">{step.state === "DONE" ? "✓" : i + 1}</span>
            <div>
              <div className="portal-step-title">{step.title}</div>
              <div className="sub">
                {step.state === "DONE" && step.date ? formatDate(step.date) : ""}
                {step.note ? (step.state === "DONE" && step.date ? " · " : "") + step.note : ""}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div className="portal-foot">
        <span className="muted">
          {done}/{vehicle.steps.length} ขั้นตอน
        </span>
        {vehicle.deliveredDate &&
          (vehicle.deliveryConfirmedAt ? (
            <span className="badge done">ยืนยันรับของแล้ว {formatDate(vehicle.deliveryConfirmedAt)}</span>
          ) : (
            <button type="button" className="primary" disabled={busy} onClick={confirm}>
              ยืนยันว่าได้รับของแล้ว
            </button>
          ))}
        {error && <span className="customer-message error">{error}</span>}
      </div>
    </div>
  );
}

export default function PortalPage() {
  const [vehicles, setVehicles] = useState<PortalVehicle[]>([]);
  const [company, setCompany] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<"ACTIVE" | "DONE" | "ALL">("ACTIVE");

  useEffect(() => {
    Promise.all([authApi.portalVehicles(), authApi.portalCompany()])
      .then(([v, c]) => {
        setVehicles(v.vehicles);
        setCompany(c.customer.company && c.customer.company !== c.customer.name ? `${c.customer.name} (${c.customer.company})` : c.customer.name);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "โหลดข้อมูลไม่สำเร็จ"))
      .finally(() => setLoading(false));
  }, []);

  const shown = vehicles.filter((v) =>
    filter === "ALL" ? true : filter === "DONE" ? v.currentStep === "เสร็จสิ้น" : v.currentStep !== "เสร็จสิ้น",
  );

  return (
    <div className="content">
      <div className="heading">
        <div>
          <h1>สถานะรถของคุณ</h1>
          <p>{company ? `รถที่ ${company} ส่งจดทะเบียนกับเรา` : "รถที่บริษัทของคุณส่งจดทะเบียนกับเรา"}</p>
        </div>
      </div>
      <div className="inspect-filter" style={{ padding: "0 0 18px" }}>
        {(
          [
            ["ACTIVE", "กำลังดำเนินการ"],
            ["DONE", "เสร็จสิ้น"],
            ["ALL", "ทั้งหมด"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} type="button" className={`filter-chip${filter === key ? " selected" : ""}`} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>
      {error && <div className="empty-page customer-message error">{error}</div>}
      {loading ? (
        <div className="empty-page">กำลังโหลด…</div>
      ) : !error && shown.length === 0 ? (
        <div className="empty-page">ยังไม่มีรถในรายการนี้</div>
      ) : (
        <div className="portal-list">
          {shown.map((v) => (
            <VehicleCard key={v.id} vehicle={v} onConfirmed={(u) => setVehicles((prev) => prev.map((x) => (x.id === u.id ? u : x)))} />
          ))}
        </div>
      )}
    </div>
  );
}
