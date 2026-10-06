"use client";

import { Suspense } from "react";
import { PayrollRunPage } from "@/components/hr/PayrollRunPage";

// รอบที่เปิดอยู่อยู่ใน URL (?id=) - useSearchParams ต้องอยู่ใต้ Suspense
export default function Page() {
  return (
    <Suspense>
      <PayrollRunPage />
    </Suspense>
  );
}
