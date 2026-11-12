import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLogging } from "../src/core/http.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import { SENSITIVE_LOG_KEYS } from "../src/core/constants.ts";
import { isLinkKey, isSensitiveKey, keyWords, log, looksPersonal, maskLink, maskMarkedFields, maskUrlQuery, setLoggingEnabled, setLogBodiesEnabled } from "../src/core/logging.ts";
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

test("withLogging includes the response body when body logging is opted in, and never the request's query", async () => {
  setLogBodiesEnabled(true);
  const c = captured();
  const next: Transport = async () => res({ ok: true });
  await withLogging(c.logger, () => 0)(next)(req({ url: "https://x/rest/people/me?page=2" }));
  const entry = c.entries[0];
  assert.deepEqual(entry.response, { ok: true });
  assert.equal(entry.url, "https://x/rest/people/me");
  setLogBodiesEnabled(false);
});

test("the default sink redacts credential keys by substring (access_token, password, refresh_token) and leaves other names to the spec's marks", () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  log({ kind: "request", response: { access_token: "a", password: "p", iban: "DE00", tax_id: "123", nested: { refresh_token: "r" } } });
  const line = readFileSync(join(dir, "deel.log"), "utf8").trim().split("\n").pop()!;
  const parsed = JSON.parse(line);
  assert.equal(parsed.response.access_token, "***");
  assert.equal(parsed.response.password, "***");
  assert.equal(parsed.response.nested.refresh_token, "***");
  assert.equal(parsed.response.iban, "DE00");
  assert.equal(parsed.response.tax_id, "123");
  delete process.env.DEEL_LOG_DIR;
});

