"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth";

// รูปใบเสร็จ/ป้าย/เล่ม อยู่หลัง backend endpoint ที่ต้องมี Authorization header (ดู auth.guard.ts)
// <img src="..."> ส่ง header เองไม่ได้ - เคยชี้ตรงไปที่ endpoint แล้วขึ้น 401 (รูปพัง) จึงต้องโหลดเป็น blob เองก่อน
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

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- เปลี่ยน src ต้องเคลียร์รูป/error เก่าก่อนโหลดรูปใหม่
    setObjectUrl(null);
    setFailed(false);
    (async () => {
      try {
        const token = getToken();
        const res = await fetch(src, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        url = URL.createObjectURL(await res.blob());
        if (!cancelled) setObjectUrl(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [src]);

  if (failed) {
    return (
      <div style={{ ...style, display: "flex", alignItems: "center", justifyContent: "center", background: "#f1f3f8", color: "#8a94a6", fontSize: 11, textAlign: "center" }}>
        โหลดรูปไม่สำเร็จ
      </div>
    );
  }
  if (!objectUrl) return <div style={{ ...style, background: "#f1f3f8" }} />;
  return (
    <a href={objectUrl} target="_blank" rel="noreferrer" title={linkTitle}>
      {/* eslint-disable-next-line @next/next/no-img-element -- รูปโหลดเป็น blob เอง (ต้องแนบ Authorization) ไม่ผ่าน next/image */}
      <img src={objectUrl} alt={alt} style={style} />
    </a>
  );
}
