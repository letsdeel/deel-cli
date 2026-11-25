#!/usr/bin/env node
// DeelCLI entry point. Runs directly under Node 22 (type-stripping) or Bun.

import { run } from "./cli.ts";
import { CliError, EXIT, failureEnvelope } from "./core/errors.ts";
import { reexecWithSystemCa } from "./core/tls.ts";
import { exitAfterFlush } from "./core/io.ts";

// CA trust (OS store by default) is installed lazily in the HTTP transport, so
// offline commands (--help, --generate-input) stay fast.
run(process.argv.slice(2))
  .then((code) => exitAfterFlush(code))
  .catch((err) => {
    // Bun's binary ignores setDefaultCACertificates; retry once trusting the OS store.
    if (err instanceof CliError && err.code === "network.tls") reexecWithSystemCa(); // exits on retry; returns if already retried
    process.stderr.write(JSON.stringify(failureEnvelope(err), null, 2) + "\n");
    exitAfterFlush(EXIT.ERROR);
  });
