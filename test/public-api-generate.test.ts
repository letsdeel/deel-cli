import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import type { Definition } from "../scripts/public-api/definitions.ts";
import { pathParams } from "../scripts/public-api/command-map.ts";
import type { MapEntry } from "../scripts/public-api/command-map.ts";
import { generate as generateWith, mergeVariants, readGeneratedManifest, reservedClashes, summarize } from "../scripts/public-api/generate.ts";
import type { GenerateOptions } from "../scripts/public-api/generate.ts";
import type { Descriptor } from "../src/types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/definitions/${name}`, import.meta.url), "utf8"));
const widgets = () => parseDefinitions(fixture("widgets.json"));
const NOW = new Date("2026-10-30T00:00:00Z");

const widgetsMap = (): MapEntry[] => fixture("widgets-map.json");

// Names an endpoint the plain way (path words, a verb from the method, one argument per path param),
// for the tests that aren't about naming.
function plainEntry(definition: Definition): MapEntry {
  const words = definition.path.split("/").filter((s) => s && !s.startsWith("{")).map((s) => s.toLowerCase().replace(/[_.]/g, "-"));
  const verbs: Record<string, string> = { GET: definition.path.endsWith("}") ? "get" : "list", POST: "create", PATCH: "update", PUT: "update", DELETE: "delete" };
  const labels = pathParams(definition.path).map((param) => `<${param.toLowerCase().replace(/_/g, "-")}>`);
  return { api: definition.api, method: definition.method, path: definition.path, command: ["deel", ...words, verbs[definition.method], ...labels].join(" ") };
}

function options(extra: Partial<GenerateOptions> = {}): GenerateOptions {
  return { reserved: { commands: [], topLevel: new Set(["auth", "job"]) }, map: widgetsMap(), now: NOW, ...extra };
}

// The widgets map, plus a plain entry for every other endpoint a test adds.
function generate(definitions: Definition[], opts: GenerateOptions) {
  const named = new Set(opts.map.map((entry) => `${entry.method} ${entry.path.replace(/\{[^}]+\}/g, "{}")}`));
  const extra = new Map<string, MapEntry>();
  for (const d of definitions) {
    const route = `${d.method} ${d.path.replace(/\{[^}]+\}/g, "{}")}`;
    if (!named.has(route) && !extra.has(route)) extra.set(route, plainEntry(d));
  }
  return generateWith(definitions, { ...opts, map: [...opts.map, ...extra.values()] });
}

function names(descriptors: Descriptor[]): string[] {
  return descriptors.map((descriptor) => descriptor.command.join(" "));
}

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

test("a response field the spec marks x-deel-sensitive is carried into the manifest as sensitive, and the mark is the only addition", () => {
  const marked = parseDefinitions([
    {
      api: "rest", method: "GET", path: "/gadgets", version: "2026-01-01", beta_until: null, sunset_at: null,
      operation: {
        operationId: "getGadgets-v2026-01-01", summary: "List gadgets",
        responses: { "200": { content: { "application/json": { schema: { type: "object", properties: { data: { type: "array", items: { type: "object", properties: {
          id: { type: "string" },
          badge_color_choice: { type: "string", "x-deel-sensitive": true },
        } } } } } } } } },
      },
    },
  ]);
  const { manifest, errors } = generate(marked, options());
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest.descriptors[0].responseFields.map((field) => [field.name, field.sensitive]), [["id", undefined], ["badge_color_choice", true]]);
});

