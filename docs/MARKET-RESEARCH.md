# Market research — survey / forms / data-collection platforms (2026)

**Why this exists.** Phase 1 was built to `specs/BUILD.md`, which specified an *invite-only,
single-purpose* tool: "Schools log in via email+OTP" and §7.1 "Login ONLY via registered email + OTP".
That is why a normal address (e.g. Gmail) is rejected — it is the intended behaviour of that brief,
not a defect. The actual goal is a **general-purpose, multi-tenant, self-hostable platform** where
anyone can sign up. This document is the research base for that pivot.

**Method & evidence caveats.** Four research passes covered enterprise XM suites, self-serve form
builders, offline/field collection tools, open-source platforms, market demand, and platform
architecture. Vendor pricing/feature pages were read directly. **G2, Capterra, TrustRadius and Reddit
blocked automated reading**, so complaint themes come from search-result leads and vendor docs, not a
coded review sample. Treat *complaint frequency* as directional; treat *documented product limits*
(as cited in vendor docs) as solid.

---

## 1. The market

| | |
|---|---|
| Size (2026) | **~$5.1–5.4B**, growing **~13–14.5% CAGR** (Mordor, Grand View, Precedence — boundaries differ) |
| Shape | enterprise ~62% of revenue; online ~86%; cloud ~80%; large enterprises ~64% |
| Fastest-growing regions | APAC; North America largest |
| Biggest verticals | retail/e-commerce (~29%), financial services, healthcare, education/public sector, travel |
| Buyer split | non-specialists who want simple collection **vs.** research teams who want statistical rigour |

The critical observation: **this is not one market.** It is at least four, and almost every vendor is
only credible in one or two.

1. **Enterprise experience management** — Qualtrics, Medallia, Forsta, Verint, SurveyMonkey Enterprise.
2. **Self-serve form/survey builders** — Typeform, Jotform, Tally, Fillout, Google Forms, Formstack.
3. **Field & offline data collection** — ODK, KoboToolbox, SurveyCTO, Ona, CommCare, Fulcrum, Survey123.
4. **Open-source / self-hostable** — LimeSurvey, Formbricks, OpnForm, HeyForm, Form.io, SurveyJS.

---

## 2. The landscape

### Tier 1 — Enterprise XM suites

| Product | Entry price seen | The core problem |
|---|---|---|
| Qualtrics | $420/mo annual (**1,000 responses shared across all users**); enterprise quote-only | Powerful, but needs specialists; usage-based pricing is opaque |
| SurveyMonkey Enterprise | **quote-only, positioned at 5+ users**, no trial | Response-bundle/overage ambiguity; key integrations (Salesforce/Power BI/Tableau) are Enterprise-gated |
| Alchemer | $55–275/user/mo, annual limits 75k–125k responses | **Hard seat cliff: self-serve caps at 3 users**, then custom quote |
| Medallia / Forsta / Verint | **no public price** | Broad suite bought for a survey problem; heavy implementation |

### Tier 2 — Self-serve builders

| Product | Free tier | Paid entry | Known catch |
|---|---|---|---|
| Typeform | quota unclear/unpublished | $28–39/mo, **100 responses/mo**, 1 user | Best design; poor value at volume; branding removal starts on Plus |
| Tally | **unlimited forms & submissions** | $24/mo | 10 MB free file cap; branding removal is Pro; "fair use" discretion |
| Fillout | unlimited forms, **1,000 responses/mo**, unlimited seats | $15/mo | 20 MB/file; branding until Pro |
| Jotform | 5 forms, 100 submissions/mo | ~$34/mo | Paid-only multi-user (Enterprise) |
| Google Forms | free | n/a | No white-label; **upload questions require Google sign-in**; degrades past 50k–100k responses |
| Microsoft Forms | free personal (200 responses) | bundled | **File uploads require org-restricted respondents** — unusable for public intake |
| Formstack | none (14-day trial) | $83/mo, 1 builder | Expensive; setup complexity reported |
| Airtable / Notion Forms | included | ~$20–45/editor/mo | Record limits become response caps; **Notion logic is Business-only**; Form view not exportable |

### Tier 3 — Field / offline

| Product | Open source | Real `.sav`? | Note |
|---|---|---|---|
| ODK (Collect + Central) | Yes (Apache-2.0) | not verified | Android-only client; **self-hosting = Linux + domain + Docker + ops**; Cloud $199–499/mo |
| KoboToolbox | Yes (AGPL/mixed) | **No — "SPSS Labels" is syntax, not a .sav** | CSV drops repeat groups; KML is legacy |
| SurveyCTO | No | **Yes (.sav)** | $225–700/mo; warns of 255-char truncation in SAV export |
| Ona | source public, licence unclear | reportedly zipped SAV | $199–299/mo |
| CommCare | Yes (BSD/Apache) | not verified | Service-delivery/case management, not a survey tool |
| Fulcrum | No | No | GIS-first; $43/user/mo, **5-user minimum** |
| Survey123 | No | No | XLSForm *partial* support; **Excel export excludes attachments** |

### Tier 4 — Open source

