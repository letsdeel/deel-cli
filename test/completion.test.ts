import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { run } from "../src/cli.ts";
import { EXIT, CliError } from "../src/core/errors.ts";
import { completionScript, formatCandidates } from "../src/core/completion.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));

async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const origOut = process.stdout.write;
  process.stdout.write = ((chunk: any) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    const code = await run(argv);
    return { code, out: out.join("") };
  } finally {
    process.stdout.write = origOut;
  }
}

// Candidate values only (drops the tab-separated descriptions).
async function values(...words: string[]): Promise<string[]> {
  const { code, out } = await capture(["__complete", ...words]);
  assert.equal(code, EXIT.OK);
  return out.split("\n").filter(Boolean).map((line) => line.split("\t")[0]);
}

test("__complete lists static and generated top-level commands", async () => {
  const commands = await values("");
  for (const name of ["adjustments", "auth", "completion", "job", "jobs"]) assert.ok(commands.includes(name), name);
  assert.ok(!commands.includes("__complete"));
});

test("__complete filters by the partial word and walks into groups", async () => {
  assert.deepEqual(await values("adj"), ["adjustments"]);
  assert.deepEqual(await values("adjustments", ""), ["create", "create-bulk"]);
  assert.deepEqual(await values("auth", "lo"), ["login", "logout"]);
});

test("__complete lists an action's flags, including variant selectors and --help", async () => {
  const flags = await values("adjustments", "create", "--");
  for (const flag of ["--invoice", "--payroll", "--input", "--env", "--fields", "--jq", "--help"]) assert.ok(flags.includes(flag), flag);
  assert.deepEqual(await values("adjustments", "create", "--pa"), ["--payroll"]);
});

test("__complete prints descriptions after a tab", async () => {
  const { out } = await capture(["__complete", "jobs", "list", "--qu"]);
  assert.equal(out, "--quiet\tPrint ids only\n");
});

test("__complete offers flags on an action when nothing is typed yet", async () => {
  const flags = await values("jobs", "list", "");
  assert.ok(flags.includes("--fields"));
});

test("__complete completes --env values, in both --env x and --env=x forms", async () => {
  assert.deepEqual(await values("jobs", "list", "--env", ""), ["demo", "prod"]);
  assert.deepEqual(await values("jobs", "list", "--env=p"), ["--env=prod"]);
});

test("__complete completes --fields from the action's response fields, one comma segment at a time", async () => {
  const fields = await values("jobs", "list", "--fields", "");
  assert.ok(fields.includes("job_id") && fields.includes("status"));
  const next = await values("jobs", "list", "--fields", "job_id,");
  assert.ok(next.includes("job_id,status"));
  assert.ok(!next.includes("job_id,job_id"), "already-selected fields are not offered again");
  assert.deepEqual(await values("jobs", "list", "--fields=job_id,st"), ["--fields=job_id,status"]);
});

test("__complete returns nothing for free-form values so the shell falls back to files", async () => {
  assert.deepEqual(await values("adjustments", "create", "--input", ""), []);
  assert.deepEqual(await values("adjustments", "create", "--ca-cert", "./"), []);
});

test("__complete skips flag values while walking the typed words", async () => {
  // "jobs" after --jq is the flag's value, not a command.
  assert.deepEqual(await values("jobs", "list", "--jq", "jobs", "--fie"), ["--fields"]);
  assert.deepEqual(await values("jobs", "list", "--jq=.data", "--qu"), ["--quiet"]);
});

test("__complete handles positionals and stops after --", async () => {
  assert.deepEqual(await values("job", "status", ""), []);
  assert.deepEqual(await values("completion", ""), ["bash", "fish", "zsh"]);
  assert.deepEqual(await values("completion", "bash", ""), []);
  assert.deepEqual(await values("jobs", "list", "--", ""), []);
});

test("__complete works before --version/--help handling and never needs a token", async () => {
  const saved = process.env.DEEL_TOKEN;
  delete process.env.DEEL_TOKEN;
  try {
    assert.deepEqual(await values("jobs", "list", "--version", "--qu"), ["--quiet"]);
  } finally {
    if (saved !== undefined) process.env.DEEL_TOKEN = saved;
  }
});

test("formatCandidates collapses whitespace in descriptions so each candidate stays on one line", () => {
  assert.equal(formatCandidates([{ value: "a", description: "two\nlines" }, { value: "b" }]), "a\ttwo lines\nb");
});

test("deel completion prints a script for each shell", async () => {
  for (const shell of ["bash", "zsh", "fish"] as const) {
    const { code, out } = await capture(["completion", shell]);
    assert.equal(code, EXIT.OK);
    assert.equal(out, completionScript(shell));
    assert.match(out, /deel __complete/);
  }
});

test("deel completion rejects an unknown shell with a usage error", async () => {
  await assert.rejects(
    capture(["completion", "powershell"]),
    (err: unknown) => err instanceof CliError && err.code === "usage.completion",
  );
});

test("generated scripts are valid shell syntax", () => {
  const bash = spawnSync("bash", ["-n"], { input: completionScript("bash") });
  assert.equal(bash.status, 0, bash.stderr.toString());
  for (const shell of ["zsh", "fish"] as const) {
    const probe = spawnSync(shell, ["--version"]);
    if (probe.error) continue; // shell not installed on this machine
    const check = spawnSync(shell, ["-n"], { input: completionScript(shell) });
    assert.equal(check.status, 0, `${shell}: ${check.stderr.toString()}`);
  }
});

// Drive the real bash function the way readline does: set COMP_LINE/COMP_POINT,
// call it, and read COMPREPLY. `deel` is shimmed to run this checkout.
function bashComplete(line: string): string[] {
  const script = `
deel() { "${process.execPath}" "${MAIN}" "$@"; }
${completionScript("bash")}
COMP_LINE=${JSON.stringify(line)}
COMP_POINT=\${#COMP_LINE}
_deel_completion
printf '%s\\n' "\${COMPREPLY[@]}"
`;
  const result = spawnSync("bash", ["-c", script], { env: { ...process.env, DEEL_TOKEN: "" } });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout.toString().split("\n").filter(Boolean);
}

test("the bash script completes commands, flags and --flag=value through deel __complete", () => {
  assert.deepEqual(bashComplete("deel adj"), ["adjustments"]);
  assert.deepEqual(bashComplete("deel adjustments "), ["create", "create-bulk"]);
  assert.deepEqual(bashComplete("deel jobs list --env "), ["demo", "prod"]);
  // bash splits the current word at '=', so the reply must only contain the value part.
  assert.deepEqual(bashComplete("deel jobs list --env=de"), ["demo"]);
  assert.deepEqual(bashComplete("deel jobs list --fields job_id,st"), ["job_id,status"]);
});
