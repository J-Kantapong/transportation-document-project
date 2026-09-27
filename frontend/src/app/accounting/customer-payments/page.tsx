"use client";

import { Suspense } from "react";
import { CustomerPaymentsPage } from "@/components/CustomerPaymentsPage";

// ลูกค้าที่เลือกอยู่ใน URL (?customer=) - useSearchParams ต้องอยู่ใต้ Suspense
export default function Page() {
  return (
    <Suspense>
      <CustomerPaymentsPage />
    </Suspense>
  );
}
