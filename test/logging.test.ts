import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLogging } from "../src/core/http.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";
import { log, setLoggingEnabled, setLogBodiesEnabled } from "../src/core/logging.ts";

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
