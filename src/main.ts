#!/usr/bin/env node
// DeelCLI entry point. Runs directly under Node 22 (type-stripping) or Bun.

import { run } from "./cli.ts";
import { CliError, EXIT, isParserError, toEnvelope, usageEnvelope } from "./core/errors.ts";
import { reexecWithSystemCa } from "./core/tls.ts";

// CA trust (OS store by default) is installed lazily in the HTTP transport, so
// offline commands (--help, --generate-input) stay fast.
run(process.argv.slice(2))
  .then((code) => {
    // Not process.exit: it can cut off stdout still queued on a pipe, e.g. a large JSON result piped to jq.
    process.exitCode = code;
  })
  .catch((err) => {
    if (err instanceof CliError) {
      // Bun's binary ignores setDefaultCACertificates; retry once trusting the OS store.
      if (err.code === "network.tls") reexecWithSystemCa(); // exits on retry; returns if already retried
      process.stderr.write(JSON.stringify({ error: toEnvelope(err) }, null, 2) + "\n");
      process.exit(EXIT.ERROR);
    }
    if (isParserError(err)) {
      process.stderr.write(JSON.stringify({ error: usageEnvelope(err as Error) }, null, 2) + "\n");
      process.exit(EXIT.ERROR);
    }
    process.stderr.write(JSON.stringify({ error: { code: "unexpected", message: (err as Error).message } }, null, 2) + "\n");
    process.exit(EXIT.ERROR);
  });
