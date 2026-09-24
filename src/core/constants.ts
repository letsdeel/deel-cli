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
// Substrings matched (case-insensitive) against keys; a match masks the value.
export const SENSITIVE_LOG_KEYS = new Set([
  "token", "password", "secret", "authorization", "credential",
  "api_key", "apikey", "ssn", "tax", "iban", "swift", "email",
  "phone", "mobile", "dob", "birth", "address", "bank", "card",
  "cvv", "cvc", "pin", "passport", "national_id", "routing", "account_number",
]);

// --- Idempotency ---
// Fixed DeelCLI namespace for deterministic UUIDv5 keys.
export const IDEMPOTENCY_NAMESPACE = "8f4b6c1e-3d2a-4f9c-9a1b-7e5d0c2a1f00";

// --- Environment detection ---
// Presence of any of these (CI must equal "true") forces non-interactive mode.
export const AGENT_ENV_SIGNALS = ["CI", "CLAUDE_CODE", "CURSOR", "CODEX"] as const;

// --- Command resolver vocabulary ---
export const RESERVED_COMMANDS = new Set(["job", "auth"]);
export const COMMAND_SUFFIX_MODIFIERS = ["-bulk", "-async"];

// --- Header names (lowercase; fetch normalizes) ---
export const HEADER = {
  authorization: "authorization",
  accept: "accept",
  contentType: "content-type",
  requestId: "x-request-id",
  cliVersion: "x-deel-cli-version",
  apiVersion: "x-version",         // API spec version; omitted when descriptor.version is absent
  idempotencyKey: "idempotency-key",
  retryAfter: "retry-after",
} as const;
