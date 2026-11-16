import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli.ts";
import { fillPrompt, isStdinInUse, requireConfirmation, resolveStdinInUse, retiredFlagError } from "../src/core/confirm.ts";
import type { ConfirmationRequest } from "../src/core/confirm.ts";
import { captureIO } from "../src/core/io.ts";
import { CliError } from "../src/core/errors.ts";
import type { Confirm } from "../src/core/prompt.ts";
import { loadGeneratedDescriptors } from "../src/public-api/commands.ts";
import type { Descriptor } from "../src/types.ts";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const DISABLE_PROMPT = "Disable app {app_id}? This revokes all consents and tokens; enable does not restore them.";
const DELETE_PROMPT = "Delete webhook {id}? Deel stops sending its events, and the subscription cannot be restored.";
const INVALIDATE_PROMPT = "Invalidate token {token_id}? It stops working at once and cannot be restored.";

const descriptors = await loadGeneratedDescriptors();
const find = (method: string, path: string): Descriptor => descriptors.find((d) => d.method === method && d.path === path)!;
const enable = find("POST", "/oauth2-apps/{app_id}/enable");

const person = () => captureIO({ isTTY: true, canPrompt: true });
const nobody = () => captureIO({ isTTY: false, canPrompt: false });
const never: Confirm = async () => assert.fail("must not prompt");

const request = (overrides: Partial<ConfirmationRequest> = {}): ConfirmationRequest => ({
  name: "deel oauth2-apps update <app_id> --status disabled",
  group: "oauth2-apps",
  prompt: DISABLE_PROMPT,
  values: { app_id: APP_ID },
  confirmed: false,
  io: person(),
  ...overrides,
});

test("exactly the oauth2-apps disable, webhooks delete and token invalidate endpoints ask first, each with its own prompt", () => {
  assert.deepEqual(
    descriptors.filter((d) => d.confirmPrompt).map((d) => [`${d.method} ${d.path}`, d.confirmPrompt]).sort(),
    [
      ["DELETE /webhooks/{id}", DELETE_PROMPT],
      ["POST /api-tokens/{token_id}/invalidate", INVALIDATE_PROMPT],
      ["POST /oauth2-apps/{app_id}/disable", DISABLE_PROMPT],
    ],
  );
  assert.equal(enable.confirmPrompt, undefined);
});

test("a committed prompt names only path IDs of its endpoint, so the question always shows what it acts on", () => {
  for (const descriptor of descriptors.filter((d) => d.confirmPrompt)) {
    for (const [, name] of descriptor.confirmPrompt!.matchAll(/\{([^}]+)\}/g)) assert.ok(descriptor.path.includes(`{${name}}`), `${descriptor.path}: {${name}}`);
  }
});

test("fillPrompt fills {param} from the values given and leaves a placeholder it has no value for", () => {
  assert.equal(fillPrompt(DISABLE_PROMPT, { app_id: APP_ID }), `Disable app ${APP_ID}? This revokes all consents and tokens; enable does not restore them.`);
  assert.match(fillPrompt(DISABLE_PROMPT, {}), /^Disable app \{app_id\}\?/);
});

test("requireConfirmation asks the filled prompt with [y/N] and goes on only on yes", async () => {
  const questions: string[] = [];
  await requireConfirmation(request({ ask: async (q) => (questions.push(q), true) }));
  assert.deepEqual(questions, [`Disable app ${APP_ID}? This revokes all consents and tokens; enable does not restore them. [y/N] `]);
  await assert.rejects(
    () => requireConfirmation(request({ ask: async () => false })),
    (err: CliError) => err.code === "oauth2-apps.aborted" && /was not run/.test(err.message) && err.next === undefined,
  );
});

test("requireConfirmation aborts on a timeout and names --confirm", async () => {
  await assert.rejects(
    () => requireConfirmation(request({ ask: async () => "timeout" })),
    (err: CliError) => err.code === "oauth2-apps.aborted" && /No answer within 60s\. Pass --confirm/.test(err.next ?? ""),
  );
});

test("requireConfirmation with --confirm never prompts, with or without a terminal", async () => {
  await requireConfirmation(request({ confirmed: true, ask: never }));
  await requireConfirmation(request({ confirmed: true, io: nobody(), ask: never }));
  await requireConfirmation(request({ confirmed: true, stdinInUse: true, ask: never }));
});

test("requireConfirmation where nobody can answer is a usage error naming --confirm, without prompting", async () => {
  await assert.rejects(
    () => requireConfirmation(request({ io: nobody(), ask: never })),
    (err: CliError) => err.code === "usage.confirm" && /Pass --confirm to run this without a terminal, in CI or under an agent/.test(err.next ?? "") && /oauth2-apps update <app_id> --status disabled/.test(err.message),
  );
  await assert.rejects(
    () => requireConfirmation(request({ stdinInUse: true, ask: never })),
    (err: CliError) => err.code === "usage.confirm" && /Pass --confirm: stdin carries the token or the input/.test(err.next ?? ""),
  );
});

test("requireConfirmation leaves a command with no prompt alone, wherever it runs", async () => {
  await requireConfirmation(request({ prompt: undefined, io: nobody(), stdinInUse: true, ask: never }));
});

test("isStdinInUse is true for --input -, --token-stdin and a piped stdin, and false for a terminal", () => {
  assert.equal(isStdinInUse({ input: "-" }, true), true);
  assert.equal(isStdinInUse({ "token-stdin": true }, true), true);
  assert.equal(isStdinInUse({}, false), true);
  assert.equal(isStdinInUse({ input: "name=x" }, true), false);
  assert.equal(isStdinInUse({}, true), false);
});

