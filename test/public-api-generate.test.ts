import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveCommand, kebab } from "../scripts/public-api/naming.ts";
import { definitionsFromOpenApi, deref, loadJson, parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate, summarize } from "../scripts/public-api/generate.ts";
import type { GenerateOptions } from "../scripts/public-api/generate.ts";
import type { Descriptor } from "../src/types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/definitions/${name}`, import.meta.url), "utf8"));
const widgets = () => parseDefinitions(fixture("widgets.json"));
const NOW = new Date("2026-10-30T00:00:00Z");

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { reserved: { commands: [], topLevel: new Set(["auth", "job"]) }, overrides: {}, now: NOW, ...extra };
}

function names(descriptors: Descriptor[]): string[] {
  return descriptors.map((descriptor) => descriptor.command.join(" "));
}

test("kebab-cases path segments", () => {
  assert.equal(kebab("custom_fields"), "custom-fields");
  assert.equal(kebab("vendorBills"), "vendor-bills");
  assert.equal(kebab("Users"), "users");
  assert.equal(kebab("accounts-payable"), "accounts-payable");
});

test("the action comes from the method and whether the path ends in a param", () => {
  assert.deepEqual(deriveCommand("rest", "GET", "/contracts"), ["contracts", "list"]);
  assert.deepEqual(deriveCommand("rest", "GET", "/contracts/{contract_id}"), ["contracts", "get"]);
  assert.deepEqual(deriveCommand("rest", "POST", "/it/assets/{asset_id}/archive"), ["it", "assets", "archive", "create"]);
  assert.deepEqual(deriveCommand("rest", "PATCH", "/gp/workers/{worker_id}/banks/{bank_id}"), ["gp", "workers", "banks", "update"]);
  assert.deepEqual(deriveCommand("rest", "PUT", "/profiles/{id}/parent"), ["profiles", "parent", "replace"]);
  assert.deepEqual(deriveCommand("rest", "DELETE", "/contracts/{contract_id}/invitations"), ["contracts", "invitations", "delete"]);
  assert.deepEqual(deriveCommand("scim", "GET", "/Users"), ["scim", "users", "list"]);
  assert.throws(() => deriveCommand("rest", "GET", "/{id}"), /No static path segment/);
  assert.throws(() => deriveCommand("rest", "HEAD", "/contracts"), /Unsupported method/);
});

test("generates one command per endpoint from the fixtures", () => {
  const { manifest, errors } = generate(widgets(), options());
  assert.deepEqual(errors, []);
  assert.deepEqual(names(manifest.descriptors), [
    "gizmos list",
    "scim users list",
    "widgets create",
    "widgets get",
    "widgets list",
    "widgets notes list",
    "widgets notes list",
    "widgets reports list",
    "widgets update",
  ]);
});

test("a sunset endpoint is left out", () => {
  const { manifest } = generate(widgets(), options());
  assert.ok(!manifest.descriptors.some((descriptor) => descriptor.path.startsWith("/old-things")));
});

test("the newest stable version is the command's version; every live version is listed", () => {
  const { manifest } = generate(widgets(), options());
  const reports = manifest.descriptors.find((descriptor) => descriptor.path === "/widgets/reports")!;
  assert.equal(reports.version, "2026-01-01");
  assert.equal(reports.summary, "Widget report (stable)");
  assert.equal(reports.beta, undefined);
  assert.deepEqual(reports.versions!.map((v) => v.version), ["2026-01-01", "2026-06-01"]);
});

test("a beta-only endpoint uses its beta version and is marked beta", () => {
  const { manifest } = generate(widgets(), options());
  const gizmos = manifest.descriptors.find((descriptor) => descriptor.path === "/gizmos")!;
  assert.equal(gizmos.version, "2026-03-01");
  assert.equal(gizmos.beta, true);
});

