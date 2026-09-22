import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // dev เท่านั้น: ให้เปิดหน้าเว็บผ่าน 127.0.0.1 ได้ด้วย (ไม่งั้น Next ตอบ 403 ให้ไฟล์ /_next/* จาก origin ที่ไม่ใช่ localhost)
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
