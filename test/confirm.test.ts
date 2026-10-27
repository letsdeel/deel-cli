import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmDescriptor, run } from "../src/cli.ts";
import { captureIO } from "../src/core/io.ts";
import { CliError } from "../src/core/errors.ts";
import { manifest } from "../src/manifest.generated.ts";
import type { Descriptor } from "../src/types.ts";

const APP_ID = "11111111-2222-3333-4444-555555555555";

const withConfirm: Descriptor = {
  command: ["things", "drop"],
  method: "POST",
  path: "/things/{thing_id}/drop",
  confirm: "Drop {thing_id} for {missing}?",
  async: false,
  bodyKind: "none",
  supportsMultipart: false,
  bodyWrapper: "none",
  params: [],
  bodyProps: [],
  fileFields: [],
  responseKind: "object",
  responseFields: [],
};
const withoutConfirm: Descriptor = { ...withConfirm, confirm: undefined };

const terminal = () => captureIO({ isTTY: true });
const noTerminal = () => captureIO({ isTTY: false });

test("confirmDescriptor fills {param} placeholders from the flags and asks [y/N]", async () => {
  const questions: string[] = [];
  await confirmDescriptor(withConfirm, { thing_id: "t1" }, false, terminal(), async (q) => (questions.push(q), true));
  assert.deepEqual(questions, ["Drop t1 for {missing}? [y/N] "]);
});

test("confirmDescriptor proceeds on yes in a terminal", async () => {
  await confirmDescriptor(withConfirm, { thing_id: "t1" }, false, terminal(), async () => true);
});

test("confirmDescriptor aborts on no in a terminal", async () => {
  await assert.rejects(
    () => confirmDescriptor(withConfirm, { thing_id: "t1" }, false, terminal(), async () => false),
    (err: CliError) => err.code === "things.aborted",
  );
});

test("confirmDescriptor with --yes never prompts, even without a terminal", async () => {
  const ask = async () => assert.fail("must not prompt");
  await confirmDescriptor(withConfirm, {}, true, terminal(), ask);
  await confirmDescriptor(withConfirm, {}, true, noTerminal(), ask);
});

test("confirmDescriptor without a terminal and without --yes is a usage error that never prompts", async () => {
  await assert.rejects(
    () => confirmDescriptor(withConfirm, {}, false, noTerminal(), async () => assert.fail("must not prompt")),
    (err: CliError) => err.code === "usage.confirm" && /Pass --yes to run this non-interactively/.test(err.next ?? ""),
  );
});

test("confirmDescriptor in a terminal refuses without --yes when stdin carries the token or the input, and never prompts", async () => {
  await assert.rejects(
    () => confirmDescriptor(withConfirm, {}, false, terminal(), async () => assert.fail("must not prompt"), true),
    (err: CliError) => err.code === "usage.confirm" && /Pass --yes: stdin carries the token or the input/.test(err.next ?? ""),
  );
});

test("confirmDescriptor with --yes proceeds when stdin carries the token or the input", async () => {
  await confirmDescriptor(withConfirm, {}, true, terminal(), async () => assert.fail("must not prompt"), true);
});

test("confirmDescriptor leaves commands without confirm alone", async () => {
  await confirmDescriptor(withoutConfirm, {}, false, noTerminal(), async () => assert.fail("must not prompt"));
});

// End to end through run(): the test process has no TTY, so the run is non-interactive.
async function runWithFetch(argv: string[]): Promise<{ requests: { method: string; url: string }[]; error?: CliError; out: string }> {
  const requests: { method: string; url: string }[] = [];
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  const originalToken = process.env.DEEL_TOKEN;
  const out: string[] = [];
  process.env.DEEL_TOKEN = "tok_TEST";
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ method: String(init.method), url: String(url) });
    return new Response(JSON.stringify({ data: { id: APP_ID, api_access: "disabled" } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await run(argv);
    return { requests, out: out.join("") };
  } catch (err) {
    return { requests, error: err as CliError, out: out.join("") };
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
    if (originalToken === undefined) delete process.env.DEEL_TOKEN;
    else process.env.DEEL_TOKEN = originalToken;
  }
}

test("deel apps disable without --yes and without a terminal sends nothing", async () => {
  const { requests, error } = await runWithFetch(["apps", "disable", "--app_id", APP_ID]);
  assert.equal(error?.code, "usage.confirm");
  assert.equal(requests.length, 0);
});

test("deel apps disable --yes sends the request without prompting", async () => {
  const { requests, error, out } = await runWithFetch(["apps", "disable", "--app_id", APP_ID, "--yes"]);
  assert.equal(error, undefined);
  assert.deepEqual(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`), [`POST /rest/apps/${APP_ID}/disable`]);
  assert.match(out, /api_access/);
});

test("deel apps enable needs no confirmation", async () => {
  const { requests, error } = await runWithFetch(["apps", "enable", "--app_id", APP_ID]);
  assert.equal(error, undefined);
  assert.equal(requests.length, 1);
});

test("the apps disable confirm text names the app and warns about revoked consents and tokens", () => {
  const disable = manifest.descriptors.find((d) => d.command.join(" ") === "apps disable");
  assert.equal(disable?.confirm, "Disable app {app_id}? This revokes all consents and tokens; enable does not restore them.");
});
