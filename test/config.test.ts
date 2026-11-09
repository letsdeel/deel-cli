import { test } from "node:test";
import assert from "node:assert/strict";
import { apiBaseUrl, resolveConfig, ENVIRONMENTS } from "../src/core/config.ts";
import { configFrom } from "../src/commands/shared.ts";

test("defaults to prod", () => {
  const config = resolveConfig({});
  assert.equal(config.env, "prod");
  assert.equal(config.baseUrl, ENVIRONMENTS.prod);
});

test("--env selects a known environment", () => {
  assert.equal(resolveConfig({ env: "demo" }).baseUrl, ENVIRONMENTS.demo);
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
    assert.equal(resolveConfig({}).baseUrl, ENVIRONMENTS.demo);
  } finally {
    if (prev === undefined) delete process.env.DEEL_ENV;
    else process.env.DEEL_ENV = prev;
  }
});

test("--beta sets config.beta, and it is unset otherwise", () => {
  assert.equal(resolveConfig({ beta: true }).beta, true);
  assert.equal(resolveConfig({}).beta, undefined);
  assert.equal(resolveConfig({ beta: false }).beta, undefined);
});

test("configFrom wires the --beta flag into the config", () => {
  assert.equal(configFrom({ beta: true }, []).beta, true);
  assert.equal(configFrom({}, []).beta, undefined);
});

test("SCIM commands call the sibling /scim base path", () => {
  assert.equal(apiBaseUrl(ENVIRONMENTS.prod, "scim"), "https://api.letsdeel.com/scim");
  assert.equal(apiBaseUrl(ENVIRONMENTS.demo, "scim"), "https://api-staging.letsdeel.com/scim");
  assert.equal(apiBaseUrl("https://localhost:8787", "scim"), "https://localhost:8787/scim");
});

test("REST and hand-picked commands keep the configured base path", () => {
  assert.equal(apiBaseUrl(ENVIRONMENTS.prod, "rest"), ENVIRONMENTS.prod);
  assert.equal(apiBaseUrl(ENVIRONMENTS.prod, undefined), ENVIRONMENTS.prod);
});
