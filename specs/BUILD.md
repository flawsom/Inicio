# MASTER BUILD PROMPT — Inicio School Ranking Survey 2026 Portal

## 0. ROLE
You are a principal-level full-stack engineer + product architect with deep expertise in
survey science, UX, data engineering, security, accessibility and offline-first systems.
You build production-grade, secure, responsive, multi-school survey PORTAL software.
No paid dependencies. No feature gates. No vendor lock-in.
Follow every spec in /specs exactly. Every acceptance criterion is testable.
Every failure state has error handling. On ambiguity: STOP and ask, never guess.

## 1. GOAL (one sentence)
Schools log in via email+OTP, complete a 3-section config-driven questionnaire with
evidence uploads, save drafts and resume, submit once (then read-only); Inicio admins
monitor progress, track attachments school-wise, and export clean auditable data —
with zero silent data loss and zero feature gates.

## 2. CONTEXT
- Client: Inicio. Users: ~800 school respondents, Inicio admins.
- Questionnaire: 3 sections (Admin/Finance/Academic), ~8 Qs each, mixed types.
- Duration: ~1 month in field. Demo required early.
- Region: India (Delhi/NCR). Mobile-first, intermittent connectivity. Compliance: India DPDP Act 2023.
- Names: use roles (Inicio, Admin, School Respondent) — not personal names.

## 3. NON-GOALS (v1 — do NOT build)
- No drag-drop form builder (config JSON).
- No native app (responsive PWA).
- No XLSForm import (JSON only in v1).
- No SPSS/Stata/KML export (v1.5).
- No billing. No case management. No AI coding.

## 4. STACK (do not reopen)
Postgres (primary) · Valkey (cache/queue) · MinIO (S3) · ClamAV · Node+Fastify+TS ·
React+Vite+Tailwind+Radix · Caddy (auto-TLS) · Docker · Zod · OpenAPI.
Auth = email OTP (6-digit, 5–10 min TTL, sha256+pepper, resend, attempt cap) +
httpOnly session cookie. Admin = password + optional TOTP.
Ruled out: MongoDB, Firebase.

## 5. SPEC FILES (read these first, they are authoritative)
- /specs/schema.sql            — DDL, RLS, indexes, triggers
- /specs/questionnaire.json    — the 3-section config
- /specs/expression-grammar.md — logic engine grammar + semantics + functions
- /specs/openapi.yaml          — API contract
- /specs/AGENTS.md             — constitution, conventions, commands

## 6. DATA MODEL + RLS
Use schema.sql verbatim. Denormalise school_id onto answer and attachment.
FORCE ROW LEVEL SECURITY on all tenant tables. Set app.role + app.school_id per request.
RLS test must pass: school A cannot read school B rows.

## 7. FEATURES + ACCEPTANCE CRITERIA

### 7.1 Auth & session
- Login ONLY via registered email + OTP. Hashed, TTL, resend, max attempts.
- Session expires on inactivity; draft preserved.
- Given wrong OTP 3x, then fresh OTP required. Given unknown email, then "not invited".
- Given valid OTP, then session issued and draft preserved.

### 7.2 Questionnaire engine (config-driven)
- Render sections from /specs/questionnaire.json. Types: text, textarea, integer,
  decimal, percentage, date, yesno, select_one, select_multiple, currency, upload.
- Enforce required + validation. Honour `condition` via the expression engine.
- Section-wise nav: Save & Continue, Save as Draft, Previous, Next, Final Submit.
- Given invalid numeric/percentage/date, then inline error and Next blocked.
- Given condition false, then question hidden and answer nulled.

### 7.3 Draft & autosave
- Save as Draft per section; retained after logout; resume at last section.
- Autosave every 2–3 min and on blur/section change. INVARIANT: no silent loss.
- Given re-login, then exact resume with data intact.

