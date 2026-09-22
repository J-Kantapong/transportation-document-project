import { EmptyWorkPage } from "@/components/EmptyWorkPage";

// รถเก่า กับ รถเก่า - ผู้ใช้จะบอกเงื่อนไขภายหลัง (2026-09-22) ห้ามเดาฟิลด์
export default function PlateSwapOldOldPage() {
  return <EmptyWorkPage title="รถเก่า กับ รถเก่า" backHref="/registration/plate-swap" backLabel="การสลับเลข" />;
}