test("mergeVariants keeps x-deel-sensitive on a property when any variant that names it carries the mark", () => {
  const merged = mergeVariants({
    oneOf: [
      { type: "object", properties: { email: { type: "string" }, id: { type: "string" } } },
      { type: "object", properties: { email: { type: "string", "x-deel-sensitive": true }, id: { type: "string" } } },
    ],
  });

  assert.equal(merged.properties.email["x-deel-sensitive"], true);
  assert.equal(merged.properties.id["x-deel-sensitive"], undefined);
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

test("an endpoint the map names under a static command is served by it and isn't generated", () => {
  const definitions = widgets();
  definitions.push({ ...definitions[0], path: "/auth/sessions", operation: { responses: {} } });
  const { manifest, errors, warnings } = generate(definitions, options());
  assert.deepEqual(errors, []);
  assert.ok(!manifest.descriptors.some((descriptor) => descriptor.path === "/auth/sessions"));
  assert.ok(warnings.some((warning) => /GET \/auth\/sessions is served by the static "deel auth" command/.test(warning)), warnings.join("\n"));
});

test("an endpoint with a hand-picked command too gets a warning", () => {
  const reserved = { commands: [{ command: ["gadgets", "list"], method: "GET", path: "/widgets" }], topLevel: new Set<string>() };
  const { warnings, errors } = generate(widgets(), options({ reserved }));
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((warning) => /GET \/widgets has a hand-picked command and a generated one/.test(warning)));
});

test("released names are locked", () => {
  const first = generate(widgets(), options()).manifest;
  const map = widgetsMap().map((entry) => (entry.method === "POST" && entry.path === "/widgets" ? { ...entry, command: "deel widgets add" } : entry));
  const renamed = generate(widgets(), options({ previous: first, map }));
  assert.ok(renamed.errors.some((error) => /Lock: POST \/widgets was released as "deel widgets create"/.test(error)), renamed.errors.join("\n"));
});

test("a param named like a global flag gets a -param flag", () => {
  const { manifest } = generate(widgets(), options());
  const update = manifest.descriptors.find((descriptor) => descriptor.command.join(" ") === "widgets update")!;
  const fields = update.params.find((param) => param.name === "fields")!;
  assert.equal(fields.flag, "fields-param");
  assert.equal(update.params.find((param) => param.name === "widget_id")!.flag, undefined);
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

test("a version that renamed its path params is the same endpoint, not a clash", () => {
  const definitions = parseDefinitions([
    { api: "rest", method: "get", path: "/gadgets/{gadgetId}", version: "2026-01-01", beta_until: null, sunset_at: null, operation: { operationId: "getGadget-v2026-01-01", summary: "old", responses: {} } },
    { api: "rest", method: "get", path: "/gadgets/{gadget_id}", version: "2026-09-01", beta_until: "2099-01-01T00:00:00.000Z", sunset_at: null, operation: { operationId: "getGadget-v2026-09-01", summary: "new", responses: {} } },
  ]);
  const { manifest, errors } = generate(definitions, options());
  assert.deepEqual(errors, []);
  assert.equal(manifest.descriptors.length, 1);
  const [gadget] = manifest.descriptors;
  assert.equal(gadget.path, "/gadgets/{gadgetId}");
  assert.deepEqual(gadget.versions!.map((v) => v.version), ["2026-01-01", "2026-09-01"]);
});

const def = (method: string, path: string, extra: Record<string, unknown> = {}) => ({
  api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null, operation: { responses: {}, ...extra },
});

test("a path param declared with another spelling follows the path's; one that isn't in the path is an error", () => {
  const declared = (name: string) => def("PATCH", "/roles/{roleid}", { parameters: [{ name, in: "path", required: true, schema: { type: "string" } }] });
  const ok = generate(parseDefinitions([declared("roleId")]), options());
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.manifest.descriptors[0].params.map((param) => param.name), ["roleid"]);
  const bad = generate(parseDefinitions([declared("other")]), options());
  assert.ok(bad.errors.some((error) => /path parameter "other" is not in the path/.test(error)), bad.errors.join("\n"));
});

test("a path param the operation doesn't declare still becomes a required argument", () => {
  const { manifest } = generate(parseDefinitions([def("GET", "/things/{thing_id}")]), options());
  assert.deepEqual(manifest.descriptors[0].params, [{ name: "thing_id", in: "path", type: "string", required: true }]);
  assert.deepEqual(manifest.descriptors[0].form!.positionals, [{ label: "thing-id", param: "thing_id" }]);
});

test("flag names collide by spelling, not just by exact name", () => {
  const query = (name: string) => ({ name, in: "query", schema: { type: "string" } });
  const global = generate(parseDefinitions([def("POST", "/things", { parameters: [query("idempotency_key")] })]), options());
  assert.equal(global.manifest.descriptors[0].params[0].flag, "idempotency_key-param");
  const twin = generate(parseDefinitions([def("GET", "/things", { parameters: [query("a_b"), query("aB")] })]), options());
  assert.ok(twin.errors.some((error) => /would share one flag/.test(error)), twin.errors.join("\n"));
  // A path param is an argument, not a flag, so a query param of the same name doesn't clash with it.
  assert.deepEqual(generate(parseDefinitions([def("GET", "/things/{id}", { parameters: [query("id")] })]), options()).errors, []);
});

test("the same version of one route can't be defined twice", () => {
  const { errors } = generate(parseDefinitions([def("GET", "/a/{p}/b"), def("GET", "/a/{q}/b")]), options());
  assert.ok(errors.some((error) => /defined more than once/.test(error)), errors.join("\n"));
});

const gadgetOp = (extra: Record<string, any> = {}) => ({ summary: "S", responses: { "200": { description: "ok" } }, ...extra });
const gadget = (extra: Record<string, any>) => ({ api: "rest", method: "GET", path: "/gadgets", version: "2026-01-01", beta_until: null, sunset_at: null, operation: gadgetOp(), ...extra });

test("a descriptor carries the param types, enum, body shape and response contract of its operation", () => {
  const { manifest, errors } = generate(
    parseDefinitions([
      gadget({
        method: "POST",
        path: "/gadgets/{gadget_id}/parts",
        operation: gadgetOp({
          parameters: [
            { name: "gadget_id", in: "path", schema: { type: "string" } },
            { name: "limit", in: "query", required: true, schema: { type: "integer" }, description: "Page size" },
            { name: "active", in: "query", schema: { type: "boolean" } },
            { name: "kind", in: "query", schema: { type: "string", enum: ["a", "b", null] } },
            { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { data: { type: "array", maxItems: 5, items: { type: "object", required: ["name"], properties: { name: { type: "string" }, qty: { type: "integer" } } } } },
                },
              },
            },
          },
          responses: {
            "202": {
              description: "accepted",
              content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", required: ["id"], properties: { id: { type: "string" }, ok: { type: "boolean" } } } } } } },
            },
          },
        }),
      }),
    ]),
    options(),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest.descriptors, [
    {
      command: ["gadgets", "parts", "create"],
      method: "POST",
      path: "/gadgets/{gadget_id}/parts",
      summary: "S",
      version: "2026-01-01",
      async: true,
      bodyKind: "json-array",
      supportsMultipart: false,
      bodyWrapper: "data",
      params: [
        { name: "gadget_id", in: "path", type: "string", required: true },
        { name: "limit", in: "query", type: "integer", required: true, description: "Page size" },
        { name: "active", in: "query", type: "boolean", required: false },
        { name: "kind", in: "query", type: "string", required: false, enum: ["a", "b"] },
        { name: "tags", in: "query", type: "array", required: false },
      ],
      bodyProps: [
        { name: "name", in: "body", type: "string", required: true },
        { name: "qty", in: "body", type: "integer", required: false },
      ],
      maxItems: 5,
      fileFields: [],
      responseKind: "object",
      responseFields: [
        { name: "id", in: "body", type: "string", required: true },
        { name: "ok", in: "body", type: "boolean", required: false },
      ],
      api: "rest",
      versions: [{ version: "2026-01-01", beta_until: null, sunset_at: null }],
      form: { positionals: [{ label: "gadget-id", param: "gadget_id" }], scopes: [], selectors: [] },
    },
  ]);
});

