"use client";

import { useEffect, useRef, useState } from "react";
import { fetchAuthedBlob } from "@/lib/api";

// รูปใบเสร็จ/ป้าย/เล่ม อยู่หลัง backend endpoint ที่ต้องมี Authorization header (ดู auth.guard.ts)
// <img src="..."> ส่ง header เองไม่ได้ - เคยชี้ตรงไปที่ endpoint แล้วขึ้น 401 (รูปพัง) จึงต้องโหลดเป็น blob เองก่อน
// fetchAuthedBlob พาไปหน้าล็อกอินเองเมื่อ token หมดอายุ (401) - ที่นี่แสดงแค่ว่าโหลดไม่สำเร็จ
//
// รูปขึ้นช้า (ผู้ใช้ 2026-09-30): หน้ารับใบเสร็จเคยยิงรูปเต็มเป็นร้อยรูปพร้อมกันตอนเปิดหน้า ทุกรูปผ่าน backend (Render ฟรี)
// - โหลดเฉพาะรูปที่เลื่อนมาใกล้จอ (IntersectionObserver)
// - โหลดพร้อมกันไม่เกิน MAX_CONCURRENT รูป รูปที่เหลือต่อคิว
// - จำ blob ไว้ในหน่วยความจำ (src ทุกตัวเป็น URL ตาม id ของรูป ไฟล์ไม่เปลี่ยน) - ตารางโหลดใหม่/เปลี่ยนหน้าแล้วกลับมาไม่ต้องโหลดซ้ำ
//   backend ส่ง Cache-Control ด้วย เปิดหน้าใหม่ก็ยังได้จาก cache ของเบราว์เซอร์
const MAX_CONCURRENT = 6;
const MAX_CACHED = 300;
const blobCache = new Map<string, Promise<Blob>>();
let active = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

function loadBlob(src: string): Promise<Blob> {
  const cached = blobCache.get(src);
  if (cached) {
    // ใช้ล่าสุดไว้ท้าย Map - ตัดตัวที่ไม่ได้ใช้นานที่สุดออกก่อน
    blobCache.delete(src);
    blobCache.set(src, cached);
    return cached;
  }
  const promise = withSlot(() => fetchAuthedBlob(src));
  blobCache.set(src, promise);
  promise.catch(() => blobCache.delete(src)); // โหลดไม่สำเร็จไม่จำ - รอบหน้าลองใหม่
  while (blobCache.size > MAX_CACHED) blobCache.delete(blobCache.keys().next().value!);
  return promise;
}

export function AuthedImage({
  src,
  alt,
  style,
  linkTitle,
}: {
  src: string;
  alt: string;
  style?: React.CSSProperties;
  linkTitle?: string;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const placeholderRef = useRef<HTMLDivElement>(null);

  // เริ่มโหลดเมื่อรูปเข้ามาใกล้จอ (เผื่อไว้ 300px) - เห็นแล้วไม่ต้องดูต่อ
  useEffect(() => {
    if (visible) return;
    const el = placeholderRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, objectUrl, failed]);

  // กด Esc ปิดรูปที่ขยายอยู่
  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoomed(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  useEffect(() => {
    if (!visible) return;
    let url: string | null = null;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- เปลี่ยน src ต้องเคลียร์รูป/error เก่าก่อนโหลดรูปใหม่
    setObjectUrl(null);
    setFailed(false);
    (async () => {
      try {
        const blob = await loadBlob(src);
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setObjectUrl(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src, visible]);

  if (failed) {
    return (
      <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f3f8", color: "#8a94a6", fontSize: 11, textAlign: "center" }}>
        โหลดรูปไม่สำเร็จ
      </div>
    );
  }
  if (!objectUrl) return <div ref={placeholderRef} style={{ ...style, background: "#f1f3f8" }} />;
  // กดแล้วเปิดรูปเต็มทับหน้าเดิม (เดิมเปิดแท็บใหม่ด้วย target=_blank - หน้าต่างในแอป/บางเบราว์เซอร์บล็อก กดแล้วไม่เกิดอะไร)
  // ctrl/⌘/กลางเมาส์ยังเปิดแท็บใหม่ได้ตามปกติ
  return (
    <>
      <a
        href={objectUrl}
        target="_blank"
        rel="noreferrer"
        title={linkTitle}
        onClick={(e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey) return;
          e.preventDefault();
          setZoomed(true);
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- รูปโหลดเป็น blob เอง (ต้องแนบ Authorization) ไม่ผ่าน next/image */}
        <img src={objectUrl} alt={alt} style={style} />
      </a>
      {zoomed && (
        <div
          role="dialog"
          aria-label={alt}
          onClick={() => setZoomed(false)}
          style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, cursor: "zoom-out" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- ดูข้างบน */}
          <img src={objectUrl} alt={alt} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", background: "#fff" }} />
          <button
            type="button"
            aria-label="ปิดรูป"
            onClick={() => setZoomed(false)}
            style={{ position: "absolute", top: 12, right: 16, fontSize: 28, lineHeight: 1, color: "#fff", background: "transparent", border: 0, cursor: "pointer" }}
          >
            ×
          </button>
        </div>
      )}
    </>
  );
}
