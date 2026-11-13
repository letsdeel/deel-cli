import { test } from "node:test";
import assert from "node:assert/strict";
import { run, unknownFlag } from "../src/cli.ts";
import { CliError, EXIT } from "../src/core/errors.ts";
import { commonArgs, valuedFlags } from "../src/commands/shared.ts";
import { printContract, printContractJson } from "../src/help.ts";
import type { Descriptor } from "../src/types.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { staticCommands } from "../src/commands/index.ts";
import { generatedDescriptors, setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";

// Capture direct process.stdout/stderr writes for the offline routing paths
// (version, help, generate-input, unknown command) — none of these hit the network.
// A CliError run() throws is what main.ts prints as the stderr envelope and exits 1 on, so it is reported the same way: `error`.
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string; error?: CliError }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { code: EXIT.ERROR, out: out.join(""), err: `${err.join("")}${error.message}`, error };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("--version prints the CLI version", async () => {
  const { code, out } = await capture(["--version"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^deel \d+\.\d+\.\d+/);
});

test("--generate-input prints a body skeleton for the variant action", async () => {
  const { code, out } = await capture(["adjustments", "create", "--invoice", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  const skeleton = JSON.parse(out);
  assert.ok("contract_id" in skeleton);
});

test("--generate-input expands nested object fields (bulk item.request.*)", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  const [item] = JSON.parse(out);
  assert.ok("external_id" in item);
  assert.ok("contract_id" in item.request);
});

test("action --help --json expands nested object fields (bulk item.request.*)", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  const request = contract.body.fields.find((field: { name: string }) => field.name === "request");
  assert.ok(Array.isArray(request.properties));
  assert.ok(request.properties.some((field: { name: string }) => field.name === "contract_id"));
});

test("action --help --json expands nested response fields (bulk items.*)", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  const items = contract.response.fields.find((field: { name: string }) => field.name === "items");
  assert.ok(Array.isArray(items.properties));
  assert.ok(items.properties.some((field: { name: string }) => field.name === "status"));
});

