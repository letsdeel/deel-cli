import { test } from "node:test";
import assert from "node:assert/strict";
import { check, headerErrors } from "../scripts/check-manifest.ts";
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

const fileEntry = commandMap.find((e) => e.command === "files status")!;
const fileDescriptor = manifest.descriptors.find((d) => d.command.join(" ") === "files status")!;

test("the header flags of the map and the manifest agree for a generated command", () => {
  assert.deepEqual(headerErrors([fileEntry], [fileDescriptor]), []);
});

test("a header flag missing from the manifest is reported", () => {
  const withoutHeaders = { ...fileDescriptor, params: fileDescriptor.params.filter((param) => param.in !== "header") };
  assert.deepEqual(headerErrors([fileEntry], [withoutHeaders]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [] differ from map [one_time_secret=x-one-time-secret]",
  ]);
});

test("a header flag the map does not name is reported", () => {
  const { headers: _headers, ...plainEntry } = fileEntry;
  assert.deepEqual(headerErrors([plainEntry], [fileDescriptor]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [one_time_secret=x-one-time-secret] differ from map []",
  ]);
});

test("a header flag that fills the wrong HTTP header is reported", () => {
  const wrongHeader = { ...fileDescriptor, params: fileDescriptor.params.map((param) => (param.in === "header" ? { ...param, header: "x-other" } : param)) };
  assert.deepEqual(headerErrors([fileEntry], [wrongHeader]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [one_time_secret=x-other] differ from map [one_time_secret=x-one-time-secret]",
  ]);
});

test("a header flag without a header target is reported", () => {
  const noTarget = { ...fileDescriptor, params: fileDescriptor.params.map(({ header: _header, ...param }) => param) };
  assert.deepEqual(headerErrors([fileEntry], [noTarget]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [one_time_secret=] differ from map [one_time_secret=x-one-time-secret]",
  ]);
});

test("the header name is compared without regard to case", () => {
  const upper = { ...fileDescriptor, params: fileDescriptor.params.map((param) => (param.in === "header" ? { ...param, header: "X-One-Time-Secret" } : param)) };
  assert.deepEqual(headerErrors([fileEntry], [upper]), []);
});
