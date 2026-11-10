// Bounded, redacted local logging (NDJSON). Fail-open, size-capped rotation.
// Local-only; separate from network telemetry. Disable with --no-log / DEEL_LOG=off.

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { LOG_DIR_MODE, LOG_FILE_MODE, LOG_MAX_BYTES_DEFAULT, LOG_MAX_FILES_DEFAULT, LINK_KEY_WORDS, SENSITIVE_LOG_KEYS, SENSITIVE_LOG_WORDS } from "./constants.ts";

// A logger is any sink for structured entries; the default writes bounded NDJSON.
export type Logger = (entry: Record<string, unknown>) => void;

const maxBytes = Number(process.env.DEEL_LOG_MAX_SIZE ?? LOG_MAX_BYTES_DEFAULT);
const maxFiles = Number(process.env.DEEL_LOG_MAX_FILES ?? LOG_MAX_FILES_DEFAULT);

let enabled = true;
export function setLoggingEnabled(value: boolean) {
  enabled = value && process.env.DEEL_LOG !== "off";
}

// Response bodies are logged only when opted in (--log-bodies / DEEL_LOG_BODIES=1).
let logBodies = process.env.DEEL_LOG_BODIES === "1";
export function setLogBodiesEnabled(value: boolean) {
  logBodies = value || process.env.DEEL_LOG_BODIES === "1";
}
export function bodyLoggingEnabled(): boolean {
  return logBodies;
}

function logDir(): string {
  if (process.env.DEEL_LOG_DIR) return process.env.DEEL_LOG_DIR;
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Logs", "deel");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA ?? home, "deel", "logs");
  return join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "deel", "logs");
}

// Match by substring so variants (access_token, tax_id, …) are caught, not just exact keys; the short names that
// would match inside other words are matched as whole words of the key.
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const needle of SENSITIVE_LOG_KEYS) if (lower.includes(needle)) return true;
  return keyWords(key).some((word) => SENSITIVE_LOG_WORDS.has(word));
}

// A key's words: `download_url`, `downloadUrl` and `download-url` are all download + url.
export function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Whether a key names a link (a url, uri, link or href), whose value may be signed in its query or fragment.
export function isLinkKey(key: string): boolean {
  return keyWords(key).some((word) => LINK_KEY_WORDS.has(word));
}

// A pre-signed link works for whoever holds it, and the signature sits in its query string or fragment, so those
// are cut; the scheme, host and path stay for debugging.
export function maskLink(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : `${value.slice(0, cut)}?***`;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

// A value that is personal data whatever key carries it: an email address (`?q=ana@example.com`, a free-text `note`) or
// a JWT-shaped token. Key names can't catch a search or filter parameter, or a note, that holds one. Read as a single
// pass over the text, split into tokens at whitespace and URL or punctuation delimiters, with plain checks on each
// token (no regular expression over unbounded input, so a long run of `a@a.` can't make it quadratic).
const TOKEN_DELIMITERS = new Set("/?&=,;<>()[]{}\"'");
const BASE64URL = /^[\w-]+$/;
const isDelimiter = (char: string): boolean => TOKEN_DELIMITERS.has(char) || /\s/.test(char);

function isEmail(token: string): boolean {
  const at = token.indexOf("@");
  if (at < 1) return false;
  const domain = token.slice(at + 1);
  for (let index = 1; index < domain.length - 1; index++) if (domain[index] === "." && domain[index - 1] !== "." && domain[index + 1] !== "." && domain[index + 1] !== "@") return true;
  return false;
}

function isJwt(token: string): boolean {
  if (!token.startsWith("eyJ")) return false;
  const parts = token.split(".");
  return parts.length === 3 && BASE64URL.test(parts[0]) && BASE64URL.test(parts[1]) && (parts[2] === "" || BASE64URL.test(parts[2]));
}

const isPersonalToken = (token: string): boolean => isEmail(token) || isJwt(token);

function scanPersonal(text: string, mask: boolean): { found: boolean; text: string } {
  const out: string[] = [];
  let found = false;
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && !isDelimiter(text[index])) continue;
    const token = text.slice(start, index);
    if (token && isPersonalToken(token)) {
      found = true;
      if (!mask) return { found, text };
      out.push("***");
    } else out.push(token);
    if (index < text.length) out.push(text[index]);
    start = index + 1;
  }
  return { found, text: out.join("") };
}

export const looksPersonal = (text: string): boolean => scanPersonal(text, false).found;
const maskPersonalText = (text: string): string => scanPersonal(text, true).text;

// A request URL with the values of its sensitive query parameters masked, by the same key policy as a body field
// (`?email=...`, `?personalId=...`, `?ids[]=...`, a repeated key, an encoded key); the other parameters, the path and the
// host stay readable. The fragment is never sent to a server and may hold a token, so it is cut. A value under a link key
// (`?redirect_url=...`) loses its own query like a link in a body. Text that isn't a URL passes unchanged.
export function maskUrlQuery(url: string): string {
  const hash = url.indexOf("#");
  const withoutFragment = hash === -1 ? url : url.slice(0, hash);
  const cut = withoutFragment.indexOf("?");
  if (cut === -1) return hash === -1 ? url : `${withoutFragment}#***`;
  const params = withoutFragment
    .slice(cut + 1)
    .split("&")
    .map((pair) => {
      const equals = pair.indexOf("=");
      if (equals === -1) return pair;
      const key = decoded(pair.slice(0, equals)).replace(/\[\]$/, "");
      const value = pair.slice(equals + 1);
      if (isSensitiveKey(key)) return `${pair.slice(0, equals)}=***`;
      if (isLinkKey(key)) return `${pair.slice(0, equals)}=${encodeURIComponent(maskPersonalText(maskLink(decoded(value))))}`;
      return looksPersonal(decoded(value)) ? `${pair.slice(0, equals)}=${encodeURIComponent(maskPersonalText(decoded(value)))}` : pair;
    });
  return `${withoutFragment.slice(0, cut)}?${params.join("&")}${hash === -1 ? "" : "#***"}`;
}

// `link` is true under a link key, which masks the query of the strings it holds (or lists). The entry's own top-level
// keys are not redacted this way: its `url` is the request URL, kept whole under --log-bodies.
function redact(value: unknown, link = false): unknown {
  if (typeof value === "string") return maskPersonalText(link ? maskLink(value) : value);
  if (Array.isArray(value)) return value.map((item) => redact(item, link));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = isSensitiveKey(key) ? "***" : redact(nested, isLinkKey(key));
    }
    return redacted;
  }
  return value;
}

function redactEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) redacted[key] = isSensitiveKey(key) ? "***" : redact(value);
  return redacted;
}

function rotate(file: string) {
  try {
    if (!existsSync(file)) return;
    if (statSync(file).size < maxBytes) return;
    for (let index = maxFiles - 1; index >= 1; index--) {
      const source = index === 1 ? file : `${file}.${index - 1}`;
      const target = `${file}.${index}`;
      if (existsSync(source)) renameSync(source, target);
    }
  } catch {
    /* fail-open */
  }
}

export function log(entry: Record<string, unknown>): void {
  if (!enabled) return;
  try {
    const dir = logDir();
    mkdirSync(dir, { recursive: true, mode: LOG_DIR_MODE });
    const file = join(dir, "deel.log");
    rotate(file);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...redactEntry(entry) }) + "\n";
    appendFileSync(file, line, { mode: LOG_FILE_MODE });
  } catch {
    /* fail-open: logging must never break a command */
  }
}

export function logLocation(): string {
  return join(logDir(), "deel.log");
}
