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
// Every field name an endpoint takes or returns is masked in the log, or made only of words reviewed as safe
// (test/fixtures/log-safe-words.txt), or reviewed by name below. Nothing passes by default: a new endpoint with a
// new word, or a new name that carries a word of an identifier (code, number, key...), fails this test, instead of
// surfacing in a review of the log. The policy itself is in src/core/constants.ts.
const SAFE_WORDS = new Set(
  readFileSync(new URL("./fixtures/log-safe-words.txt", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#")),
);

// Names that carry a word which names an identifier or a credential in other fields (account, code, number, key,
// hash), reviewed one by one: none holds a credential or a person's identifier.
const REVIEWED_SAFE: Record<string, string[]> = {
  "a date, a kind or a label of an account, or the id of a company's own account record": ["account_activation_date", "account_type", "general_ledger_account", "expense_account_id"],
  "an internal number of a company's own record (employee, grant, position, cost center) or a part number": [
    "alternate_employee_number", "employeeNumber", "employee_number", "employee_grant_number", "split_employee_grant_number", "position_number",
    "cost_center_number", "number", "serial_number",
  ],
  "company registry data, public by nature": ["registration_number", "registrationNumber", "sic_number"],
  "the unit or representation of a number field": ["number_type"],
  "a code of a type, currency, country, state, job or response, or a machine-readable error code": [
    "benefit_type_code", "calling_code", "country_code", "currency_code", "currency_iso_code", "fmv_currency_code", "dial_code", "job_code",
    "state_code", "vat_code", "response_status_code", "code",
  ],
  "a field, question, category or storage key of the product, not a credential": [
    "category_key", "compare_key", "display_key", "group_key", "key", "left_field_key", "right_field_key", "question_key", "missing_keys",
  ],
  "a hash that fingerprints a record's version": ["row_hash", "version_hash"],
};

function fieldNamesOf(fields: CliParam[] | undefined, into: Set<string>): void {
  for (const field of fields ?? []) {
    into.add(field.name);
    fieldNamesOf(field.properties, into);
  }
}

test("every field name of the generated manifest is masked in the log, made of reviewed words, or reviewed by name", async () => {
  const names = new Set<string>();
  for (const descriptor of await loadGeneratedDescriptors()) {
    fieldNamesOf(descriptor.params, names);
    fieldNamesOf(descriptor.bodyProps, names);
    fieldNamesOf(descriptor.responseFields, names);
  }
  const safe = new Map(Object.entries(REVIEWED_SAFE).flatMap(([reason, keys]) => keys.map((key) => [key, reason] as const)));
  const masked = (name: string) => isSensitiveKey(name) || isLinkKey(name);
  const unreviewed = [...names].filter((name) => !masked(name) && !keyWords(name).every((word) => SAFE_WORDS.has(word)) && !safe.has(name));
  assert.deepEqual(
    unreviewed.sort(),
    [],
    "mask these in src/core/constants.ts (SENSITIVE_LOG_KEYS or SENSITIVE_LOG_WORDS), add their new words to test/fixtures/log-safe-words.txt if they are safe, or list them in REVIEWED_SAFE with a reason",
  );
  // The reviewed lists stay honest: no stale name, none masked anyway, none that the safe words already cover.
  for (const [name, reason] of safe) {
    assert.ok(names.has(name), `${name} (${reason}) is no longer a field of the manifest`);
    assert.equal(masked(name), false, `${name} is masked already; drop it from REVIEWED_SAFE`);
    assert.equal(keyWords(name).every((word) => SAFE_WORDS.has(word)), false, `${name} is made of safe words already; drop it from REVIEWED_SAFE`);
  }
  assert.ok(safe.size < 60, "the reviewed-by-name list is meant to stay small");
  // The words list is sorted and unique so a change reads as a diff, and no word in it is one the log masks.
  const words = [...SAFE_WORDS];
  assert.deepEqual(words, [...new Set(words)].sort(), "keep test/fixtures/log-safe-words.txt sorted, one word per line, without duplicates");
  for (const word of words) assert.equal(masked(word), false, `${word} is a safe word but the log masks it`);
});

test("the log masks credentials, identifiers and personal data by name, in every spelling, and keeps ordinary fields", () => {
  const sensitive = [
    // identifiers of a person
    "personal_id", "personalId", "PersonalID", "national_id", "nationalId", "passport_number", "driver_license", "driving_licence", "identity_number",
    "tax_id", "tin", "ssn", "nric", "cpf", "curp", "dni", "nif", "social_security_number", "document_number", "id_number",
    // the special categories of the GDPR, article 9
    "ethnicity", "ethnic_origin", "race", "racial_origin", "religion", "religious_belief", "political_opinion", "union_membership", "health_status",
    "medical_condition", "disability", "disability_status", "sick_leave_reason", "sexual_orientation", "sex", "biometric_data", "genetic_data",
    // family, birth, contact and address
    "marital_status", "spouse_name", "dependents", "children", "family_members", "date_of_birth", "dob", "place_of_birth", "phone_number", "mobile",
    "work_email", "fax", "home_address", "street", "street_name", "postal_code", "post_code", "zip", "zip_code", "line1", "line2", "residence_country", "resident_id",
    // bank, card, pay
    "iban", "bic", "swift_code", "routing_number", "account_number", "account_holder_name", "sort_code", "card_number", "cvv", "pan", "last4_digits",
    "salary", "base_wage", "annual_income", "bonus_amount", "compensation", "commission_rate",
    // credentials, sessions and links
    "access_token", "refresh_token", "client_secret", "password", "passcode", "otp", "api_key", "private_key", "username", "session_id", "ip", "magic_link",
    "emergency_contact", "immigration_status", "visa_type", "beneficiary", "demographics", "pii", "pep", "sensitive_fields",
  ];
  for (const key of sensitive) assert.equal(isSensitiveKey(key), true, key);
  const ordinary = [
    "id", "name", "first_name", "company_name", "status", "type", "title", "description", "created_at", "start_date", "is_active", "country", "city",
    "currency", "amount", "rate", "unit", "count", "contract_id", "organization_id", "payment_cycle_id", "page", "limit", "cursor",
  ];
  for (const key of ordinary) assert.equal(isSensitiveKey(key), false, key);
  // Short names match as whole words, so they don't hide ordinary words that contain them.
  for (const key of ["company", "panel", "planning", "setting", "single", "tiny", "ipsum"]) assert.equal(isSensitiveKey(key), false, key);
});