test("the logged body masks login links and pre-signed links of the generated commands, wherever they sit", () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  const secrets = ["magic_link", "download_link", "upload_url", "pdf_url", "signing_key", "client_secret"];
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

test("a request URL named in an error or the debug line masks the values of credential query parameters and keeps the rest readable", () => {
  const mask = maskUrlQuery;
  assert.equal(mask("https://x/rest/people?token=abc&page=2&limit=5"), "https://x/rest/people?token=***&page=2&limit=5");
  // Any spelling of the key, as the body policy reads it: case, camel case, an encoded key, a list key, a repeated key.
  assert.equal(mask("https://x/p?Token=a&clientSecret=b&API-KEY=c&ids%5B%5D=1&access%5Ftoken=d&api_key=e&api_key=f&ids=9"), "https://x/p?Token=***&clientSecret=***&API-KEY=***&ids%5B%5D=1&access%5Ftoken=***&api_key=***&api_key=***&ids=9");
  assert.equal(mask("https://x/p?password[]=1&password[]=2&secret=GB00"), "https://x/p?password[]=***&password[]=***&secret=***");
  // A key with an empty value, a parameter with no value, no query, an empty query.
  assert.equal(mask("https://x/p?token=&flag&page=1"), "https://x/p?token=***&flag&page=1");
  assert.equal(mask("https://x/p"), "https://x/p");
  assert.equal(mask("https://x/p?"), "https://x/p?");
  assert.equal(mask("/rest/p?token=a"), "/rest/p?token=***");
  // A link-valued parameter loses the query of its own link; the fragment, which a server never sees, is cut.
  assert.equal(mask("https://x/p?redirect_url=https%3A%2F%2Fy.co%2Fcb%3Fsig%3Dabc&page=1"), "https://x/p?redirect_url=https%3A%2F%2Fy.co%2Fcb%3F***&page=1");
  assert.equal(mask("https://x/p?page=1#access_token=abc"), "https://x/p?page=1#***");
  assert.equal(mask("https://x/p#frag"), "https://x/p#***");
  // A key that doesn't decode is read as written.
  assert.equal(mask("https://x/p?%E0%A4%A=1&token=a"), "https://x/p?%E0%A4%A=1&token=***");
  assert.match(mask("https://x/p?contact=a%40b.co&page=1"), /^https:\/\/x\/p\?contact=[^&]*&page=1$/);
  assert.doesNotMatch(mask("https://x/p?contact=a%40b.co&page=1"), /a%40b\.co|a@b\.co/);
  // The path and the host are not parameters: they stay.
  assert.equal(mask("https://token.example.co/rest/tokens/abc?page=2"), "https://token.example.co/rest/tokens/abc?page=2");
});

test("the log never keeps the request's query, with or without --log-bodies", async () => {
  const url = "https://x/rest/people?email=a%40b.co&personal_id=P123&page=2";
  const run = async (bodies: boolean) => {
    setLogBodiesEnabled(bodies);
    const c = captured();
    await withLogging(c.logger, () => 0)(async () => res({ ok: true }))(req({ url }));
    return c.entries[0].url;
  };
  try {
    assert.equal(await run(true), "https://x/rest/people");
    assert.equal(await run(false), "https://x/rest/people");
  } finally {
    setLogBodiesEnabled(false);
  }
});

const marked = (name: string, extra: Partial<CliParam> = {}): CliParam => ({ name, in: "body", type: "string", required: false, sensitive: true, ...extra });
const plain = (name: string, extra: Partial<CliParam> = {}): CliParam => ({ name, in: "body", type: "string", required: false, ...extra });

test("maskMarkedFields masks a marked field where the endpoint puts it, and the same name elsewhere is left as it is", () => {
  const fields = [plain("id"), marked("badge_color_choice"), plain("owner", { type: "object", properties: [plain("id"), marked("nickname")] }), plain("tags", { type: "array", properties: [marked("label"), plain("kind")] })];
  const body = { id: "1", badge_color_choice: "teal", owner: { id: "7", nickname: "ace", unlisted: "kept" }, tags: [{ label: "a", kind: "x" }, { label: "b", kind: "y" }], extra: { badge_color_choice: "not this endpoint's field" } };
  assert.deepEqual(maskMarkedFields(body, fields), {
    id: "1",
    badge_color_choice: "***",
    owner: { id: "7", nickname: "***", unlisted: "kept" },
    tags: [{ label: "***", kind: "x" }, { label: "***", kind: "y" }],
    extra: { badge_color_choice: "not this endpoint's field" },
  });
});

test("maskMarkedFields reads the data envelope, an array body and a body that is not an object", () => {
  const fields = [plain("id"), marked("secret_note")];
  assert.deepEqual(maskMarkedFields({ data: { id: "1", secret_note: "n" }, page: { total: 1 } }, fields), { data: { id: "1", secret_note: "***" }, page: { total: 1 } });
  assert.deepEqual(maskMarkedFields({ data: [{ id: "1", secret_note: "n" }] }, fields), { data: [{ id: "1", secret_note: "***" }] });
  assert.deepEqual(maskMarkedFields([{ id: "1", secret_note: "n" }], fields), [{ id: "1", secret_note: "***" }]);
  assert.equal(maskMarkedFields("text", fields), "text");
  assert.equal(maskMarkedFields(null, fields), null);
});

test("maskMarkedFields changes nothing when the endpoint marks no field or has none", () => {
  const body = { data: { id: "1", name: "n" } };
  assert.deepEqual(maskMarkedFields(body, [plain("id"), plain("name")]), body);
  assert.equal(maskMarkedFields(body, []), body);
  assert.equal(maskMarkedFields(body, undefined), body);
});

test("withLogging masks the marked fields of the endpoint in the written log and keeps an unmarked field of the same name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  setLogBodiesEnabled(true);
  try {
    const c = captured();
    const fields = [plain("id"), plain("name"), plain("owner", { type: "object", properties: [plain("id"), marked("name")] })];
    await withLogging(c.logger, () => 0)(async () => res({ data: { id: "1", name: "Widget", owner: { id: "7", name: "Ada" } } }))(req({ responseFields: fields }));
    log(c.entries[0]);
    const parsed = JSON.parse(readFileSync(join(dir, "deel.log"), "utf8").trim().split("\n").pop()!);
    assert.deepEqual(parsed.response, { data: { id: "1", name: "Widget", owner: { id: "7", name: "***" } } });
  } finally {
    setLogBodiesEnabled(false);
    delete process.env.DEEL_LOG_DIR;
  }
});

