# GHOST-HANDS

Browser automation engine for job applications. Owns worker execution, adapter orchestration, callback/auth flows with VALET, session storage, and runtime security controls for sandboxed automation.

## Review Guidelines

- Treat this repo as high risk for worker correctness, sandbox isolation, callback/auth integrity, credential handling, and concurrency. Prioritize correctness, security, and operational safety over style.
- Be harsh and skeptical. Look first for duplicate execution, queue races, deadlocks, retry storms, domain-lockdown bypasses, callback auth regressions, session leakage, and silent task corruption.
- Prefer findings over praise. Only comment when there is a concrete failure mode, exploit path, or missing validation/test with meaningful production impact.
- Flag missing or weakened tests whenever a change touches workers, adapter selection, job state transitions, callback/webhook auth, encryption/session storage, security middleware, rate limiting, or migrations.
- Treat as high severity anything that can run the wrong automation, execute a task twice, bypass auth or domain restrictions, leak credentials/session state, break VALET integration contracts, or leave workers stuck while jobs appear healthy.
- Ignore pure style nits unless they hide a behavioral or security issue.
