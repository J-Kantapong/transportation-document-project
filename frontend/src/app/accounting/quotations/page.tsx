"use client";

import { Suspense } from "react";
import { QuotationsPage } from "@/components/QuotationsPage";

export default function Page() {
  return (
    <Suspense>
      <QuotationsPage />
    </Suspense>
  );
}