test("withLogging logs the body as it is when the request carries no response fields, apart from the credential names", async () => {
  setLogBodiesEnabled(true);
  try {
    const c = captured();
    await withLogging(c.logger, () => 0)(async () => res({ data: { id: "1", name: "Widget" } }))(req());
    assert.deepEqual(c.entries[0].response, { data: { id: "1", name: "Widget" } });
  } finally {
    setLogBodiesEnabled(false);
  }
});

test("the log masks credentials and sign-in links by name, in every spelling, and decides nothing else by name", () => {
  const sensitive = [
    "access_token", "refresh_token", "client_secret", "password", "passcode", "otp", "mfa", "api_key", "apiKey", "private_key", "session_id", "cookie",
    "jwt", "magic_link", "download_link", "upload_url", "pdf_url", "signing_key", "authorization", "cvv", "cvc",
  ];
  for (const key of sensitive) assert.equal(isSensitiveKey(key), true, key);
  const ordinary = [
    "id", "name", "first_name", "company_name", "status", "type", "title", "description", "created_at", "start_date", "is_active", "country", "city",
    "currency", "amount", "rate", "unit", "count", "contract_id", "organization_id", "payment_cycle_id", "page", "limit", "cursor",
    "email", "phone_number", "tax_id", "iban", "salary", "date_of_birth", "home_address",
  ];
  for (const key of ordinary) assert.equal(isSensitiveKey(key), false, key);
  // Short names match as whole words, so they don't hide ordinary words that contain them.
  for (const key of ["company", "panel", "planning", "setting", "single", "tiny", "ipsum", "passenger", "compass"]) assert.equal(isSensitiveKey(key), false, key);
});

test("an email or a JWT is masked wherever it sits, in a URL query value or a body string, whatever its key", () => {
  assert.equal(maskUrlQuery("https://api.example.test/rest/people?q=ana@example.com&limit=5"), "https://api.example.test/rest/people?q=***&limit=5");
  assert.equal(maskUrlQuery("https://api.example.test/rest/people?search=ana%40example.com&filter=a%2Bb%40example.org"), "https://api.example.test/rest/people?search=***&filter=***");
  assert.equal(maskUrlQuery("https://api.example.test/x?next=https%3A%2F%2Fa.test%2Fp%3Fe%3Dana%40example.com"), "https://api.example.test/x?next=https%3A%2F%2Fa.test%2Fp%3Fe%3D***");
  assert.equal(maskUrlQuery("https://api.example.test/x?note=see+eyJhbGciOi.eyJzdWIiOi.c2ln+now"), "https://api.example.test/x?note=see%20***%20now");
  // Ordinary values, and a bare @ that is no address, stay readable.
  assert.equal(maskUrlQuery("https://api.example.test/x?q=widgets&at=@home&status=open"), "https://api.example.test/x?q=widgets&at=@home&status=open");
  assert.equal(looksPersonal("ana@example.com"), true);
  assert.equal(looksPersonal("plain text"), false);
});

