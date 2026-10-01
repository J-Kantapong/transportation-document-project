"use client";

import { Suspense } from "react";
import { QuotationFormPage } from "@/components/QuotationFormPage";

export default function Page() {
  return (
    <Suspense>
      <QuotationFormPage />
    </Suspense>
  );
}
