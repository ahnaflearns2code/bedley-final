import { ObjectId } from "mongodb";
import { requireRole } from "@/lib/auth";
import { C, getDb } from "@/lib/db";
import { getOrCreateConversation } from "@/lib/messaging";
import { Thread } from "@/components/Thread";

export default async function TenantMessages() {
  const s = await requireRole("tenant");
  const db = await getDb();
  const convo = await getOrCreateConversation(new ObjectId(s.orgId), new ObjectId(s.tenantId));
  const messages = await db.collection(C.messages).find({ conversationId: convo._id, tenantId: new ObjectId(s.tenantId) }).sort({ ts: 1 }).limit(200).toArray();
  return (
    <div className="space-y-4">
      <h1 className="h1">Messages with your landlord</h1>
      <Thread convoId={String(convo._id)} messages={messages} viewerId={s.userId} canChooseChannel={false} />
      <p className="text-xs text-ink-faint">Messages may also reach you by SMS, WhatsApp or email, depending on your preferences in Profile. Chat messages are not formal legal notices.</p>
    </div>
  );
}
