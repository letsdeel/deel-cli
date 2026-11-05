import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../scripts/check-manifest.ts";
import { commandMap } from "../src/commands.map.ts";
import { manifest } from "../src/manifest.generated.ts";

const entry = { command: "things drop", method: "POST", path: "/things/{id}/drop", confirm: "Drop {id}?" } as (typeof commandMap)[number];
const descriptor = { ...manifest.descriptors[0], command: ["things", "drop"], method: "POST", path: "/things/{id}/drop", variant: undefined, confirm: "Drop {id}?" } as (typeof manifest.descriptors)[number];

test("check accepts a descriptor whose confirm matches its map entry", () => {
  assert.deepEqual(check([descriptor], [entry]), []);
});

test("check reports a descriptor whose confirm differs from its map entry", () => {
  const errors = check([{ ...descriptor, confirm: "Something else?" }], [entry]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[confirm\] things drop POST \/things\/\{id\}\/drop/);
});

test("check reports a descriptor that dropped the confirm its map entry sets", () => {
  const { confirm: _dropped, ...withoutConfirm } = descriptor;
  const errors = check([withoutConfirm as typeof descriptor], [entry]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[confirm\]/);
});

test("check passes on the real manifest and command map", () => {
  assert.deepEqual(check(), []);
});