test("a renamed path param still matches its map entry, its released name and its summary entry", () => {
  const param = (name: string) => gadgetOp({ parameters: [{ name, in: "path", schema: { type: "string" } }] });
  const map: MapEntry[] = [{ method: "PATCH", path: "/types/{typeId}", command: "deel kinds update <type>" }];
  const released = generate(parseDefinitions([gadget({ method: "PATCH", path: "/types/{typeId}", operation: param("typeId") })]), options({ map }));
  assert.deepEqual(names(released.manifest.descriptors), ["kinds update"]);

  const renamed = parseDefinitions([gadget({ method: "PATCH", path: "/types/{type_id}", operation: param("type_id") })]);
  const next = generate(renamed, options({ map, previous: released.manifest }));
  assert.deepEqual(next.errors, []);
  assert.deepEqual(next.warnings, []);
  assert.deepEqual(names(next.manifest.descriptors), ["kinds update"]);
  assert.deepEqual([next.summary.added.length, next.summary.removed.length, next.summary.changed.length, next.summary.bump], [0, 0, 1, "patch"]);

  const locked = generate(renamed, options({ map: [], previous: released.manifest }));
  assert.match(locked.errors.join("\n"), /Lock: .*released as "deel kinds update <type>"/);
});

test("a param named like a global flag in any spelling the parser knows gets the -param flag", () => {
  for (const name of ["help", "h", "version", "v", "base-url", "base_url", "beta", "versions", "json", "fields"]) {
    const { manifest, errors } = generate(parseDefinitions([gadget({ operation: gadgetOp({ parameters: [{ name, in: "query", schema: { type: "string" } }] }) })]), options());
    assert.deepEqual(errors, [], name);
    assert.equal(manifest.descriptors[0].params.find((param) => param.name === name)!.flag, `${name}-param`, name);
  }
});

