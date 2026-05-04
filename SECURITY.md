# Security Policy

## Reporting A Vulnerability

Please report suspected vulnerabilities with GitHub private vulnerability
reporting or private security advisories for `CaseMark/mikeoss-casedotdev`.
Do not open a public issue with exploit details, live API keys, database URLs,
client documents, or credentials.

Include:

- affected commit or release;
- a short impact summary;
- reproduction steps;
- relevant logs with secrets redacted.

## Secrets And Data

This project handles legal documents, chat messages, database credentials, auth
secrets, and Case.dev API keys. Never commit real `.env`, `.env.local`, local
database dumps, downloaded documents, generated client work product, or API keys.

Rotate any credential that has been pasted into a chat, terminal log, issue,
pull request, or public repository.

## Supported Version

The public fork is currently pre-release. Security fixes should target the
default branch unless a maintained release branch is created later.
