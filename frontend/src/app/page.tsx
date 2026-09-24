import { HomeDashboard } from "@/components/HomeDashboard";
import { RegistrationOverview } from "@/components/RegistrationOverview";

export default function DashboardPage() {
  return <HomeDashboard fallback={<RegistrationOverview />} />;
}