test("the primary version is the newest stable one however the definitions are ordered", () => {
  const versions = ["2026-08-10", "2026-01-01", "2026-04-02"];
  for (const order of [versions, [...versions].reverse(), [...versions].sort()]) {
    const { manifest, errors } = generate(parseDefinitions(order.map((version) => gadget({ version }))), options());
    assert.deepEqual(errors, []);
    assert.equal(manifest.descriptors[0].version, "2026-08-10");
    assert.deepEqual(manifest.descriptors[0].versions!.map((entry) => entry.version), ["2026-01-01", "2026-04-02", "2026-08-10"]);
  }
});

test("header and cookie params never become flags", () => {
  const { manifest } = generate(
    parseDefinitions([gadget({ operation: gadgetOp({ parameters: [{ name: "x-trace", in: "header", schema: { type: "string" } }, { name: "sid", in: "cookie", schema: { type: "string" } }, { name: "q", in: "query", schema: { type: "string" } }] }) })]),
    options(),
  );
  assert.deepEqual(manifest.descriptors[0].params.map((param) => param.name), ["q"]);
});

// ---------------- the command map ----------------

test("an endpoint with no map entry is an error, and a map entry with no endpoint is a warning", () => {
  const map = widgetsMap().filter((entry) => entry.path !== "/gizmos");
  map.push({ method: "GET", path: "/nothing", command: "deel nothing list" });
  const { errors, warnings } = generateWith(widgets(), options({ map }));
  assert.ok(errors.some((error) => /GET \/gizmos has no entry in src\/public-api\/commands.json/.test(error)), errors.join("\n"));
  assert.ok(warnings.some((warning) => /names GET \/nothing, which isn't in the definitions/.test(warning)), warnings.join("\n"));
});

test("the map can't name one route twice", () => {
  const map = [...widgetsMap(), { method: "GET", path: "/gizmos", command: "deel gadgets list" }];
  const { errors } = generateWith(widgets(), options({ map }));
  assert.ok(errors.some((error) => /names GET \/gizmos twice/.test(error)), errors.join("\n"));
});

test("a scope flag picks the parent-scoped endpoint and fills its path param", () => {
  const { manifest } = generate(widgets(), options());
  const notes = manifest.descriptors.filter((descriptor) => descriptor.command.join(" ") === "widgets notes list");
  assert.deepEqual(notes.map((d) => [d.path, d.form!.scopes]), [
    ["/widgets/notes", []],
    ["/widgets/{widget_id}/notes", [{ flag: "widget", label: "widget", param: "widget_id" }]],
  ]);
});

test("two endpoints with the same command line are an error unless the map collapses them, and then the first is called", () => {
  const twins = parseDefinitions([def("POST", "/a/{id}/stop"), def("POST", "/b/{id}/stop")]);
  const same = (collapse?: string): MapEntry[] => [
    { method: "POST", path: "/a/{id}/stop", command: "deel things stops create <thing>", ...(collapse ? { collapse } : {}) },
    { method: "POST", path: "/b/{id}/stop", command: "deel things stops create <thing>", ...(collapse ? { collapse } : {}) },
  ];
  const clash = generateWith(twins, options({ map: same() }));
  assert.ok(clash.errors.some((error) => /"deel things stops create <thing>" names POST \/a\/\{id\}\/stop and POST \/b\/\{id\}\/stop/.test(error)), clash.errors.join("\n"));
  const collapsed = generateWith(twins, options({ map: same("stop") }));
  assert.deepEqual(collapsed.errors, []);
  assert.deepEqual(collapsed.manifest.descriptors.map((d) => d.path), ["/a/{id}/stop"]);
  assert.ok(collapsed.warnings.some((warning) => /POST \/b\/\{id\}\/stop is collapsed into POST \/a\/\{id\}\/stop/.test(warning)));
});

test("a selector or scope flag can't share a spelling with a global flag or one of the endpoint's own flags", () => {
  const definitions = parseDefinitions([def("POST", "/shifts/raw", { parameters: [{ name: "mode", in: "query", schema: { type: "string" } }] })]);
  for (const [command, why] of [["deel shifts create --raw", /--raw clashes with the global --raw/], ["deel shifts create --mode fast", /--mode clashes with its --mode/]] as const) {
    const { errors } = generateWith(definitions, options({ map: [{ method: "POST", path: "/shifts/raw", command }] }));
    assert.ok(errors.some((error) => why.test(error)), `${command}: ${errors.join("\n")}`);
  }
});

test("a map entry that leaves a path param out, or names a label the path doesn't have, is an error", () => {
  const definitions = parseDefinitions([def("GET", "/entities/{entity_id}/imports/{import_id}")]);
  const { errors } = generateWith(definitions, options({ map: [{ method: "GET", path: "/entities/{entity_id}/imports/{import_id}", command: "deel imports get <import>" }] }));
  assert.ok(errors.some((error) => /path param \{entity_id\} .* has no argument/.test(error)), errors.join("\n"));
  const extra = generateWith(parseDefinitions([def("GET", "/things")]), options({ map: [{ method: "GET", path: "/things", command: "deel things list <thing>" }] }));
  assert.ok(extra.errors.some((error) => /<thing> matches no path param of \/things/.test(error)), extra.errors.join("\n"));
});

test("a flag that picks an endpoint can't also be a flag of another endpoint sharing the words", () => {
  const definitions = parseDefinitions([def("GET", "/fleet", { parameters: [{ name: "status", in: "query", schema: { type: "string" } }] }), def("GET", "/fleet/archived")]);
  const map: MapEntry[] = [
    { method: "GET", path: "/fleet", command: "deel ships list" },
    { method: "GET", path: "/fleet/archived", command: "deel ships list --status archived" },
  ];
  const { errors } = generateWith(definitions, options({ map }));
  assert.ok(errors.some((error) => /"deel ships list --status archived": --status picks this endpoint, but it is also a flag of "deel ships list"/.test(error)), errors.join("\n"));
});

test("two endpoints that share the words and differ only in their arguments are an error", () => {
  const definitions = parseDefinitions([def("GET", "/vault/items"), def("GET", "/vault/folders/{folder_id}/items")]);
  const map: MapEntry[] = [
    { method: "GET", path: "/vault/items", command: "deel vault items list" },
    { method: "GET", path: "/vault/folders/{folder_id}/items", command: "deel vault items list <folder>" },
  ];
  const { errors } = generateWith(definitions, options({ map }));
  assert.ok(errors.some((error) => /"deel vault items list" and "deel vault items list <folder>" differ only in their arguments/.test(error)), errors.join("\n"));
});

test("object variants read as one object: every property, enums joined, required only where every variant requires it", () => {
  const cash = { type: "object", required: ["type", "amount"], properties: { type: { type: "string", enum: ["CASH"] }, amount: { type: "number" } } };
  const time = { type: "object", required: ["type", "time_unit"], properties: { type: { type: "string", enum: ["TIME"] }, time_unit: { type: "string" } } };
  const merged = mergeVariants({ type: "object", properties: { severance: { oneOf: [cash, time] } } }).properties.severance;
  assert.deepEqual(Object.keys(merged.properties).sort(), ["amount", "time_unit", "type"]);
  assert.deepEqual(merged.properties.type.enum, ["CASH", "TIME"]);
  assert.deepEqual(merged.required, ["type"]);
  // allOf requires what any member requires; a lone member plus null is left for the nullable reading.
  assert.deepEqual(mergeVariants({ allOf: [cash, { type: "object", required: ["note"], properties: { note: { type: "string" } } }] }).required.sort(), ["amount", "note", "type"]);
  const nullable = { anyOf: [cash, { type: "null" }] };
  assert.deepEqual(mergeVariants(nullable), nullable);
  assert.equal(mergeVariants({ anyOf: [cash, time, { type: "null" }] }).nullable, true);
  // Variants that aren't all objects stay as they are.
  const mixed = { oneOf: [cash, { type: "string" }] };
  assert.deepEqual(mergeVariants(mixed), mixed);
});

test("reservedClashes finds a name that shadows, replaces, groups or is grouped by a reserved command", () => {
  const reserved = { commands: [{ command: ["gizmos", "list"], method: "GET", path: "/gizmos" }, { command: ["gadgets", "show", "all"], method: "GET", path: "/gadgets" }], topLevel: new Set(["auth"]) };
  assert.equal(reservedClashes(["auth sessions list"], reserved).length, 1);
  assert.match(reservedClashes(["gizmos list"], reserved, () => " (GET /x)")[0], /"deel gizmos list" \(GET \/x\) clashes with a hand-picked command/);
  assert.match(reservedClashes(["gizmos list all"], reserved)[0], /turn the hand-picked "deel gizmos list" into a group/);
  assert.match(reservedClashes(["gadgets show"], reserved)[0], /is a group of the hand-picked "deel gadgets show all"/);
  assert.deepEqual(reservedClashes(["gizmos get", "widgets list"], reserved), []);
});

test("readGeneratedManifest refuses a damaged manifest by name, not with a TypeError", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-command-map-"));
  const manifest = join(dir, "manifest.json");
  for (const content of ['{"descriptors": [{"method": "GET"}]}', "{}"]) {
    writeFileSync(manifest, content);
    assert.throws(() => readGeneratedManifest(manifest), /manifest\.json is not a generated manifest/);
  }
  writeFileSync(manifest, JSON.stringify({ generator: "x", descriptors: [{ method: "GET", path: "/a", command: ["a", "list"], params: [], form: { positionals: [], scopes: [], selectors: [] } }] }));
  assert.equal(readGeneratedManifest(manifest).descriptors.length, 1);
  writeFileSync(manifest, JSON.stringify({ descriptors: [{ method: "GET", path: "/a", command: ["a"], params: [], form: { positionals: [] } }] }));
  assert.throws(() => readGeneratedManifest(manifest), /descriptor 0 has a form without positionals, scopes and selectors/);
  assert.throws(() => readGeneratedManifest(join(dir, "nope.json")), /nope\.json/);
  writeFileSync(manifest, "not json");
  assert.throws(() => readGeneratedManifest(manifest), /manifest\.json: /);
});
