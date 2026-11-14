import dns from "node:dns";
import { MongoClient, Db, ObjectId } from "mongodb";

// Some networks (venue/guest Wi-Fi, some Windows setups) can't resolve the SRV records
// used by mongodb+srv:// links. Use public DNS so the Atlas lookup works everywhere.
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  /* keep system DNS */
}

declare global {
  // eslint-disable-next-line no-var
  var _mongoClient: Promise<MongoClient> | undefined;
}

export function getClient(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Copy .env.example to .env and fill it in.");
  if (!global._mongoClient) {
    global._mongoClient = new MongoClient(uri, { appName: "keystone", ignoreUndefined: true }).connect();
    // If the first connect fails (Wi-Fi blip, IP not yet allowed), retry on the next call instead of caching the failure forever.
    global._mongoClient.catch(() => {
      global._mongoClient = undefined;
    });
  }
  return global._mongoClient;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  return client.db(process.env.MONGODB_DB || "keystone");
}

/** Collection names in one place so nothing drifts. */
export const C = {
  orgs: "organizations",
  users: "users",
  properties: "properties",
  units: "units",
  tenants: "tenants",
  leases: "leases",
  rent: "rent_records",
  payments: "payments",
  stripeEvents: "stripe_events",
  tickets: "maintenance_requests",
  contractors: "contractors",
  runs: "agent_runs",
  approvals: "approvals",
  audit: "audit_logs",
  policies: "policies",
  conversations: "conversations",
  messages: "messages",
  calls: "call_logs",
  consents: "consents",
} as const;

export function oid(id: string | ObjectId): ObjectId {
  if (id instanceof ObjectId) return id;
  if (!ObjectId.isValid(id)) throw new Error("Invalid id");
  return new ObjectId(id);
}

export { ObjectId };
