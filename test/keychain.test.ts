import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { macStore } from "../src/core/keychain.ts";
import { writeOAuthEntry, readOAuthEntry, removeOAuthEntry, CHUNK_SIZE } from "../src/core/oauth.ts";
import type { OAuthEntry } from "../src/core/oauth.ts";
import { pathWith, stubDir, tempDir } from "./stubs.ts";

const entry: OAuthEntry = {
  v: 2,
  access_token: 'ey"quoted\\back.slash',
  refresh_token: "refresh/+=",
  expires_at: "2030-01-01T00:00:00.000Z",
};
const ISSUER = "https://api.letsdeel.com";
const ACCOUNT = "oauth:https://api.letsdeel.com";

test("a JSON credential survives security -i quoting (quotes and backslashes)", (t) => {
  const dir = tempDir(t);
  const capture = join(dir, "stdin.txt");
  const stubs = stubDir(t, { security: `cat >> "${capture}"` });
  const savedPath = process.env.PATH;
  process.env.PATH = pathWith(stubs);
  t.after(() => {
    process.env.PATH = savedPath;
  });

  assert.equal(writeOAuthEntry(macStore, ISSUER, entry), true);

  const line = readFileSync(capture, "utf8");
  const lines = line.split("\n").filter(Boolean);
  assert.equal(lines.length, 2, "a chunk, then the manifest");
  assert.ok(lines[0].startsWith(`add-generic-password -U -s "deel-cli" -a "${ACCOUNT}#0" -w "`));
  assert.ok(lines[1].startsWith(`add-generic-password -U -s "deel-cli" -a "${ACCOUNT}" -w "`));
  // security(1) unescapes \" and \\ exactly like a JSON string does, so decoding the quoted
  // argument must give back the stored chunk byte for byte.
  const quoted = lines[0].slice(lines[0].indexOf('-w "') + 3);
  assert.equal(JSON.parse(quoted), JSON.stringify(entry));
});

test("readOAuthEntry ignores a raw PAT, a missing manifest and an unavailable keychain", () => {
  const store = (value: string | null) => ({ available: () => true, get: () => value, set: () => true, remove: () => true });
  assert.equal(readOAuthEntry(store("pat_raw_token"), ISSUER), null);
  assert.equal(readOAuthEntry(store(null), ISSUER), null);
  assert.equal(readOAuthEntry(store(JSON.stringify({ v: 1, chunks: 1 })), ISSUER), null);
  assert.equal(readOAuthEntry({ ...store(JSON.stringify(entry)), available: () => false }, ISSUER), null);
});

// A fake `security`: -i parses add-generic-password lines from stdin (undoing the quoting) into one file per
// account; find / delete work on those files. Every invocation's argv is logged so a test can prove no secret
// is ever passed in argv.
const FAKE_SECURITY = `
const fs = require("fs"); const path = require("path");
const [dir, log, ...argv] = process.argv.slice(2);
fs.appendFileSync(log, argv.join(" ") + "\\n");
const file = (account) => path.join(dir, Buffer.from(account).toString("hex"));
const arg = (name) => argv[argv.indexOf(name) + 1];
const unquote = (text) => JSON.parse(text);
if (argv[0] === "-i") {
  for (const line of fs.readFileSync(0, "utf8").split("\\n").filter(Boolean)) {
    const m = /^add-generic-password -U -s ("(?:[^"\\\\]|\\\\.)*") -a ("(?:[^"\\\\]|\\\\.)*") -w ("(?:[^"\\\\]|\\\\.)*")$/.exec(line);
    if (!m) { console.error("security: bad line"); process.exit(1); }
    fs.writeFileSync(file(unquote(m[2])), unquote(m[3]));
  }
} else if (argv[0] === "find-generic-password") {
  const f = file(arg("-a"));
  if (!fs.existsSync(f)) process.exit(44);
  process.stdout.write(fs.readFileSync(f, "utf8") + "\\n");
} else if (argv[0] === "delete-generic-password") {
  const f = file(arg("-a"));
  if (!fs.existsSync(f)) process.exit(44);
  fs.unlinkSync(f);
}
`;

function fakeSecurity(t: import("node:test").TestContext) {
  const dir = tempDir(t);
  const items = join(dir, "items");
  const log = join(dir, "argv.log");
  const script = join(dir, "fake-security.cjs");
  mkdirSync(items);
  writeFileSync(script, FAKE_SECURITY);
  const stubs = stubDir(t, { security: `exec "${process.execPath}" "${script}" "${items}" "${log}" "$@"` });
  const saved = process.env.PATH;
  process.env.PATH = pathWith(stubs);
  t.after(() => {
    process.env.PATH = saved;
  });
  return {
    argv: () => (existsSync(log) ? readFileSync(log, "utf8") : ""),
    accounts: () => readdirSync(items).map((name) => Buffer.from(name, "hex").toString()).sort(),
    drop: (account: string) => unlinkSync(join(items, Buffer.from(account).toString("hex"))),
    corrupt: (account: string, value: string) => writeFileSync(join(items, Buffer.from(account).toString("hex")), value),
  };
}

