import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, ENVIRONMENTS } from "../src/core/config.ts";

test("defaults to prod", () => {
  const config = resolveConfig({});
  assert.equal(config.env, "prod");
  assert.equal(config.baseUrl, ENVIRONMENTS.prod.baseUrl);
});

test("--env selects a known environment", () => {
  assert.equal(resolveConfig({ env: "demo" }).baseUrl, ENVIRONMENTS.demo.baseUrl);
});

test("--base-url overrides --env and strips a trailing slash", () => {
  const config = resolveConfig({ env: "demo", baseUrl: "https://localhost:8787/rest/" });
  assert.equal(config.baseUrl, "https://localhost:8787/rest");
});

test("a non-https --base-url is rejected (token must never travel over http)", () => {
  assert.throws(() => resolveConfig({ baseUrl: "http://localhost:8787/rest" }), /must use https/);
});

test("an unknown --env is a usage error", () => {
  assert.throws(() => resolveConfig({ env: "nope" }), /Unknown --env/);
});

test("DEEL_ENV is honored when no --env is passed", () => {
  const prev = process.env.DEEL_ENV;
  process.env.DEEL_ENV = "demo";
  try {
    assert.equal(resolveConfig({}).baseUrl, ENVIRONMENTS.demo.baseUrl);
  } finally {
    if (prev === undefined) delete process.env.DEEL_ENV;
    else process.env.DEEL_ENV = prev;
  }
});

function withEnvVars(vars: Record<string, string | undefined>, body: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("each environment carries its OAuth issuer and the CLI client id", () => {
  withEnvVars({ DEEL_OAUTH_ISSUER: undefined, DEEL_OAUTH_CLIENT_ID: undefined }, () => {
    const prod = resolveConfig({});
    assert.equal(prod.issuer, "https://api.letsdeel.com");
    assert.equal(prod.clientId, "b035545c-ee8a-4884-a51f-e416447e6d62");
    assert.equal(prod.oauthBaseUrlOk, true);
    assert.equal(resolveConfig({ env: "demo" }).issuer, "https://api-staging.letsdeel.com");
  });
});

test("DEEL_OAUTH_ISSUER and DEEL_OAUTH_CLIENT_ID override the defaults", () => {
  withEnvVars({ DEEL_OAUTH_ISSUER: "https://idp.example.test/", DEEL_OAUTH_CLIENT_ID: "client-x" }, () => {
    const config = resolveConfig({});
    assert.equal(config.issuer, "https://idp.example.test");
    assert.equal(config.clientId, "client-x");
  });
});

test("DEEL_OAUTH_ISSUER must be https", () => {
  withEnvVars({ DEEL_OAUTH_ISSUER: "http://idp.example.test" }, () => {
    assert.throws(() => resolveConfig({}), /must be an https URL/);
  });
});

test("OAuth tokens are only allowed towards the environment's own host", () => {
  withEnvVars({ DEEL_OAUTH_ISSUER: undefined, DEEL_OAUTH_CLIENT_ID: undefined }, () => {
    assert.equal(resolveConfig({ baseUrl: "https://api.letsdeel.com/rest/v2" }).oauthBaseUrlOk, true);
    assert.equal(resolveConfig({ baseUrl: "https://other.example.test/rest" }).oauthBaseUrlOk, false);
  });
});

test("an overridden issuer makes its own host an allowed API host", () => {
  withEnvVars({ DEEL_OAUTH_ISSUER: "https://dev.example.test" }, () => {
    assert.equal(resolveConfig({ env: "nope", baseUrl: "https://dev.example.test/rest" }).oauthBaseUrlOk, true);
    assert.equal(resolveConfig({ env: "nope", baseUrl: "https://other.example.test/rest" }).oauthBaseUrlOk, false);
  });
});

test("an unknown environment reached through --base-url has no issuer", () => {
  withEnvVars({ DEEL_OAUTH_ISSUER: undefined }, () => {
    const config = resolveConfig({ env: "nope", baseUrl: "https://x.example.test/rest" });
    assert.equal(config.issuer, null);
    assert.equal(config.oauthBaseUrlOk, false);
  });
});
