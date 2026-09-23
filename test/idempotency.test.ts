import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveIdempotencyKey, uuidv5 } from "../src/core/idempotency.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("uuidv5 is a valid v5 UUID and deterministic", () => {
  const a = uuidv5("hello");
  const b = uuidv5("hello");
  assert.match(a, UUID_RE);
  assert.equal(a, b);
  assert.notEqual(a, uuidv5("world"));
});

test("identical requests derive the identical key (order-insensitive body)", () => {
  const k1 = deriveIdempotencyKey({ method: "POST", path: "/adjustments", query: { contract_id: "AC1" }, body: { amount: 1, reason: "x" } });
  const k2 = deriveIdempotencyKey({ method: "post", path: "/adjustments", query: { contract_id: "AC1" }, body: { reason: "x", amount: 1 } });
  assert.equal(k1, k2);
});

test("different bodies derive different keys", () => {
  const k1 = deriveIdempotencyKey({ method: "POST", path: "/adjustments", query: {}, body: { amount: 1 } });
  const k2 = deriveIdempotencyKey({ method: "POST", path: "/adjustments", query: {}, body: { amount: 2 } });
  assert.notEqual(k1, k2);
});
