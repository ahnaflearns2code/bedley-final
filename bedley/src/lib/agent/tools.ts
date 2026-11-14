import { ObjectId } from "mongodb";
import type Anthropic from "@anthropic-ai/sdk";
import { C, getDb } from "../db";
import { searchPlaces } from "../integrations/places";
import { callAndSay, contractorDestination, placeVoiceCall, publicBaseUrl, sendSms, twilioConfigured } from "../integrations/twilio";
import { searchVideos } from "../integrations/youtube";
import { simulatedContractors, simulatedQuote } from "../sim/contractors";
import { postLandlordUpdate } from "../landlordUpdates";
import { bookingMessages } from "../scripts";

const SIMULATE = () => process.env.DEMO_SIMULATE_CONTRACTORS !== "0";
import { notifyTenant } from "../messaging";
import type { ResultStatus } from "../audit";

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: "triage_ticket",
    description:
      "Classify the maintenance request and write a structured diagnosis to the ticket. Call this first. If there is any risk to safety (gas smell, active flooding, sparking, no heat in freezing weather, CO alarm), set priority=emergency and include emergency instructions.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["plumbing", "electrical", "hvac", "appliance", "pest", "locks", "structural", "water_damage", "mould", "noise", "other"] },
        priority: { type: "string", enum: ["low", "normal", "high", "emergency"] },
        trade: { type: "string", description: "Trade to search for, e.g. 'plumber', 'electrician', 'HVAC technician'" },
        summary: { type: "string", description: "One or two sentence diagnosis for the landlord" },
        diy_safe: { type: "boolean", description: "True only if a tenant can safely try a fix without tools beyond a plunger/reset button" },
        diy_steps: { type: "array", items: { type: "string" } },
        emergency_instructions: { type: "string" },
        major_repair: { type: "boolean", description: "True if this is a big or costly job (flooding, water damage, no heat, electrical hazard, structural, mould, sewage) — the landlord gets a phone call before anything is booked" },
      },
      required: ["category", "priority", "trade", "summary", "diy_safe", "major_repair"],
    },
  },
  {
    name: "suggest_diy_fix",
    description:
      "Help the tenant fix or contain the problem themselves FIRST: clear, safe, numbered steps plus real YouTube tutorials. Use for simple issues (clogged drain, running toilet, tripped breaker reset, furnace filter) and also for safe interim steps on bigger issues (e.g. close the shut-off valve under the sink). Never suggest electrical, gas, structural or anything needing tools beyond a plunger.",
    input_schema: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" }, description: "3-6 short, safe steps" },
        video_search: { type: "string", description: "YouTube search query, e.g. 'how to unclog kitchen sink without chemicals'" },
        interim_only: { type: "boolean", description: "True if this only contains the problem while a contractor is arranged" },
      },
      required: ["steps", "video_search"],
    },
  },
  {
    name: "wait_for_tenant",
    description:
      "Pause until the tenant answers 'that fixed it' or 'still broken' on their ticket page (auto-continues after 10 minutes with no answer). Use right after suggest_diy_fix when the fix might fully solve it. Result: { tenant_answer: 'fixed' | 'not_fixed' | 'no_answer' }.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_contractors",
    description: "Find real local contractors for the trade near the property (Google Places + the landlord's saved contractors). Never invent contractors.",
    input_schema: {
      type: "object",
      properties: { trade: { type: "string" }, query: { type: "string", description: "Search text, e.g. 'emergency plumber'" } },
      required: ["trade", "query"],
    },
  },
  {
    name: "contact_contractor",
    description:
      "Contact one contractor for price and availability: an AI voice phone call (ElevenLabs voice over Twilio) when voice is configured, otherwise SMS. The platform adds the AI disclosure automatically. Do not include tenant names, phone numbers or unit numbers.",
    input_schema: {
      type: "object",
      properties: { contractor_id: { type: "string" }, message: { type: "string", description: "Short description of the job and what you need from them" } },
      required: ["contractor_id", "message"],
    },
  },
  {
    name: "wait_for_quotes",
    description:
      "Pause this workflow while contractors answer the AI phone call / SMS. The run sleeps (no tokens used) and resumes automatically with every quote received so far. Use after contacting contractors, before propose_booking. Max 120 seconds per call.",
    input_schema: {
      type: "object",
      properties: { seconds: { type: "integer", description: "How long to wait, 15-120" } },
      required: ["seconds"],
    },
  },
  {
    name: "propose_booking",
    description:
      "Propose booking one contractor. This ALWAYS pauses for landlord approval; the landlord may pick a different contractor. Call it on its own (no other tools in the same turn). Only include estimate_cents if a contractor actually quoted it.",
    input_schema: {
      type: "object",
      properties: {
        contractor_id: { type: "string" },
        estimate_cents: { type: "integer" },
        proposed_window: { type: "string" },
        rationale: { type: "string", description: "Why this contractor: rating, reviews, distance, availability, quoted price" },
      },
      required: ["contractor_id", "proposed_window", "rationale"],
    },
  },
  {
    name: "notify_tenant",
    description:
      "Send the tenant an update on their preferred channel (a phone call reads it aloud). After a booking, call with kind='booking_confirmed' and no message: the platform writes a full script (issue, contractors called, who is coming and when, cost covered by landlord, what to do meanwhile).",
    input_schema: { type: "object", properties: { message: { type: "string" }, kind: { type: "string", enum: ["update", "booking_confirmed"] } } },
  },
  {
    name: "notify_landlord",
    description: "Tell the landlord what happened and what was decided (shown on their dashboard). After a booking use kind='booking_confirmed' with no message for an automatic summary.",
    input_schema: { type: "object", properties: { message: { type: "string" }, kind: { type: "string", enum: ["update", "booking_confirmed"] } } },
  },
  {
    name: "charge_payment",
    description: "Charge the tenant or landlord. Agents are normally NOT permitted to move money; the policy gate decides.",
    input_schema: {
      type: "object",
      properties: { amount_cents: { type: "integer" }, reason: { type: "string" } },
      required: ["amount_cents", "reason"],
    },
  },
];

