import { test } from "node:test";
import assert from "node:assert/strict";
import { newIdempotencyKey } from "../src/core/idempotency.ts";
import { createContext } from "../src/core/context.ts";
import { captureIO } from "../src/core/io.ts";
import type { Config } from "../src/core/config.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("newIdempotencyKey returns a random v4 UUID, a new one on every call", () => {
  const a = newIdempotencyKey();
  const b = newIdempotencyKey();
  assert.match(a, UUID_V4);
  assert.match(b, UUID_V4);
  assert.notEqual(a, b);
});

test("the context generates random keys by default and takes an injected generator", () => {
  const base = { config: { env: "demo", baseUrl: "https://example.test/rest", issuer: null, clientId: "test-client", oauthBaseUrlOk: false } as Config, token: null, io: captureIO({}), logger: () => {} };
  const ctx = createContext(base);
  assert.match(ctx.newIdempotencyKey(), UUID_V4);
  assert.notEqual(ctx.newIdempotencyKey(), ctx.newIdempotencyKey());
  assert.equal(createContext({ ...base, idempotencyKey: () => "fixed-key" }).newIdempotencyKey(), "fixed-key");
});