test("a body string that holds an email or a JWT is masked even under an ordinary key", () => {
  const dir = mkdtempSync(join(tmpdir(), "deel-log-"));
  process.env.DEEL_LOG_DIR = dir;
  setLoggingEnabled(true);
  log({ kind: "request", response: { note: "ask ana@example.com about it", title: "Quarterly review", items: [{ memo: "token eyJhbGciOi.eyJzdWIiOi.c2ln" }, { memo: "plain" }] } });
  const parsed = JSON.parse(readFileSync(join(dir, "deel.log"), "utf8").trim().split("\n").pop()!);
  assert.equal(parsed.response.note, "ask *** about it");
  assert.equal(parsed.response.title, "Quarterly review");
  assert.deepEqual(parsed.response.items, [{ memo: "token ***" }, { memo: "plain" }]);
  delete process.env.DEEL_LOG_DIR;
});

// A backtracking scan would never return on 1e6 characters, and a synchronous test can't be interrupted by the
// runner's timeout, so the scan runs in a child process that is killed after a minute.
test("masking personal text is linear: long unspaced runs of email- and JWT-like text finish", () => {
  const script = `
    import { isLinkKey, isSensitiveKey, keyWords, looksPersonal, maskUrlQuery } from ${JSON.stringify(new URL("../src/core/logging.ts", import.meta.url).href)};
    const n = 1_000_000;
    for (const shape of ["a", "a@", "a@a.", "@@@@", ".....", "a@a.a.a.a.", "eyJ.eyJ.", "eyJa.b.", "a.@", "==&&??//", " a@ "]) {
      const text = shape.repeat(Math.ceil(n / shape.length));
      looksPersonal(text);
      if (typeof maskUrlQuery("https://x/y?q=" + text + "&k=" + text.slice(0, 1000)) !== "string") process.exit(2);
    }
    const key = "a_".repeat(500_000);
    isSensitiveKey(key); isLinkKey(key); keyWords(key);
    console.log("done");
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
  assert.equal(run.signal, null, "the scan did not finish within a minute");
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), "done");
});

test("an email or a JWT is found as a token, with its edges, and nothing else is", () => {
  const cases: Array<[string, boolean]> = [
    ["ana@example.com", true],
    ["Ana.Lopez+tag@mail.example.co.uk", true],
    ["ana@example", false],
    ["@example.com", false],
    ["ana@.com", false],
    ["ana@example.", false],
    ["ana@a..b", false],
    ["a@b.c", true],
    ["eyJhbGciOi.eyJzdWIiOi.c2ln", true],
    ["eyJhbGciOi.eyJzdWIiOi.", true],
    ["eyJhbGciOi.eyJzdWIiOi", false],
    ["eyJhbGciOi.e yJ.x", false],
    ["notajwt.eyJa.b", false],
    ["plain text with a.dot and 5 @ signs", false],
  ];
  for (const [text, personal] of cases) assert.equal(looksPersonal(text), personal, text);
  assert.equal(maskUrlQuery("https://x/y?q=<ana@example.com>,bob@example.org;ok"), "https://x/y?q=%3C***%3E%2C***%3Bok");
});

test("every needle of SENSITIVE_LOG_KEYS is masked in every spelling of a key: snake, camel, Pascal, kebab, UPPER_SNAKE, dotted, run together", () => {
  const missed: string[] = [];
  for (const needle of SENSITIVE_LOG_KEYS) {
    const words = needle.split("_");
    const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
    const spellings = [
      needle,
      words[0] + words.slice(1).map(capital).join(""),
      words.map(capital).join(""),
      words.join("-"),
      words.join("_").toUpperCase(),
      words.join("."),
      words.join(""),
      `user_${needle}`,
      `user${words.map(capital).join("")}`,
      `${needle}_value`,
    ];
    for (const spelling of spellings) if (!isSensitiveKey(spelling)) missed.push(`${needle} -> ${spelling}`);
  }
  assert.deepEqual(missed, []);
  for (const key of ["accessToken", "client-secret", "privateKey", "SigningKey", "x-api-key", "downloadLink"]) assert.equal(isSensitiveKey(key), true, key);
  for (const key of ["id", "name", "status", "created_at", "company_id", "contractId", "workerType", "planning", "setting"]) assert.equal(isSensitiveKey(key), false, key);
});
