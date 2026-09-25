"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { focusChassis } from "@/lib/vehicle-focus";

// เปิดหน้าด้วย ?focus=<เลขตัวถัง> (จากหน้าค้นหารถ) = รอจนแถวของรถคันนั้นขึ้นบนจอ แล้วเลื่อนไปหาและไฮไลต์ให้
// รายการโหลดช้า/หน้าเปิดแท็บหรือใบให้เองทีหลัง จึงคอยดู DOM ไปเรื่อยๆ จนเจอหรือครบเวลา
const WAIT_MS = 15_000;

function findRow(chassis: string): HTMLElement | null {
  const needle = chassis.toUpperCase();
  for (const row of document.querySelectorAll<HTMLElement>("main tbody tr")) {
    if (row.offsetParent !== null && (row.textContent ?? "").toUpperCase().includes(needle)) return row;
  }
  return null;
}

export function FocusVehicleRow() {
  const pathname = usePathname();
  const [missing, setMissing] = useState<{ chassis: string; path: string } | null>(null);

  useEffect(() => {
    const chassis = focusChassis();
    if (!chassis) return;
    let done = false;
    let highlighted: HTMLElement | null = null;
    const settleTimers: number[] = [];
    // รูป/ข้อมูลที่โหลดตามมาดันแถวเลื่อนลงหลังเลื่อนไปแล้ว - จัดให้อยู่กลางจออีกสองสามครั้งช่วงหน้ากำลังนิ่ง
    // แต่หยุดทันทีที่ผู้ใช้เลื่อนหน้าเอง
    const stopSettling = () => settleTimers.splice(0).forEach((t) => window.clearTimeout(t));
    const userScrollEvents = ["wheel", "touchstart", "keydown", "mousedown"] as const;
    const tryFocus = () => {
      if (done) return;
      const row = findRow(chassis);
      if (!row) return;
      done = true;
      highlighted = row;
      row.classList.add("row-focus");
      row.scrollIntoView({ block: "center" });
      observer.disconnect();
      for (const ms of [300, 800, 1500, 2500]) {
        settleTimers.push(window.setTimeout(() => row.isConnected && row.scrollIntoView({ block: "center" }), ms));
      }
      userScrollEvents.forEach((e) => window.addEventListener(e, stopSettling, { once: true, passive: true }));
    };
    const observer = new MutationObserver(tryFocus);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    tryFocus();
    const timer = window.setTimeout(() => {
      observer.disconnect();
      if (!done) setMissing({ chassis, path: pathname });
    }, WAIT_MS);
    return () => {
      done = true;
      observer.disconnect();
      window.clearTimeout(timer);
      stopSettling();
      userScrollEvents.forEach((e) => window.removeEventListener(e, stopSettling));
      highlighted?.classList.remove("row-focus");
    };
  }, [pathname]);

  if (!missing || missing.path !== pathname) return null;
  return (
    <div className="focus-missing" role="status">
      ไม่พบรถเลขตัวถัง {missing.chassis} ในหน้านี้ (อาจผ่านขั้นนี้ไปแล้ว หรือถูกกรองออก)
      <button type="button" className="text-button" onClick={() => setMissing(null)} aria-label="ปิด">
        ×
      </button>
    </div>
  );
}
