/**
 * Redaction pass applied to anything that leaves our boundary toward an LLM,
 * a log line, or the audit ledger. Masks SIN-shaped numbers (Luhn-valid 9 digits),
 * card numbers, and long account-like digit runs.
 */

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redact(text: string): string {
  if (!text) return text;
  // Card numbers: 13-19 digits with optional spaces/dashes, Luhn-valid
  let out = text.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 13 && luhnValid(d) ? "[REDACTED_CARD]" : m;
  });
  // SIN: 9 digits, optionally grouped 3-3-3
  out = out.replace(/\b\d{3}[ -]?\d{3}[ -]?\d{3}\b/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length === 9 && luhnValid(d) ? "[REDACTED_SIN]" : m;
  });
  // Bank-account-like runs (7-12 digits after "account"/"acct"/"transit")
  out = out.replace(/\b(account|acct|transit|institution)(\s*(?:no\.?|number|#)?\s*:?\s*)\d{5,12}\b/gi, "$1$2[REDACTED_ACCOUNT]");
  return out;
}

/** Deep-redact any JSON-ish value. Drops keys that must never be logged. */
const BLOCKED_KEYS = /^(sin|sinEnc|dob|dobEnc|passport|governmentId|password|passwordHash|token|secret)$/i;
export function redactDeep<T>(v: T): T {
  if (typeof v === "string") return redact(v) as unknown as T;
  if (Array.isArray(v)) return v.map(redactDeep) as unknown as T;
  if (v && typeof v === "object" && !(v as object).constructor?.name?.match(/ObjectId|Date|Binary/)) {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      o[k] = BLOCKED_KEYS.test(k) ? "[REDACTED]" : redactDeep(val);
    }
    return o as T;
  }
  return v;
}
