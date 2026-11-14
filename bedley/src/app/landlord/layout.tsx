import { requireRole } from "@/lib/auth";
import { Shell } from "@/components/Shell";

export const dynamic = "force-dynamic";

export default async function LandlordLayout({ children }: { children: React.ReactNode }) {
  const s = await requireRole("landlord", "admin");
  return <Shell session={s}>{children}</Shell>;
}
