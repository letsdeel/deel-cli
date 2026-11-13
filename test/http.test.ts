import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchTransport, withAuth, withVersion, withRequestId, withRetry, withBeta } from "../src/core/http.ts";
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

test("an error that names the request URL masks its credential query values", async () => {
  const a = capturing();
  await assert.rejects(
    () => withAuth("tok")(a.next)(req({ url: "http://x/people?api_key=k123&access_token=t&page=2" })),
    (error: Error) => /non-https URL: http:\/\/x\/people\?api_key=\*\*\*&access_token=\*\*\*&page=2$/.test(error.message),
  );
  assert.equal(a.seen.length, 0);
});

test("a timeout and a TLS failure name the request URL with its sensitive query values masked", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const url = "https://x/people?email=a%40b.co&page=2";
  const fail = (error: Error) => {
    globalThis.fetch = (async () => {
      throw error;
    }) as typeof fetch;
  };
  fail(Object.assign(new Error("aborted"), { name: "AbortError" }));
  await assert.rejects(() => fetchTransport(req({ url })), (error: Error) => error.message === "Request timed out: GET https://x/people?email=***&page=2");
  fail(Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }));
  await assert.rejects(() => fetchTransport(req({ url })), (error: Error) => error.message === "TLS verification failed: https://x/people?email=***&page=2");
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

test("withAuth resolves an async token provider at send time", async () => {
  const a = capturing();
  let calls = 0;
  await withAuth(async () => (calls++, "fresh"))(a.next)(req());
  assert.equal(a.seen[0].headers["authorization"], "Bearer fresh");
  assert.equal(calls, 1);
});

test("withAuth does not call the provider when a credential is already set or the URL is not https", async () => {
  let calls = 0;
  const provider = async () => (calls++, "fresh");
  const a = capturing();
  await withAuth(provider)(a.next)(req({ headers: { authorization: "Bearer preset" } }));
  assert.equal(calls, 0);
  await assert.rejects(async () => {
    await withAuth(provider)(a.next)(req({ url: "http://x" }));
  }, /non-https/);
  assert.equal(calls, 0);
});

test("withAuth sends no header when the provider has no token", async () => {
  const a = capturing();
  await withAuth(async () => null)(a.next)(req());
  assert.equal(a.seen[0].headers["authorization"], undefined);
});

test("a retry asks the token provider again and the caller's request is left untouched", async () => {
  const tokens = ["first", "second"];
  const seen: HttpRequest[] = [];
  const base: Transport = async (request) => (seen.push(request), seen.length === 1 ? res(503) : res(200));
  const request = req({ retryable: true });
  const response = await withRetry()(withAuth(async () => tokens.shift() as string)(base))(request);
  assert.equal(response.status, 200);
  assert.deepEqual(
    seen.map((sent) => sent.headers["authorization"]),
    ["Bearer first", "Bearer second"],
  );
  assert.equal(request.headers["authorization"], undefined);
});

test("withBeta sends X-Beta: true only when enabled", async () => {
  const on = capturing();
  await withBeta(true)(on.next)(req());
  assert.equal(on.seen[0].headers["x-beta"], "true");

  const off = capturing();
  await withBeta(undefined)(off.next)(req());
  assert.equal(off.seen[0].headers["x-beta"], undefined);
});
