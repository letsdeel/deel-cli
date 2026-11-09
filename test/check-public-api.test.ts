import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkManifest, checkMapIsPublic, definitionsUrlMentions, idTokenWriters, run, GENERATOR, MANIFEST_FILE } from "../scripts/check-public-api.ts";
import { tempDir } from "./stubs.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: ["widgets", "get"],
    method: "GET",
    path: "/widgets/{id}",
    summary: "Get a widget",
    version: "2026-01-01",
    async: false,
    bodyKind: "none",
    supportsMultipart: false,
    bodyWrapper: "none",
    params: [{ name: "id", in: "path", type: "string", required: true, description: "Widget id" }],
    bodyProps: [],
    fileFields: [],
    responseKind: "object",
    responseFields: [
      { name: "owner", in: "body", type: "object", required: false, properties: [{ name: "id", in: "body", type: "string", required: true }] },
    ],
    api: "rest",
    beta: false,
    versions: [{ version: "2026-01-01", beta_until: null, sunset_at: null }],
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}, descriptors: unknown[] = [descriptor()]): string {
  return JSON.stringify({ generator: GENERATOR, descriptors, ...overrides });
}

test("the committed manifest passes", () => {
  assert.deepEqual(checkManifest(readFileSync(join(REPO_ROOT, MANIFEST_FILE), "utf8")), []);
});

test("a manifest with every allowlisted field passes", () => {
  assert.deepEqual(checkManifest(manifest()), []);
  assert.deepEqual(checkManifest(manifest({}, [descriptor({ api: "scim", method: "PATCH", variant: "by-email", maxItems: 5 })])), []);
});

test("shape: rejects keys outside the allowlist at every level", () => {
  assert.match(checkManifest(manifest({ spec: {} })).join("\n"), /top level: unexpected key "spec"/);
  assert.match(checkManifest(manifest({}, [descriptor({ operationId: "getWidget" })])).join("\n"), /descriptors\[0\] \(widgets get\): unexpected key "operationId"/);

  const nested = descriptor({
    responseFields: [{ name: "owner", in: "body", type: "object", required: false, properties: [{ name: "id", in: "body", type: "string", required: true, example: "w_1" }] }],
  });
  assert.match(checkManifest(manifest({}, [nested])).join("\n"), /responseFields\[0\]\.properties\[0\]: unexpected key "example"/);

  const version = descriptor({ versions: [{ version: "2026-01-01", beta_until: null, sunset_at: null, owner: "team" }] });
  assert.match(checkManifest(manifest({}, [version])).join("\n"), /versions\[0\]: unexpected key "owner"/);
});

test("shape: rejects a manifest that is not JSON, not an object, or has no descriptors array", () => {
  assert.deepEqual(checkManifest("{nope"), [`[manifest] ${MANIFEST_FILE} is not valid JSON`]);
  assert.deepEqual(checkManifest("[]"), [`[manifest] ${MANIFEST_FILE} must be a JSON object`]);
  assert.match(checkManifest(manifest({ descriptors: {} })).join("\n"), /"descriptors" must be an array/);
  assert.match(checkManifest(manifest({}, ["widgets"])).join("\n"), /descriptors\[0\] must be an object/);
  assert.match(checkManifest(manifest({}, [descriptor({ params: {} })])).join("\n"), /params must be an array/);
  assert.match(checkManifest(manifest({}, [descriptor({ bodyProps: ["x"] })])).join("\n"), /bodyProps\[0\] must be an object/);
  assert.match(checkManifest(manifest({}, [descriptor({ versions: {} })])).join("\n"), /versions must be an array/);
  assert.match(checkManifest(manifest({}, [descriptor({ versions: ["v1"] })])).join("\n"), /versions\[0\] must be an object/);
});

test("public data: rejects x- keys anywhere in the file", () => {
  const errors = checkManifest(manifest({}, [descriptor({ params: [{ name: "id", in: "path", type: "string", required: true, "x-internal": true }] })]));
  assert.ok(errors.some((e) => /^\[public-data\] \$\.descriptors\[0\]\.params\[0\]\.x-internal: extension/.test(e)), errors.join("\n"));
  assert.ok(checkManifest(manifest({ "x-owner": "team" })).some((e) => /\$\.x-owner: extension/.test(e)));
});