test("action --help resolves the descriptor even behind a value-taking flag", async () => {
  // Regression: a valued flag before --help must not hide the action contract.
  const { code, out } = await capture(["jobs", "status", "--job_id", "j_1", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /USAGE\s+deel jobs status/);
  assert.match(out, /OPTIONS/);
});

test("action --help --json emits the machine-readable contract", async () => {
  const { code, out } = await capture(["adjustments", "create", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.command, "adjustments create");
  assert.equal(contract.variant, "invoice");
  assert.ok(Array.isArray(contract.body.fields));
});

test("action --help --json includes a ready-to-run usage line", async () => {
  const { code, out } = await capture(["adjustments", "create-bulk", "--invoice", "--help", "--json"]);
  assert.equal(code, EXIT.OK);
  const contract = JSON.parse(out);
  assert.equal(contract.usage, "deel adjustments create-bulk --invoice [GLOBAL OPTIONS] [--input <body>]");
});

test("variant group --help without a selector lists available variants", async () => {
  const { code, out } = await capture(["adjustments", "create", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /--invoice/);
});

test("variant group --generate-input without a selector prompts to specify a variant", async () => {
  const { code, err } = await capture(["adjustments", "create", "--generate-input"]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /Specify a variant first/);
});

test("variant group --generate-input with an explicit variant succeeds", async () => {
  const { code, out } = await capture(["adjustments", "create", "--invoice", "--generate-input"]);
  assert.equal(code, EXIT.OK);
  const skeleton = JSON.parse(out);
  assert.ok("contract_id" in skeleton);
});

test("a word under a group that names none of its commands fails instead of printing the group's help", async () => {
  const removed = await capture(["adjustments", "nope"]);
  assert.equal(removed.code, EXIT.ERROR);
  assert.match(removed.err, /Unknown command 'deel adjustments nope'\./);
  assert.deepEqual([removed.error?.code, removed.error?.next], ["usage.command", "Run 'deel adjustments --help' to see its commands."]);
  assert.equal((await capture(["adjustments", "constructor"])).code, EXIT.ERROR);
  assert.equal((await capture(["constructor"])).code, EXIT.ERROR);
  // An option between the command words is named as the problem, not the command it stopped at.
  for (const argv of [["adjustments", "--env", "demo", "create"], ["adjustments", "--base-url", "https://a.test/rest", "create"]]) {
    const misplaced = await capture(argv);
    assert.equal(misplaced.code, EXIT.ERROR, argv.join(" "));
    assert.match(misplaced.err, /^Options go after the command: write 'deel adjustments create …'/, argv.join(" "));
    assert.equal(misplaced.error?.code, "usage.command", argv.join(" "));
  }
});

test("an option before the command's last word is refused, since citty would drop it and the call would go out without it", async () => {
  const leading = [
    ["--env=demo", "webhooks", "delete", "abc"],
    ["--env", "demo", "webhooks", "delete", "abc"],
    ["--base-url", "https://a.test/rest", "webhooks", "list"],
    ["--base-url=https://a.test/rest", "webhooks", "list"],
    ["--beta", "webhooks", "list"],
    ["--token-stdin", "webhooks", "list"],
    ["--no-log", "webhooks", "list"],
    ["--json", "webhooks", "list"],
    ["--env", "demo", "auth", "status"],
    ["adjustments", "--no-log", "create"],
  ];
  for (const argv of leading) {
    const refused = await capture(argv);
    assert.equal(refused.code, EXIT.ERROR, argv.join(" "));
    assert.equal(refused.error?.code, "usage.command", argv.join(" "));
    assert.match(refused.err, /^Options go after the command: write 'deel (webhooks (delete|list)|auth status|adjustments create) …' with the options at the end\./, argv.join(" "));
  }
  // A flag's value is not the command: the word after `--env demo` is read, and named when it is not one.
  const unknown = await capture(["--env", "demo", "definitely-not-a-command"]);
  assert.match(unknown.err, /Unknown command 'definitely-not-a-command'\./);
  assert.equal(unknown.error?.code, "usage.command");
  // A single-dash option or a flag the command line doesn't know reads its value as the word, and says options go last.
  const short = await capture(["-env", "demo", "webhooks", "list"]);
  assert.match(short.err, /Unknown command 'demo'\./);
  assert.match(short.error?.next ?? "", /Options go after the command/);
  // After the last word, before --, or as a help switch anywhere, an option is fine.
  for (const argv of [["adjustments", "--env", "demo"], ["adjustments", "--", "--env", "demo"], ["--help", "adjustments"], ["--env", "demo", "--help"]]) {
    assert.equal((await capture(argv)).code, EXIT.OK, argv.join(" "));
  }
});

test("what run() answers itself is answered wherever its option stands, and only the rest is refused", async () => {
  // --generate-input and --json with help are read from the whole command line, so a leading one is not dropped.
  const skeleton = await capture(["--generate-input", "adjustments", "create", "--invoice"]);
  assert.equal(skeleton.code, EXIT.OK);
  assert.ok("contract_id" in JSON.parse(skeleton.out));
  assert.equal((await capture(["--env", "demo", "--generate-input", "adjustments", "create", "--invoice"])).code, EXIT.OK);
  const variant = await capture(["--generate-input", "adjustments", "create"]);
  assert.match(variant.err, /Specify a variant first/);
  const contract = await capture(["--json", "adjustments", "create", "--invoice", "--help"]);
  assert.equal(contract.code, EXIT.OK);
  assert.equal(typeof JSON.parse(contract.out), "object");
  const forms = await capture(["--env", "demo", "adjustments", "create", "--help"]);
  assert.equal(forms.code, EXIT.OK);
  // Help in any position, short or long, passes the option guard.
  for (const argv of [["-h", "adjustments"], ["--help", "adjustments", "create"], ["adjustments", "-h", "create"], ["adjustments", "--help", "create"], ["--env", "demo", "-h"], ["--no-log", "-h", "adjustments", "create"]]) {
    assert.equal((await capture(argv)).code, EXIT.OK, argv.join(" "));
  }
  // Nothing answers --generate-input on a command with no body (a static one), so a leading one would be dropped.
  const dropped = await capture(["--generate-input", "auth", "status"]);
  assert.equal(dropped.error?.code, "usage.command");
  assert.match(dropped.err, /^Options go after the command: write 'deel auth status …'/);
});

test("a switch before a word is not a flag value: it neither hides the stray word nor makes one", async () => {
  const stray = await capture(["adjustments", "--json", "nope"]);
  assert.match(stray.err, /Unknown command 'deel adjustments nope'\./);
  assert.equal((await capture(["adjustments", "--json"])).code, EXIT.OK);
});

test("an unknown command reports an error", async () => {
  const { code, err, error } = await capture(["definitely-not-a-command"]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /Unknown command 'definitely-not-a-command'/);
  assert.equal(error?.code, "usage.command");
});

function captureStdout(run: () => void): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join("");
}

const nullableContract: Descriptor = {
  command: ["things", "update"],
  method: "PATCH",
  path: "/things",
  async: false,
  bodyKind: "json",
  supportsMultipart: false,
  bodyWrapper: "none",
  params: [],
  bodyProps: [
    { name: "title", in: "body", type: "string", required: true },
    { name: "note", in: "body", type: "string", required: false, nullable: true },
    { name: "limit", in: "body", type: "number", required: true, nullable: true },
  ],
  fileFields: [],
  responseKind: "none",
  responseFields: [],
};

test("--help marks nullable body fields and keeps the other columns", () => {
  const out = captureStdout(() => printContract(nullableContract));
  assert.match(out, /note\s+string\s+nullable/);
  assert.match(out, /limit\s+number\s+required, nullable/);
  assert.match(out, /title\s+string\s+required\s*\n/);
});

test("--help leaves the flag column unchanged when nothing is nullable", () => {
  const plain: Descriptor = { ...nullableContract, bodyProps: [{ name: "title", in: "body", type: "string", required: true }] };
  const out = captureStdout(() => printContract(plain));
  assert.ok(!out.includes("nullable"));
  assert.match(out, /title {18}string {3}required \n/);
});

test("--help --json carries nullable on the fields that have it", () => {
  const out = captureStdout(() => printContractJson(nullableContract));
  const fields = JSON.parse(out).body.fields;
  assert.equal(fields.find((f: { name: string }) => f.name === "note").nullable, true);
  assert.equal("nullable" in fields.find((f: { name: string }) => f.name === "title"), false);
});

test("unknownFlag accepts every spelling and negation of a known flag and names the first unknown one", () => {
  assert.equal(unknownFlag(["--worker-type", "eor", "--workerType=eor", "--no-json", "--json=false"], ["worker-type", "json"]), undefined);
  assert.equal(unknownFlag(["a", "--limit", "5", "--other"], ["json"]), "--limit");
  assert.equal(unknownFlag(["-x", "s1"], ["json"]), "-x");
  assert.equal(unknownFlag(["--", "--limit"], []), undefined);
});

test("every static command is a reserved name, so the generator and the committed-manifest check can see it", () => {
  assert.deepEqual(Object.keys(staticCommands).sort(), [...RESERVED_COMMANDS].sort());
});

test("--version and the static commands never load the generated manifest; a generated command does", async () => {
  setGeneratedDescriptorsForTests(undefined);
  try {
    for (const argv of [["--version"], ["job", "--help"], ["auth", "--help"]]) {
      assert.equal((await capture(argv)).code, EXIT.OK, argv.join(" "));
      assert.deepEqual(generatedDescriptors(), [], `${argv.join(" ")} loaded the manifest`);
    }
    assert.equal((await capture(["contracts", "get", "--help"])).code, EXIT.OK);
    assert.ok(generatedDescriptors().length > 0);
  } finally {
    setGeneratedDescriptorsForTests(undefined);
  }
});

test("-v and --version after -- are arguments, not a version request", async () => {
  for (const argv of [["--help", "--", "-v"], ["--help", "--", "--version"], ["adjustments", "create", "--invoice", "--generate-input", "--", "--version"]]) {
    const { code, out } = await capture(argv);
    assert.equal(code, EXIT.OK, argv.join(" "));
    assert.doesNotMatch(out, /^deel \d+\.\d+\.\d+\n?$/, argv.join(" "));
  }
  // Before --, a bare --version or -v is the version request; after a command word --version names an API version.
  for (const argv of [["-v"], ["--version"]]) assert.match((await capture(argv)).out, /^deel \d+\.\d+\.\d+/, argv.join(" "));
});

test("a variant selector written --invoice=true selects it, and --invoice=false does not", async () => {
  const on = await capture(["adjustments", "create", "--invoice=true", "--generate-input"]);
  assert.equal(on.code, EXIT.OK);
  assert.ok("contract_id" in JSON.parse(on.out));
  const off = await capture(["adjustments", "create", "--invoice=false", "--generate-input"]);
  assert.equal(off.code, EXIT.ERROR);
  assert.match(off.err, /Specify a variant first/);
  const no = await capture(["adjustments", "create", "--no-invoice", "--generate-input"]);
  assert.equal(no.code, EXIT.ERROR);
});

test("a --base-url with no value fails before any request, on a generated command and on a static one", async () => {
  for (const argv of [["contracts", "list", "--base-url"], ["contracts", "list", "--base-url="], ["contracts", "list", "--base-url", "--json"], ["job", "status", "j1", "--base-url="]]) {
    await assert.rejects(() => run(argv), (error: unknown) => error instanceof CliError && error.code === "usage.flag_value" && /--base-url needs a value/.test(error.message), argv.join(" "));
  }
});

test("a flag that takes a value, typed with none, stops every command before any request, on a generated and a static command alike", async (t) => {
  let sent = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    sent++;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const saved = { token: process.env.DEEL_TOKEN, log: process.env.DEEL_LOG };
  process.env.DEEL_TOKEN = "a-token";
  process.env.DEEL_LOG = "off";
  t.after(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of [["DEEL_TOKEN", saved.token], ["DEEL_LOG", saved.log]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Every global string flag, taken from commonArgs, so one added later is covered without touching this test.
  const flags = Object.entries(commonArgs).filter(([, def]) => def.type === "string").map(([name]) => name);
  assert.deepEqual(valuedFlags().sort(), [...flags, "base-url"].sort());
  assert.ok(["fields", "jq", "input", "env", "file", "ca-cert", "idempotency-key"].every((flag) => flags.includes(flag)));
  const commands = [["legal-entities", "list"], ["webhooks", "list"], ["dev", "tokens", "list"], ["job", "status", "j1"], ["job", "list"], ["auth", "status"], ["auth", "logout"]];
  for (const command of commands) {
    for (const flag of [...flags, "base-url"]) {
      // The bare flag last, empty with =, and followed by another flag (--raw, which a filter would otherwise swallow).
      for (const typed of [[`--${flag}`], [`--${flag}=`], [`--${flag}`, "--raw"]]) {
        const argv = [...command, ...typed];
        await assert.rejects(() => run(argv), (error: unknown) => error instanceof CliError && error.code === "usage.flag_value" && error.message === `--${flag} needs a value.`, argv.join(" "));
      }
    }
  }
  // The parameters of the endpoint itself, and `auth login --scopes`.
  for (const argv of [["legal-entities", "list", "--limit"], ["legal-entities", "list", "--cursor="], ["webhooks", "list", "--limit", "--json"], ["auth", "login", "--scopes"], ["auth", "login", "--scopes="]]) {
    await assert.rejects(() => run(argv), (error: unknown) => error instanceof CliError && error.code === "usage.flag_value", argv.join(" "));
  }
  assert.equal(sent, 0);
});
