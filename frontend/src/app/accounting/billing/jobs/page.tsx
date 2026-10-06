"use client";

import { Suspense } from "react";
import { OtherJobsBillingPage } from "@/components/OtherJobsBillingPage";

export default function Page() {
  return (
    <Suspense>
      <OtherJobsBillingPage />
    </Suspense>
  );
}
