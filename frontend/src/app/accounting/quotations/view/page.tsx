"use client";

import { Suspense } from "react";
import { QuotationDetailPage } from "@/components/QuotationDetailPage";

export default function Page() {
  return (
    <Suspense>
      <QuotationDetailPage />
    </Suspense>
  );
}
