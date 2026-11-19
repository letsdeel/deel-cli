// The shared vocabulary in src/core/constants.ts: the routes and fields it names must exist where it says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTCOME_ROUTES, SEND_ONCE_ROUTES, SENSITIVE_LOG_KEYS, WITHHELD_RESPONSE_FIELDS, withheldFieldFor } from "../src/core/constants.ts";
import { isSensitiveKey } from "../src/core/logging.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import type { CliParam } from "../src/types.ts";

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

// ---- what a response may carry that the CLI withholds ----
// A response field that is a credential is either withheld (WITHHELD_RESPONSE_FIELDS: a secret that stays viewable
// elsewhere and that no command needs back) or printed on purpose, listed here with the reason. Both stay masked in the
// local log. Which other response fields look like credentials is not checked: a name is no proof either way.
const PRINTED_ON_PURPOSE: Record<string, string> = {
  token: "the access token the command exists to issue (worker sessions, delegated tokens); it can't be read again",
  unique_consent_token: "the consent JWT the command issues, which the caller passes on",
  one_time_secret: "claims the uploaded file; returned once, and the next call needs it",
  magic_link: "the login link the command exists to create",
};

test("every withheld or printed-on-purpose credential is a response field of the manifest and masked in the local log", async () => {
  const names = new Set<string>();
  const walk = (fields: CliParam[] | undefined) => {
    for (const field of fields ?? []) {
      names.add(field.name);
      walk(field.properties);
    }
  };
  for (const descriptor of await loadGeneratedDescriptors()) walk(descriptor.responseFields);
  for (const name of [...Object.keys(PRINTED_ON_PURPOSE), ...Object.keys(WITHHELD_RESPONSE_FIELDS)]) {
    assert.ok(names.has(name), `${name} is no longer a response field of the manifest`);
    assert.ok(isSensitiveKey(name), `${name} must stay masked in the log`);
  }
});

test("withheldFieldFor names the withheld field by any spelling of it, and nothing inherited or similar", () => {
  for (const key of ["signing_key", "signingKey", "SigningKey", "Signing_Key", "signing-key", "SIGNING_KEY", "signing.key"]) assert.equal(withheldFieldFor(key), "signing_key", key);
  for (const key of ["signing", "key", "signing_keys", "constructor", "__proto__", "toString", ""]) assert.equal(withheldFieldFor(key), undefined, key);
  assert.deepEqual(Object.keys(WITHHELD_RESPONSE_FIELDS).every((name) => withheldFieldFor(name) === name), true);
});

