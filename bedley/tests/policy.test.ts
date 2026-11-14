import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, evaluate } from "../src/lib/policy-core";

const ctx = { runStopRequested: false, contractorsContactedSoFar: 0 };

test("booking always needs approval", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "propose_booking", {}, ctx).decision, "needs_approval");
});
test("approved booking is allowed", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "propose_booking", {}, { ...ctx, approved: true }).decision, "allowed");
});
test("agents cannot move money", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "charge_payment", { estimateCents: 100 }, ctx).decision, "denied");
});
test("unknown tools are denied", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "delete_database", {}, ctx).decision, "denied");
});
test("kill switch denies everything", () => {
  assert.equal(evaluate({ ...DEFAULT_POLICY, killSwitch: true }, "triage_ticket", {}, ctx).decision, "denied");
});
test("stopped run denies", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "notify_tenant", {}, { ...ctx, runStopRequested: true }).decision, "denied");
});
test("contact limit enforced", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "contact_contractor", {}, { ...ctx, contractorsContactedSoFar: 5 }).decision, "denied");
});
test("over hard cap denied even with approval", () => {
  assert.equal(evaluate(DEFAULT_POLICY, "propose_booking", { estimateCents: 500000 }, { ...ctx, approved: true }).decision, "denied");
});