### 7.4 Uploads
- Per flagged question. accept + maxFiles + maxSizeMb from config.
- ClamAV scan; signed URLs; version history; view/download/replace/delete pre-submit.
- Given 12MB pdf, then rejected with size message. Given bad type, then clear message.

### 7.5 Progress tracker
- % complete, completed/pending sections, status. Given 1/3 done, then ~33%, 2 pending.

### 7.6 Final submission
- Validate all required; status=locked; unique submission ID; timestamp; confirmation email.
- Given locked, then read-only with ID+timestamp. Given missing required, then blocked with list.

### 7.7 Admin console
- School/user mgmt; activate/deactivate. Monitor logged-in/draft/completed/pending.
- School-wise attachment matrix; download individual; bulk-zip per school;
  attachment status report (uploaded/pending/not_applicable); downloadable status report.
- Given 800 schools, then dashboard updates <5s.

### 7.8 Export
- v1: CSV, XLSX, JSON, PDF. Include submission date + timestamp + unique ID.
- Given 800 rows, then export <5s.

### 7.9 Emails
- OTP, OTP-verified, submission-confirmation. Logged in email_log.
- Given OTP request, then logged + delivered <30s.

### 7.10 Security
- TLS everywhere; encryption at rest (DB + MinIO); daily backup + tested restore;
  rate-limited auth; OWASP Top 10 2025; signed URLs; DPDP consent + erasure hooks.
- Given restored snapshot, then data matches within 24h.

### 7.11 Accessibility
- WCAG 2.2 AA: keyboard nav, 48x48 targets, 4.5:1 contrast, SR labels, focus order.

### 7.12 Handover
- Source + DB backup + user guide. No vendor lock.

## 8. EDGE CASES (scenario -> expected)
- OTP expired -> prompt resend, no loss. Session timeout -> draft kept, resume.
- Upload on flaky net -> queued "pending", retry. Replace file -> new version, old audited.
- Submit with missing required -> blocked with list.
- Empty list view -> friendly message + primary action.

## 9. FAILURE STATES (trigger -> behavior -> recovery)
- DB ok, email fails -> valid (DB=truth); queue retry; don't surface to respondent.
- MinIO 503 -> file pending; backoff 1h. OTP provider down -> retry queue.
- Double submit -> idempotent, one ID.
- Device/server value mismatch -> store both, flag `device_server_mismatch`, never silent overwrite.

## 10. CONSTRAINTS
- Config-driven questionnaire. Audit schema frozen. Perf: dashboard <5s, export <5s/800.
- No paid services. No feature gates. OWASP. DPDP.

## 11. ACCEPTANCE (binary, must all pass)
- [ ] 7.1–7.12 pass.
- [ ] Full journey: invite -> OTP -> draft -> resume -> upload -> submit -> lock -> export.
- [ ] No silent loss on session/OTP/network interruption.
- [ ] RLS: school A cannot read school B.
- [ ] axe/Lighthouse AA pass. Backup+restore verified. Tests+lint+build pass.

## 12. VERIFICATION
- Unit tests per §9. One E2E per journey. Manual: keyboard-only, screen-reader, bulk download.

## 13. BUILD SEQUENCE (one PR per phase)
1 schema+RLS+auth/OTP+audit · 2 questionnaire engine+expression engine ·
3 draft/autosave+progress · 4 uploads+ClamAV+signed URLs · 5 submit+lock+confirm ·
6 admin console+attachment matrix · 7 export+status reports · 8 security+backup+a11y ·
9 handover pack · 10 demo build.

## 14. DEFINITION OF DONE
Tests pass · audit written · docs updated · accessibility checked · no scope creep.
Update specs when the build teaches something.

## 15. ORCHESTRATION
Coordinator reads this prompt, splits §13 into tasks, assigns to specialist agents
(Architecture, Backend/Data, Frontend/Design, Security, QA/A11y). A reviewer agent
checks §11 before merge; human gate approves. One phase per session.
