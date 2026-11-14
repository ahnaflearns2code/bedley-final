import Link from "next/link";
import { ObjectId } from "mongodb";
import { requireRole, orgFilter } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { getOrCreateConversation } from "@/lib/messaging";
import { Thread } from "@/components/Thread";
import { when } from "@/components/ui";

export default async function LandlordMessages({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const s = await requireRole("landlord", "admin");
  const { t } = await searchParams;
  const db = await getDb();
  const tenants = await db.collection(C.tenants).find(orgFilter(s)).sort({ name: 1 }).toArray();
  const convos = await db.collection(C.conversations).find(orgFilter(s)).toArray();
  const byTenant = Object.fromEntries(convos.map((c) => [String(c.tenantId), c]));
  const active = tenants.find((x) => String(x._id) === t) ?? tenants[0];
  const convo = active ? await getOrCreateConversation(new ObjectId(s.orgId), active._id) : null;
  const messages = convo ? await db.collection(C.messages).find({ conversationId: convo._id, ...orgFilter(s) }).sort({ ts: 1 }).limit(200).toArray() : [];

  return (
    <div className="space-y-4">
      <h1 className="h1">Messages</h1>
      <div className="grid gap-4 md:grid-cols-[240px_1fr]">
        <div className="panel divide-y divide-line self-start">
          {tenants.map((x) => {
            const c = byTenant[String(x._id)];
            const isActive = active && String(active._id) === String(x._id);
            return (
              <Link key={String(x._id)} href={`/landlord/messages?t=${x._id}`} className={`block px-3 py-2.5 text-sm ${isActive ? "bg-forest-50" : "hover:bg-stone-50"}`}>
                <div className="font-medium">{x.name}</div>
                <div className="truncate text-xs text-ink-faint">{c?.lastMessage ?? "No messages"}</div>
                {c?.updatedAt && <div className="text-[11px] text-ink-faint">{when(c.updatedAt)}</div>}
              </Link>
            );
          })}
        </div>
        {convo && active && (
          <Thread convoId={String(convo._id)} messages={messages} viewerId={s.userId} canChooseChannel tenantPrefs={{ preferredChannel: active.preferredChannel, optIn: active.optIn }} />
        )}
      </div>
    </div>
  );
}
