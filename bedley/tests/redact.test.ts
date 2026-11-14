import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactDeep, luhnValid } from "../src/lib/redact";

test("valid SIN is redacted", () => {
  assert.ok(luhnValid("046454286"));
  assert.equal(redact("my sin is 046 454 286 ok"), "my sin is [REDACTED_SIN] ok");
});
test("non-Luhn 9 digit number kept", () => {
  assert.equal(redact("order 123456789"), "order 123456789");
});
test("card number redacted", () => {
  assert.match(redact("card 4242 4242 4242 4242"), /REDACTED_CARD/);
});
test("deep redaction drops sensitive keys", () => {
  const out = redactDeep({ name: "x", sin: "046454286", nested: { note: "046-454-286" } }) as any;
  assert.equal(out.sin, "[REDACTED]");
  assert.equal(out.nested.note, "[REDACTED_SIN]");
});
