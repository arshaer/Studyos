import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib-admin";
import { AdminAiDashboard } from "@/components/AdminAiDashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!await requireAdmin()) notFound();
  return <AdminAiDashboard />;
}