test("a collection and its parent-scoped twin merge into one command", () => {
  const { manifest, errors } = generate(widgets(), options());
  assert.deepEqual(errors, []);
  const notes = manifest.descriptors.filter((descriptor) => descriptor.command.join(" ") === "widgets notes list");
  assert.deepEqual(notes.map((descriptor) => descriptor.path).sort(), ["/widgets/notes", "/widgets/{widget_id}/notes"]);
});

test("any other same-name pair is an error", () => {
  const definitions = widgets();
  definitions.push({ ...definitions[0], path: "/widgets/{a}/{b}", method: "GET", operation: { responses: {} } }); // "widgets get" twice, path params that don't nest
  const { errors } = generate(definitions, options());
  assert.ok(errors.some((error) => /Ambiguous command "deel widgets get"/.test(error)), errors.join("\n"));
});

test("a word can't be both a command and a group", () => {
  const definitions = widgets();
  definitions.push({ ...definitions[0], path: "/widgets/list/extra", method: "GET", operation: { responses: {} } });
  const { errors } = generate(definitions, options());
  assert.ok(errors.some((error) => /"deel widgets list" is a command and also a group/.test(error)), errors.join("\n"));
});

test("hand-picked names are reserved", () => {
  const reserved = { commands: [{ command: ["widgets", "create"], method: "POST", path: "/widgets/special" }], topLevel: new Set(["auth", "job"]) };
  const { errors } = generate(widgets(), options({ reserved }));
  assert.ok(errors.some((error) => /"deel widgets create".*clashes with a hand-picked command/.test(error)), errors.join("\n"));
});

test("a generated command can't turn a hand-picked command into a group, or the other way round", () => {
  const leaf = generate(widgets(), options({ reserved: { commands: [{ command: ["widgets", "notes"], method: "GET", path: "/x" }], topLevel: new Set() } }));
  assert.ok(leaf.errors.some((error) => /turn the hand-picked "deel widgets notes" into a group/.test(error)), leaf.errors.join("\n"));
  const group = generate(widgets(), options({ reserved: { commands: [{ command: ["gizmos", "list", "all"], method: "GET", path: "/y" }], topLevel: new Set() } }));
  assert.ok(group.errors.some((error) => /"deel gizmos list" is a group of the hand-picked "deel gizmos list all"/.test(error)), group.errors.join("\n"));
});

test("static commands keep their top-level names", () => {
  const definitions = widgets();
  definitions.push({ ...definitions[0], path: "/auth/sessions", operation: { responses: {} } });
  const { errors } = generate(definitions, options());
  assert.ok(errors.some((error) => /shadow the static "deel auth"/.test(error)), errors.join("\n"));
});

