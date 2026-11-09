// A minimal MCP client: one JSON-RPC `tools/call` per HTTP POST, no session and no SDK. The server is
// stateless, so no `initialize` handshake is needed. A tool failure comes back as HTTP 200 with `isError`
// and a JSON text payload; this module returns it as data and leaves its meaning to the caller.

import { CliError } from "./errors.ts";
import { HEADER, MCP_ACCEPT } from "./constants.ts";
import type { Transport } from "./http.ts";

export type ToolResult = {
  isError: boolean;
  texts: string[]; // the text items of `content`, in order
  requestId: string;
};

// The error payload the server puts in an `isError` result's first text item.
export type ToolFailure = {
  statusCode?: number; // absent when the server's payload carries none
  code?: string;
  message: string;
  details?: unknown;
};

export type CallToolOpts = {
  http: Transport;
  url: string;
  requestId: string;
  name: string;
  args: Record<string, unknown>;
  retryable: boolean;
  // Called once when the server answers HTTP 401; returns true when a retry may help (a refreshed login).
  onUnauthorized?: () => Promise<boolean>;
  command?: string;
};

type RpcMessage = { jsonrpc?: string; id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };

// A Streamable HTTP response is either one JSON body or an SSE stream whose `data:` lines carry the messages.
export function parseRpcBody(text: string, contentType: string | undefined, id: number): RpcMessage | null {
  if (contentType?.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data:".length).trim()) as RpcMessage;
        } catch {
          return null;
        }
      })
      .filter((message): message is RpcMessage => message !== null);
    return messages.find((message) => message.id === id) ?? null;
  }
  try {
    const message: unknown = JSON.parse(text);
    return message && typeof message === "object" && !Array.isArray(message) ? (message as RpcMessage) : null;
  } catch {
    return null;
  }
}

function printable(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500) : fallback;
}

export async function callTool(opts: CallToolOpts): Promise<ToolResult> {
  const id = 1;
  const send = () =>
    opts.http({
      method: "POST",
      url: opts.url,
      headers: {
        [HEADER.accept]: MCP_ACCEPT,
        [HEADER.contentType]: "application/json",
        [HEADER.requestId]: opts.requestId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: opts.name, arguments: opts.args } }),
      retryable: opts.retryable,
      // The reply carries the action's output as a JSON string, so the log's key masking can't see into it.
      omitBodyFromLog: true,
      meta: { command: opts.command ?? "mcp", tool: opts.name },
    });

  let response = await send();
  // A 401 is answered before the tool runs, so one retry with a renewed login is safe even for a write.
  if (response.status === 401 && opts.onUnauthorized && (await opts.onUnauthorized())) response = await send();
  if (response.status === 401) {
    throw withRequestId(new CliError("auth.expired", "The Deel login was rejected.", "deel auth login"), opts.requestId);
  }
  if (response.status < 200 || response.status >= 300) {
    throw withRequestId(new CliError(`http.${response.status}`, `The MCP endpoint answered HTTP ${response.status}.`), opts.requestId);
  }

  const message = parseRpcBody(response.text, response.headers[HEADER.contentType], id);
  if (!message) throw withRequestId(new CliError("mcp.response", "The MCP endpoint sent a response that is not JSON-RPC."), opts.requestId);
  if (message.error) {
    const text = printable(message.error.message, "JSON-RPC error");
    // An unregistered tool: the server has app actions switched off.
    if (/-32601|-32602/.test(String(message.error.code)) && /not found|unknown tool/i.test(text)) {
      throw withRequestId(new CliError("app.unavailable", "Web-app actions are not available on this server.", "They are rolled out per organization."), opts.requestId);
    }
    throw withRequestId(new CliError("mcp.rpc", `${text} (JSON-RPC ${String(message.error.code ?? "error")})`), opts.requestId);
  }

  // A gateway's own 200 (`{}`, a plain message) is not a tool result, and must not read as an empty success.
  if (!message.result || typeof message.result !== "object" || Array.isArray(message.result)) {
    throw withRequestId(new CliError("mcp.response", "The MCP endpoint sent a response without a tool result."), opts.requestId);
  }
  const result = message.result as { isError?: unknown; content?: unknown };
  if (!Array.isArray(result.content)) {
    throw withRequestId(new CliError("mcp.response", "The MCP endpoint sent a tool result without content."), opts.requestId);
  }
  const content = result.content;
  const texts = content
    .filter((item): item is { type: string; text: string } => Boolean(item) && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text);
  return { isError: result.isError === true, texts, requestId: opts.requestId };
}

// Reads `{statusCode, message, errors: [{code}], details}` from an `isError` result.
export function toolFailure(result: ToolResult): ToolFailure {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(result.texts[0] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    /* plain-text error */
  }
  const errors = Array.isArray(payload.errors) ? (payload.errors as Array<Record<string, unknown>>) : [];
  const code = errors.find((error) => typeof error?.code === "string" && error.code)?.code as string | undefined;
  const statusCode = typeof payload.statusCode === "number" ? payload.statusCode : undefined;
  const message = printable(payload.message ?? result.texts[0], "The tool call failed.");
  return { ...(statusCode !== undefined ? { statusCode } : {}), ...(code ? { code } : {}), message, ...(payload.details !== undefined ? { details: payload.details } : {}) };
}

function withRequestId(error: CliError, requestId: string): CliError {
  error.requestId = requestId;
  return error;
}
