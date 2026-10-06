"use client";

import { Suspense } from "react";
import { TaxInvoiceCustomPage } from "@/components/TaxInvoiceCustomPage";

export default function Page() {
  return (
    <Suspense>
      <TaxInvoiceCustomPage />
    </Suspense>
  );
}