test("an endpoint with a hand-picked command too gets a warning", () => {
  const reserved = { commands: [{ command: ["gadgets", "list"], method: "GET", path: "/widgets" }], topLevel: new Set<string>() };
  const { warnings, errors } = generate(widgets(), options({ reserved }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((warning) => /GET \/widgets has a hand-picked command and a generated one/.test(warning)));
});

test("overrides rename a command, and an unused override is reported", () => {
  const { manifest, warnings } = generate(widgets(), options({ overrides: { "POST /widgets": "widgets add", "GET /nothing": "nothing" } }));
  assert.ok(names(manifest.descriptors).includes("widgets add"));
  assert.ok(!names(manifest.descriptors).includes("widgets create"));
  assert.ok(warnings.some((warning) => /Override for GET \/nothing matches no endpoint/.test(warning)));
});

test("released names are locked", () => {
  const first = generate(widgets(), options()).manifest;
  const renamed = generate(widgets(), options({ previous: first, overrides: { "POST /widgets": "widgets add" } }));
  assert.ok(renamed.errors.some((error) => /Lock: POST \/widgets was released as "deel widgets create"/.test(error)), renamed.errors.join("\n"));
});

test("a param named like a global flag gets a -param flag", () => {
  const { manifest } = generate(widgets(), options());
  const update = manifest.descriptors.find((descriptor) => descriptor.command.join(" ") === "widgets update")!;
  const fields = update.params.find((param) => param.name === "fields")!;
  assert.equal(fields.flag, "fields-param");
  assert.equal(update.params.find((param) => param.name === "widget_id")!.flag, undefined);
});

test("nothing outside the operation allowlist reaches the manifest", () => {
  const { manifest } = generate(widgets(), options());
  assert.doesNotMatch(JSON.stringify(manifest), /team-that-must-not-leak|x-owner-team/);
});

test("the summary bumps patch for changes, minor for new commands, major for removed ones", () => {
  const base = generate(widgets(), options()).manifest.descriptors;
  assert.equal(summarize(base, base).bump, "none");
  const changed = base.map((descriptor) => (descriptor.path === "/gizmos" ? { ...descriptor, summary: "List all gizmos" } : descriptor));
  assert.deepEqual(summarize(base, changed), { added: [], changed: [{ command: "gizmos list", method: "GET", path: "/gizmos" }], removed: [], bump: "patch" });
  assert.equal(summarize(base.slice(1), base).bump, "minor");
  const both = summarize(base.slice(1), base.slice(0, -1));
  assert.equal(both.bump, "major");
});

test("parseDefinitions rejects malformed input", () => {
  assert.throws(() => parseDefinitions({}), /must be a JSON array/);
  assert.throws(() => parseDefinitions([{ api: "rest" }]), /missing "method"/);
  assert.throws(() => parseDefinitions([{ api: "soap", method: "GET", path: "/x", version: "v", operation: {} }]), /unknown api "soap"/);
  assert.equal(parseDefinitions({ data: [] }).length, 0);
});

test("the OpenAPI bridge inlines $refs, merges path-level params, strips the base path and drops extensions", () => {
  const [definition] = definitionsFromOpenApi(fixture("openapi-with-refs.json"), "rest");
  assert.equal(definition.path, "/widgets/{widget_id}");
  assert.equal(definition.version, "2026-01-01");
  assert.equal(definition.operation["x-internal-note"], undefined);
  assert.deepEqual(definition.operation.parameters.map((param: { name: string }) => param.name), ["widget_id"]);
  const data = definition.operation.responses["200"].content["application/json"].schema.properties.data;
  assert.equal(data.properties.id.type, "string");
  assert.deepEqual(data.properties.parent, { type: "object" }); // the cycle stops here
  const { manifest, errors } = generate([definition], options());
  assert.deepEqual(errors, []);
  assert.deepEqual(names(manifest.descriptors), ["widgets get"]);
});

test("deref rejects remote and unresolved refs", () => {
  assert.throws(() => deref({ $ref: "https://example.com/x.json" }, {}), /Only local \$ref/);
  assert.throws(() => deref({ $ref: "#/components/schemas/Missing" }, {}), /Unresolved \$ref/);
});

test("the OpenAPI bridge needs a version on every operation", () => {
  const doc = { paths: { "/widgets": { get: { operationId: "getWidgets", responses: {} } } } };
  assert.throws(() => definitionsFromOpenApi(doc, "rest"), /No version for GET \/widgets/);
});

test("a version that renamed its path params is the same endpoint, not a clash", () => {
  const definitions = parseDefinitions([
    { api: "rest", method: "get", path: "/gadgets/{gadgetId}", version: "2026-01-01", beta_until: null, sunset_at: null, operation: { operationId: "getGadget-v2026-01-01", summary: "old", responses: {} } },
    { api: "rest", method: "get", path: "/gadgets/{gadget_id}", version: "2026-09-01", beta_until: "2099-01-01T00:00:00.000Z", sunset_at: null, operation: { operationId: "getGadget-v2026-09-01", summary: "new", responses: {} } },
  ]);
  const { manifest, errors } = generate(definitions, options());
  assert.deepEqual(errors, []);
  assert.equal(manifest.descriptors.length, 1);
  const [gadget] = manifest.descriptors;
  assert.equal(gadget.path, "/gadgets/{gadgetId}"); // the stable version's path and flags
  assert.deepEqual(gadget.versions!.map((v) => v.version), ["2026-01-01", "2026-09-01"]);
});

test("one operation registered under two spellings of its path keeps the kebab-case one", () => {
  const operation = (version: string) => ({ operationId: `listGadgetNotes-v${version}`, summary: "List notes", responses: {} });
  const definitions = parseDefinitions([
    { api: "rest", method: "get", path: "/gadgets/{gadget_id}/gadget_notes", version: "2026-09-01", beta_until: null, sunset_at: null, operation: operation("2026-09-01") },
    { api: "rest", method: "get", path: "/gadgets/{gadget_id}/gadget-notes", version: "2026-09-01", beta_until: null, sunset_at: null, operation: operation("2026-09-01") },
  ]);
  const { manifest, errors, warnings } = generate(definitions, options());
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest.descriptors.map((d) => [d.command.join(" "), d.path]), [["gadgets gadget-notes list", "/gadgets/{gadget_id}/gadget-notes"]]);
  assert.ok(warnings.some((warning) => /gadget_notes is an alias of GET \/gadgets\/\{gadget_id\}\/gadget-notes/.test(warning)));
});

