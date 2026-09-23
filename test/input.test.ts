import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInput } from "../src/core/input.ts";
import type { CliParam } from "../src/types.ts";

const props: CliParam[] = [
  { name: "amount", in: "body", type: "number", required: true },
  { name: "reason", in: "body", type: "string", required: false },
  { name: "currency", in: "body", type: "string", required: false, enum: ["USD", "EUR"] },
];

test("inline JSON is parsed", () => {
  assert.deepEqual(parseInput('{"amount":5000,"reason":"x"}', props), { amount: 5000, reason: "x" });
});

test("shorthand k=v with schema coercion", () => {
  assert.deepEqual(parseInput("amount=5000,reason=correction", props), { amount: 5000, reason: "correction" });
});

test("shorthand coerces number and validates enum", () => {
  assert.deepEqual(parseInput("amount=10,currency=EUR", props), { amount: 10, currency: "EUR" });
  assert.throws(() => parseInput("amount=10,currency=YEN", props), /currency must be one of/);
});

test("nested object shorthand", () => {
  const out = parseInput("customer={name=Ada,country=PT},amount=1", props) as any;
  assert.deepEqual(out.customer, { name: "Ada", country: "PT" });
  assert.equal(out.amount, 1);
});

test("space-separated list shorthand", () => {
  const out = parseInput("tags=a b c,amount=1", props) as any;
  assert.deepEqual(out.tags, ["a", "b", "c"]);
});

test("bracket list of structs", () => {
  const out = parseInput("items=[{sku=A,qty=1},{sku=B,qty=2}]", props) as any;
  assert.deepEqual(out.items, [{ sku: "A", qty: 1 }, { sku: "B", qty: 2 }]);
});

test("non-number for a number field errors", () => {
  assert.throws(() => parseInput("amount=abc", props), /expects a number/);
});

test("unrecognized input errors", () => {
  assert.throws(() => parseInput("just-a-word", props), /Unrecognized/);
});
