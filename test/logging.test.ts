import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLogging } from "../src/core/http.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import { isLinkKey, isSensitiveKey, keyWords, log, maskLink, setLoggingEnabled, setLogBodiesEnabled } from "../src/core/logging.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import type { CliParam } from "../src/types.ts";

const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ method: "GET", url: "https://x/rest/people/me", headers: {}, ...over });
const res = (json: unknown): HttpResponse => ({ status: 200, headers: {}, text: "", json });

function captured(): { logger: (e: Record<string, unknown>) => void; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  return { entries, logger: (e) => entries.push(e) };
}

test("withLogging omits the response body and strips the query string by default", async () => {
  setLogBodiesEnabled(false);
  const c = captured();
  const next: Transport = async () => res({ access_token: "secret" });
  await withLogging(c.logger, () => 0)(next)(req({ url: "https://x/rest/people/me?token=abc" }));
  const entry = c.entries[0];
  assert.equal("response" in entry, false);
  assert.equal(entry.url, "https://x/rest/people/me");
});

test("withLogging includes the response body when body logging is opted in", async () => {
  setLogBodiesEnabled(true);
  const c = captured();
  const next: Transport = async () => res({ ok: true });
  await withLogging(c.logger, () => 0)(next)(req({ url: "https://x/rest/people/me?page=2" }));
  const entry = c.entries[0];
  assert.deepEqual(entry.response, { ok: true });
  assert.equal(entry.url, "https://x/rest/people/me?page=2");
  setLogBodiesEnabled(false);
});

test("the default sink redacts sensitive keys by substring (access_token, email, iban, tax_id)", () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  log({ kind: "request", response: { access_token: "a", email: "e@x.com", iban: "DE00", tax_id: "123", nested: { refresh_token: "r" } } });
  const line = readFileSync(join(dir, "deel.log"), "utf8").trim().split("\n").pop()!;
  const parsed = JSON.parse(line);
  assert.equal(parsed.response.access_token, "***");
  assert.equal(parsed.response.email, "***");
  assert.equal(parsed.response.iban, "***");
  assert.equal(parsed.response.tax_id, "***");
  assert.equal(parsed.response.nested.refresh_token, "***");
  delete process.env.DEEL_LOG_DIR;
});

test("the logged body masks login links, pre-signed links and government, tax and bank identifiers of the generated commands", () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  const secrets = ["magic_link", "download_link", "upload_url", "pdf_url", "identity_document_number", "vat_id", "sort_code", "branch_code"];
  const body = Object.fromEntries(secrets.map((key) => [key, `value-of-${key}`]));
  log({ kind: "request", response: { ...body, nested: { items: [{ ...body }] }, vat_percentage: 21, url: "https://example.test/hook", country_code: "DE" } });
  const parsed = JSON.parse(readFileSync(join(dir, "deel.log"), "utf8").trim().split("\n").pop()!);
  for (const key of secrets) {
    assert.equal(parsed.response[key], "***", key);
    assert.equal(parsed.response.nested.items[0][key], "***", `nested ${key}`);
  }
  // Fields that only look similar keep their value.
  assert.deepEqual([parsed.response.vat_percentage, parsed.response.url, parsed.response.country_code], [21, "https://example.test/hook", "DE"]);
  delete process.env.DEEL_LOG_DIR;
});

test("a --log-bodies run of a generated command logs a magic link as ***", async () => {
  setLogBodiesEnabled(true);
  const c = captured();
  const next: Transport = async () => res({ data: { magic_link: "https://app.example.test/login?t=abc", expires_at: "2026-11-10T00:00:00Z" } });
  await withLogging(c.logger, () => 0)(next)(req({ method: "POST", url: "https://x/rest/access/magic-links" }));
  setLogBodiesEnabled(false);
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  log(c.entries[0]);
  const logged = readFileSync(join(dir, "deel.log"), "utf8");
  assert.doesNotMatch(logged, /app\.example\.test\/login/);
  assert.equal(JSON.parse(logged.trim().split("\n").pop()!).response.data.magic_link, "***");
  delete process.env.DEEL_LOG_DIR;
});

test("a link in a logged body keeps its host and path but not the query or fragment, where a pre-signed link keeps its signature", () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  const signed = "https://files.example.test/payslip.pdf?X-Amz-Signature=abc123&X-Amz-Expires=900";
  log({
    kind: "request",
    url: "https://x/rest/payslips?page=2", // the entry's own url is the request, kept whole
    response: { data: { download_url: signed, redirectUri: "https://app.example.test/cb#access=xyz", links: [signed], link: signed, redirect_uris: [signed, "https://ok.example.test/a"], nested: { items: [{ pic_url: signed }] }, note: signed, hook_url: "https://example.test/hook" } },
  });
  const parsed = JSON.parse(readFileSync(join(dir, "deel.log"), "utf8").trim().split("\n").pop()!);
  assert.equal(parsed.url, "https://x/rest/payslips?page=2");
  const data = parsed.response.data;
  assert.equal(data.download_url, "https://files.example.test/payslip.pdf?***");
  assert.equal(data.redirectUri, "https://app.example.test/cb?***");
  assert.equal(data.link, "https://files.example.test/payslip.pdf?***");
  assert.deepEqual(data.links, ["https://files.example.test/payslip.pdf?***"]);
  assert.deepEqual(data.redirect_uris, ["https://files.example.test/payslip.pdf?***", "https://ok.example.test/a"]);
  assert.equal(data.nested.items[0].pic_url, "https://files.example.test/payslip.pdf?***");
  assert.equal(data.hook_url, "https://example.test/hook"); // nothing to cut
  assert.equal(data.note, signed); // not a link key: left as the API sent it
  assert.doesNotMatch(JSON.stringify({ ...data, note: undefined }), /abc123|access=xyz/);
  delete process.env.DEEL_LOG_DIR;
});

