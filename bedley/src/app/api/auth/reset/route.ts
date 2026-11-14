import { NextResponse } from "next/server";

/** Clears a stale session (e.g. after the demo data was reset) and goes to login. */
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL("/login", req.url));
  res.cookies.delete("ks_session");
  return res;
}
