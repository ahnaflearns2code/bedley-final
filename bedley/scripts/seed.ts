/**
 * Seeds demo data + indexes + schema validation into the Atlas Sandbox.
 *   npm run seed            (refuses if data exists)
 *   npm run seed -- --reset (drops the app's collections first — demo DB only!)
 *
 * Standalone on purpose (no "server-only" imports) so it runs with plain tsx.
 */
import dns from "node:dns";
import { MongoClient, ClientEncryption, ObjectId, Db } from "mongodb";

dns.setServers(["8.8.8.8", "1.1.1.1"]);
import bcrypt from "bcryptjs";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "keystone";
const masterKey = process.env.ENCRYPTION_MASTER_KEY;
if (!uri || !masterKey) {
  console.error("Set MONGODB_URI and ENCRYPTION_MASTER_KEY in .env first.");
  process.exit(1);
}

const norm = (p: string) => {
  const d = p.replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d;
};

async function ensureValidators(db: Db) {
  const validators: Record<string, object> = {
    audit_logs: {
      $jsonSchema: {
        bsonType: "object",
        required: ["orgId", "actor", "action", "ts"],
        properties: {
          orgId: { bsonType: "objectId" },
          actor: { bsonType: "object", required: ["type", "id", "name"], properties: { type: { enum: ["agent", "user", "system", "provider"] } } },
          action: { bsonType: "string" },
          decision: { enum: ["allowed", "denied", "needs_approval"] },
          ts: { bsonType: "date" },
        },
      },
    },
    rent_records: {
      $jsonSchema: {
        bsonType: "object",
        required: ["orgId", "tenantId", "period", "amountCents", "status", "dueDate"],
        properties: {
          amountCents: { bsonType: ["int", "long"], minimum: 0 },
          status: { enum: ["due", "processing", "paid", "failed", "overdue", "disputed", "under_review"] },
          period: { bsonType: "string", pattern: "^\\d{4}-\\d{2}$" },
        },
      },
    },
    maintenance_requests: {
      $jsonSchema: {
        bsonType: "object",
        required: ["orgId", "tenantId", "unitId", "title", "status"],
        properties: {
          priority: { enum: ["low", "normal", "high", "emergency", null] },
          status: { enum: ["new", "ai_triage", "ai_troubleshooting", "contractor_search", "awaiting_approval", "contractor_booked", "in_progress", "completed", "closed", "emergency", "cancelled"] },
        },
      },
    },
    tenants: {
      $jsonSchema: {
        bsonType: "object",
        required: ["orgId", "name", "email", "unitId"],
        properties: { sinEnc: { bsonType: "binData" }, dobEnc: { bsonType: "binData" }, phoneEnc: { bsonType: "binData" } },
      },
    },
    policies: {
      $jsonSchema: {
        bsonType: "object",
        required: ["orgId", "version", "tools", "spendingLimitCents", "hardCapCents"],
      },
    },
  };
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  for (const [name, validator] of Object.entries(validators)) {
    if (existing.has(name)) await db.command({ collMod: name, validator, validationLevel: "moderate" });
    else await db.createCollection(name, { validator, validationLevel: "moderate" });
  }
}

async function ensureIndexes(db: Db) {
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
  await db.collection("tenants").createIndex({ orgId: 1, unitId: 1 });
  await db.collection("tenants").createIndex({ phoneEnc: 1 });
  await db.collection("properties").createIndex({ orgId: 1 });
  await db.collection("units").createIndex({ orgId: 1, propertyId: 1 });
  await db.collection("maintenance_requests").createIndex({ orgId: 1, status: 1, updatedAt: -1 });
  await db.collection("maintenance_requests").createIndex({ tenantId: 1, createdAt: -1 });
  await db.collection("maintenance_requests").createIndex({ "contacts.to": 1, updatedAt: -1 });
  await db.collection("agent_runs").createIndex({ orgId: 1, status: 1 });
  await db.collection("approvals").createIndex({ orgId: 1, status: 1, requestedAt: -1 });
  await db.collection("approvals").createIndex({ runId: 1, toolUseId: 1 }, { unique: true });
  await db.collection("audit_logs").createIndex({ orgId: 1, ts: -1 });
  await db.collection("audit_logs").createIndex({ ticketId: 1, ts: 1 });
  await db.collection("audit_logs").createIndex({ runId: 1, toolUseId: 1 });
  await db.collection("audit_logs").createIndex({ "result.providerId": 1 }, { sparse: true });
  await db.collection("policies").createIndex({ orgId: 1, version: -1 }, { unique: true });
  await db.collection("rent_records").createIndex({ orgId: 1, period: 1 });
  await db.collection("rent_records").createIndex({ tenantId: 1, dueDate: -1 });
  await db.collection("payments").createIndex({ stripePaymentIntentId: 1 }, { unique: true, partialFilterExpression: { stripePaymentIntentId: { $type: "string" } } });
  await db.collection("contractors").createIndex({ orgId: 1, placeId: 1 }, { unique: true, partialFilterExpression: { placeId: { $type: "string" } } });
  await db.collection("conversations").createIndex({ orgId: 1, tenantId: 1 }, { unique: true });
  await db.collection("messages").createIndex({ conversationId: 1, ts: 1 });
  await db.collection("messages").createIndex({ ticketId: 1, ts: 1 });
  await db.collection("messages").createIndex({ "delivery.providerId": 1 }, { sparse: true });
  // Quarantined unknown-sender messages expire after 7 days (TTL)
  await db.collection("quarantined_messages").createIndex({ receivedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
  // ElevenLabs audio clips for live calls expire after a day (TTL)
  await db.collection("voice_clips").createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });
  await db.collection("maintenance_requests").createIndex({ status: 1, agentClaimedAt: 1, createdAt: 1 });
  await db.collection("agent_runs").createIndex({ status: 1, resumeAt: 1 });
}

