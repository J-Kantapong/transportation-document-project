"use client";

import { useEffect, useState } from "react";
import { PlateKindTabs, PlatePhotoPanel, loadPlateKind, savePlateKind } from "@/components/PlatePhotoPanel";
import type { PlateKind } from "@/lib/api";

// หน้าถ่ายรูปป้ายบนมือถือ - คนที่ถือป้ายอยู่ถ่ายแล้วยืนยันได้ทันที (หรือปล่อยให้ออฟฟิศยืนยันจากหน้ารับป้ายทะเบียน)
// เลือกแท็บรถยนต์/มอเตอร์ไซค์ก่อนถ่าย - จับคู่เฉพาะรถประเภทนั้น
export default function PlateCaptureRoute() {
  const [kind, setKind] = useState<PlateKind>("car");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setKind(loadPlateKind());
  }, []);

  function switchKind(next: PlateKind) {
    setKind(next);
    savePlateKind(next);
  }

  return (
    <section className="content">
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 0 }}>ถ่ายรูปป้ายทะเบียน</h1>
        <PlateKindTabs kind={kind} onChange={switchKind} />
        <div style={{ marginTop: 14 }}>
          <PlatePhotoPanel key={kind} kind={kind} compact />
        </div>
      </div>
    </section>
  );
}
