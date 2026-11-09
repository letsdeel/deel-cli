import { test } from "node:test";
import assert from "node:assert/strict";
import { run, unknownFlag } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { printContract, printContractJson } from "../src/help.ts";
import type { Descriptor } from "../src/types.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { staticCommands } from "../src/commands/index.ts";
import { generatedDescriptors, setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";

// Capture direct process.stdout/stderr writes for the offline routing paths
// (version, help, generate-input, unknown command) — none of these hit the network.
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
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
  assert.match(removed.err, /Unknown command 'deel adjustments nope'\. Run 'deel adjustments --help'/);
  assert.equal((await capture(["adjustments", "constructor"])).code, EXIT.ERROR);
  assert.equal((await capture(["constructor"])).code, EXIT.ERROR);
  // An option between the command words is named as the problem, not the command it stopped at.
  for (const argv of [["adjustments", "--env", "demo", "create"], ["adjustments", "--base-url", "https://a.test/rest", "create"]]) {
    const misplaced = await capture(argv);
    assert.equal(misplaced.code, EXIT.ERROR, argv.join(" "));
    assert.match(misplaced.err, /^Options go after the command: write 'deel adjustments create …'/, argv.join(" "));
  }
  // The group alone, its --help, and a global flag's value after it still show the help.
  for (const argv of [["adjustments"], ["adjustments", "--help"], ["adjustments", "--env", "demo"]]) assert.equal((await capture(argv)).code, EXIT.OK, argv.join(" "));
});

test("an unknown command reports an error", async () => {
  const { code, err } = await capture(["definitely-not-a-command"]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /Unknown command/);
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
