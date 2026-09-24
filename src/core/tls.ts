// TLS trust: trust the OS certificate store by default (like Go CLIs and Claude
// Code), so corporate TLS-inspection proxies and internal/dev CAs "just work"
// when their root is installed on the machine — no flags, no env, no re-exec.
//
// Node 22.15+ and Bun both expose tls.getCACertificates()/setDefaultCACertificates(),
// which reconfigure the CA set used by the built-in fetch. We merge:
//   bundled Mozilla + NODE_EXTRA_CA_CERTS  ("default")  +  OS store ("system")  +  --ca-cert files
// Override the sources with DEEL_CERT_STORE (e.g. "bundled" to skip the OS store).

import tls from "node:tls";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type TlsApi = {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: Array<string | Buffer>) => void;
};

function readAllFlagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  const prefix = `--${name}`;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === prefix && argv[index + 1] !== undefined) out.push(argv[++index]);
    else if (token.startsWith(prefix + "=")) out.push(token.slice(prefix.length + 1));
  }
  return out;
}

export function resolveCertConfig(argv: string[], env: NodeJS.ProcessEnv): { caCertPaths: string[]; includeSystem: boolean } {
  const caCertPaths = readAllFlagValues(argv, "ca-cert");
  if (env.DEEL_CA_CERT) caCertPaths.push(env.DEEL_CA_CERT);
  const includeSystem = env.DEEL_CERT_STORE
    ? env.DEEL_CERT_STORE.split(",").map((source) => source.trim()).includes("system")
    : true;
  return { caCertPaths, includeSystem };
}

let installed = false;

// Merge OS + bundled + extra CAs into the process default. Idempotent; safe to
// call before every request. No-ops on runtimes without the API (falls back to
// bundled + NODE_EXTRA_CA_CERTS, which those runtimes still honor).
export function installCaTrust(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  installed = true;
  const api = tls as unknown as TlsApi;
  if (typeof api.getCACertificates !== "function" || typeof api.setDefaultCACertificates !== "function") return;

  const { caCertPaths, includeSystem } = resolveCertConfig(argv, env);
  const certs = new Set<string>(api.getCACertificates("default")); // bundled + NODE_EXTRA_CA_CERTS
  if (includeSystem) {
    try {
      for (const cert of api.getCACertificates("system")) certs.add(cert);
    } catch {
      /* platform without a readable system store — keep going */
    }
  }
  for (const path of caCertPaths) {
    try {
      certs.add(readFileSync(path, "utf8"));
    } catch {
      process.stderr.write(`[deel] warning: could not read --ca-cert file: ${path}\n`);
    }
  }
  try {
    api.setDefaultCACertificates([...certs]);
  } catch {
    /* leave the runtime default in place if this fails */
  }
}

// The compiled Bun binary uses a separate TLS path that ignores
// setDefaultCACertificates(); its native switch for the OS keychain is
// NODE_USE_SYSTEM_CA=1 (read at startup). So on a cert failure we re-exec once
// with that enabled (plus any --ca-cert) — the binary "just works" without the
// user knowing env vars. Sentinel-guarded so it can never loop.
export function reexecWithSystemCa(): void {
  if (process.env.DEEL_TLS_RETRY) return; // already retried — let the caller surface the error
  const isBun = Boolean((process as unknown as { versions?: { bun?: string } }).versions?.bun);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_SYSTEM_CA: "1", DEEL_TLS_RETRY: "1" };
  const { caCertPaths } = resolveCertConfig(process.argv.slice(2), process.env);
  if (caCertPaths[0]) env.NODE_EXTRA_CA_CERTS = caCertPaths[0];

  const nodeFlags = isBun ? [] : ["--use-system-ca"];
  const passthrough = isBun ? process.argv.slice(2) : process.argv.slice(1);
  const child = spawnSync(process.execPath, [...nodeFlags, ...passthrough], { env, stdio: "inherit" });
  process.exit(child.status ?? 1);
}

// Recognize TLS certificate-chain failures so we can give an actionable hint.
const CERT_ERROR_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function isCertError(error: unknown): boolean {
  const anyErr = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = anyErr?.cause?.code ?? anyErr?.code ?? "";
  const message = `${anyErr?.message ?? ""} ${anyErr?.cause?.message ?? ""}`;
  return CERT_ERROR_CODES.has(code) || /certificate|self[- ]signed|unable to verify|CERT_/i.test(message);
}

export const TLS_HINT =
  "TLS verification failed. The OS trust store is trusted by default; ensure your corporate/internal " +
  "root CA is installed there, or point at it with --ca-cert <root.pem> (or NODE_EXTRA_CA_CERTS).";
