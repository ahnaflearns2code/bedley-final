import { ObjectId } from "mongodb";
import { C, getDb } from "./db";

const PLURAL: Record<string, string> = {
  plumber: "plumbers", electrician: "electricians", hvac: "heating and cooling companies", appliance: "appliance repair shops",
  pest: "pest control companies", locks: "locksmiths", handyman: "handyman services",
};
const plural = (trade?: string) => {
  const t = String(trade || "").toLowerCase();
  const k = Object.keys(PLURAL).find((x) => t.includes(x === "hvac" ? "hvac" : x)) ?? (/heat|furnace/.test(t) ? "hvac" : "handyman");
  return PLURAL[k];
};
const dollars = (c?: number | null) => (c ? `$${Math.round(c / 100)}` : "");

/** Full spoken/written scripts once a contractor is booked — for the tenant and the landlord. */
export async function bookingMessages(ticketId: ObjectId) {
  const db = await getDb();
  const t = await db.collection(C.tickets).findOne({ _id: ticketId });
  if (!t) return { tenant: "Your repair has been arranged.", landlord: "A repair was arranged." };
  const [tenant, unit, property, landlord, approval] = await Promise.all([
    db.collection(C.tenants).findOne({ _id: t.tenantId }),
    db.collection(C.units).findOne({ _id: t.unitId }),
    db.collection(C.properties).findOne({ _id: t.propertyId }),
    db.collection(C.users).findOne({ orgId: t.orgId, role: "landlord" }),
    db.collection(C.approvals).find({ ticketId }).sort({ requestedAt: -1 }).limit(1).next(),
  ]);
  const first = String(tenant?.name ?? "there").split(" ")[0];
  const lfirst = String(landlord?.name ?? "your landlord").split(" ")[0];
  const n = t.contacts?.length ?? 0;
  const b = { ...(t.booking || {}) };
  if (b.window) b.window = String(b.window).replace(/\.+$/, "");
  const contractor = b.contractorId ? await db.collection(C.contractors).findOne({ _id: b.contractorId }) : null;
  const names = new Map<string, string>();
  if (t.candidateContractorIds?.length)
    for (const c of await db.collection(C.contractors).find({ _id: { $in: t.candidateContractorIds } }).toArray()) names.set(String(c._id), c.name);
  const quoteList = (t.quotes ?? [])
    .filter((q: any) => q.amountCents)
    .map((q: any) => `${names.get(String(q.contractorId)) ?? "a contractor"} ${dollars(q.amountCents)}`)
    .join(", ");
  const issue = String(t.title || "repair").replace(/\.$/, "");
  const humanApproved = approval?.status === "approved";

  const tenantMsg =
    `Hi ${first}, this is Bedley, your building's maintenance assistant, with an update on the ${issue.toLowerCase()} you reported. ` +
    `I called ${n || "several"} local ${plural(t.trade)} and compared their prices and availability. ` +
    `I've booked ${b.contractorName ?? "a contractor"}${contractor?.rating ? `, rated ${contractor.rating} stars` : ""}. They'll come ${b.window ?? "soon"}. ` +
    `The cost is covered by your landlord, ${lfirst}, who has already been told. ` +
    (t.diyInterim ? "Until then, please keep the water valve under the sink closed and a towel down. " : "") +
    `If anything changes, just reply in the Bedley app. Thanks, ${first}!`;

  const landlordMsg =
    `${tenant?.name ?? "A tenant"} at ${property?.name ?? "your property"}, unit ${unit?.label ?? ""} reported: ${issue}. ` +
    `Bedley called ${n} ${plural(t.trade)}${quoteList ? ` (${quoteList})` : ""} and booked ${b.contractorName ?? "a contractor"}` +
    `${b.approvedCents ? ` for ${dollars(b.approvedCents)}` : ""}, ${b.window ?? ""}. ` +
    (humanApproved ? "You approved this booking." : "It was under your auto-book limit, so Bedley booked it without calling you.") +
    ` ${first} has been told.`;

  return { tenant: tenantMsg, landlord: landlordMsg };
}
