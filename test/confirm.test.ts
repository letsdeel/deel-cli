import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmDescriptor, isStdinInUse, resolveStdinInUse, run } from "../src/cli.ts";
import { confirmMessage } from "../src/core/executor.ts";
import { captureIO } from "../src/core/io.ts";
import { CliError } from "../src/core/errors.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import type { Descriptor } from "../src/types.ts";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const DISABLE_MESSAGE = "Disable app {app_id}? This revokes all consents and tokens; enable does not restore them.";

const descriptors = await loadGeneratedDescriptors();
const find = (method: string, path: string): Descriptor => descriptors.find((d) => d.method === method && d.path === path)!;
const disable = find("POST", "/oauth2-apps/{app_id}/disable");
const enable = find("POST", "/oauth2-apps/{app_id}/enable");

const terminal = () => captureIO({ isTTY: true });
const noTerminal = () => captureIO({ isTTY: false });

test("only the oauth2-apps disable endpoint asks before sending", () => {
  assert.equal(confirmMessage(disable), DISABLE_MESSAGE);
  assert.equal(confirmMessage(enable), undefined);
  assert.equal(confirmMessage(find("GET", "/oauth2-apps")), undefined);
});

test("confirmDescriptor fills {param} placeholders from the flags and asks [y/N]", async () => {
  const questions: string[] = [];
  await confirmDescriptor(disable, { app_id: APP_ID }, false, terminal(), async (q) => (questions.push(q), true));
  assert.deepEqual(questions, [`Disable app ${APP_ID}? This revokes all consents and tokens; enable does not restore them. [y/N] `]);
});

test("confirmDescriptor leaves a placeholder it has no value for", async () => {
  const questions: string[] = [];
  await confirmDescriptor(disable, {}, false, terminal(), async (q) => (questions.push(q), true));
  assert.match(questions[0], /^Disable app \{app_id\}\?/);
});

test("confirmDescriptor proceeds on yes in a terminal and aborts on no", async () => {
  await confirmDescriptor(disable, { app_id: APP_ID }, false, terminal(), async () => true);
  await assert.rejects(
    () => confirmDescriptor(disable, { app_id: APP_ID }, false, terminal(), async () => false),
    (err: CliError) => err.code === "oauth2-apps.aborted",
  );
});

test("confirmDescriptor with --yes never prompts, even without a terminal", async () => {
  const ask = async () => assert.fail("must not prompt");
  await confirmDescriptor(disable, {}, true, terminal(), ask);
  await confirmDescriptor(disable, {}, true, noTerminal(), ask);
});

test("confirmDescriptor without a terminal and without --yes is a usage error that never prompts", async () => {
  await assert.rejects(
    () => confirmDescriptor(disable, {}, false, noTerminal(), async () => assert.fail("must not prompt")),
    (err: CliError) => err.code === "usage.confirm" && /Pass --yes to run this non-interactively/.test(err.next ?? "") && /oauth2-apps update <app_id> --status disabled/.test(err.message),
  );
});

test("confirmDescriptor leaves commands that ask nothing alone", async () => {
  await confirmDescriptor(enable, {}, false, noTerminal(), async () => assert.fail("must not prompt"));
});

test("confirmDescriptor refuses when stdin is in use, even in a terminal", async () => {
  await assert.rejects(
    () => confirmDescriptor(disable, { app_id: APP_ID }, false, terminal(), async () => assert.fail("must not prompt"), true),
    (err: CliError) => err.code === "usage.confirm" && /stdin carries the token or the input/.test(err.next ?? ""),
  );
});

test("isStdinInUse is true for --input -, --token-stdin and a piped stdin, and false for a terminal", () => {
  assert.equal(isStdinInUse({ input: "-" }, true), true);
  assert.equal(isStdinInUse({ "token-stdin": true }, true), true);
  assert.equal(isStdinInUse({}, false), true);
  assert.equal(isStdinInUse({ input: "name=x" }, true), false);
  assert.equal(isStdinInUse({}, true), false);
});

test("resolveStdinInUse asks the terminal only when a prompt could be needed", () => {
  const asked = (descriptor: Descriptor, args: Parameters<typeof resolveStdinInUse>[1]) => {
    let calls = 0;
    resolveStdinInUse(descriptor, args, () => (calls++, true));
    return calls;
  };
  assert.equal(asked(enable, {}), 0);
  assert.equal(asked(disable, { yes: true }), 0);
  assert.equal(asked(disable, {}), 1);
});

test("resolveStdinInUse combines --token-stdin, --input - and the terminal for a confirming command", () => {
  const cases: Array<[Parameters<typeof resolveStdinInUse>[1], boolean, boolean]> = [
    [{ "token-stdin": true }, true, true],
    [{ input: "-" }, true, true],
    [{ input: "name=x" }, true, false],
    [{}, true, false],
    [{}, false, true],
  ];
  for (const [args, tty, expected] of cases) assert.equal(resolveStdinInUse(disable, args, () => tty), expected, JSON.stringify({ args, tty }));
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

test("deel oauth2-apps update --status disabled without --yes and without a terminal sends nothing", async () => {
  const { requests, error } = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--beta"]);
  assert.equal(error?.code, "usage.confirm");
  assert.equal(requests.length, 0);
});

test("deel oauth2-apps update --status disabled --yes sends the request without prompting", async () => {
  const { requests, error, out } = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--yes", "--beta"]);
  assert.equal(error, undefined);
  assert.deepEqual(requests.map((r) => `${r.method} ${new URL(r.url).pathname}`), [`POST /rest/oauth2-apps/${APP_ID}/disable`]);
  assert.match(out, /api_access/);
});

test("deel oauth2-apps update --status enabled needs no confirmation and takes no --yes", async () => {
  const plain = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "enabled", "--beta"]);
  assert.equal(plain.error, undefined);
  assert.equal(plain.requests.length, 1);
  const withYes = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "enabled", "--yes", "--beta"]);
  assert.equal(withYes.error?.code, "usage.flag");
  assert.equal(withYes.requests.length, 0);
});

test("--token-stdin on the confirming command refuses before reading the token or sending anything", async () => {
  const { requests, error } = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--token-stdin", "--beta"]);
  assert.equal(error?.code, "usage.confirm");
  assert.match(error?.next ?? "", /stdin carries the token or the input/);
  assert.equal(requests.length, 0);
});

async function helpOf(argv: string[]): Promise<string> {
  const out: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    await run(argv);
  } finally {
    process.stdout.write = original;
  }
  return out.join("");
}

test("--help for the confirming endpoint lists --yes in the usage line, the options and the JSON contract", async () => {
  const human = await helpOf(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--help"]);
  assert.match(human, /USAGE  deel oauth2-apps update <app_id> --status disabled \[GLOBAL OPTIONS\] \[--yes\]/);
  assert.match(human, /--yes   Skip the confirmation prompt/);
  const json = JSON.parse(await helpOf(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--help", "--json"]));
  assert.deepEqual(json.confirm, { message: DISABLE_MESSAGE, flag: "yes", requiredWhenNonInteractive: true, requiredWhenStdinInUse: true });
  assert.doesNotMatch(await helpOf(["oauth2-apps", "update", APP_ID, "--status", "enabled", "--help"]), /--yes/);
});
