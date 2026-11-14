import { ObjectId } from "mongodb";
import { getDb } from "./db";

/** Updates from Bedley AI that appear on the landlord's overview. */
export async function postLandlordUpdate(orgId: ObjectId, ticketId: ObjectId | null, text: string) {
  const db = await getDb();
  await db.collection("landlord_updates").insertOne({ orgId, ticketId, text, ts: new Date() });
}