async function main() {
  const reset = process.argv.includes("--reset");
  const client = await new MongoClient(uri!, { ignoreUndefined: true }).connect();
  const db = client.db(dbName);

  if (reset) {
    for (const c of await db.listCollections().toArray()) await db.collection(c.name).drop();
    await client.db("encryption").collection("__keyVault").drop().catch(() => {});
    console.log("Reset: dropped all collections in", dbName);
  } else if (await db.collection("users").countDocuments()) {
    console.log("Data already exists. Use `npm run seed -- --reset` to start over.");
    await client.close();
    return;
  }

  // ---- encryption key
  const kv = client.db("encryption").collection("__keyVault");
  await kv.createIndex({ keyAltNames: 1 }, { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } });
  const ce = new ClientEncryption(client, { keyVaultNamespace: "encryption.__keyVault", kmsProviders: { local: { key: Buffer.from(masterKey!, "base64") } } });
  if (!(await kv.findOne({ keyAltNames: "tenant-pii" }))) await ce.createDataKey("local", { keyAltNames: ["tenant-pii"] });
  const encR = (v: string) => ce.encrypt(v, { keyAltName: "tenant-pii", algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Random" });
  const encD = (v: string) => ce.encrypt(v, { keyAltName: "tenant-pii", algorithm: "AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic" });

  await ensureValidators(db);
  await ensureIndexes(db);

  const now = new Date();
  const hash = await bcrypt.hash("demo1234", 10);
  const orgId = new ObjectId();
  await db.collection("organizations").insertOne({ _id: orgId, name: "Raman Property Group", jurisdiction: "ON", demo: true, createdAt: now });

  const propertyId = new ObjectId();
  const property2Id = new ObjectId();
  await db.collection("properties").insertMany([
    {
      _id: propertyId, orgId, name: "Midland Commons", address: "2350 Midland Ave", city: "Toronto", province: "ON", postal: "M1S 1P8",
      lat: 43.7865, lng: -79.2717, yearBuilt: 1988, demo: true, createdAt: now,
      appliances: [{ type: "Furnace", model: "Carrier 59SC5", installed: "2019" }, { type: "Water heater", model: "Rheem 40 gal (rental)", installed: "2021" }],
    },
    {
      _id: property2Id, orgId, name: "Birchmount Terrace", address: "1910 Birchmount Rd", city: "Toronto", province: "ON", postal: "M1P 2J3",
      lat: 43.7726, lng: -79.2938, yearBuilt: 1995, demo: true, createdAt: now,
      appliances: [{ type: "Boiler", model: "Navien NCB-240E", installed: "2020" }],
    },
  ]);
  const units = [
    { _id: new ObjectId(), propertyId: property2Id, label: "1A", rentCents: 185000, beds: 1 },
    { _id: new ObjectId(), propertyId, label: "2B", rentCents: 215000, beds: 2 },
  ];
  await db.collection("units").insertMany(units.map((u) => ({ ...u, orgId, demo: true })));

  const landlordUserId = new ObjectId();
  await db.collection("users").insertOne({
    _id: landlordUserId, orgId, email: "landlord@bedley.demo", passwordHash: hash, role: "landlord", name: "Priya Raman", callForApprovals: true,
    phoneEnc: process.env.DEMO_LANDLORD_PHONE ? await encD(norm(process.env.DEMO_LANDLORD_PHONE)) : undefined, demo: true, createdAt: now,
  });

  const tenantDefs = [
    { name: "Marcus Chen", email: "tenant@bedley.demo", unit: units[1], phone: process.env.DEMO_TENANT_PHONE || "+14165550142", sin: "046454286", pref: "in_app" },
    { name: "Aisha Okafor", email: "tenant2@bedley.demo", unit: units[0], phone: "+14165550177", sin: null, pref: "email" },
  ];
  const tenantIds: ObjectId[] = [];
  for (const t of tenantDefs) {
    const tenantId = new ObjectId();
    const userId = new ObjectId();
    tenantIds.push(tenantId);
    const phone = norm(t.phone);
    await db.collection("tenants").insertOne({
      _id: tenantId, orgId, userId, name: t.name, email: t.email, unitId: t.unit._id,
      phoneEnc: await encD(phone), phoneLast4: phone.slice(-4),
      ...(t.sin ? { sinEnc: await encR(t.sin), sinLast3: t.sin.slice(-3), sinPurpose: "credit_check", sinDeleteAfter: new Date(now.getTime() + 30 * 864e5) } : {}),
      dobEnc: await encR("1996-04-12"),
      preferredChannel: t.pref, optIn: { call: true, sms: false, whatsapp: false, email: true },
      demo: true, createdAt: now,
    });
    if (t.sin) await db.collection("consents").insertOne({ orgId, tenantId, field: "sin", purpose: "credit_check", recordedBy: String(landlordUserId), at: now, demo: true });
    await db.collection("users").insertOne({ _id: userId, orgId, email: t.email, passwordHash: hash, role: "tenant", name: t.name, tenantId, demo: true, createdAt: now });
    await db.collection("leases").insertOne({
      orgId, tenantId, unitId: t.unit._id, start: new Date(now.getFullYear() - 1, 8, 1), end: new Date(now.getFullYear() + 1, 7, 31),
      rentCents: t.unit.rentCents, frequency: "monthly", utilities: ["water", "heat"], parking: t.unit.label === "2B" ? "Spot 14" : null,
      form: "Ontario Standard Lease (2229E)", demo: true,
    });
    // last 3 months of rent; current month due
    for (let k = 2; k >= 0; k--) {
      const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      const paid = k > 0 || t.name === "Aisha Okafor";
      await db.collection("rent_records").insertOne({
        orgId, tenantId, unitId: t.unit._id, period, amountCents: t.unit.rentCents, dueDate: d,
        status: paid ? "paid" : "due", ...(paid ? { paidAt: new Date(d.getTime() + 2 * 864e5), paidVia: "e-transfer" } : {}), demo: true,
      });
    }
    const convoId = new ObjectId();
    await db.collection("conversations").insertOne({ _id: convoId, orgId, tenantId, createdAt: now, updatedAt: now, lastMessage: "Thanks Priya!" });
    await db.collection("messages").insertMany([
      { orgId, conversationId: convoId, tenantId, channel: "in_app", direction: "outbound", sender: { type: "user", id: String(landlordUserId), name: "Priya Raman", role: "landlord" }, body: "Hi! Reminder that the furnace filter swap is this Saturday between 10 and 12.", ts: new Date(now.getTime() - 3 * 864e5), readBy: [] },
      { orgId, conversationId: convoId, tenantId, channel: "in_app", direction: "outbound", sender: { type: "user", id: String(userId), name: t.name, role: "tenant" }, body: "Thanks Priya!", ts: new Date(now.getTime() - 3 * 864e5 + 3600e3), readBy: [] },
    ]);
  }

  await db.collection("contractors").insertMany([
    { orgId, name: "Danforth Plumbing Co.", phone: norm(process.env.DEMO_CONTRACTOR_PHONE || "+14165550199"), trades: ["plumber", "emergency plumber"], source: "saved", verification: "landlord_verified", rating: 4.8, reviews: 212, demo: true, createdAt: now },
    { orgId, name: "Scarborough Heating & Air", phone: norm(process.env.DEMO_CONTRACTOR_PHONE || "+14165550188"), trades: ["hvac technician", "gas technician"], source: "saved", verification: "landlord_verified", rating: 4.6, reviews: 98, demo: true, createdAt: now },
    { orgId, name: "Kingston Rd Electric", phone: norm(process.env.DEMO_CONTRACTOR_PHONE || "+14165550166"), trades: ["electrician"], source: "saved", verification: "unverified", rating: 4.4, reviews: 51, demo: true, createdAt: now },
  ]);

  await db.collection("policies").insertOne({
    orgId, version: 1, killSwitch: false, spendingLimitCents: 50000, hardCapCents: 200000, maxContractorsContacted: 5, autoBookMinor: true,
    tools: { triage_ticket: "allow", search_contractors: "allow", contact_contractor: "allow", propose_booking: "approval", notify_tenant: "allow", charge_payment: "deny", refund_payment: "deny" },
    changedBy: String(landlordUserId), createdAt: now, demo: true,
  });

  // Historical closed ticket so the dashboards aren't empty
  const oldTicket = new ObjectId();
  await db.collection("maintenance_requests").insertOne({
    _id: oldTicket, orgId, propertyId: property2Id, unitId: units[0]._id, tenantId: tenantIds[1], title: "Bathroom fan not working",
    description: "The bathroom exhaust fan stopped turning on last week.", category: "electrical", priority: "normal", trade: "electrician",
    status: "closed", finalCostCents: 18500, closedAt: new Date(now.getTime() - 20 * 864e5),
    createdAt: new Date(now.getTime() - 26 * 864e5), updatedAt: new Date(now.getTime() - 20 * 864e5), demo: true,
  });
  await db.collection("audit_logs").insertOne({ orgId, ticketId: oldTicket, actor: { type: "user", id: String(landlordUserId), name: "Priya Raman" }, action: "ticket.closed", input: { finalCostCents: 18500 }, result: { status: "confirmed" }, ts: new Date(now.getTime() - 20 * 864e5) });

  console.log("Seeded. Log in with landlord@bedley.demo / tenant@bedley.demo (password demo1234).");
  await client.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