const big = (size: number): OAuthEntry => ({ ...entry, access_token: ('x"\\y').repeat(Math.ceil(size / 4)).slice(0, size) });

test("a ~10 KB login round-trips through security in several short items, never through argv", (t) => {
  const fake = fakeSecurity(t);
  const large = big(10_000);
  assert.equal(writeOAuthEntry(macStore, ISSUER, large), true);
  const chunks = Math.ceil(JSON.stringify(large).length / CHUNK_SIZE);
  assert.ok(chunks >= 4);
  assert.deepEqual(fake.accounts(), [ACCOUNT, ...Array.from({ length: chunks }, (_, index) => `${ACCOUNT}#${index}`)].sort());
  assert.deepEqual(readOAuthEntry(macStore, ISSUER), large);
  const argv = fake.argv();
  assert.equal(argv.includes(large.access_token), false);
  assert.equal(argv.includes(large.refresh_token), false);
  assert.equal(argv.includes(large.access_token.slice(0, 40)), false);
  assert.ok(CHUNK_SIZE <= 3000);
});

test("rewriting with a smaller entry removes the stale chunks", (t) => {
  const fake = fakeSecurity(t);
  writeOAuthEntry(macStore, ISSUER, big(10_000));
  assert.equal(writeOAuthEntry(macStore, ISSUER, entry), true);
  assert.deepEqual(fake.accounts(), [ACCOUNT, `${ACCOUNT}#0`]);
  assert.deepEqual(readOAuthEntry(macStore, ISSUER), entry);
});

test("removing a login deletes the manifest and every chunk", (t) => {
  const fake = fakeSecurity(t);
  writeOAuthEntry(macStore, ISSUER, big(10_000));
  assert.equal(removeOAuthEntry(macStore, ISSUER), true);
  assert.deepEqual(fake.accounts(), []);
  assert.equal(removeOAuthEntry(macStore, ISSUER), false);
});

test("a missing chunk or damaged data means no login", (t) => {
  const fake = fakeSecurity(t);
  writeOAuthEntry(macStore, ISSUER, big(10_000));
  fake.drop(`${ACCOUNT}#2`);
  assert.equal(readOAuthEntry(macStore, ISSUER), null);
  writeOAuthEntry(macStore, ISSUER, big(10_000));
  fake.corrupt(`${ACCOUNT}#0`, "garbage");
  assert.equal(readOAuthEntry(macStore, ISSUER), null);
  fake.corrupt(ACCOUNT, "not json");
  assert.equal(readOAuthEntry(macStore, ISSUER), null);
  fake.corrupt(ACCOUNT, JSON.stringify({ v: 2, chunks: 9999 }));
  assert.equal(readOAuthEntry(macStore, ISSUER), null);
});

test("the keychain account is derived from the issuer origin", (t) => {
  const fake = fakeSecurity(t);
  writeOAuthEntry(macStore, "https://api-staging.letsdeel.com/", entry);
  assert.deepEqual(fake.accounts(), ["oauth:https://api-staging.letsdeel.com", "oauth:https://api-staging.letsdeel.com#0"]);
});

test("a login stored for one issuer is not found under another", (t) => {
  fakeSecurity(t);
  writeOAuthEntry(macStore, ISSUER, entry);
  assert.deepEqual(readOAuthEntry(macStore, ISSUER), entry);
  assert.equal(readOAuthEntry(macStore, "https://api-staging.letsdeel.com"), null);
  assert.equal(readOAuthEntry(macStore, "https://other.example.test"), null);
});

test("an entry that is not version 2 reads as no login", (t) => {
  const fake = fakeSecurity(t);
  writeOAuthEntry(macStore, ISSUER, entry);
  fake.corrupt(`${ACCOUNT}#0`, JSON.stringify({ ...entry, v: 1 }));
  assert.equal(readOAuthEntry(macStore, ISSUER), null);
});

test("a stored login stays small with a realistic JWT", (t) => {
  const fake = fakeSecurity(t);
  const jwt = ["h".repeat(40), Buffer.from(JSON.stringify({ scope: "people:read ".repeat(135) })).toString("base64url"), "s".repeat(342)].join(".");
  writeOAuthEntry(macStore, ISSUER, { ...entry, access_token: jwt });
  assert.equal(fake.accounts().length, 2, "one chunk plus the manifest");
});