test("public data: api must be rest or scim, path absolute, method a plain HTTP verb", () => {
  const api = checkManifest(manifest({}, [descriptor({ api: "internal" })]));
  assert.match(api.join("\n"), /"api" must be "rest" or "scim", got "internal"/);
  const { api: _dropped, ...noApi } = descriptor();
  assert.match(checkManifest(manifest({}, [noApi])).join("\n"), /"api" must be "rest" or "scim", got null/);

  assert.match(checkManifest(manifest({}, [descriptor({ path: "widgets/{id}" })])).join("\n"), /"path" must start with "\/"/);
  assert.match(checkManifest(manifest({}, [descriptor({ path: "https://example.com/widgets" })])).join("\n"), /"path" must start with "\/"/);

  for (const method of ["HEAD", "get", "OPTIONS", 1]) {
    assert.match(checkManifest(manifest({}, [descriptor({ method })])).join("\n"), /"method" must be one of GET\/POST\/PUT\/PATCH\/DELETE/);
  }
});

test("the generator must be this repository's script", () => {
  assert.match(checkManifest(manifest({ generator: "scripts/other.ts" })).join("\n"), /"generator" is "scripts\/other\.ts"/);
});

test("run: reads the manifest under --root", (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, "src", "public-api"), { recursive: true });
  assert.deepEqual(run(["--root", root]), [`[manifest] ${MANIFEST_FILE} is missing`]);
  writeFileSync(join(root, MANIFEST_FILE), manifest({ generator: "scripts/other.ts" }));
  assert.match(run(["--root", root]).join("\n"), /^\[manifest\]/);
  writeFileSync(join(root, MANIFEST_FILE), manifest());
  assert.deepEqual(run(["--root", root]), []);
});

test("a manifest with a command-map form passes, and unknown form keys don't", () => {
  const form = { positionals: [{ label: "widget", param: "id" }], scopes: [], selectors: [{ flag: "worker-type", value: "eor" }] };
  assert.deepEqual(checkManifest(manifest({}, [descriptor({ form })])), []);
  assert.match(checkManifest(manifest({}, [descriptor({ form: { ...form, hidden: true } })])).join("\n"), /form: unexpected key "hidden"/);
});

test("every endpoint the map names must be in the manifest, unless no manifest is committed yet", () => {
  const map = (rows: unknown[]) => JSON.stringify(rows);
  const published = manifest();
  assert.deepEqual(checkMapIsPublic(map([{ method: "GET", path: "/widgets/{widget_id}" }]), published), []);
  assert.match(checkMapIsPublic(map([{ method: "GET", path: "/internal/things" }]), published).join(), /names GET \/internal\/things, which is not in the public manifest/);
  assert.deepEqual(checkMapIsPublic(map([{ method: "GET", path: "/internal/things" }]), manifest({}, [])), []);
  const collapsed = map([{ method: "GET", path: "/widgets/{id}", collapse: "w" }, { method: "GET", path: "/old/widgets/{id}", collapse: "w" }]);
  assert.deepEqual(checkMapIsPublic(collapsed, published), []);
});

test("no tracked file may name a definitions URL, and no workflow may request id-token: write", () => {
  const url = ["https://api.example.test", "openapi", "definitions"].join("/");
  assert.deepEqual(definitionsUrlMentions([{ path: "a.ts", text: `ok\nconst u = "${url}";` }, { path: "b.md", text: "the public definitions route" }]), ["a.ts:2"]);
  assert.deepEqual(idTokenWriters([
    { path: ".github/workflows/a.yaml", text: "permissions:\n  id-token: write\n" },
    { path: ".github/workflows/b.yaml", text: "permissions:\n  contents: read\n  id-token: none\n" },
  ]), [".github/workflows/a.yaml"]);
});

test("the repository itself names no definitions URL and no workflow requests id-token: write", () => {
  assert.deepEqual(run(["--root", REPO_ROOT]), []);
});