export interface ToolCtx {
  orgId: ObjectId;
  ticketId: ObjectId;
  runId: ObjectId;
  agentName: string;
}

export interface ToolOutcome {
  status: ResultStatus;
  output: Record<string, unknown>;
  providerId?: string;
  isError?: boolean;
}

type Executor = (input: any, ctx: ToolCtx) => Promise<ToolOutcome>;

const PRIORITY_STATUS: Record<string, string> = { emergency: "emergency", high: "contractor_search", normal: "contractor_search", low: "contractor_search" };

export const EXECUTORS: Record<string, Executor> = {
  async suggest_diy_fix(input, ctx) {
    const db = await getDb();
    const ticket = await db.collection(C.tickets).findOne({ _id: ctx.ticketId, orgId: ctx.orgId });
    if (!ticket) return { status: "failed", output: { error: "Ticket not found" }, isError: true };
    const steps: string[] = (input.steps || []).map((x: unknown) => String(x).slice(0, 300)).slice(0, 8);
    const yt = await searchVideos(String(input.video_search || ticket.title), 3);
    await db.collection(C.tickets).updateOne(
      { _id: ctx.ticketId },
      {
        $set: {
          diySteps: steps,
          videos: yt.videos,
          diyInterim: !!input.interim_only,
          ...(input.interim_only ? {} : { status: "ai_troubleshooting", diyResult: null }),
          updatedAt: new Date(),
        },
      }
    );
    const msg =
      (input.interim_only ? "While we line up a contractor, here's how to limit the damage:\n" : "Let's try a quick fix first:\n") +
      steps.map((x, i) => `${i + 1}. ${x}`).join("\n") +
      (yt.videos.length ? `\n\nVideo guide: ${yt.videos[0].title} — ${yt.videos[0].url}` : "") +
      (input.interim_only ? "" : "\n\nOn your request page, tap \"That fixed it\" or \"Still broken\".");
    const n = await notifyTenant(ctx.orgId, ticket.tenantId, msg, { type: "agent", id: `agent:${ctx.agentName}`, name: "Bedley AI" }, ctx.ticketId);
    return {
      status: "confirmed",
      output: { stepsSent: steps.length, videos: yt.videos.map((v) => v.title), youtubeError: yt.ok ? undefined : yt.error, tenantNotifiedVia: n.channel },
    };
  },

  async triage_ticket(input, ctx) {
    const db = await getDb();
    const status = input.diy_safe && input.priority === "low" ? "ai_troubleshooting" : PRIORITY_STATUS[input.priority] ?? "contractor_search";
    const r = await db.collection(C.tickets).updateOne(
      { _id: ctx.ticketId, orgId: ctx.orgId },
      {
        $set: {
          category: input.category,
          priority: input.priority,
          trade: input.trade,
          aiDiagnosis: input.summary,
          diySafe: !!input.diy_safe,
          diySteps: input.diy_steps ?? [],
          emergencyInstructions: input.emergency_instructions ?? null,
          majorRepair: !!input.major_repair || input.priority === "emergency",
          status,
          updatedAt: new Date(),
        },
      }
    );
    if (r.matchedCount === 1 && (input.priority === "emergency" || input.major_repair)) {
      // Phone the landlord right now with a briefing (fire-and-forget; the call result is audited).
      void import("../approvals").then((m) => m.briefLandlordsNow(ctx.orgId, ctx.ticketId)).catch((e) => console.error("[brief landlord]", e));
    }
    return {
      status: r.matchedCount === 1 ? "confirmed" : "failed",
      output: { ok: r.matchedCount === 1, ticketStatus: status, landlordWillBeCalled: !!input.major_repair || input.priority === "emergency" },
      isError: r.matchedCount !== 1,
    };
  },

  async search_contractors(input, ctx) {
    const db = await getDb();
    const ticket = await db.collection(C.tickets).findOne({ _id: ctx.ticketId, orgId: ctx.orgId });
    const property = ticket && (await db.collection(C.properties).findOne({ _id: ticket.propertyId, orgId: ctx.orgId }));
    if (!property) return { status: "failed", output: { error: "Property not found" }, isError: true };

    const found: Array<Record<string, unknown>> = [];
    if (SIMULATE()) {
      const sims = simulatedContractors(String(input.trade), 4, ctx.ticketId.getTimestamp().getTime());
      for (const c of sims) {
        const up = await db.collection(C.contractors).findOneAndUpdate(
          { orgId: ctx.orgId, name: c.name, source: "demo_simulated" },
          {
            $set: { rating: c.rating, reviews: c.reviews, distanceKm: c.distanceKm, phone: null, updatedAt: new Date() },
            $addToSet: { trades: c.trade },
            $setOnInsert: { orgId: ctx.orgId, name: c.name, source: "demo_simulated", verification: "unverified", createdAt: new Date() },
          },
          { upsert: true, returnDocument: "after" }
        );
        found.push({ id: String(up!._id), name: c.name, rating: c.rating, reviews: c.reviews, distanceKm: c.distanceKm, source: "local_search" });
      }
      await db.collection(C.tickets).updateOne(
        { _id: ctx.ticketId },
        { $set: { candidateContractorIds: found.map((f) => new ObjectId(String(f.id))), status: "contractor_search", updatedAt: new Date() } }
      );
      return { status: "confirmed", output: { contractors: found, simulated: true } };
    }
    const places = await searchPlaces(`${input.query} ${property.city}`, { lat: property.lat, lng: property.lng }, 5);
    for (const p of places.results) {
      const up = await db.collection(C.contractors).findOneAndUpdate(
        { orgId: ctx.orgId, placeId: p.placeId },
        {
          $set: { name: p.name, address: p.address, phone: p.phone, website: p.website, rating: p.rating, reviews: p.reviews, source: "google_places", updatedAt: new Date() },
          $addToSet: { trades: String(input.trade).toLowerCase() },
          $setOnInsert: { orgId: ctx.orgId, placeId: p.placeId, verification: "unverified", createdAt: new Date() },
        },
        { upsert: true, returnDocument: "after" }
      );
      found.push({ id: String(up!._id), name: p.name, rating: p.rating, reviews: p.reviews, distanceKm: p.distanceKm, source: "google_places", verification: up!.verification });
    }
    // Landlord's saved / preferred contractors for this trade
    const saved = await db
      .collection(C.contractors)
      .find({ orgId: ctx.orgId, source: "saved", trades: { $regex: String(input.trade).split(" ")[0], $options: "i" }, blacklisted: { $ne: true } })
      .limit(3)
      .toArray();
    for (const s of saved) found.push({ id: String(s._id), name: s.name, rating: s.rating, reviews: s.reviews, source: "saved_directory", verification: s.verification });

    if (!found.length)
      return { status: "failed", output: { error: places.error || "No contractors found", hint: "Add saved contractors in settings or configure GOOGLE_PLACES_API_KEY" }, isError: true };

    await db.collection(C.tickets).updateOne(
      { _id: ctx.ticketId },
      { $set: { candidateContractorIds: found.map((f) => new ObjectId(String(f.id))), status: "contractor_search", updatedAt: new Date() } }
    );
    return { status: "confirmed", output: { contractors: found, placesError: places.ok ? undefined : places.error } };
  },

  async contact_contractor(input, ctx) {
    const db = await getDb();
    if (!ObjectId.isValid(input.contractor_id)) return { status: "failed", output: { error: "Invalid contractor_id" }, isError: true };
    const contractor = await db.collection(C.contractors).findOne({ _id: new ObjectId(input.contractor_id), orgId: ctx.orgId });
    if (!contractor) return { status: "failed", output: { error: "Contractor not in this organisation's results" }, isError: true };
    const ticket = await db.collection(C.tickets).findOne({ _id: ctx.ticketId });
    const org = await db.collection(C.orgs).findOne({ _id: ctx.orgId });
    const code = `Q${(ticket?.contacts?.length ?? 0) + 1}`;
    if (contractor.source === "demo_simulated") {
      // Demo market: the "call" connects and the contractor answers a few seconds later (worker delivers the quote).
      const n = ticket?.contacts?.length ?? 0;
      const q = simulatedQuote(String(ticket?.trade || "handyman"), ticket?.priority === "emergency" || ticket?.priority === "high", contractor._id.getTimestamp().getTime() + n * 7919);
      await db.collection(C.tickets).updateOne(
        { _id: ctx.ticketId },
        {
          $push: { contacts: { code, channel: "voice", contractorId: contractor._id, simulated: true, status: "confirmed", sentAt: new Date(), replyAt: new Date(Date.now() + 4000 + n * 3500 + Math.round(Math.random() * 2500)), simQuote: q } } as any,
          $set: { updatedAt: new Date() },
        }
      );
      return { status: "confirmed", output: { channel: "ai_voice_call", connected: true, code, simulated: true } };
    }
    const dest = contractorDestination(contractor);
    if (!dest.to) return { status: "failed", output: { error: "Contractor has no phone number in your directory" }, isError: true };

    // Twilio trial accounts can't send custom SMS, so the agent phones contractors.
    // SMS is used only when TWILIO_SMS_ENABLED=1 (upgraded Twilio account) or Twilio isn't configured.
    const base = publicBaseUrl();
    const smsOk = process.env.TWILIO_SMS_ENABLED === "1";
    const voice = twilioConfigured() && (!smsOk || !!base);
    const interactive = voice && !!base; // can listen for the spoken quote only with a public URL
    const job = String(input.message).slice(0, 300);
    const orgName = org?.name ?? "a property manager";
    let res;
    if (interactive) {
      await db.collection(C.tickets).updateOne({ _id: ctx.ticketId }, { $set: { [`callScripts.${code}`]: { job, org: orgName, contractor: contractor.name } } });
      res = await placeVoiceCall(
        dest.to,
        `${base}/api/voice/contractor?t=${ctx.ticketId}&c=${code}`,
        `Hi ${contractor.name}, this is an automated A.I. assistant calling for ${orgName}, a property manager in Toronto. We have a repair job: ${job}`,
        `${base}/api/voice/quote?t=${ctx.ticketId}&c=${code}`
      );
    } else if (voice) {
      res = await callAndSay(
        dest.to,
        `Hello ${contractor.name}, this is an automated A.I. assistant calling for ${orgName}, a property manager in Toronto. ${job} If you can take this job, please call back this number with your price and availability. Thank you.`
      );
    } else {
      const body =
        `Hi ${contractor.name}, this is an automated AI maintenance assistant for ${orgName} in Toronto. ` +
        `${job} Please reply starting with ${code}, then your price estimate and earliest availability. Reply STOP to opt out.`;
      res = await sendSms(dest.to, body);
    }
    await db.collection(C.tickets).updateOne(
      { _id: ctx.ticketId },
      {
        $push: {
          contacts: { code, channel: voice ? (interactive ? "voice" : "voice_message") : "sms", contractorId: contractor._id, to: dest.to, redirectedToDemo: dest.redirected, sid: res.providerId ?? null, status: res.status, sentAt: new Date() },
        } as any,
        $set: { updatedAt: new Date() },
      }
    );
    return {
      status: res.status,
      providerId: res.providerId,
      output: { channel: voice ? "ai_voice_call" : "sms", listensForQuote: interactive, delivery: res.status, detail: res.detail, code, redirectedToDemoPhone: dest.redirected },
      isError: res.status === "failed",
    };
  },

  /** Only reached after the policy gate returns "allowed" (i.e. a human approved). */
  async propose_booking(input, ctx) {
    const db = await getDb();
    const contractor = await db.collection(C.contractors).findOne({ _id: new ObjectId(input.contractor_id), orgId: ctx.orgId });
    if (!contractor) return { status: "failed", output: { error: "Contractor not found" }, isError: true };
    if (contractor.source === "demo_simulated") {
      await db.collection(C.tickets).updateOne(
        { _id: ctx.ticketId },
        {
          $set: {
            status: "contractor_booked",
            booking: { contractorId: contractor._id, contractorName: contractor.name, window: input.proposed_window, approvedCents: input.estimate_cents ?? null, confirmation: { status: "confirmed", simulated: true }, bookedAt: new Date() },
            updatedAt: new Date(),
          },
        }
      );
      return { status: "confirmed", output: { booked: true, contractor: contractor.name, window: input.proposed_window, simulated: true } };
    }
    const dest = contractorDestination(contractor);
    const confirmText =
      `Hello ${contractor.name}, this is the automated A.I. assistant again. The property manager has approved the booking for ${input.proposed_window}` +
      (input.estimate_cents ? `, up to ${Math.round(input.estimate_cents / 100)} dollars` : "") +
      `. They will be in touch with the address. Thank you.`;
    const sms = dest.to
      ? process.env.TWILIO_SMS_ENABLED === "1"
        ? await sendSms(dest.to, confirmText)
        : await callAndSay(dest.to, confirmText)
      : { status: "failed" as const, detail: "No phone" };
    await db.collection(C.tickets).updateOne(
      { _id: ctx.ticketId },
      {
        $set: {
          status: sms.status === "failed" ? "awaiting_approval" : "contractor_booked",
          booking: {
            contractorId: contractor._id,
            contractorName: contractor.name,
            window: input.proposed_window,
            approvedCents: input.estimate_cents ?? null,
            confirmation: { status: sms.status, sid: sms.providerId ?? null },
            bookedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      }
    );
    return {
      status: sms.status,
      providerId: sms.providerId,
      output: { booked: sms.status !== "failed", contractor: contractor.name, window: input.proposed_window, detail: sms.detail },
      isError: sms.status === "failed",
    };
  },

  async notify_tenant(input, ctx) {
    const db = await getDb();
    const ticket = await db.collection(C.tickets).findOne({ _id: ctx.ticketId, orgId: ctx.orgId });
    if (!ticket) return { status: "failed", output: { error: "Ticket not found" }, isError: true };
    const text = input.kind === "booking_confirmed" || !input.message ? (await bookingMessages(ctx.ticketId)).tenant : String(input.message);
    const r = await notifyTenant(ctx.orgId, ticket.tenantId, text, { type: "agent", id: `agent:${ctx.agentName}`, name: "Bedley AI" }, ctx.ticketId);
    const status: ResultStatus = !r.external ? "confirmed" : r.external.status;
    return { status, providerId: r.external?.providerId, output: { channel: r.channel, inApp: "stored", external: r.external?.status ?? "n/a", detail: r.external?.detail } };
  },

  async notify_landlord(input, ctx) {
    const text = input.kind === "booking_confirmed" || !input.message ? (await bookingMessages(ctx.ticketId)).landlord : String(input.message);
    await postLandlordUpdate(ctx.orgId, ctx.ticketId, text);
    return { status: "confirmed", output: { posted: true } };
  },

  async charge_payment() {
    // Intentionally no implementation: money movement requires a human in the dashboard.
    return { status: "failed", output: { error: "Agents cannot move money." }, isError: true };
  },
};
