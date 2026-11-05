import { test } from "node:test";
import assert from "node:assert/strict";
import { envelope, applyFields, render } from "../src/core/output.ts";
import type { OutputOpts } from "../src/core/output.ts";
import { captureIO } from "../src/core/io.ts";

const opts = (over: Partial<OutputOpts> = {}): OutputOpts => ({ json: false, quiet: false, raw: false, ...over });

test("envelope carries data and meta", () => {
  const env = envelope({ id: "a1" }, { request_id: "r1" });
  assert.deepEqual(env.data, { id: "a1" });
  assert.deepEqual(env.meta, { request_id: "r1" });
  assert.ok(!("kind" in env));
  assert.ok(!("version" in env));
  assert.ok(!("apiVersion" in env));
});

test("applyFields projects objects, arrays, and dotted paths", () => {
  assert.deepEqual(applyFields({ id: "a", amount: 1, extra: "x" }, "id,amount"), { id: "a", amount: 1 });
  assert.deepEqual(applyFields([{ id: "a", n: 1 }, { id: "b", n: 2 }], "id"), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(applyFields({ nested: { deep: 7 } }, "nested.deep"), { "nested.deep": 7 });
});

test("render forces the JSON envelope with --json even on a TTY", async () => {
  const io = captureIO({ isTTY: true });
  await render(io, envelope({ id: "x" }), opts({ json: true }));
  const parsed = JSON.parse(io.stdout.join(""));
  assert.equal(parsed.data.id, "x");
  assert.ok(!("kind" in parsed));
});

test("render emits JSON when non-interactive even without --json", async () => {
  const io = captureIO({ isTTY: false });
  await render(io, envelope({ id: "x" }), opts());
  const parsed = JSON.parse(io.stdout.join(""));
  assert.equal(parsed.data.id, "x");
});

test("render human view on a TTY prints the data directly", async () => {
  const io = captureIO({ isTTY: true });
  await render(io, envelope({ id: "x" }), opts());
  const out = io.stdout.join("");
  assert.match(out, /"id": "x"/);
});

test("render --quiet prints only ids (object and array)", async () => {
  const io1 = captureIO({});
  await render(io1, envelope({ id: "abc" }), opts({ quiet: true }));
  assert.equal(io1.stdout.join("").trim(), "abc");

  const io2 = captureIO({});
  await render(io2, envelope([{ id: "a" }, { job_id: "b" }]), opts({ quiet: true }));
  assert.equal(io2.stdout.join("").trim(), "a\nb");
});

test("render --fields projects the envelope data", async () => {
  const io = captureIO({});
  await render(io, envelope({ id: "x", amount: 5, secret: "s" }), opts({ json: true, fields: "id,amount" }));
  const parsed = JSON.parse(io.stdout.join(""));
  assert.deepEqual(parsed.data, { id: "x", amount: 5 });
});

test("render --jq transforms the data payload", async () => {
  const io = captureIO({});
  await render(io, envelope([{ id: "a", n: 1 }, { id: "b", n: 3 }]), opts({ jq: ".[] | select(.n > 2) | .id" }));
  assert.equal(io.stdout.join("").trim(), '"b"');
});

test("render --jq --raw prints scalar strings unquoted", async () => {
  const io = captureIO({});
  await render(io, envelope([{ id: "a" }, { id: "b" }]), opts({ jq: ".[].id", raw: true }));
  assert.equal(io.stdout.join("").trim(), "a\nb");
});

test("envelope places page next to data only when a page is given", () => {
  const paged = envelope([{ id: "a" }], { request_id: "r1" }, { cursor: "c2", has_next_page: true });
  assert.deepEqual(Object.keys(paged), ["data", "page", "meta"]);
  assert.deepEqual(paged.page, { cursor: "c2", has_next_page: true });
  assert.ok(!("page" in envelope({ id: "a" }, { request_id: "r1" })));
});

test("render keeps page in the JSON envelope, also under --fields", async () => {
  const io = captureIO({});
  await render(io, envelope([{ id: "a", n: 1 }], { request_id: "r1" }, { cursor: "c2", has_next_page: true }), opts({ json: true, fields: "id" }));
  const parsed = JSON.parse(io.stdout.join(""));
  assert.deepEqual(parsed.data, [{ id: "a" }]);
  assert.deepEqual(parsed.page, { cursor: "c2", has_next_page: true });
  assert.equal(parsed.meta.request_id, "r1");
});

test("render --jq and --quiet keep operating on data only (page is not printed)", async () => {
  const paged = envelope([{ id: "a" }, { id: "b" }], undefined, { cursor: "c2", has_next_page: true });
  const io1 = captureIO({});
  await render(io1, paged, opts({ jq: ".[].id", raw: true }));
  assert.equal(io1.stdout.join("").trim(), "a\nb");
  const io2 = captureIO({});
  await render(io2, paged, opts({ quiet: true }));
  assert.equal(io2.stdout.join("").trim(), "a\nb");
});
