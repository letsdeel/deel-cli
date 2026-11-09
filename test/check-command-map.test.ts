import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkMap } from "../scripts/check-command-map.ts";
import type { MapEntry } from "../scripts/public-api/command-map.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const entry = (method: string, path: string, command: string, extra: Partial<MapEntry> = {}): MapEntry => ({ method, path, command, ...extra });
const rules = (entries: MapEntry[]) => checkMap(entries).failures.map((f) => `${f.rule} ${f.message}`);

test("the committed command map passes every rule", () => {
  const map = JSON.parse(readFileSync(new URL("../src/public-api/commands.json", import.meta.url), "utf8")) as MapEntry[];
  assert.deepEqual(checkMap(map).failures, []);
  const run = spawnSync(process.execPath, ["scripts/check-command-map.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /command map: 0 failure\(s\)/);
});

test("R1 and R2: kebab-case words, a core or registry verb, and a named case when the verb isn't the method's", () => {
  assert.match(rules([entry("GET", "/x", "deel Things list")]).join(), /R1 'Things' is not lowercase/);
  assert.match(rules([entry("POST", "/x/{id}/frob", "deel things frob <thing>")]).join(), /R2 verb 'frob' is neither a core verb/);
  assert.match(rules([entry("POST", "/x/search", "deel things list")]).join(), /R2 verb differs from POST and names no override case/);
  assert.deepEqual(rules([entry("POST", "/x/search", "deel things list", { case: "read" })]), []);
  assert.match(rules([entry("POST", "/x/{id}/archive", "deel things update <thing>", { case: "state" })]).join(), /case 'state' needs update with --status/);
  assert.deepEqual(rules([entry("POST", "/x/{id}/archive", "deel things update <thing> --status archived", { case: "state" })]), []);
});

test("R3: a path trigger selects its registry verb, and a registry verb needs its trigger and scope", () => {
  assert.match(rules([entry("POST", "/contracts/{id}/signatures", "deel contracts signatures create <contract>")]).join(), /path ends in 'signatures', which selects registry verb 'sign'/);
  assert.deepEqual(rules([entry("POST", "/contracts/{id}/signatures", "deel contracts sign <contract>")]), []);
  assert.match(rules([entry("POST", "/contracts/{id}/agree", "deel contracts accept <contract>")]).join(), /registry verb 'accept' needs a path trigger/);
  assert.match(rules([entry("POST", "/people/{id}/approve", "deel people approve <person>")]).join(), /'approve' is not registered for domain 'people'/);
  // A DELETE never takes a registry verb, whatever its path ends in.
  assert.deepEqual(rules([entry("DELETE", "/contracts/{id}/invitations", "deel contracts invite delete <contract>")]), []);
});

test("R5: resource words are plural or declared singletons, and a list ends on a plural", () => {
  assert.match(rules([entry("GET", "/x", "deel things item notes list")]).join(), /R5 'item' is not plural/);
  assert.match(rules([entry("GET", "/x", "deel things note list")]).join(), /list returns a collection, so 'note' must be plural/);
  assert.deepEqual(rules([entry("GET", "/x/{id}/preview", "deel things preview get <thing>")]), []);
  assert.deepEqual(rules([entry("GET", "/x/{id}/crew", "deel things crew get <thing>", { literals: ["crew"] })]), []);
});

test("R7: a command with fewer arguments than path IDs can't be called", () => {
  assert.match(rules([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <b>")]).join(), /R7 2 IDs in the path but only 1 arguments/);
  assert.deepEqual(rules([entry("GET", "/a/{a_id}/b/{b_id}", "deel things get <b> --a <a>")]), []);
  const extra = checkMap([entry("GET", "/benefits", "deel benefits list --country <country>")]);
  assert.deepEqual([extra.failures.length, extra.warnings[0].rule], [0, "R7"]);
});

test("R8: no global flag names, and the worker type comes from the path, required only when the words are shared", () => {
  assert.match(rules([entry("POST", "/shifts/raw", "deel shifts create --raw", { case: "action" })]).join(), /R8 --raw is a global flag/);
  assert.match(rules([entry("GET", "/eor/things", "deel things list")]).join(), /path names worker type 'eor' but the command has none/);
  assert.match(rules([entry("GET", "/things", "deel things list --worker-type eor")]).join(), /the path names no worker type/);
  assert.match(rules([entry("GET", "/eor/things", "deel things list --worker-type eor")]).join(), /only endpoint with these words, so --worker-type should be optional/);
  assert.deepEqual(rules([entry("GET", "/eor/things", "deel things list [--worker-type eor]")]), []);
  const shared = [entry("GET", "/things", "deel things list"), entry("GET", "/eor/things", "deel things list [--worker-type eor]")];
  assert.match(rules(shared).join(), /shared words, so --worker-type must be required/);
  // An alias names a namespace, so a resource called "employees" deeper in the path is not a worker type.
  assert.deepEqual(rules([entry("GET", "/benefits/entities/{id}/employees", "deel benefits enrollments list --entity <entity>")]), []);
  assert.deepEqual(rules([entry("GET", "/contracts/{id}/ic-taxes", "deel contracts taxes list <contract> [--worker-type contractor]")]), []);
});

test("R7b and R9: arguments may differ across types only behind a required flag, and command lines are unique unless collapsed", () => {
  const optional = [entry("PATCH", "/eor/c/{c_id}/info", "deel people info update <contract> [--worker-type eor]"), entry("PATCH", "/gp/w/{w_id}/info", "deel people info update <worker> [--worker-type gp]")];
  assert.match(rules(optional).join(), /R7b arguments differ across worker types/);
  const twins = (collapse?: string) => [entry("POST", "/a/{id}/stop", "deel things stops create <thing>", collapse ? { collapse } : {}), entry("POST", "/b/{id}/stop", "deel things stops create <thing>", collapse ? { collapse } : {})];
  assert.match(rules(twins()).join(), /R9 same words and flags as \/a\/\{id\}\/stop/);
  const collapsed = checkMap(twins("stop"));
  assert.deepEqual([collapsed.failures.length, collapsed.warnings[0].rule], [0, "R9"]);
});
