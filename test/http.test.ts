import { test } from "node:test";
import assert from "node:assert/strict";
import { withAuth, withVersion, withRequestId, withRetry } from "../src/core/http.ts";
import type { HttpRequest, HttpResponse, Transport } from "../src/core/http.ts";

const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({ method: "GET", url: "https://x", headers: {}, ...over });
const res = (status: number, headers: Record<string, string> = {}): HttpResponse => ({ status, headers, text: "", json: {} });

function capturing(response: HttpResponse = res(200)): { next: Transport; seen: HttpRequest[] } {
  const seen: HttpRequest[] = [];
  return { seen, next: async (request) => (seen.push(request), response) };
}

test("withAuth adds a bearer header, without overriding an existing one", async () => {
  const a = capturing();
  await withAuth("tok")(a.next)(req());
  assert.equal(a.seen[0].headers["authorization"], "Bearer tok");

  const b = capturing();
  await withAuth("tok")(b.next)(req({ headers: { authorization: "Bearer preset" } }));
  assert.equal(b.seen[0].headers["authorization"], "Bearer preset");
});

test("withAuth adds nothing when there is no token", async () => {
  const a = capturing();
  await withAuth(null)(a.next)(req());
  assert.equal(a.seen[0].headers["authorization"], undefined);
});

test("withAuth refuses to send a token over a non-https URL", async () => {
  const a = capturing();
  await assert.rejects(async () => {
    await withAuth("tok")(a.next)(req({ url: "http://x" }));
  }, /non-https/);
  assert.equal(a.seen.length, 0);
});

test("withVersion and withRequestId inject their headers", async () => {
  const v = capturing();
  await withVersion("1.2.3")(v.next)(req());
  assert.equal(v.seen[0].headers["x-deel-cli-version"], "1.2.3");

  const r = capturing();
  await withRequestId(() => "fixed-id")(r.next)(req());
  assert.equal(r.seen[0].headers["x-request-id"], "fixed-id");
});

test("withRetry retries a retryable 5xx then succeeds", async () => {
  let call = 0;
  const next: Transport = async () => (++call === 1 ? res(503) : res(200));
  const response = await withRetry(3)(next)(req({ retryable: true }));
  assert.equal(response.status, 200);
  assert.equal(call, 2);
});

test("withRetry honors Retry-After and retries a 429", async () => {
  let call = 0;
  const next: Transport = async () => (++call === 1 ? res(429, { "retry-after": "0" }) : res(200));
  const response = await withRetry(3)(next)(req({ retryable: true }));
  assert.equal(response.status, 200);
  assert.equal(call, 2);
});

test("withRetry does not retry a non-retryable request", async () => {
  let call = 0;
  const next: Transport = async () => (call++, res(503));
  const response = await withRetry(3)(next)(req({ retryable: false }));
  assert.equal(response.status, 503);
  assert.equal(call, 1);
});