test("keyWords and isLinkKey read snake, kebab and camel case; maskLink only cuts a query or fragment", () => {
  assert.deepEqual(keyWords("downloadUrl"), ["download", "url"]);
  assert.deepEqual(keyWords("download-link_2"), ["download", "link", "2"]);
  for (const key of ["url", "pdf_url", "redirectUri", "download-link", "hrefs", "redirect_uris", "Link"]) assert.equal(isLinkKey(key), true, key);
  for (const key of ["curl", "blink", "hurl", "country_code", "linked_in"]) assert.equal(isLinkKey(key), false, key);
  assert.equal(maskLink("https://a.test/p"), "https://a.test/p");
  assert.equal(maskLink("https://a.test/p?x=1#y"), "https://a.test/p?***");
  assert.equal(maskLink("https://a.test/p#y"), "https://a.test/p?***");
  assert.equal(maskLink("not a link?x"), "not a link?***");
});

// ---- the masking policy against the generated manifest ----
// Every field name an endpoint takes or returns that reads like a credential, a link, a financial or government
// identifier or a person's data must be masked in the log, or be listed here as reviewed and safe, with the reason. A new
// endpoint with a new such name fails this test, instead of surfacing in a review of the log.
const LOOKS_SENSITIVE = new Set([
  "key", "keys", "secret", "secrets", "token", "tokens", "password", "passwd", "credential", "credentials", "link", "url", "uri", "href",
  "signature", "signatures", "iban", "bic", "swift", "rib", "account", "routing", "ssn", "tax", "vat", "passport", "identity", "national",
  "nationality", "birth", "dob", "email", "phone", "mobile", "address", "card", "cvv", "cvc", "pin", "otp", "hash", "salary", "gender",
  "number", "code", "private", "auth", "session", "cookie", "jwt", "certificate", "cert", "license", "social", "security",
]);

const REVIEWED_SAFE: Record<string, string[]> = {
  "a date, a kind or a label of an account, not its number": ["account_activation_date", "account_type", "general_ledger_account"],
  "an internal id or reference of a company's own record": [
    "alternate_employee_number", "employeeNumber", "employee_number", "employee_grant_number", "split_employee_grant_number", "position_number",
    "cost_center_number", "number", "expense_account_id", "import_session_id", "serial_number",
  ],
  "company registry data, public by nature": ["registration_number", "registrationNumber", "sic_number", "certificate_of_good_standing"],
  "a code of a type, currency, country, state or response": [
    "benefit_type_code", "calling_code", "country_code", "currency_code", "currency_iso_code", "compensation_currency_iso_code", "fmv_currency_code",
    "dial_code", "job_code", "state_code", "vat_code", "response_status_code", "code", "number_type",
  ],
  "a postal code: part of an address, which is masked whole": ["post_code", "postalCode", "zip_code"],
  "a field or storage key of the product, not a credential": ["category_key", "compare_key", "display_key", "group_key", "key", "left_field_key", "right_field_key", "question_key", "missing_keys"],
  "a hash that fingerprints a record's version": ["row_hash", "version_hash"],
  "a VAT amount or rate, not an identifier": ["vat", "vat_amount", "vat_percentage", "vat_rate", "vat_total"],
};

function fieldNamesOf(fields: CliParam[] | undefined, into: Set<string>): void {
  for (const field of fields ?? []) {
    into.add(field.name);
    fieldNamesOf(field.properties, into);
  }
}

test("every field name of the generated manifest that reads as sensitive is masked in the log or reviewed as safe", async () => {
  const names = new Set<string>();
  for (const descriptor of await loadGeneratedDescriptors()) {
    fieldNamesOf(descriptor.params, names);
    fieldNamesOf(descriptor.bodyProps, names);
    fieldNamesOf(descriptor.responseFields, names);
  }
  const safe = new Map(Object.entries(REVIEWED_SAFE).flatMap(([reason, keys]) => keys.map((key) => [key, reason] as const)));
  const unreviewed = [...names].filter((name) => keyWords(name).some((word) => LOOKS_SENSITIVE.has(word)) && !isSensitiveKey(name) && !isLinkKey(name) && !safe.has(name));
  assert.deepEqual(unreviewed.sort(), [], "mask these in SENSITIVE_LOG_KEYS (src/core/constants.ts), or list them as safe with a reason");
  // The list stays honest: no entry is stale, masked anyway, or a name the heuristic would never ask about.
  for (const [name, reason] of safe) {
    assert.ok(names.has(name), `${name} (${reason}) is no longer a field of the manifest`);
    assert.equal(isSensitiveKey(name) || isLinkKey(name), false, `${name} is masked already; drop it from the reviewed list`);
  }
  assert.ok(safe.size < 80, "the reviewed list is meant to stay small");
  // And the names that matter most are masked.
  for (const name of ["magic_link", "rib_number", "id_number", "ifsc_code", "bsb_code", "vat_number", "client_signature", "account_holder", "annual_salary", "nationality"]) {
    assert.ok(names.has(name) || name === "client_signature", `${name} no longer exists; update this list`);
    assert.equal(isSensitiveKey(name), true, name);
  }
});