| Project | Licence | Stars | Verdict |
|---|---|---|---|
| LimeSurvey | GPL-2.0+ | ~3.8k | Only mature full survey platform; 30+ question types, SPSS/R/Stata exports. Interface dated; you own ops |
| Formbricks | **AGPLv3** + commercial | ~13.1k | Best OSS feedback platform; self-host = **8 services, 4 GB RAM floor**; one workspace on free licence |
| OpnForm | **AGPLv3** + proprietary EE | ~3.8k | Free self-host capped at **2 users**; $1,999/yr for multi-workspace |
| HeyForm | AGPLv3 | ~9.0k | Lightest self-host; MongoDB + KeyDB; no tenant lifecycle |
| SurveyJS | MIT renderer, **commercial creator** | ~4.9k | **Not a service** — you build storage, auth, tenancy. Creator $589+/dev |
| Form.io | OSL-3.0 + EE | ~2.3k | **The only one that explicitly sells tenant isolation** — and it is a paid module (~$330/mo per 10 tenants) |
| TellForm / OhMyForm / Encuestame | mixed | ~3k/2.9k/61 | **Archived + vulnerable. Do not deploy.** OhMyForm's own maintainer points to Formbricks |

---

## 3. The pain that repeats everywhere

Ranked by how well the evidence supports it:

1. **Pricing and usage friction — strongest signal by far.** Response caps, overage uncertainty,
   per-seat cliffs, and quote-only enterprise pricing. A competitor's review analysis found pricing
   was SurveyMonkey's single most-disliked theme.
2. **Feature gating.** Logic, branding removal, exports, SSO, audit logs and integrations are
   routinely withheld from lower tiers, so the product feels like a sequence of paywalls.
3. **Complexity vs. power.** Qualtrics/Medallia/Forsta need specialists. ODK/Kobo need XLSForm and
   XPath. Neither side serves "serious logic without a specialist".
4. **Reporting is charts, not decisions.** Users want cross-survey trends, segmentation, and answers
   joined to behavioural/business outcomes.
5. **Data portability is an audit question, not a feature.** Buyers now ask vendors to *demonstrate*
   raw export: labels, metadata, embedded variables, attachments, multilingual fields.
6. **Self-hosting is a lie of omission.** "Open source" frequently means 6–8 services, a 4 GB RAM
   floor, mandatory HTTPS, and no tenant model.
7. **AI trust.** 69% already use AI in research, but **91% of research-ops professionals worry about
   AI accuracy**. A controlled NORC experiment found conversational AI probing improved some answers
   yet **worsened respondent experience, raised attrition, and was worst on mobile**.
8. **Mobile and accessibility are afterthoughts**, especially for public-facing intake.

**Licensing trap (important for us):** Formbricks, OpnForm and HeyForm are **AGPLv3** — if you run a
modified version as a network service you must offer the source. That is a real constraint on a
commercial platform. MIT/GPL alternatives exist but with weaker products.

---

## 4. White space — what "the absolute best" actually means here

Everything below is a gap that is *documented by vendors themselves*, not a guess:

1. **Transparent, non-punitive pricing.** Visible quotas before launch, no seat cliffs, no
   quote-only wall, no surprise overage. The #1 complaint in the market is the #1 opportunity.
2. **Nothing important behind a paywall.** Logic, branding removal, exports, API and webhooks on the
   free tier. Compete on volume and support, not on withheld features.
3. **Portable by default.** Real CSV, XLSX, JSON, PDF, **SPSS `.sav`** (not "labels syntax"),
   Stata, KML/GeoJSON, plus attachments in one archive. Nobody does this well across the board.
4. **Serious logic without a specialist.** Visual branching, testable paths, contradiction detection,
   and XLSForm import for the ODK/Kobo crowd — instead of forcing either extreme.
5. **Multi-tenant from day one.** Organisations → projects → roles → invites. In the entire OSS field
   only Form.io Enterprise sells this, and it costs extra.
6. **Offline-capable collection** that is a first-class citizen, not an app-shaped bolt-on.
7. **AI that shows its work.** Every AI-suggested question, classification and summary traceable to
   the underlying responses, always human-reviewable, and mobile-tested before it ships.
8. **Self-host and cloud from one codebase**, with residency as a real capability rather than a
   marketing line.

**Positioning:** *the survey platform that is powerful enough for researchers, simple enough for
everyone else, transparent about price, and honest about your data.* The wedge is **trust through
transparency** — because opacity is the market's defining failure.

**Sequencing a platform, not a toy** (from the platform research): tenant-aware data + authorization
→ workspaces/invites/RBAC → API + webhooks → billing/entitlements → MFA/passkeys → SSO/SCIM/audit →
integrations/embeds/templates → regional or single-tenant deployments.

---

## 5. What this means for our build

The good news: **Phase 1's infrastructure survives the pivot.** Row-level security, the per-request
`SET LOCAL app.role / app.school_id` binding, OTP + session handling, the audit trail and the email
log are all reusable as-is. What has to change is the **domain model and the specs**, not the plumbing.

The specific changes:

| Now (school-specific) | Becomes (platform) |
|---|---|
| `school` is the tenant **and** the auth gate | `user` (any email, open signup) + `organization` (tenant) + `membership` |
| `school.registered_email` must pre-exist | Anyone signs up; OTP verifies possession of any address |
| `app.school_id` RLS variable | `app.org_id` (plus `app.user_id`) |
| One hard-coded questionnaire | `form` → `version` → `question`, authorable by users |
| Inicio branding baked into emails/UI | Per-org branding, white-label, custom domain |
| `response_set` keyed to `school_id` | `response` keyed to `form_version` and `org_id` |
| Admin = a separate password login | Same identity, `org`-scoped roles (`owner`/`admin`/`member`/`viewer`) |

Open questions that need the client's decision before I rewrite the specs are listed in the response.
