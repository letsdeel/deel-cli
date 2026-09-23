# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it
responsibly by emailing **security@deel.com** rather than opening a public
GitHub issue.

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept (if applicable)
- Any suggested mitigations

We aim to acknowledge reports within 3 business days and will keep you informed
as we investigate and address the issue.

## Scope

The Deel CLI is a thin client that wraps the [Deel Public API](https://developer.deel.com).
It introduces no server-side components or new network-facing attack surface — all
API endpoints it calls are pre-reviewed by Deel's security team. Security concerns
about the API itself should be reported through the same channel above.

The CLI holds credentials **in memory only** and never writes them to disk. By default, API response bodies are **not** written to the local log file — only request metadata (command, method, URL path, status, request id, duration, headers) is recorded, with the `Authorization` header and other sensitive request keys redacted. Response bodies are logged only when explicitly opted in (`--log-bodies` per command, or `DEEL_LOG_BODIES=1` globally); even then, keys that look sensitive (`token`, `password`, `email`, `iban`, `tax_id`, and similar) are redacted before writing, but the remaining payload may still contain personal data, so enable this only when you need it. The log directory and file are created with owner-only permissions (`0700`/`0600`).
