import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, ENVIRONMENTS } from "../src/core/config.ts";

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
