// The shared vocabulary in src/core/constants.ts: the routes and fields it names must exist where it says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTCOME_ROUTES, SEND_ONCE_ROUTES, SENSITIVE_LOG_KEYS, WITHHELD_RESPONSE_FIELDS } from "../src/core/constants.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";

// The key SEND_ONCE_ROUTES and OUTCOME_ROUTES use: "METHOD /path" with the path params as {}.
const routeOf = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;

test("every send-once and outcome route is an endpoint of the committed manifest", async () => {
  const routes = new Set((await loadGeneratedDescriptors()).map((descriptor) => routeOf(descriptor.method, descriptor.path)));
  for (const route of [...SEND_ONCE_ROUTES, ...Object.keys(OUTCOME_ROUTES)]) assert.ok(routes.has(route), `${route} is not in src/public-api/manifest.json`);
});

test("an outcome route names a boolean field its endpoint documents in the response", async () => {
  const descriptors = await loadGeneratedDescriptors();
  for (const [route, { field }] of Object.entries(OUTCOME_ROUTES)) {
    const descriptor = descriptors.find((d) => routeOf(d.method, d.path) === route)!;
    const documented = descriptor.responseFields.find((f) => f.name === field);
    assert.equal(documented?.type, "boolean", `${route} documents no boolean ${field}`);
  }
});

test("every withheld response field is also masked in the local log", () => {
  for (const field of Object.keys(WITHHELD_RESPONSE_FIELDS)) assert.ok(SENSITIVE_LOG_KEYS.has(field), field);
});
