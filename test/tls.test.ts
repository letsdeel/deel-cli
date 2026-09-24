import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCertConfig, isCertError, installCaTrust } from "../src/core/tls.ts";

test("resolveCertConfig collects --ca-cert (repeatable) + DEEL_CA_CERT; system on by default", () => {
  assert.deepEqual(
    resolveCertConfig(["--ca-cert", "/a.pem", "--ca-cert=/b.pem", "ats", "candidates", "list"], {} as NodeJS.ProcessEnv),
    { caCertPaths: ["/a.pem", "/b.pem"], includeSystem: true },
  );
  assert.deepEqual(resolveCertConfig([], { DEEL_CA_CERT: "/z.pem" } as NodeJS.ProcessEnv), { caCertPaths: ["/z.pem"], includeSystem: true });
});

test("DEEL_CERT_STORE controls whether the OS store is included", () => {
  assert.equal(resolveCertConfig([], { DEEL_CERT_STORE: "bundled" } as NodeJS.ProcessEnv).includeSystem, false);
  assert.equal(resolveCertConfig([], { DEEL_CERT_STORE: "bundled,system" } as NodeJS.ProcessEnv).includeSystem, true);
});

test("isCertError recognizes chain failures, not other network errors", () => {
  assert.equal(isCertError({ cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }), true);
  assert.equal(isCertError({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }), true);
  assert.equal(isCertError({ message: "unable to verify the first certificate" }), true);
  assert.equal(isCertError({ code: "ECONNREFUSED" }), false);
  assert.equal(isCertError({ message: "socket hang up" }), false);
});

test("installCaTrust runs without throwing (merges OS store into the default CA)", () => {
  assert.doesNotThrow(() => installCaTrust([], {} as NodeJS.ProcessEnv));
});
