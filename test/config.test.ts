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

function withBaseUrlEnv(value: string | undefined, fn: () => void) {
  const prev = process.env.DEEL_CLI_BASE_URL;
  if (value === undefined) delete process.env.DEEL_CLI_BASE_URL;
  else process.env.DEEL_CLI_BASE_URL = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.DEEL_CLI_BASE_URL;
    else process.env.DEEL_CLI_BASE_URL = prev;
  }
}

test("DEEL_CLI_BASE_URL is used when no --base-url is passed", () => {
  withBaseUrlEnv("https://example.test/rest", () => {
    assert.equal(resolveConfig({}).baseUrl, "https://example.test/rest");
  });
});

test("--base-url beats DEEL_CLI_BASE_URL", () => {
  withBaseUrlEnv("https://env.test/rest", () => {
    assert.equal(resolveConfig({ baseUrl: "https://flag.test/rest" }).baseUrl, "https://flag.test/rest");
  });
});

test("DEEL_CLI_BASE_URL beats --env", () => {
  withBaseUrlEnv("https://env.test/rest", () => {
    assert.equal(resolveConfig({ env: "demo" }).baseUrl, "https://env.test/rest");
  });
});

test("an empty DEEL_CLI_BASE_URL falls back to --env", () => {
  withBaseUrlEnv("", () => {
    assert.equal(resolveConfig({ env: "demo" }).baseUrl, ENVIRONMENTS.demo);
  });
});

test("DEEL_CLI_BASE_URL trailing slash is stripped", () => {
  withBaseUrlEnv("https://env.test/rest/", () => {
    assert.equal(resolveConfig({}).baseUrl, "https://env.test/rest");
  });
});

test("an invalid DEEL_CLI_BASE_URL names the variable", () => {
  withBaseUrlEnv("not a url", () => {
    assert.throws(() => resolveConfig({}), /DEEL_CLI_BASE_URL/);
  });
});

test("a non-https DEEL_CLI_BASE_URL is rejected", () => {
  withBaseUrlEnv("http://localhost:8787/rest", () => {
    assert.throws(() => resolveConfig({}), /DEEL_CLI_BASE_URL must use https/);
  });
});
