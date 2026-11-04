import { test } from "node:test";
import assert from "node:assert/strict";
import { headerErrors } from "../scripts/check-manifest.ts";
import { commandMap } from "../src/commands.map.ts";
import { manifest } from "../src/manifest.generated.ts";

const entry = commandMap.find((e) => e.command === "files status")!;
const descriptor = manifest.descriptors.find((d) => d.command.join(" ") === "files status")!;

test("the header flags of the map and the manifest agree for a generated command", () => {
  assert.deepEqual(headerErrors([entry], [descriptor]), []);
});

test("a header flag missing from the manifest is reported", () => {
  const withoutHeaders = { ...descriptor, params: descriptor.params.filter((param) => param.in !== "header") };
  assert.deepEqual(headerErrors([entry], [withoutHeaders]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [] differ from map [one_time_secret=x-one-time-secret]",
  ]);
});

test("a header flag the map does not name is reported", () => {
  const { headers: _headers, ...plainEntry } = entry;
  assert.deepEqual(headerErrors([plainEntry], [descriptor]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [one_time_secret=x-one-time-secret] differ from map []",
  ]);
});

test("a header flag that fills the wrong HTTP header is reported", () => {
  const wrongHeader = { ...descriptor, params: descriptor.params.map((param) => (param.in === "header" ? { ...param, header: "x-other" } : param)) };
  assert.deepEqual(headerErrors([entry], [wrongHeader]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [one_time_secret=x-other] differ from map [one_time_secret=x-one-time-secret]",
  ]);
});

test("a header flag without a header target is reported", () => {
  const noTarget = { ...descriptor, params: descriptor.params.map(({ header: _header, ...param }) => param) };
  assert.deepEqual(headerErrors([entry], [noTarget]), [
    "[headers] files status GET /files/{file_id}/status: manifest header flags [one_time_secret=] differ from map [one_time_secret=x-one-time-secret]",
  ]);
});

test("the header name is compared without regard to case", () => {
  const upper = { ...descriptor, params: descriptor.params.map((param) => (param.in === "header" ? { ...param, header: "X-One-Time-Secret" } : param)) };
  assert.deepEqual(headerErrors([entry], [upper]), []);
});
