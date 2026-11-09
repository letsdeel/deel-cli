import { test } from "node:test";
import assert from "node:assert/strict";
import { loadJson, parseDefinitions } from "../scripts/public-api/definitions.ts";

const def = (method: string, path: string, extra: Record<string, unknown> = {}) => ({
  api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null, operation: { responses: {}, ...extra },
});
const gadgetOp = (extra: Record<string, any> = {}) => ({ summary: "S", responses: { "200": { description: "ok" } }, ...extra });
const gadget = (extra: Record<string, any>) => ({ api: "rest", method: "GET", path: "/gadgets", version: "2026-01-01", beta_until: null, sunset_at: null, operation: gadgetOp(), ...extra });

test("only the allowlisted operation fields are kept from a definition", () => {
  const [definition] = parseDefinitions([
    gadget({ operation: gadgetOp({ operationId: "x", description: "d", tags: ["t"], deprecated: true, "x-extension": "dropped", servers: [{ url: "https://example.invalid" }], callbacks: {}, security: [{ k: [] }] }) }),
  ]);
  assert.deepEqual(Object.keys(definition.operation).sort(), ["deprecated", "description", "operationId", "responses", "summary", "tags"]);
});

test("parseDefinitions rejects malformed input", () => {
  assert.throws(() => parseDefinitions({}), /must be a JSON array/);
  assert.throws(() => parseDefinitions([{ api: "rest" }]), /missing "method"/);
  assert.throws(() => parseDefinitions([{ api: "soap", method: "GET", path: "/x", version: "v", operation: {} }]), /unknown api "soap"/);
  assert.equal(parseDefinitions({ data: [] }).length, 0);
});

test("parseDefinitions validates paths, versions, dates and duplicates", () => {
  const bad = (entry: Record<string, unknown>) => () => parseDefinitions([{ ...def("GET", "/x"), ...entry }]);
  for (const path of ["/../../admin/x", "/x?y=1", "/z#f", "evil/x", "/u/{a", "/a b", "//x"]) assert.throws(bad({ path }), /invalid path/, path);
  for (const version of [null, 20260101, "2026-1-1", "latest"]) assert.throws(bad({ version }), /invalid version/, String(version));
  for (const field of ["beta_until", "sunset_at"]) assert.throws(bad({ [field]: "not-a-date" }), new RegExp(`invalid ${field}`));
  assert.throws(() => parseDefinitions([def("GET", "/x"), def("get", "/x")]), /Duplicate definition/);
  assert.doesNotThrow(() => parseDefinitions([def("GET", "/"), def("GET", "/Users/{id}"), def("GET", "/files/report.v2")]));
});

test("loadJson only fetches https, never follows a redirect and reads at most the size limit", async () => {
  const realFetch = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    seen.push(init);
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(loadJson("http://example.test/defs"), /must use https/);
    assert.deepEqual(await loadJson("https://example.test/defs"), []);
    assert.equal(seen[0].redirect, "error");
    assert.ok(seen[0].signal);
    globalThis.fetch = (async () => new Response(new Uint8Array(65 * 1024 * 1024))) as typeof fetch;
    await assert.rejects(loadJson("https://example.test/big"), /larger than/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("loadJson rejects an HTTP error status, an empty body and a failed request instead of reading them as definitions", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const status of [401, 403, 500]) {
      globalThis.fetch = (async () => new Response('{"message":"no"}', { status })) as typeof fetch;
      await assert.rejects(loadJson("https://example.test/defs"), new RegExp(`HTTP ${status}`));
    }
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
    await assert.rejects(loadJson("https://example.test/defs"), /sent no body/);
    globalThis.fetch = (async () => new Response("not json", { status: 200 })) as typeof fetch;
    await assert.rejects(loadJson("https://example.test/defs"), SyntaxError);
    globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await assert.rejects(loadJson("https://example.test/defs"), /fetch failed/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("loadJson reads a local file, and a missing or malformed one is an error", async () => {
  const widgets = await loadJson(new URL("./fixtures/definitions/widgets.json", import.meta.url).pathname);
  assert.ok(Array.isArray(widgets) && widgets.length > 0);
  await assert.rejects(loadJson(new URL("./fixtures/definitions/missing.json", import.meta.url).pathname), /ENOENT/);
  await assert.rejects(loadJson(new URL("./definitions.test.ts", import.meta.url).pathname), SyntaxError);
});

test("parseDefinitions refuses an entry without an operation object", () => {
  const entry = { api: "rest", method: "GET", path: "/x", version: "2026-01-01" };
  for (const operation of [null, [], "text"]) assert.throws(() => parseDefinitions([{ ...entry, operation }]), /has no operation object/);
});
