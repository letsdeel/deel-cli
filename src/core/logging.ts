// Bounded, redacted local logging (NDJSON). Fail-open, size-capped rotation.
// Local-only; separate from network telemetry. Disable with --no-log / DEEL_LOG=off.

import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { LOG_DIR_MODE, LOG_FILE_MODE, LOG_MAX_BYTES_DEFAULT, LOG_MAX_FILES_DEFAULT, LINK_KEY_WORDS, SENSITIVE_LOG_KEYS } from "./constants.ts";

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

// Match by substring so variants (access_token, tax_id, …) are caught, not just exact keys.
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const needle of SENSITIVE_LOG_KEYS) if (lower.includes(needle)) return true;
  return false;
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

// `link` is true under a link key, which masks the query of the strings it holds (or lists). The entry's own top-level
// keys are not redacted this way: its `url` is the request URL, kept whole under --log-bodies.
function redact(value: unknown, link = false): unknown {
  if (typeof value === "string") return link ? maskLink(value) : value;
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
