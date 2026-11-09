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

test("exact shorthand keeps every number as text, nested and in lists; booleans are still parsed", () => {
  const exact = { exactScalars: true };
  assert.deepEqual(parseInput("path_params={code=00123,id=12345678901234567890},query={v=1.10,n=-0,on=true,ids=[1,2],tags=3 4}", [], exact), {
    path_params: { code: "00123", id: "12345678901234567890" },
    query: { v: "1.10", n: "-0", on: true, ids: ["1", "2"], tags: ["3", "4"] },
  });
  assert.deepEqual(parseInput("a={n=5}", []), { a: { n: 5 } }); // the default is unchanged
});
