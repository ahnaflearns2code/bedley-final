import Link from "next/link";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { maskSin } from "@/lib/encryption";
import { money } from "@/components/ui";

export default async function TenantsPage() {
  const s = await requireRole("landlord", "admin");
  const db = await getDb();
  const tenants = await db.collection(C.tenants).find(orgFilter(s)).sort({ name: 1 }).toArray();
  const units = Object.fromEntries((await db.collection(C.units).find(orgFilter(s)).toArray()).map((u) => [String(u._id), u]));
  return (
    <div className="space-y-4">
      <h1 className="h1">Tenants</h1>
      <div className="panel overflow-hidden">
        <table className="tbl">
          <thead><tr><th>Name</th><th>Unit</th><th>Rent</th><th>Phone</th><th>SIN</th><th>Preferred channel</th></tr></thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={String(t._id)} className="hover:bg-stone-50">
                <td><Link href={`/landlord/tenants/${t._id}`} className="font-medium text-forest hover:underline">{t.name}</Link><div className="text-xs text-ink-faint">{t.email}</div></td>
                <td>{units[String(t.unitId)]?.label}</td>
                <td>{money(units[String(t.unitId)]?.rentCents)}</td>
                <td className="mono">{t.phoneLast4 ? `••• ${t.phoneLast4}` : "—"}</td>
                <td className="mono">{maskSin(t.sinLast3)}</td>
                <td className="capitalize text-ink-soft">{String(t.preferredChannel ?? "in_app").replace("_", "-")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
