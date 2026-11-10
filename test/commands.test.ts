import { test } from "node:test";
import assert from "node:assert/strict";
import type { CommandDef } from "citty";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { staticCommands } from "../src/commands/index.ts";
import { commandRows, renderCommandRows } from "../src/core/commands-list.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";

const definitions = parseDefinitions(
  [
    ["GET", "/contracts/{contract_id}", "Retrieve a single contract"],
    ["GET", "/eor/contracts/{contract_id}/details", "Retrieve EOR contract details"],
  ].map(([method, path, summary]) => ({ api: "rest", method, path, version: "2026-01-01", beta_until: null, sunset_at: null, operation: { summary, responses: { "200": { description: "ok" } } } })),
);
const { manifest } = generate(definitions, {
  reserved: { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS },
  map: [
    { method: "GET", path: "/contracts/{contract_id}", command: "deel contracts get <contract>" },
    { method: "GET", path: "/eor/contracts/{contract_id}/details", command: "deel contracts get <contract> --worker-type eor" },
  ],
  now: new Date("2026-10-30T00:00:00Z"),
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  setGeneratedDescriptorsForTests(manifest.descriptors);
  try {
    return { code: await run(argv), out: out.join(""), err: err.join("") };
  } catch (error) {
    return { code: EXIT.ERROR, out: out.join(""), err: (error as Error).message };
  } finally {
    setGeneratedDescriptorsForTests(undefined);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

test("deel commands lists every generated endpoint as its command line, the hand-picked and the static commands", async () => {
  const { code, out } = await capture(["commands"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^contracts get <contract> +GET +\/contracts\/\{contract_id\} +Retrieve a single contract$/m);
  assert.match(out, /^contracts get <contract> --worker-type eor +GET +\/eor\/contracts\/\{contract_id\}\/details +Retrieve EOR contract details$/m);
  assert.match(out, /^adjustments create --invoice +POST +\/adjustments\/invoice/m);
  assert.match(out, /^auth login/m);
});

test("deel commands --filter keeps the rows that contain every word, and --json prints them", async () => {
  const json = JSON.parse((await capture(["commands", "--filter", "eor contract", "--json"])).out);
  assert.deepEqual(json, [{ command: "contracts get <contract> --worker-type eor", method: "GET", path: "/eor/contracts/{contract_id}/details", summary: "Retrieve EOR contract details" }]);
  const none = await capture(["commands", "--filter", "nothing-matches-this"]);
  assert.notEqual(none.code, EXIT.OK);
  assert.match(none.err, /No commands match 'nothing-matches-this'/);
  const empty = await capture(["commands", "--filter", " "]);
  assert.match(empty.err, /--filter needs the text to look for/);
});

test("deel commands --filter with no value fails as a value flag does, and sends nothing", async () => {
  for (const argv of [["commands", "--filter"], ["commands", "--filter="], ["commands", "--filter", "--json"]]) {
    await assert.rejects(
      run(argv),
      (error: { code?: string; message: string }) => error.code === "usage.flag_value" && /^--filter needs a value\./.test(error.message),
      argv.join(" "),
    );
  }
});

test("commandRows sorts by command, then path, whatever order the rows come in; renderCommandRows aligns the columns", () => {
  const plain = manifest.descriptors.find((d) => d.path === "/contracts/{contract_id}")!;
  const eor = manifest.descriptors.find((d) => d.path === "/eor/contracts/{contract_id}/details")!;
  const samePlainCommandLaterPath = { ...plain, path: "/z/contracts/{contract_id}" };
  const authLike = { meta: { description: "Sign in" } } as unknown as CommandDef;
  const rows = commandRows([eor, samePlainCommandLaterPath, plain], { auth: authLike }, undefined);
  assert.deepEqual(rows.map((row) => [row.command, row.path]), [
    ["auth", null],
    ["contracts get <contract>", "/contracts/{contract_id}"],
    ["contracts get <contract>", "/z/contracts/{contract_id}"],
    ["contracts get <contract> --worker-type eor", "/eor/contracts/{contract_id}/details"],
  ]);
  const lines = renderCommandRows(rows).trimEnd().split("\n");
  assert.equal(lines[1].indexOf("GET"), lines[3].indexOf("GET"));
  assert.equal(lines[1].indexOf("/contracts"), lines[3].indexOf("/eor"));
});

test("commands is a reserved static name", () => {
  assert.ok(RESERVED_COMMANDS.has("commands"));
  assert.ok("commands" in staticCommands);
});
