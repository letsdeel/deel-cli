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
It introduces no server-side components — all API endpoints it calls are pre-reviewed by
Deel's security team. Security concerns about the API itself should be reported through
the same channel above.

`deel auth login` signs in with OAuth 2.0 (authorization code with PKCE). While it runs, it
listens on a random port on `127.0.0.1` (never `localhost` or another interface) for the
browser's redirect: it accepts a single `GET /callback` whose `Host` header and `state`
match the sign-in it started, and it closes after that response or after 5 minutes.

The OAuth login is stored in the OS keychain (macOS Keychain, or libsecret on Linux), never
in a plain file and never on a command line. It is only sent to the API host of the
environment that issued it. A personal access token passed with `DEEL_TOKEN` or
`--token-stdin` is held **in memory only** and never written to disk. By default, API response bodies are **not** written to the local log file — only request metadata (command, method, URL path, status, request id, duration, headers) is recorded, with the `Authorization` header and other sensitive request keys redacted. Response bodies are logged only when explicitly opted in (`--log-bodies` per command, or `DEEL_LOG_BODIES=1` globally); even then, credentials (`token`, `password`, `secret`, and similar), links that sign you in, and the fields the API definition marks as personal or employment data are redacted before writing, but a field the API definition has not marked is logged as it is (apart from emails and JWTs, masked by value), and responses of the `auth` and `job` commands carry no field marks. The remaining payload may therefore contain personal data, so enable this only when you need it. The query string of a request is never written to the log. The log directory and file are created with owner-only permissions (`0700`/`0600`).
