// HTTP transport as a swappable interface with a composable middleware chain.
// Cross-cutting concerns (auth header, version, request-id, retry, logging) are
// middlewares — the executor just builds a request and calls the composed transport.

import { CliError } from "./errors.ts";
import { redactHeaders } from "./auth.ts";
import { isCertError, TLS_HINT, installCaTrust } from "./tls.ts";
import type { Logger } from "./logging.ts";
import { bodyLoggingEnabled } from "./logging.ts";
import { HEADER, HTTP_TIMEOUT_MS, RETRY_MAX_ATTEMPTS, RETRY_BASE_DELAY_MS } from "./constants.ts";

export type HttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
  timeoutMs?: number;
  retryable?: boolean;
  meta?: Record<string, unknown>; // extra fields for logging (command, idempotency key, ...)
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  json: unknown;
};

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
export type Middleware = (next: Transport) => Transport;

// Compose so the first middleware is the outermost wrapper.
export function compose(base: Transport, ...middlewares: Middleware[]): Transport {
  return middlewares.reduceRight((next, middleware) => middleware(next), base);
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => (result[name] = value));
  return result;
}

// Base transport: one real fetch, with a timeout. No retries/headers here.
export const fetchTransport: Transport = async (request) => {
  installCaTrust(); // trust the OS store (once) before the first request
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body ?? undefined, signal: controller.signal });
    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, headers: headersToObject(response.headers), text, json };
  } catch (error) {
    const failure = error as Error;
    if (failure.name === "AbortError") throw new CliError("network.timeout", `Request timed out: ${request.method} ${request.url}`);
    if (isCertError(error)) throw new CliError("network.tls", `TLS verification failed: ${request.url}`, TLS_HINT);
    throw new CliError("network.error", `Network error: ${failure.message}`);
  } finally {
    clearTimeout(timer);
  }
};

// ---------------- middlewares ----------------

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Attach the bearer token, but never over a non-https URL (also guards redirects).
export function withAuth(token: string | null): Middleware {
  return (next) => (request) => {
    const willSendCredential = Boolean(token) || Boolean(request.headers[HEADER.authorization]);
    if (willSendCredential && !isHttps(request.url)) {
      throw new CliError("network.insecure", `Refusing to send credentials over a non-https URL: ${request.url}`, "Only https endpoints are supported.");
    }
    if (token && !request.headers[HEADER.authorization]) request.headers[HEADER.authorization] = `Bearer ${token}`;
    return next(request);
  };
}

export function withVersion(version: string): Middleware {
  return (next) => (request) => {
    if (!request.headers[HEADER.cliVersion]) request.headers[HEADER.cliVersion] = version;
    return next(request);
  };
}

export function withRequestId(newRequestId: () => string): Middleware {
  return (next) => (request) => {
    if (!request.headers[HEADER.requestId]) request.headers[HEADER.requestId] = newRequestId();
    return next(request);
  };
}

// Retry idempotent requests on 429/5xx, honoring Retry-After.
export function withRetry(maxAttempts = RETRY_MAX_ATTEMPTS): Middleware {
  return (next) => async (request) => {
    const attempts = request.retryable ? maxAttempts : 1;
    let lastResponse: HttpResponse | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const response = await next(request);
      lastResponse = response;
      const retriable = response.status === 429 || response.status >= 500;
      if (!retriable || attempt >= attempts) return response;
      const retryAfter = Number(response.headers[HEADER.retryAfter]);
      const backoffMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
    return lastResponse as HttpResponse;
  };
}

// Drop the query string (it can carry identifiers/PII) from a logged URL.
function urlPath(url: string): string {
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

// Metadata only by default; the response body is included (redacted) only under --log-bodies.
export function withLogging(logger: Logger, clock: () => number): Middleware {
  return (next) => async (request) => {
    const startedAt = clock();
    const response = await next(request);
    const withBodies = bodyLoggingEnabled();
    const entry: Record<string, unknown> = {
      kind: "request",
      ...(request.meta ?? {}),
      method: request.method,
      url: withBodies ? request.url : urlPath(request.url),
      request_id: request.headers[HEADER.requestId],
      status: response.status,
      duration_ms: clock() - startedAt,
      headers: redactHeaders(request.headers),
    };
    if (withBodies) entry.response = response.json;
    logger(entry);
    return response;
  };
}
