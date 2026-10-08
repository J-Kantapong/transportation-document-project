"use client";

import { useEffect, useState } from "react";
import { supplierRatesApi, type SupplierRate } from "@/lib/supplier-rates-api";
import { isSupplierProvince } from "@/lib/supplier-route";

// บอกตั้งแต่ตอนกรอกข้อมูลรถว่าจังหวัดที่จดนี้ส่งซับจด และเตือนถ้าซับไม่รับ/ยังไม่มีราคา (ผู้ใช้ 2026-10-08)
// โหลดตารางราคาซับครั้งเดียวต่อการเปิดหน้า (ใช้ร่วมกันทุกจุดที่วาง) - โหลดไม่ได้ก็ยังบอกว่าส่งซับ แค่ไม่มีคำเตือน
let ratesPromise: Promise<SupplierRate[]> | null = null;
function loadRates(): Promise<SupplierRate[]> {
  ratesPromise ??= supplierRatesApi
    .list()
    .then((r) => r.rates)
    .catch(() => {
      ratesPromise = null;
      return [];
    });
  return ratesPromise;
}

export function SupplierRouteHint({ province }: { province: string | null | undefined }) {
  const [rates, setRates] = useState<SupplierRate[]>([]);
  const supplier = isSupplierProvince(province);

  useEffect(() => {
    if (!supplier) return;
    let cancelled = false;
    void loadRates().then((r) => !cancelled && setRates(r));
    return () => {
      cancelled = true;
    };
  }, [supplier]);

  if (!supplier) return null;
  const rate = rates.find((r) => r.province === province);
  if (rate && !rate.accepts) {
    return (
      <span className="badge warn" role="alert">
        ซับไม่รับจดทะเบียนจังหวัด{province}
      </span>
    );
  }
  return (
    <span className="badge warn">
      ส่งซับจด{rate && rate.total === null ? " (ยังไม่มีราคาซับ)" : ""}
    </span>
  );
}
