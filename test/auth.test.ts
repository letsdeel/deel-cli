import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveToken, requireToken, maskToken, redactHeaders } from "../src/core/auth.ts";
import type { CredentialStore } from "../src/core/keychain.ts";

const fakeStore = (token: string | null): CredentialStore => ({
  available: () => true,
  get: () => token,
  set: () => true,
  remove: () => true,
});

function withEnv(vars: Record<string, string | undefined>, body: () => void) {
  const keys = ["DEEL_TOKEN"];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) saved[key] = process.env[key];
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) process.env[key] = value;
  try {
    body();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("maskToken keeps only the last four characters", () => {
  assert.equal(maskToken("pat_ABCD1234"), "****1234");
  assert.equal(maskToken("abcd"), "****");
});

test("redactHeaders masks Authorization case-insensitively", () => {
  assert.deepEqual(redactHeaders({ Authorization: "Bearer secret", accept: "application/json" }), {
    Authorization: "Bearer ***",
    accept: "application/json",
  });
});

test("resolveToken reads DEEL_TOKEN from the environment", () => {
  withEnv({ DEEL_TOKEN: "tok_env" }, () => {
    assert.deepEqual(resolveToken({}), { token: "tok_env", source: "env" });
  });
});

test("resolveToken trims the environment token", () => {
  withEnv({ DEEL_TOKEN: "  tok_env  " }, () => {
    assert.equal(resolveToken({}).token, "tok_env");
  });
});

test("resolveToken falls back to the keychain when stdin/env are absent", () => {
  withEnv({}, () => {
    assert.deepEqual(resolveToken({ env: "prod", store: fakeStore("tok_kc") }), { token: "tok_kc", source: "keychain" });
  });
});

test("DEEL_TOKEN takes precedence over the keychain", () => {
  withEnv({ DEEL_TOKEN: "tok_env" }, () => {
    assert.equal(resolveToken({ env: "prod", store: fakeStore("tok_kc") }).source, "env");
  });
});

test("resolveToken reports none when nothing is stored", () => {
  withEnv({}, () => {
    assert.deepEqual(resolveToken({ env: "prod", store: fakeStore(null) }), { token: null, source: "none" });
  });
});

test("requireToken throws a helpful auth error when absent", () => {
  assert.throws(() => requireToken({ token: null, source: "none" }), /No API token found/);
  assert.equal(requireToken({ token: "t", source: "env" }), "t");
});