test("two different operations behind one name are still an error", () => {
  const definitions = parseDefinitions([
    { api: "rest", method: "get", path: "/gadgets/gadget_notes", version: "2026-09-01", beta_until: null, sunset_at: null, operation: { operationId: "listA-v2026-09-01", responses: {} } },
    { api: "rest", method: "get", path: "/gadgets/gadget-notes", version: "2026-09-01", beta_until: null, sunset_at: null, operation: { operationId: "listB-v2026-09-01", responses: {} } },
  ]);
  const { errors } = generate(definitions, options());
  assert.ok(errors.some((error) => /Ambiguous command "deel gadgets gadget-notes list"/.test(error)), errors.join("\n"));
});

const def = (method: string, path: string, extra: Record<string, unknown> = {}) => ({
  api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null, operation: { responses: {}, ...extra },
});

test("only reads merge: a mistyped flag must not turn one delete or create into the other", () => {
  for (const method of ["DELETE", "POST", "PATCH", "PUT"]) {
    const { errors } = generate(parseDefinitions([def(method, "/things"), def(method, "/things/{id}")]), options());
    assert.ok(errors.some((error) => /Ambiguous command/.test(error)), `${method}: ${errors.join("\n")}`);
  }
});

test("a path param declared with another spelling follows the path's; one that isn't in the path is an error", () => {
  const declared = (name: string) => def("PATCH", "/roles/{roleid}", { parameters: [{ name, in: "path", required: true, schema: { type: "string" } }] });
  const ok = generate(parseDefinitions([declared("roleId")]), options());
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.manifest.descriptors[0].params.map((param) => param.name), ["roleid"]);
  const bad = generate(parseDefinitions([declared("other")]), options());
  assert.ok(bad.errors.some((error) => /path parameter "other" is not in the path/.test(error)), bad.errors.join("\n"));
});

test("a path param the operation doesn't declare still becomes a required flag", () => {
  const { manifest } = generate(parseDefinitions([def("GET", "/things/{thing_id}")]), options());
  assert.deepEqual(manifest.descriptors[0].params, [{ name: "thing_id", in: "path", type: "string", required: true }]);
});

test("flag names collide by spelling, not just by exact name", () => {
  const query = (name: string) => ({ name, in: "query", schema: { type: "string" } });
  const global = generate(parseDefinitions([def("POST", "/things", { parameters: [query("idempotency_key")] })]), options());
  assert.equal(global.manifest.descriptors[0].params[0].flag, "idempotency_key-param");
  const twin = generate(parseDefinitions([def("GET", "/things/{id}", { parameters: [query("id")] })]), options());
  assert.ok(twin.errors.some((error) => /would share one flag/.test(error)), twin.errors.join("\n"));
});

test("the same version of one route can't be defined twice", () => {
  const { errors } = generate(parseDefinitions([def("GET", "/a/{p}/b"), def("GET", "/a/{q}/b")]), options());
  assert.ok(errors.some((error) => /defined more than once/.test(error)), errors.join("\n"));
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
