import { requireRole } from "@/lib/auth";
import { Shell } from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const s = await requireRole("tenant");
  return <Shell session={s}>{children}</Shell>;
}
