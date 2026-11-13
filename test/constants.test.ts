// The shared vocabulary in src/core/constants.ts: the routes and fields it names must exist where it says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONFIRM_ROUTES, CREDENTIAL_LOG_KEYS, CREDENTIAL_LOG_WORDS, OUTCOME_ROUTES, SEND_ONCE_ROUTES, SENSITIVE_LOG_KEYS, WITHHELD_RESPONSE_FIELDS, withheldFieldFor } from "../src/core/constants.ts";
import { isSensitiveKey, keyWords } from "../src/core/logging.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import type { CliParam } from "../src/types.ts";

// The key SEND_ONCE_ROUTES and OUTCOME_ROUTES use: "METHOD /path" with the path params as {}.
const routeOf = (method: string, path: string) => `${method.toUpperCase()} ${path.replace(/\{[^}]+\}/g, "{}")}`;

test("every send-once, outcome and confirm route is an endpoint of the committed manifest", async () => {
  const routes = new Set((await loadGeneratedDescriptors()).map((descriptor) => routeOf(descriptor.method, descriptor.path)));
  for (const route of [...SEND_ONCE_ROUTES, ...Object.keys(OUTCOME_ROUTES), ...Object.keys(CONFIRM_ROUTES)]) assert.ok(routes.has(route), `${route} is not in src/public-api/manifest.json`);
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
// elsewhere and that no command needs back) or printed on purpose, listed here with the reason. A new endpoint with a
// new credential-looking response field fails this test until someone decides which.
const PRINTED_ON_PURPOSE: Record<string, string> = {
  token: "the access token the command exists to issue (worker sessions, delegated tokens); it can't be read again",
  unique_consent_token: "the consent JWT the command issues, which the caller passes on",
  one_time_secret: "claims the uploaded file; returned once, and the next call needs it",
  magic_link: "the login link the command exists to create",
};
const NOT_CREDENTIALS = [
  "active_tokens", "token_type", "token_usage", "tokens_left", // counts and kinds of tokens
  "signature", "signatures", "client_signature", "contractor_signature", "employee_signature", "eor_signature", "worker_signature", // the name a party signed a document with
  "import_session_id", // the id of an import run, not a login session
  "skipping_confirmation_text", // matches `pin` inside "skipping": a prompt, not a PIN
];

test("every credential-looking response field of the manifest is withheld or reviewed as printed on purpose", async () => {
  const names = new Set<string>();
  const walk = (fields: CliParam[] | undefined) => {
    for (const field of fields ?? []) {
      names.add(field.name);
      walk(field.properties);
    }
  };
  for (const descriptor of await loadGeneratedDescriptors()) walk(descriptor.responseFields);
  // The vocabulary the log masks credentials by, plus the plural a field of tokens or secrets is written in.
  const looksLikeCredential = (name: string) => {
    const lower = name.toLowerCase();
    return CREDENTIAL_LOG_KEYS.some((needle) => lower.includes(needle)) || keyWords(name).some((word) => CREDENTIAL_LOG_WORDS.includes(word.replace(/s$/, "")));
  };
  const unreviewed = [...names].filter((name) => looksLikeCredential(name) && !(name in WITHHELD_RESPONSE_FIELDS) && !(name in PRINTED_ON_PURPOSE) && !NOT_CREDENTIALS.includes(name));
  assert.deepEqual(unreviewed.sort(), [], "withhold these in WITHHELD_RESPONSE_FIELDS (src/core/constants.ts), or list them as printed on purpose with a reason");
  for (const name of [...Object.keys(PRINTED_ON_PURPOSE), ...NOT_CREDENTIALS, ...Object.keys(WITHHELD_RESPONSE_FIELDS)]) assert.ok(names.has(name), `${name} is no longer a response field of the manifest`);
  // What is printed on purpose is still masked in the local log.
  for (const name of Object.keys(PRINTED_ON_PURPOSE)) assert.ok(isSensitiveKey(name), `${name} is printed but must stay masked in the log`);
});

test("withheldFieldFor names the withheld field by any spelling of it, and nothing inherited or similar", () => {
  for (const key of ["signing_key", "signingKey", "SigningKey", "Signing_Key", "signing-key", "SIGNING_KEY", "signing.key"]) assert.equal(withheldFieldFor(key), "signing_key", key);
  for (const key of ["signing", "key", "signing_keys", "constructor", "__proto__", "toString", ""]) assert.equal(withheldFieldFor(key), undefined, key);
  assert.deepEqual(Object.keys(WITHHELD_RESPONSE_FIELDS).every((name) => withheldFieldFor(name) === name), true);
});

test("a confirm message only names parameters its endpoint takes", async () => {
  const descriptors = await loadGeneratedDescriptors();
  for (const [route, message] of Object.entries(CONFIRM_ROUTES)) {
    const descriptor = descriptors.find((d) => routeOf(d.method, d.path) === route)!;
    for (const [, name] of message.matchAll(/\{([^}]+)\}/g)) assert.ok(descriptor.params.some((param) => param.name === name), `${route}: {${name}} is not a parameter`);
  }
});
