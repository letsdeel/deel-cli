import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { EXIT } from "../src/core/errors.ts";
import { RESERVED_COMMANDS } from "../src/core/constants.ts";
import { manifest as handPicked } from "../src/manifest.generated.ts";
import { setGeneratedDescriptorsForTests } from "../src/public-api/commands.ts";
import { sectionOf, suggestions, titleSectionOf } from "../src/help.ts";
import type { Descriptor } from "../src/types.ts";
import { parseDefinitions } from "../scripts/public-api/definitions.ts";
import { generate } from "../scripts/public-api/generate.ts";

const definitions = parseDefinitions(JSON.parse(readFileSync(new URL("./fixtures/definitions/help-tree.json", import.meta.url), "utf8")));
const generated = generate(definitions, {
  reserved: { commands: handPicked.descriptors, topLevel: RESERVED_COMMANDS },
  overrides: {},
  now: new Date("2026-10-30T00:00:00Z"),
});

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (err.push(String(chunk)), true)) as typeof process.stderr.write;
  setGeneratedDescriptorsForTests(generated.manifest.descriptors);
  try {
    const code = await run(argv);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    setGeneratedDescriptorsForTests(undefined);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

function descriptor(command: string, group?: string, api: "rest" | "scim" = "rest"): Descriptor {
  return {
    command: command.split(" "), method: "GET", path: `/${command.replace(/ /g, "/")}`, async: false, bodyKind: "none", supportsMultipart: false,
    bodyWrapper: "none", params: [], bodyProps: [], fileFields: [], responseKind: "none", responseFields: [], api, ...(group ? { group } : {}),
  };
}

test("the fixture generates without errors and carries the doc tags", () => {
  assert.deepEqual(generated.errors, []);
  const gizmos = generated.manifest.descriptors.find((d) => d.path === "/gizmos")!;
  assert.equal(gizmos.group, "Gizmos"); // the team handle before it is skipped
  assert.equal(generated.manifest.descriptors.find((d) => d.path === "/untagged-things")!.group, undefined);
});

test("root help lists top-level groups under their documentation sections", async () => {
  const { code, out } = await capture(["--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^ {2}CLI +auth +Authentication \(3 commands\)$/m);
  assert.match(out, /^ +commands +List every command with its method, path and summary$/m);
  assert.match(out, /^ {2}Adjustments +adjustments +4 commands$/m);
  assert.match(out, /^ {2}Gizmos +gizmos +2 commands$/m);
  assert.match(out, /^ {2}SCIM +scim users list +List users$/m);
  assert.match(out, /^ {2}Widgets +widget-reports create +Create a widget report\n +widgets +7 commands$/m);
  assert.match(out, /^ {2}Other +jobs +2 commands\n +untagged-things list +List untagged things$/m);
  const order = ["CLI", "Adjustments", "Gizmos", "SCIM", "Widgets", "Other"].map((section) => out.search(new RegExp(`^ {2}${section} `, "m")));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(out, /GLOBAL OPTIONS/);
  assert.match(out, /deel commands --filter <text>/);
});

test("deel with no arguments prints the root help", async () => {
  const { code, out } = await capture([]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^ {2}CLI +auth/m);
});

test("group help collapses single-child groups into full commands", async () => {
  const { code, out } = await capture(["widgets", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.equal(
    out,
    [
      "",
      "Widgets",
      "",
      "Commands:",
      "  list                 List widgets",
      "  get                  Retrieve a widget",
      "  extra-info list      Get extra info for a widget",
      "  invitations create   Send a widget invitation",
      "  parts                3 commands",
      "",
      "Run deel widgets <command> --help for flags and the request body.",
      "",
    ].join("\n"),
  );
});

test("a group without --help prints its help too", async () => {
  const { code, out } = await capture(["widgets"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /invitations create +Send a widget invitation/);
});

test("a nested group is titled with its path", async () => {
  const { code, out } = await capture(["widgets", "parts", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^deel widgets parts$/m);
  assert.match(out, /^ {2}list +List parts of a widget\n {2}get +Retrieve a widget part\n {2}create +Add a part to a widget$/m);
  assert.match(out, /Run deel widgets parts <command> --help/);
});

test("a collapsed command keeps its action help, --help at any position", async () => {
  for (const argv of [["widgets", "invitations", "create", "--help"], ["--help", "widgets", "invitations", "create"]]) {
    const { code, out } = await capture(argv);
    assert.equal(code, EXIT.OK);
    assert.match(out, /Send a widget invitation/);
    assert.match(out, /USAGE {2}deel widgets invitations create/);
  }
});

test("a group mixing hand-picked and generated commands lists both", async () => {
  const { code, out } = await capture(["adjustments", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^Adjustments$/m);
  assert.match(out, /^ {2}list +List adjustments$/m);
  assert.match(out, /^ {2}get +Retrieve an adjustment$/m);
  assert.match(out, /^ {2}create +Create a single invoice adjustment \/ Create a payroll adjustment \(--invoice, --payroll\)$/m);
  assert.match(out, /^ {2}create-bulk +Create invoice adjustments in bulk \/ Process bulk payroll adjustments \(--invoice, --payroll\)$/m);
});

test("a hand-picked group without a section is titled with its path", async () => {
  const { out } = await capture(["jobs", "--help"]);
  assert.match(out, /^deel jobs$/m);
  assert.match(out, /^ {2}list +List jobs$/m);
});

test("a static group uses its description and the static footer", async () => {
  const { code, out } = await capture(["auth", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^Authentication$/m);
  assert.match(out, /^ {2}login +Validate a PAT/m);
  assert.match(out, /Run deel auth <command> --help for its flags\./);
});

test("an unknown top-level word suggests the closest commands", async () => {
  const { code, out, err } = await capture(["widgts"]);
  assert.equal(code, EXIT.ERROR);
  assert.equal(out, "");
  assert.match(err, /^Unknown command 'widgts'\. Did you mean: widgets\?$/m);
  assert.match(err, /Run 'deel --help'/);
});

test("an unknown word under a group names the group and suggests its commands", async () => {
  for (const argv of [["widgets", "lst"], ["widgets", "lst", "--help"]]) {
    const { code, out, err } = await capture(argv);
    assert.equal(code, EXIT.ERROR);
    assert.equal(out, "");
    assert.match(err, /^Unknown command 'lst' under 'deel widgets'\. Did you mean: list\?$/m);
    assert.match(err, /Run 'deel widgets --help'/);
  }
  const deeper = await capture(["widgets", "parts", "gett"]);
  assert.match(deeper.err, /^Unknown command 'gett' under 'deel widgets parts'\. Did you mean: get\?$/m);
});

test("an unknown word with nothing close has no suggestion", async () => {
  const { code, err } = await capture(["widgets", "zzzzzz"]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /^Unknown command 'zzzzzz' under 'deel widgets'\.$/m);
});

test("a global flag's value after a group is not an unknown command", async () => {
  const { code, out } = await capture(["widgets", "--env", "demo"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^Widgets$/m);
});

test("a global flag's value before the command is not a command word", async () => {
  const group = await capture(["--env", "demo", "widgets", "--help"]);
  assert.equal(group.code, EXIT.OK);
  assert.match(group.out, /^Widgets$/m);
  const leaf = await capture(["--env", "demo", "widgets", "parts", "get", "--help"]);
  assert.equal(leaf.code, EXIT.OK);
  assert.match(leaf.out, /USAGE {2}deel widgets parts get/);
  const root = await capture(["--env", "demo"]);
  assert.equal(root.code, EXIT.OK);
  assert.match(root.out, /^Commands:$/m);
  const unknown = await capture(["--env", "demo", "widgts"]);
  assert.match(unknown.err, /^Unknown command 'widgts'\. Did you mean: widgets\?$/m);
});

test("boolean flags and --flag=value before the command keep the command word", async () => {
  for (const flags of [["--debug"], ["--quiet"], ["--no-log"], ["--token-stdin"], ["--env=demo"], ["--debug", "--env=demo"]]) {
    const { code, out } = await capture([...flags, "widgets", "--help"]);
    assert.equal(code, EXIT.OK, flags.join(" "));
    assert.match(out, /^Widgets$/m);
  }
});

test("--base-url and camelCase flag values before the command are not command words", async () => {
  for (const flags of [["--base-url", "https://api.test"], ["--idempotencyKey", "k"], ["--ca-cert", "ca.pem", "--debug"]]) {
    const { code, out } = await capture([...flags, "widgets", "parts", "--help"]);
    assert.equal(code, EXIT.OK, flags.join(" "));
    assert.match(out, /^deel widgets parts$/m);
  }
});

test("a command's own flag value after a group is not an unknown command", async () => {
  const { code, out } = await capture(["widgets", "parts", "--widget-id", "5", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^deel widgets parts$/m);
});

test("an unknown flag does not swallow a command word", async () => {
  const { code, out } = await capture(["--unknown", "widgets", "--help"]);
  assert.equal(code, EXIT.OK);
  assert.match(out, /^Widgets$/m);
});

test("an empty command word suggests nothing", async () => {
  assert.deepEqual(suggestions("", ["list", "get"]), []);
  const { code, err } = await capture([""]);
  assert.equal(code, EXIT.ERROR);
  assert.match(err, /^Unknown command ''\.$/m);
});

test("suggestions: prefixes first, then small edit distances, at most five", () => {
  assert.deepEqual(suggestions("contract", ["contracts", "contract-templates", "people"]), ["contract-templates", "contracts"]);
  assert.deepEqual(suggestions("lsit", ["list", "get", "lint"]), ["list"]); // a swap is one edit
  assert.deepEqual(suggestions("contrcts", ["contracts", "contractors", "people"]), ["contracts"]);
  assert.deepEqual(suggestions("x", ["list", "get"]), []);
  assert.equal(suggestions("a", ["a1", "a2", "a3", "a4", "a5", "a6"]).length, 5);
});

test("sectionOf: SCIM, then the tag naming the group, then the most common tag", () => {
  assert.equal(sectionOf("scim", [descriptor("scim users list", "Users", "scim")]), "SCIM");
  assert.equal(sectionOf("people", [descriptor("people list", "Custom Fields"), descriptor("people get", "Custom Fields"), descriptor("people update", "People")]), "People");
  assert.equal(sectionOf("hris", [descriptor("hris a list", "Positions"), descriptor("hris b list", "Worker Relations"), descriptor("hris c list", "Worker Relations")]), "Worker Relations");
  assert.equal(sectionOf("pay", [descriptor("pay a list", "Payments"), descriptor("pay b list", "Accounting")]), "Accounting");
  assert.equal(sectionOf("jobs", [descriptor("jobs list")]), undefined);
});

test("titleSectionOf: a section titles a group only when it names or covers it", () => {
  const it = [descriptor("it assets list", "IT assets"), descriptor("it assets get", "IT assets"), descriptor("it orders list", "IT orders")];
  assert.equal(titleSectionOf("it", it), undefined);
  assert.equal(titleSectionOf("gizmos", [descriptor("gizmos list", "Gizmos"), descriptor("gizmos get")]), "Gizmos");
  assert.equal(titleSectionOf("people", [descriptor("people list", "Custom Fields"), descriptor("people get", "People")]), "People");
  assert.equal(titleSectionOf("jobs", [descriptor("jobs list")]), undefined);
});
