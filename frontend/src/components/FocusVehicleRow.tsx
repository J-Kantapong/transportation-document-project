"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { focusChassis } from "@/lib/vehicle-focus";

// เปิดหน้าด้วย ?focus=<เลขตัวถัง> (จากหน้าค้นหารถ) = รอจนแถวของรถคันนั้นขึ้นบนจอ แล้วเลื่อนไปหาและไฮไลต์ให้
// รายการโหลดช้า/หน้าเปิดแท็บหรือใบให้เองทีหลัง จึงคอยดู DOM ไปเรื่อยๆ จนเจอหรือครบเวลา
const WAIT_MS = 15_000;

// แถวของรถ = แถวตาราง หรือกล่องที่หน้านั้นติด data-focus-row ไว้ (คิววางบิลเป็นรายการ div ไม่ใช่ตาราง - พบ 2026-10-09:
// เดิมหาไม่เจอแล้วขึ้น "ไม่พบรถ" ทั้งที่รถอยู่ในหน้า)
// หน้าที่ติด data-focus-row = บอกเองว่าแถวงานของหน้านั้นคืออันไหน จึงหาที่นั่นก่อนตาราง: หน้าวางบิลมีตาราง
// "ของพร้อมส่งยังไม่ลงส่งงาน" อยู่เหนือคิว ซึ่งอาจมีเลขตัวถังเดียวกัน (ป้ายค้างส่ง) ไม่ใช่แถวที่ต้องการ
//
// ค่าที่หาเป็นเลขตัวถัง หรือเลขที่ใบ (IV / TV จาก "สิ่งที่ควรจัดการ" ของภาพรวม, ผู้ใช้ 2026-10-09) จึงต้องตรงทั้งคำ:
// IV2026-12 ต้องไม่ไปไฮไลต์แถวของ IV2026-121 · เทียบทีละข้อความ เพราะ textContent ของแถวต่อช่องติดกันไม่มีช่องว่าง
function hasToken(row: HTMLElement, needle: string): boolean {
  if (!(row.textContent ?? "").toUpperCase().includes(needle)) return false; // ตัดแถวส่วนใหญ่ทิ้งเร็วๆ
  const wordChar = /[A-Z0-9-]/; // ขีดนับเป็นส่วนของเลขที่ (IV2026-121-A = ใบแนบ ไม่ใช่ตัวบิล)
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").toUpperCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      if (!wordChar.test(text[at - 1] ?? "") && !wordChar.test(text[at + needle.length] ?? "")) return true;
    }
  }
  return false;
}

function findRow(focus: string): HTMLElement | null {
  const needle = focus.toUpperCase();
  for (const selector of ["main [data-focus-row]", "main tbody tr"]) {
    for (const row of document.querySelectorAll<HTMLElement>(selector)) {
      if (row.offsetParent !== null && hasToken(row, needle)) return row;
    }
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
      ไม่พบ {missing.chassis} ในหน้านี้ (อาจผ่านขั้นนี้ไปแล้ว หรือถูกกรองออก)
      <button type="button" className="text-button" onClick={() => setMissing(null)} aria-label="ปิด">
        ×
      </button>
    </div>
  );
}
