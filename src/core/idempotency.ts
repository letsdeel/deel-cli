// Deterministic idempotency keys: UUIDv5 over a canonicalized request, so an
// identical re-run sends the identical key and the server dedupes. Overridable
// by an explicit --idempotency-key. Pure Node crypto — no addon.

import { createHash, randomUUID } from "node:crypto";
import { IDEMPOTENCY_NAMESPACE } from "./constants.ts";

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function uuidv5(name: string, namespace: string = IDEMPOTENCY_NAMESPACE): string {
  const digest = createHash("sha1").update(Buffer.concat([uuidToBytes(namespace), Buffer.from(name, "utf8")])).digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

export function newRequestId(): string {
  return randomUUID();
}

// Stable stringify with recursively sorted object keys.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  return `{${sortedKeys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

export type CanonicalRequest = {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
};

export function deriveIdempotencyKey(request: CanonicalRequest): string {
  return uuidv5(canonicalize({ method: request.method.toUpperCase(), path: request.path, query: request.query, body: request.body }));
}
