// Central home for tunables and shared vocabulary, so magic numbers and
// duplicated string sets don't drift across the codebase.

// --- HTTP transport ---
export const HTTP_TIMEOUT_MS = 30_000;
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 200;

// --- Local logging ---
export const LOG_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
export const LOG_MAX_FILES_DEFAULT = 5;
export const LOG_DIR_MODE = 0o700;  // owner read/write/enter; no group or other access
export const LOG_FILE_MODE = 0o600; // owner read/write only
// What the local log masks by key name: credentials, and links that sign the holder in or fetch a file. Response
// fields the spec marks sensitive are masked at their position in the response (maskMarkedFields, core/logging.ts).
// Substrings, matched (case-insensitive) against the whole key, so variants (access_token, api_key) are caught.
// Credentials are exported on their own because test/constants.test.ts reads the same vocabulary.
export const CREDENTIAL_LOG_KEYS = [
  "token", "password", "passwd", "secret", "authorization", "credential", "api_key", "apikey", "private_key", "access_key",
  "signing_key", "signature", "magic_link", "cvv", "cvc", "pin",
];
export const CREDENTIAL_LOG_WORDS = ["otp", "mfa", "passcode", "pass", "cookie", "jwt", "session"];
export const SENSITIVE_LOG_KEYS = new Set([
  ...CREDENTIAL_LOG_KEYS,
  // links that sign the holder in or fetch a file without further auth (magic and pre-signed links)
  "download_link", "upload_url", "pdf_url",
]);
export const SENSITIVE_LOG_WORDS = new Set(CREDENTIAL_LOG_WORDS);
// Words of a key (`download_url`, `downloadUrl`) that name a link. A link in a response body is logged without its
// query string and fragment, where a pre-signed link keeps its signature.
export const LINK_KEY_WORDS = new Set(["url", "urls", "uri", "uris", "link", "links", "href", "hrefs"]);

// --- Executor: withheld fields and one-shot endpoints ---
// Response fields that are secrets the CLI never prints: a webhook's signing key comes back on every webhook read
// and write, and stays viewable in Developer Center. Removed from the top level of data and of each array item.
export const WITHHELD_RESPONSE_FIELDS: Record<string, string> = {
  signing_key: "reveal the signing key in Developer Center → Webhooks",
};

// A key's words: `download_url`, `downloadUrl` and `download-url` are all download + url.
export function keyWords(key: string): string[] {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// The withheld field a response key names, whatever its spelling (`signing_key`, `signingKey`, `Signing-Key`), or
// undefined. Matched by name only: an inherited property such as `constructor` is not a field.
const WITHHELD_BY_SPELLING = new Map(Object.keys(WITHHELD_RESPONSE_FIELDS).map((name) => [keyWords(name).join("_"), name]));
export function withheldFieldFor(key: string): string | undefined {
  return WITHHELD_BY_SPELLING.get(keyWords(key).join("_"));
}

// Endpoints whose every call acts again (a test delivery): sent once, with no retry and no derived Idempotency-Key,
// so running the command again sends a new one. Keyed "METHOD /path" with the path params as {}.
export const SEND_ONCE_ROUTES = new Set(["POST /webhooks/{}/simulate"]);
// Endpoints whose 2xx response says whether the call worked: when that field is false, the response is printed and
// the command then exits 1 with the hint. Keyed like SEND_ONCE_ROUTES.
export const OUTCOME_ROUTES: Record<string, { field: string; hint: string }> = {
  "POST /webhooks/{}/simulate": { field: "is_success", hint: "The test delivery did not succeed; the printed response shows what the receiver answered." },
};

// --- Idempotency ---
// Fixed DeelCLI namespace for deterministic UUIDv5 keys.
export const IDEMPOTENCY_NAMESPACE = "8f4b6c1e-3d2a-4f9c-9a1b-7e5d0c2a1f00";

// --- Environment detection ---
// Presence of any of these (CI must equal "true") forces non-interactive mode.
export const AGENT_ENV_SIGNALS = ["CI", "CLAUDE_CODE", "CURSOR", "CODEX"] as const;

// --- Command resolver vocabulary ---
export const RESERVED_COMMANDS = new Set(["job", "auth", "commands"]);
export const COMMAND_SUFFIX_MODIFIERS = ["-bulk", "-async"];

// --- Header names (lowercase; fetch normalizes) ---
export const HEADER = {
  authorization: "authorization",
  accept: "accept",
  contentType: "content-type",
  requestId: "x-request-id",
  cliVersion: "x-deel-cli-version",
  apiVersion: "x-version",         // API version; omitted with --version none or when no version is known
  beta: "x-beta",
  idempotencyKey: "idempotency-key",
  retryAfter: "retry-after",
} as const;
