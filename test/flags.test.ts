import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsFlag, argvEnables, argvHasFlag, argvMentionsFlag, flagOf, argvAttachesValue } from "../src/core/flags.ts";

test("acceptsFlag follows the parser: written, camelCase and kebab-case spellings, acronyms included", () => {
  assert.equal(acceptsFlag("widget_id", "widget_id"), true);
  assert.equal(acceptsFlag("widget_id", "widget-id"), true);
  assert.equal(acceptsFlag("widget_id", "widgetId"), true);
  assert.equal(acceptsFlag("userIDs", "user-i-ds"), true);
  assert.equal(acceptsFlag("userIDs", "userIDs"), true);
  assert.equal(acceptsFlag("widget_id", "widget"), false);
  assert.equal(acceptsFlag("widget_id", "widget_idx"), false);
  assert.equal(acceptsFlag("limit", ""), false);
});

test("argvHasFlag matches --flag and --flag=value in every spelling, and nothing else", () => {
  assert.equal(argvHasFlag(["--widget-id", "w1"], "widget_id"), true);
  assert.equal(argvHasFlag(["--widgetId=w1"], "widget_id"), true);
  assert.equal(argvHasFlag(["--widget_idx", "w1"], "widget_id"), false);
  assert.equal(argvHasFlag(["widget_id"], "widget_id"), false);
});

test("flagOf uses the API name unless the param has a flag", () => {
  assert.equal(flagOf({ name: "limit", in: "query", type: "integer", required: false }), "limit");
  assert.equal(flagOf({ name: "fields", in: "query", type: "string", required: false, flag: "fields-param" }), "fields-param");
});

test("the flag matchers only read flags: a word that merely ends like one is not a match, and --no- negates", () => {
  assert.equal(argvHasFlag(["xxwidget_id", "w1"], "widget_id"), false);
  assert.equal(argvHasFlag(["--widget_id=w1"], "widget_id"), true);
  assert.equal(acceptsFlag("generate-input", "no-generate-input"), false);
  assert.equal(argvMentionsFlag(["--no-archived"], "archived"), true);
  assert.equal(argvMentionsFlag(["--archived=false"], "archived"), true);
  assert.equal(argvMentionsFlag(["--other"], "archived"), false);
  assert.equal(argvEnables(["--archived"], "archived"), true);
  assert.equal(argvEnables(["--archived=false"], "archived"), false);
  assert.equal(argvEnables(["--no-archived"], "archived"), false);
  assert.equal(argvEnables(["xxarchived"], "archived"), false);
});

test("argvAttachesValue is true only for the --flag=value spelling of that value, in any spelling of the flag", () => {
  assert.equal(argvAttachesValue(["--contract=-abc"], "contract", "-abc"), true);
  assert.equal(argvAttachesValue(["--contract-id=-abc"], "contractId", "-abc"), true);
  assert.equal(argvAttachesValue(["--contract", "-abc"], "contract", "-abc"), false);
  assert.equal(argvAttachesValue(["--contract=-abc"], "contract", "-xyz"), false);
  assert.equal(argvAttachesValue(["--other=-abc"], "contract", "-abc"), false);
  assert.equal(argvAttachesValue(["contract=-abc", "--=-abc"], "contract", "-abc"), false);
});
