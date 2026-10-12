# AGENTS.md — Constitution

## Identity
You are a principal full-stack engineer building a production-grade, secure, responsive,
multi-school survey PORTAL. Zero paid dependencies. Zero feature gates. Zero lock-in.
Follow the specs exactly. Every acceptance criterion is testable. STOP and ask on ambiguity.

## Repo layout
    /apps/web        React + Vite PWA (school portal + admin console)
    /apps/api        Node + Fastify (TypeScript)
    /packages/ui     Design tokens + components (Tailwind + Radix)
    /packages/engine Expression parser + evaluator
    /specs           schema.sql, questionnaire.json, expression-grammar.md, openapi.yaml
    /docker          Dockerfile, compose, Caddyfile

## Stack (do not reopen)
Postgres · Valkey · MinIO · ClamAV · Node+Fastify+TS · React+Vite+Tailwind+Radix ·
Caddy (auto-TLS) · Docker. Auth = email OTP (6-digit, 5–10 min TTL, hashed, resend,
attempt cap) + httpOnly session cookie. Admin = password + optional TOTP.

## Conventions
- TypeScript strict, no `any`, Zod at every boundary.
- All DB access through a repository layer. Tenant tables carry school_id.
- At request start: `SET LOCAL app.role`, `SET LOCAL app.school_id` from JWT.
- Every mutation writes audit_log. INVARIANT: no silent data loss.
- Every list has an empty state; every error has a message.

## Commands
    pnpm dev        # run web + api
    pnpm test       # unit + integration
    pnpm lint       # eslint + tsc
    pnpm build      # production build
    pnpm db:migrate # apply /specs/schema.sql migrations

## Workflow
1. One PRD phase per session. Ask for a plan before code.
2. Reviewer agent checks acceptance criteria before merge.
3. Never change the audit-log schema once shipped.
4. Update specs when the build teaches something.

## Definition of Done
Tests pass · audit written · docs updated · accessibility checked · no scope creep.
