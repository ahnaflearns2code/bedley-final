import { sendMessageAction, startCallAction } from "@/app/actions";
import { Badge, when } from "./ui";

/* eslint-disable @typescript-eslint/no-explicit-any */
const CH_LABEL: Record<string, string> = { in_app: "in-app", sms: "SMS", whatsapp: "WhatsApp", email: "email", call: "call" };

export function Thread({ convoId, messages, viewerId, canChooseChannel, tenantPrefs }: {
  convoId: string;
  messages: any[];
  viewerId: string;
  canChooseChannel: boolean;
  tenantPrefs?: { preferredChannel?: string; optIn?: { sms?: boolean; whatsapp?: boolean } };
}) {
  return (
    <div className="panel flex h-[70vh] flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && <p className="text-center text-sm text-ink-faint">No messages yet.</p>}
        {messages.map((m) => {
          const mine = m.sender?.id === viewerId;
          return (
            <div key={String(m._id)} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[75%] rounded border px-3 py-2 text-sm ${mine ? "border-forest/20 bg-forest-50" : m.sender?.type === "agent" ? "border-sky-200 bg-sky-50" : "border-line bg-white"}`}>
                <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <span className="font-medium text-ink-soft">{m.sender?.name}</span>
                  {m.sender?.type === "agent" && <Badge tone="blue">AI</Badge>}
                  <Badge>{CH_LABEL[m.channel] ?? m.channel}</Badge>
                  <span>{when(m.ts)}</span>
                </div>
                <p className="whitespace-pre-wrap">{m.body}</p>
                {m.delivery && (
                  <div className={`mt-1 text-[11px] ${m.delivery.status === "failed" ? "text-danger" : "text-ink-faint"}`}>
                    {m.delivery.status}{m.delivery.detail ? ` — ${m.delivery.detail}` : ""}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <form action={sendMessageAction} className="flex gap-2 border-t border-line p-3">
        <input type="hidden" name="conversationId" value={convoId} />
        {canChooseChannel && (
          <select name="channel" className="input w-36" defaultValue="in_app">
            <option value="in_app">In-app</option>
            <option value="sms" disabled={!tenantPrefs?.optIn?.sms}>SMS{tenantPrefs?.optIn?.sms ? "" : " (no opt-in)"}</option>
            <option value="whatsapp" disabled={!tenantPrefs?.optIn?.whatsapp}>WhatsApp{tenantPrefs?.optIn?.whatsapp ? "" : " (no opt-in)"}</option>
            <option value="email">Email</option>
          </select>
        )}
        <input name="body" className="input flex-1" placeholder="Write a message…" autoComplete="off" />
        <button className="btn btn-primary">Send</button>
      </form>
      {canChooseChannel && (
        <form action={startCallAction} className="border-t border-line px-3 py-2 text-xs text-ink-faint">
          <input type="hidden" name="conversationId" value={convoId} />
          <button className="btn py-1 text-xs">Call tenant (masked number)</button>
          <span className="ml-2">Twilio rings your phone, then connects the tenant. Neither of you sees the other&apos;s number. Not recorded.</span>
        </form>
      )}
    </div>
  );
}