test("resolveStdinInUse asks the terminal only when a prompt could be needed", () => {
  const asked = (prompt: string | undefined, args: Parameters<typeof resolveStdinInUse>[1]) => {
    let calls = 0;
    resolveStdinInUse(prompt, args, () => (calls++, true));
    return calls;
  };
  assert.equal(asked(undefined, {}), 0);
  assert.equal(asked(DISABLE_PROMPT, { confirm: true }), 0);
  assert.equal(asked(DISABLE_PROMPT, {}), 1);
  const cases: Array<[Parameters<typeof resolveStdinInUse>[1], boolean, boolean]> = [
    [{ "token-stdin": true }, true, true],
    [{ input: "-" }, true, true],
    [{ input: "name=x" }, true, false],
    [{}, true, false],
    [{}, false, true],
  ];
  for (const [args, tty, expected] of cases) assert.equal(resolveStdinInUse(DISABLE_PROMPT, args, () => tty), expected, JSON.stringify({ args, tty }));
});

test("retiredFlagError names --confirm for --yes in any spelling the parser reads, and nothing else", () => {
  for (const flag of ["--yes", "--no-yes"]) {
    const err = retiredFlagError(flag);
    assert.equal(err?.code, "usage.flag", flag);
    assert.match(err!.message, /was renamed to --confirm/);
  }
  for (const flag of [undefined, "--yess", "--confirm", "-y"]) assert.equal(retiredFlagError(flag), undefined, String(flag));
});

// End to end through run(): the test process has no TTY, so nobody can answer a prompt.
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

const sent = (requests: { method: string; url: string }[]) => requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);

for (const [label, argv, route] of [
  ["oauth2-apps update --status disabled", ["oauth2-apps", "update", APP_ID, "--status", "disabled", "--beta"], `POST /rest/oauth2-apps/${APP_ID}/disable`],
  ["webhooks delete", ["webhooks", "delete", "wh_1"], "DELETE /rest/webhooks/wh_1"],
  ["dev tokens revocations create", ["dev", "tokens", "revocations", "create", "tok_1", "--beta"], "POST /rest/api-tokens/tok_1/invalidate"],
] as const) {
  test(`deel ${label} without --confirm and without a terminal sends nothing; with --confirm it sends`, async () => {
    const refused = await runWithFetch([...argv]);
    assert.equal(refused.error?.code, "usage.confirm");
    assert.match(refused.error?.next ?? "", /--confirm/);
    assert.equal(refused.requests.length, 0);
    const confirmed = await runWithFetch([...argv, "--confirm"]);
    assert.equal(confirmed.error, undefined);
    assert.deepEqual(sent(confirmed.requests), [route]);
  });

  test(`deel ${label} --yes is refused with a hint naming --confirm, and sends nothing`, async () => {
    const { requests, error } = await runWithFetch([...argv, "--yes"]);
    assert.equal(error?.code, "usage.flag");
    assert.match(error?.message ?? "", /--yes was renamed to --confirm/);
    assert.equal(requests.length, 0);
  });
}

test("a command that asks nothing never prompts, and refuses --confirm as an unknown flag", async () => {
  const plain = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "enabled", "--beta"]);
  assert.equal(plain.error, undefined);
  assert.equal(plain.requests.length, 1);
  // A sibling of the same words asks first, so the error names the one that takes --confirm.
  const sibling = await runWithFetch(["oauth2-apps", "update", APP_ID, "--status", "enabled", "--confirm", "--beta"]);
  assert.equal(sibling.error?.code, "usage.flag");
  assert.match(sibling.error?.message ?? "", /has no flag --confirm; only 'deel oauth2-apps update <app_id> --status disabled' takes it/);
  assert.equal(sibling.requests.length, 0);
  const plainList = await runWithFetch(["webhooks", "list", "--confirm"]);
  assert.equal(plainList.error?.code, "usage.flag");
  assert.match(plainList.error?.message ?? "", /has no flag --confirm/);
  assert.equal(plainList.requests.length, 0);
});

test("--yes on a command that asks nothing is an unknown flag, not a hint to pass --confirm", async () => {
  const { requests, error } = await runWithFetch(["webhooks", "list", "--yes"]);
  assert.equal(error?.code, "usage.flag");
  assert.match(error?.message ?? "", /has no flag --yes/);
  assert.doesNotMatch(error?.message ?? "", /renamed/);
  assert.equal(requests.length, 0);
});

test("--token-stdin on a confirming command refuses before reading the token or sending anything", async () => {
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

test("--help for a confirming endpoint shows the question and --confirm, in the usage line, the options and the JSON contract", async () => {
  const human = await helpOf(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--help"]);
  assert.match(human, /USAGE  deel oauth2-apps update <app_id> --status disabled \[GLOBAL OPTIONS\] \[--confirm\]/);
  assert.match(human, /ASKS FIRST\n  Disable app \{app_id\}\? .* \[y\/N\]/);
  assert.match(human, /--confirm   Run without the confirmation prompt/);
  const json = JSON.parse(await helpOf(["oauth2-apps", "update", APP_ID, "--status", "disabled", "--help", "--json"]));
  assert.deepEqual(json.confirmPrompt, { message: DISABLE_PROMPT, flag: "confirm", requiredWhenNonInteractive: true, requiredWhenStdinInUse: true });
  const other = await helpOf(["oauth2-apps", "update", APP_ID, "--status", "enabled", "--help"]);
  assert.doesNotMatch(other, /--confirm|ASKS FIRST/);
  assert.match(await helpOf(["webhooks", "delete", "wh_1", "--help"]), /ASKS FIRST\n  Delete webhook \{id\}\?/);
});

test("the global options leave --confirm to the commands that ask first", async () => {
  assert.doesNotMatch(await helpOf(["--help"]), /--confirm/);
});
