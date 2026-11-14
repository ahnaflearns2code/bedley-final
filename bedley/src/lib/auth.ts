import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { ObjectId } from "mongodb";

export type Role = "landlord" | "tenant" | "admin";
export interface Session {
  userId: string;
  orgId: string;
  role: Role;
  name: string;
  tenantId?: string;
}

const COOKIE = "ks_session";

function secret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) throw new Error("AUTH_SECRET must be set (16+ chars).");
  return new TextEncoder().encode(s);
}

export async function createSession(s: Session) {
  const token = await new SignJWT({ ...s })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}

export async function destroySession() {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as Session;
  } catch {
    return null;
  }
}

/** Server-side gate. Never trust the client for role or org. */
export async function requireRole(...roles: Role[]): Promise<Session> {
  const s = await getSession();
  if (!s) redirect("/login");
  // The account may no longer exist (e.g. demo data was reset) — clear the stale login instead of crashing.
  const { getDb, C } = await import("./db");
  const db = await getDb();
  const user = ObjectId.isValid(s.userId) ? await db.collection(C.users).findOne({ _id: new ObjectId(s.userId) }, { projection: { _id: 1 } }) : null;
  if (!user) redirect("/api/auth/reset");
  if (!roles.includes(s.role)) redirect(s.role === "tenant" ? "/tenant" : "/landlord");
  return s;
}

export const orgFilter = (s: Session) => ({ orgId: new ObjectId(s.orgId) });

/** Filter that additionally pins tenants to their own records. */
export function scopeFilter(s: Session, tenantField = "tenantId") {
  const f: Record<string, unknown> = { orgId: new ObjectId(s.orgId) };
  if (s.role === "tenant") f[tenantField] = new ObjectId(s.tenantId!);
  return f;
}
