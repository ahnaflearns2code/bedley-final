import type { SendResult } from "./twilio";

export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { status: "simulated", detail: "RESEND_API_KEY not set — email not sent.", to };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || "Bedley <onboarding@resend.dev>", to: [to], subject, text }),
    });
    const body = (await res.json()) as { id?: string; message?: string };
    if (!res.ok) return { status: "failed", detail: body.message || `Resend ${res.status}`, to };
    return { status: "sent", providerId: body.id, detail: "Accepted by Resend", to };
  } catch (e) {
    return { status: "failed", detail: (e as Error).message, to };
  }
}
