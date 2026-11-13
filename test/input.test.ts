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

test("shorthand null clears a nullable field of any type, and stays literal otherwise", () => {
  const nullableProps: CliParam[] = [
    { name: "note", in: "body", type: "string", required: false, nullable: true },
    { name: "amount", in: "body", type: "number", required: false, nullable: true },
    { name: "flag", in: "body", type: "boolean", required: false, nullable: true },
    { name: "title", in: "body", type: "string", required: false },
  ];
  assert.deepEqual(parseInput("note=null,amount=null,flag=null", nullableProps), { note: null, amount: null, flag: null });
  assert.deepEqual(parseInput("title=null", nullableProps), { title: "null" });
  assert.deepEqual(parseInput('{"note":null}', nullableProps), { note: null });
});

test("shorthand null clears a nullable enum or integer field without enum or number checks", () => {
  const props: CliParam[] = [
    { name: "status", in: "body", type: "string", required: false, nullable: true, enum: ["open", "closed"] },
    { name: "count", in: "body", type: "integer", required: false, nullable: true },
  ];
  assert.deepEqual(parseInput("status=null,count=null", props), { status: null, count: null });
  assert.throws(() => parseInput("status=pending", props), /must be one of/);
});

test("a JSON string \"null\" on a nullable field stays text; only shorthand maps the literal", () => {
  const props: CliParam[] = [{ name: "note", in: "body", type: "string", required: false, nullable: true }];
  assert.deepEqual(parseInput('{"note":"null"}', props), { note: "null" });
  assert.deepEqual(parseInput("note=null", props), { note: null });
});

test("a backslash escape in a string field is applied once to the text", () => {
  assert.deepEqual(parseInput("reason=a\\,b c", props), { reason: "a,b c" });
});

test("a value that starts with a bracket but does not close it stays a string", () => {
  assert.deepEqual(parseInput("reason=[x] text", props), { reason: "[x] text" });
  assert.deepEqual(parseInput("reason={draft", props), { reason: "{draft" });
});

test("a later bracketed duplicate key is not overridden by the earlier plain text", () => {
  const listed: CliParam[] = [{ name: "reason", in: "body", type: "string", required: false, properties: [] }];
  assert.deepEqual(parseInput("reason=x,reason=[a,b]", listed), { reason: ["a", "b"] });
});
