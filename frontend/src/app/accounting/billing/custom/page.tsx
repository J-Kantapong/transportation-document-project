"use client";

import { Suspense } from "react";
import { BillingCustomInvoicePage } from "@/components/BillingCustomInvoicePage";

export default function Page() {
  return (
    <Suspense>
      <BillingCustomInvoicePage />
    </Suspense>
  );
}
