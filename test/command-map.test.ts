import { test } from "node:test";
import assert from "node:assert/strict";
import { bindForm, parseCommand } from "../scripts/public-api/command-map.ts";

test("parseCommand reads words, positionals, scope flags and the three kinds of selector", () => {
  assert.deepEqual(parseCommand("deel contracts get <contract> --file-format pdf [--worker-type eor] --as worker --bulk --contract <c>"), {
    words: ["contracts", "get"],
    labels: [{ label: "contract" }, { label: "c", flag: "contract" }],
    selectors: [{ flag: "file-format", value: "pdf" }, { flag: "worker-type", value: "eor", optional: true }, { flag: "as", value: "worker" }, { flag: "bulk" }],
  });
  assert.deepEqual(parseCommand("deel it seats unassign [--bulk]").selectors, [{ flag: "bulk", optional: true }]);
  assert.throws(() => parseCommand("contracts get"), /does not start with deel/);
  assert.throws(() => parseCommand("deel contracts"), /needs a domain and a verb/);
  assert.throws(() => parseCommand("deel contracts get <contract> stray"), /is not a positional or a flag/);
  assert.throws(() => parseCommand("deel contracts get [--worker-type eor"), /opens a bracket it never closes/);
  assert.throws(() => parseCommand("deel notes list [--job <job>]"), /a scope flag can't be optional/);
});

test("bindForm binds a label to the path param whose name holds it, then the rest in path order", () => {
  const bound = (command: string, path: string, query: string[] = []) => bindForm(parseCommand(command), path, query);
  assert.deepEqual(bound("deel docs files get <document> --contract <contract>", "/workers/contracts/{contract_id}/docs/{document_id}").form, {
    positionals: [{ label: "document", param: "document_id" }],
    scopes: [{ flag: "contract", label: "contract", param: "contract_id" }],
    selectors: [],
  });
  assert.deepEqual(bound("deel att list <type> <id> <attachment-type>", "/att/{attachable_type_slug}/{attachable_id}/{attachment_type_slug}").form!.positionals.map((p) => p.param), [
    "attachable_type_slug",
    "attachable_id",
    "attachment_type_slug",
  ]);
  assert.deepEqual(bound("deel fields delete <field> --contract <contract>", "/contracts/{contract_id}/fields/{id}").form!.positionals, [{ label: "field", param: "id" }]);
  // A scope flag left over names the one query param whose name holds it.
  assert.deepEqual(bound("deel offerings list --country <country>", "/benefits", ["country_code", "team_id"]).form!.scopes, [{ flag: "country", label: "country", param: "country_code", in: "query" }]);
});
