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

test("a string field with spaces stays one string", () => {
  assert.deepEqual(parseInput("reason=Payroll sync,amount=5", props), { reason: "Payroll sync", amount: 5 });
});

test("a string field keeps its numbers as written", () => {
  assert.deepEqual(parseInput("reason=Order 007 rev 1.50", props), { reason: "Order 007 rev 1.50" });
});

test("a JSON array sent to a string field is not joined into one string", () => {
  assert.deepEqual(parseInput('{"reason":["a","b"]}', props), { reason: ["a", "b"] });
});

test("a list shorthand is still a list for an array field", () => {
  const arrayProps: CliParam[] = [{ name: "tags", in: "body", type: "array", required: false }];
  assert.deepEqual(parseInput("tags=a b c", arrayProps), { tags: ["a", "b", "c"] });
});

test("a single word or number written for a string field stays a string", () => {
  assert.deepEqual(parseInput("reason=007", props), { reason: "007" });
  assert.deepEqual(parseInput("reason=true", props), { reason: "true" });
  assert.deepEqual(parseInput("reason=1.50,amount=2", props), { reason: "1.50", amount: 2 });
});

test("a string inside a nested object keeps its spaces and numbers", () => {
  const nested: CliParam[] = [
    { name: "customer", in: "body", type: "object", required: false, properties: [{ name: "name", in: "body", type: "string", required: false }] },
  ];
  assert.deepEqual(parseInput("customer={name=Ada Lovelace}", nested), { customer: { name: "Ada Lovelace" } });
  assert.deepEqual(parseInput("customer={name=007}", nested), { customer: { name: "007" } });
});

test("a string inside each item of a list of objects keeps its spaces", () => {
  const listed: CliParam[] = [
    { name: "items", in: "body", type: "array", required: false, properties: [{ name: "description", in: "body", type: "string", required: false }] },
  ];
  assert.deepEqual(parseInput("items=[{description=Q3 bonus},{description=Year end}]", listed), {
    items: [{ description: "Q3 bonus" }, { description: "Year end" }],
  });
});

test("a value with spaces for an enum string field is checked against the enum", () => {
  assert.throws(() => parseInput("currency=US D", props), /currency must be one of/);
});

test("a number sent as JSON for a string field is left as sent", () => {
  assert.deepEqual(parseInput('{"reason":7}', props), { reason: 7 });
});
