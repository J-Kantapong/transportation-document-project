"use client";

import { usePathname } from "next/navigation";
import { PageTabs } from "@/components/PageTabs";

// แท็บของหน้าใบกำกับภาษี - แต่ละแท็บเป็น URL ของตัวเอง (ผู้ใช้ 2026-09-25)
export function TaxInvoiceTabs() {
  const pathname = usePathname();
  const wht = pathname.startsWith("/accounting/tax-invoices/wht");
  return (
    <PageTabs
      label="ใบกำกับภาษี"
      tabs={[
        { href: "/accounting/tax-invoices", label: "ใบกำกับภาษี", selected: !wht },
        { href: "/accounting/tax-invoices/wht", label: "ติดตาม 50 ทวิ", selected: wht },
      ]}
    />
  );
}
