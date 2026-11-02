/**
 * Browser API client.
 *
 * Everything goes through `/api/v1` (proxied to the API in dev, same-origin in
 * production) and carries the session cookie. The one rule that matters here: the
 * export and download endpoints return bytes, so they are fetched as blobs rather
 * than parsed as JSON.
 */
import type { DatasetTable } from '@inicio/engine';
import type { Paradata } from './offline/types';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';
const ROOT = `${API_BASE}/api/v1`;

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string, readonly payload?: unknown) {
    super(message ?? code);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = (parsed ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, detail.error ?? 'error', detail.message, parsed);
  }
  return parsed as T;
}

export interface Organisation {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  form_count: number;
  member_count: number;
}

export interface FormSummary {
  id: string;
  name: string;
  slug: string;
  org_id: string;
  organisation: string;
  archived_at: string | null;
  published_version: number | null;
  draft_version_id: string | null;
  submitted_count: number;
  in_progress_count: number;
  active_links: number;
  updated_at: string;
}

export interface VersionSummary {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  title: string;
  published_at: string | null;
  created_at: string;
  question_count: number;
  /** The version this one was forked from — a new draft's source, or a restore's. */
  based_on: string | null;
  created_by: string | null;
}

/**
 * What one version changed against another, in the words the API computed.
 *
 * The console renders these sentences rather than deriving its own: a comparison
 * re-made in the browser could disagree with the two definitions the server actually
 * stored, and the whole value of a history is that it says what is in the database.
 */
export interface VersionComparison {
  to: VersionLineage;
  from: VersionLineage | null;
  diff: {
    identical: boolean;
    counts: { added: number; removed: number; changed: number };
    changes: string[];
    questions: Array<{ name: string; kind: 'added' | 'removed' | 'changed'; details: string[] }>;
    notes: string[];
  } | null;
}

export interface VersionLineage {
  id: string;
  version: number;
  status: string;
  title: string;
  based_on: string | null;
  created_at: string;
  published_at: string | null;
}

export interface Definition {
  title: string;
  defaultLanguage: string;
  languages: string[];
  groups: Array<{ id: string; name: string; label: Record<string, string>; repeat?: boolean }>;
  questions: Array<{
    id: string;
    name: string;
    type: string;
    label: Record<string, string>;
    /** Shown under the label, in the respondent's own language. */
    hint?: Record<string, string>;
    groupId?: string | null;
    required?: boolean | string;
    choices?: { listName?: string; inline?: Array<{ value: string; label: Record<string, string> }> } | null;
    validation?: { constraint?: string | null; message?: Record<string, string> } | null;
    rules?: { visibleIf?: string | null; enableIf?: string | null; calculate?: string | null; choiceFilter?: string | null };
  }>;
  choiceLists: Record<string, unknown>;
  triggers?: Array<{ type: string; when: string }>;
}

export interface ResponseRow {
  id: string;
  status: string;
  started_at: string;
  submitted_at: string | null;
  form_version: number;
  answers: Record<string, unknown>;
  /** How many answers this response and the server disagree about. */
  conflict_count: number;
}

export type MailTransportKind = 'smtp' | 'resend';

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDocument {
  id: 'terms' | 'privacy';
  title: string;
  version: string;
  effectiveDate: string;
  summary: string;
  sections: LegalSection[];
  hash: string;
}

export interface TermsStatus {
  required: boolean;
  currentVersion: string;
  acceptedVersion: string | null;
  checkboxText: string;
  terms: { version: string; hash: string };
  privacy: { version: string; hash: string };
}

export interface Invite {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
  pending: boolean;
}

export interface InvitePreview {
  email: string;
  role: string;
  organisation: string;
  expiresAt: string;
}

/**
 * What the login page is allowed to know. Deliberately small: whether a code can
 * be sent, and whether that came from the last real send or a live check.
 */
export interface PublicMailStatus {
  configured: boolean;
  reachable: boolean;
  basis: 'smtp-verify' | 'last-send' | 'none';
  transport: MailTransportKind;
  /** The mailbox a code arrives from — the same value the message's footer prints. */
  from: string;
  /** The lifetime the server enforces on a code. */
  otpTtlMinutes: number;
}

export interface MailStatus {
  configured: boolean;
  reachable: boolean;
  transport: MailTransportKind;
  host: string;
  port: number;
  from: string;
  detail: string;
  /**
   * How `reachable` was established. `none` means nothing has been sent yet for
   * a transport that cannot be probed (an HTTPS relay with a send-only key), so
   * "unreachable" there means "unproven", not "broken": the UI must not cry
   * wolf about it.
   */
  basis: 'smtp-verify' | 'last-send' | 'none';
  checkedAt: string;
}

/** The verdict of the delivery attempt that just happened. */
export interface MailDelivery {
  ok: boolean;
  transport: MailTransportKind;
  id?: string;
  detail: string;
  at: string;
}

/**
 * Live analytics. `generatedAt` is the server's clock at the moment the numbers
 * were read, so the console can show that what it is rendering is current rather
 * than a cached snapshot.
 */
export interface FormAnalytics {
  definition: Definition | null;
  publishedVersion: number | null;
  byStatus: Array<{ status: string; count: number }>;
  tallies: Array<{ question_id: string; value: unknown; count: number }>;
  timeline: Array<{ day: string; started: number; submitted: number }>;
  /** Responses where a device and the server disagreed about an answer. */
  conflicts: number;
  generatedAt: string;
}

/**
 * Integrations and quality control.
 *
 * Two facts shape these types. An API key's secret and a webhook's signing secret
 * are returned by the *create* calls and by nothing else — there is no read that
 * can produce them again, so a screen must show them once and say so. And a flag's
 * `detail` is whatever the detector recorded, so it is rendered as evidence rather
 * than as a fixed shape.
 */
export interface ApiScope {
  scope: string;
  detail: string;
  /**
   * Whether a route declares this scope today. The vocabulary is wider than the
   * machine surface on purpose, and this is what stops the console offering a
   * capability that would produce a key able to call nothing.
   */
  enforced: boolean;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
  active: boolean;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  active: boolean;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  disabledAt: string | null;
  /** Why it is not sending, in words, when it has disabled itself. */
  reason: string | null;
  pending?: number;
  failed?: number;
}

export interface WebhookDelivery {
  id: string;
  event: string;
  status: string;
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: string;
  delivered_at: string | null;
  next_attempt_at: string;
  payload: unknown;
}

export interface QualityFlag {
  id: string;
  formId: string;
  formName: string;
  responseId: string;
  questionId: string | null;
  kind: string;
  /** What the kind means, in words, from the server's own vocabulary. */
  kindDetail: string;
  severity: string;
  detail: Record<string, unknown>;
  status: string;
  note: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface FlagQueue {
  flags: QualityFlag[];
  summary: { byStatus: Record<string, number>; byKind: Record<string, number>; open: number };
}

/** One response waiting for, or already given, a review decision. */
export interface ReviewItem {
  id: string;
  status: string;
  reviewState: 'none' | 'pending' | 'approved' | 'rejected';
  claimedBy: string | null;
  claimedById: string | null;
  claimedAt: string | null;
  reviewedBy: string | null;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  startedAt: string;
  submittedAt: string | null;
  durationSeconds: number | null;
  enumeratorRef: string | null;
  caseid: string | null;
  formVersion: number;
  formVersionId: string;
  flags: { total: number; severe: number; open: number };
  answerCount: number;
}

export interface ReviewCorrection {
  questionId: string;
  from?: unknown;
  to: unknown;
  reason?: string;
}

export interface ReviewLogEntry {
  id: string;
  action: 'claim' | 'comment' | 'correction' | 'approve' | 'reject' | 'reopen' | 'assign';
  from_state: string | null;
  to_state: string | null;
  note: string | null;
  corrections: ReviewCorrection[];
  created_at: string;
  actor: string | null;
}

export interface ReviewFlag {
  id: string;
  question_id: string | null;
  kind: string;
  severity: string;
  detail: Record<string, unknown>;
  status: string;
  note: string | null;
  created_at: string;
}

export interface ReviewTiming {
  field_name: string;
  total_seconds: string | number;
  first_seen_seconds: string | number | null;
  visits: number;
}

export interface ReviewDetail {
  response: ReviewItem;
  answers: Record<string, unknown>;
  definition: Definition;
  log: ReviewLogEntry[];
  flags: ReviewFlag[];
  timings: ReviewTiming[];
}

export interface ReviewQueue {
  responses: ReviewItem[];
  summary: Record<string, { total: number; claimed: number; unclaimed: number }>;
  limit: number;
  offset: number;
}

export interface QcFinding {
  responseId: string;
  kind: string;
  severity: string;
  questionId: string | null;
  detail: Record<string, unknown>;
}

export interface QcReport {
  findings: QcFinding[];
  scanned: number;
  byKind: Record<string, number>;
  options: Record<string, unknown>;
}

/** An organisation-level table an instrument can read before and write after. */
export interface DatasetSummary {
  id: string;
  code: string;
  name: string;
  kind: 'data' | 'cases' | 'enumerators';
  uniqueField: string;
  columns: string[];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface DatasetRowRecord {
  key: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

export interface DatasetAttachment {
  id: string;
  datasetId: string;
  code: string;
  name: string;
  kind: string;
  uniqueField: string;
  columns: string[];
  keyQuestion: string | null;
  mapping: Record<string, string>;
  publish: boolean;
  rowCount: number;
  createdAt: string;
}

/**
 * Attachments: a file a respondent sends, and the three calls that move it.
 *
 * Two things about this path are unlike the rest of the client. The bytes never
 * pass through the API, so the one call that carries them goes to object storage
 * against a URL the API signed, with no cookie and nothing else attached. And a
 * refusal here is worded for the person holding the phone — "that file is larger
 * than this survey accepts" — so it is read as a sentence rather than as a code.
 */
export interface AttachmentCapability {
  /** The deployment's answer about itself: with no bucket configured this is false. */
  enabled: boolean;
  maxBytes: number;
  /** Whether the bytes will be looked at before they count as an answer. */
  scan: 'on' | 'off';
  /**
   * Whether a file whose scan did not happen can still be an answer. `refused` is
   * the `require` policy, where an unscanned file is not collected at all — which is
   * why `enabled` can be false while storage itself is perfectly well configured.
   */
  unscanned: 'accepted' | 'refused';
  /** The accepted types per question type, from the server's own allowlists. */
  mime: { image: string[]; audio: string[]; video: string[]; file: string[] };
}

/** One authorised file: a URL that uploads that file, of that type, and nothing else. */
export interface AttachmentAuthorisation {
  attachmentId: string;
  uploadUrl: string;
  expiresInSeconds: number;
  /** The headers the signature covers, which the PUT must send exactly. */
  headers: Record<string, string>;
  maxBytes: number;
}

/** What the server found in the store, rather than what the device said it sent. */
export interface AttachmentReceipt {
  attachmentId: string;
  /** The question's **name**: the key an answer is stored under. */
  questionId: string;
  filename: string;
  status: 'uploaded';
  scanStatus: string;
  scanDetail?: string;
  /** The size the store reported, which is the one that counts. */
  sizeBytes: number;
  sha256?: string;
  /** True when the file had already been completed and this call changed nothing. */
  alreadyComplete?: boolean;
}

export const api = {
  mailStatus: () => request<PublicMailStatus>('GET', '/auth/mail-status'),
  requestOtp: (email: string) =>
    request<{
      status: 'sent' | 'not_delivered';
      mail: PublicMailStatus;
      delivery: MailDelivery;
    }>(
      'POST',
      '/auth/otp/request',
      { email },
    ),
  verifyOtp: (email: string, code: string) => request<{ subject: string }>('POST', '/auth/otp/verify', { email, code }),
  logout: () => request<void>('POST', '/auth/logout'),
  me: () => request<{ user: { id: string; email: string; displayName: string | null }; organisations: Organisation[] }>('GET', '/auth/me'),

  createOrg: (name: string) => request<{ organisation: { id: string; name: string } }>('POST', '/orgs', { name }),

  // Legal and acceptance. The documents are public: a reader must be able to
  // open the exact text they are being asked to agree to.
  legalDocument: (id: 'terms' | 'privacy') => request<{ document: LegalDocument }>('GET', `/legal/${id}`),
  termsStatus: () => request<TermsStatus>('GET', '/auth/terms/status'),
  acceptTerms: (termsVersion: string, privacyVersion: string) =>
    request<{ accepted: boolean }>('POST', '/auth/terms/accept', {
      termsVersion,
      privacyVersion,
      accepted: true,
    }),

  // Invitation links: preview never consumes, redeem does, exactly once.
  invitePreview: (token: string) => request<{ invite: InvitePreview }>('GET', `/auth/invite/${encodeURIComponent(token)}`),
  redeemInvite: (token: string) =>
    request<{ organisation: { id: string; name: string }; role: string; termsRequired: boolean }>(
      'POST',
      '/auth/invite/redeem',
      { token },
    ),

  // Administration: owner or admin of the organisation only.
  memberRole: (orgId: string, userId: string, role: string) =>
    request<{ member: { user_id: string; role: string } }>('PATCH', `/orgs/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: string, userId: string) => request<void>('DELETE', `/orgs/${orgId}/members/${userId}`),
  invites: (orgId: string) => request<{ invites: Invite[] }>('GET', `/orgs/${orgId}/invites`),
  createInvite: (orgId: string, email: string, role: string, expiresInDays = 7) =>
    request<{ invite: Invite; path: string; url: string; singleUse: boolean }>('POST', `/orgs/${orgId}/invites`, {
      email,
      role,
      expiresInDays,
    }),
  revokeInvite: (orgId: string, inviteId: string) =>
    request<{ revoked: { id: string } }>('DELETE', `/orgs/${orgId}/invites/${inviteId}`),
  mailDiagnostics: (orgId: string) =>
    request<{ status: MailStatus; recent: Array<{ template: string; status: string; ts: string }> }>(
      'GET',
      `/orgs/${orgId}/diagnostics/mail`,
    ),

  members: (orgId: string) => request<{ members: Array<{ user_id: string; email: string; role: string }> }>('GET', `/orgs/${orgId}/members`),
  invite: (orgId: string, email: string, role: string) =>
    request<{ userId: string }>('POST', `/orgs/${orgId}/members`, { email, role }),

  templates: () =>
    request<{ templates: Array<{ id: string; title: string; description: string; questionCount: number }> }>('GET', '/templates'),
  forms: () => request<{ forms: FormSummary[] }>('GET', '/forms'),
  createForm: (payload: { orgId: string; name: string; templateId?: string; xlsformBase64?: string }) =>
    request<{ form: { id: string }; version: { id: string } }>('POST', '/forms', payload),
  form: (formId: string) =>
    request<{ form: FormSummary; versions: VersionSummary[]; responsesByStatus: Array<{ status: string; count: number }> }>(
      'GET',
      `/forms/${formId}`,
    ),
  version: (formId: string, versionId: string) =>
    request<{ version: { id: string; definition: Definition; status: string; version: number } }>(
      'GET',
      `/forms/${formId}/versions/${versionId}`,
    ),
  saveVersion: (formId: string, versionId: string, definition: unknown) =>
    request<{ errors: string[]; warnings: string[]; version?: { definition: Definition } }>(
      'PUT',
      `/forms/${formId}/versions/${versionId}`,
      { definition },
    ),
  newVersion: (formId: string) => request<{ version: { id: string } }>('POST', `/forms/${formId}/versions`, {}),
  versionDiff: (formId: string, versionId: string, against?: string) =>
    request<VersionComparison>(
      'GET',
      `/forms/${formId}/versions/${versionId}/diff${against ? `?against=${encodeURIComponent(against)}` : ''}`,
    ),
  // Restoring never rewrites the old version: it forks a new draft from it and the new
  // row records where it came from, which is what keeps the history a graph.
  restoreVersion: (formId: string, versionId: string) =>
    request<{ version: { id: string; version: number; status: string; based_on: string | null } }>(
      'POST',
      `/forms/${formId}/versions/${versionId}/restore`,
    ),
  publish: (formId: string, versionId: string) =>
    request<{ version: { version: number; status: string } | null; report: { errors: string[]; warnings: string[] } }>(
      'POST',
      `/forms/${formId}/versions/${versionId}/publish`,
    ),

  responses: (formId: string) =>
    request<{ responses: ResponseRow[]; counts: Array<{ status: string; count: number }> }>('GET', `/forms/${formId}/responses?limit=200`),
  // Computed on every request from the live tables (no cache, no snapshot).
  analytics: (formId: string) =>
    request<FormAnalytics>('GET', `/forms/${formId}/analytics`),

  links: (formId: string) =>
    request<{ links: Array<{ id: string; kind: string; label: string | null; uses: number; max_uses: number | null; active: boolean }> }>(
      'GET',
      `/forms/${formId}/links`,
    ),
  createLink: (formId: string, kind: string) =>
    request<{ token: string; collectPath: string; warning: string }>('POST', `/forms/${formId}/links`, { kind }),
  deactivateLink: (formId: string, linkId: string) => request<void>('DELETE', `/forms/${formId}/links/${linkId}`),

  /**
   * Public collection: no session, the token is the credential.
   *
   * `clientId` is the device's stable id for the response, so a start retried
   * after a dropped connection resumes the same response instead of creating a
   * second one. `base` is the last server state the device saw; the server uses
   * it to tell a real conflict from a no-op.
   */
  collectForm: (token: string) =>
    request<{
      form: { id: string; title: string; version: number; definition: Definition };
      link: { kind: string };
      /** The datasets attached to this published version, with a bounded snapshot. */
      datasets?: DatasetTable[];
      /** What this deployment can do with files, or that it cannot yet. */
      attachments: AttachmentCapability;
    }>('GET', `/collect/${token}`),
  resumeResponse: (token: string, responseId: string) =>
    request<{
      responseId: string;
      status: string;
      caseid?: string | null;
      answers: Record<string, unknown>;
      datasets?: DatasetTable[];
    }>('GET', `/collect/${token}/responses/${responseId}`),
  startResponse: (
    token: string,
    clientId?: string,
    answers: Record<string, unknown> = {},
    base: Record<string, unknown> = {},
    caseid?: string,
    enumerator?: string,
  ) =>
    request<{
      responseId: string;
      created: boolean;
      status: string;
      caseid?: string | null;
      datasets?: DatasetTable[];
    }>('POST', `/collect/${token}/responses`, {
      clientId,
      answers,
      base,
      ...(caseid ? { caseid } : {}),
      ...(enumerator ? { enumerator } : {}),
    }),
  saveResponse: (
    token: string,
    responseId: string,
    answers: Record<string, unknown>,
    base: Record<string, unknown> = {},
    paradata?: Paradata,
  ) =>
    request<{ missing: string[]; invalid: string[]; answers: Record<string, unknown>; conflicts: number }>(
      'PATCH',
      `/collect/${token}/responses/${responseId}`,
      { answers, base, ...(paradata ? { paradata } : {}) },
    ),
  submitResponse: (
    token: string,
    responseId: string,
    answers: Record<string, unknown>,
    base: Record<string, unknown> = {},
    paradata?: Paradata,
  ) =>
    request<{ status: string; conflicts: number }>('POST', `/collect/${token}/responses/${responseId}/submit`, {
      answers,
      base,
      ...(paradata ? { paradata } : {}),
    }),

  // ---------------------------------------------------------------- integrations

  /** The scope vocabulary, read from the server so the console cannot drift from it. */
  apiScopes: () => request<{ scopes: ApiScope[] }>('GET', '/api-scopes'),
  apiKeys: (orgId: string) => request<{ keys: ApiKey[] }>('GET', `/orgs/${orgId}/api-keys`),
  createApiKey: (orgId: string, payload: { name: string; scopes: string[]; expiresInDays?: number }) =>
    request<{ key: ApiKey; secret: string }>('POST', `/orgs/${orgId}/api-keys`, payload),
  revokeApiKey: (orgId: string, keyId: string) =>
    request<void>('DELETE', `/orgs/${orgId}/api-keys/${keyId}`),
  /** The old secret is refused on the next request; the new one keeps the same scopes and expiry. */
  rotateApiKey: (orgId: string, keyId: string) =>
    request<{ key: ApiKey; secret: string; revokedKeyId: string }>(
      'POST',
      `/orgs/${orgId}/api-keys/${keyId}/rotate`,
    ),

  webhookEvents: () => request<{ events: Array<{ event: string; detail: string }> }>('GET', '/webhook-events'),
  webhooks: (orgId: string) => request<{ endpoints: WebhookEndpoint[] }>('GET', `/orgs/${orgId}/webhooks`),
  createWebhook: (orgId: string, payload: { url: string; events: string[]; description?: string }) =>
    request<{ endpoint: WebhookEndpoint; secret: string }>('POST', `/orgs/${orgId}/webhooks`, payload),
  updateWebhook: (
    orgId: string,
    endpointId: string,
    payload: { url?: string; events?: string[]; description?: string; active?: boolean },
  ) => request<{ endpoint: WebhookEndpoint }>('PATCH', `/orgs/${orgId}/webhooks/${endpointId}`, payload),
  deleteWebhook: (orgId: string, endpointId: string) =>
    request<void>('DELETE', `/orgs/${orgId}/webhooks/${endpointId}`),
  webhookDeliveries: (orgId: string, endpointId: string, limit = 50) =>
    request<{ deliveries: WebhookDelivery[] }>(
      'GET',
      `/orgs/${orgId}/webhooks/${endpointId}/deliveries?limit=${limit}`,
    ),
  /** Signs and sends a synthetic event now, and reports the receiver's real answer. */
  testWebhook: (orgId: string, endpointId: string) =>
    request<{
      delivered: boolean;
      status: number | null;
      responseBody: string | null;
      error: string | null;
      deliveryId: string;
    }>('POST', `/orgs/${orgId}/webhooks/${endpointId}/test`),
  retryWebhookDelivery: (orgId: string, deliveryId: string) =>
    request<{ deliveryId: string; drained: { attempted: number; delivered: number; failed: number; retrying: number } }>(
      'POST',
      `/orgs/${orgId}/webhooks/deliveries/${deliveryId}/retry`,
    ),

  // --------------------------------------------------------------- quality queue

  flagKinds: () =>
    request<{
      kinds: Array<{ kind: string; detail: string }>;
      thresholds: { speeding: string; straightLining: string };
    }>('GET', '/flag-kinds'),
  flags: (orgId: string, options: { status?: string; formId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (options.status) params.set('status', options.status);
    if (options.formId) params.set('formId', options.formId);
    if (options.limit) params.set('limit', String(options.limit));
    const query = params.toString();
    return request<FlagQueue>('GET', `/orgs/${orgId}/flags${query ? `?${query}` : ''}`);
  },
  resolveFlag: (orgId: string, flagId: string, payload: { status: 'resolved' | 'dismissed'; note?: string }) =>
    request<{ flag: QualityFlag }>('PATCH', `/orgs/${orgId}/flags/${flagId}`, payload),
  /** The whole-form detector: exact duplicate submissions. Idempotent. */
  scanFlags: (orgId: string, formId: string) =>
    request<{ flagged: number }>('POST', `/orgs/${orgId}/forms/${formId}/flags/scan`),
  qcReport: (orgId: string, formId: string, params: { outlierMultiple?: number; minShare?: number; maxShare?: number; alpha?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.outlierMultiple !== undefined) query.set('outlierMultiple', String(params.outlierMultiple));
    if (params.minShare !== undefined) query.set('minShare', String(params.minShare));
    if (params.maxShare !== undefined) query.set('maxShare', String(params.maxShare));
    if (params.alpha !== undefined) query.set('alpha', String(params.alpha));
    return request<QcReport>('GET', `/orgs/${orgId}/forms/${formId}/qc/report${query.size > 0 ? `?${query}` : ''}`);
  },
  qcScan: (
    orgId: string,
    formId: string,
    params: { outlierMultiple?: number; minShare?: number; maxShare?: number; alpha?: number; exclusions?: number[] } = {},
  ) =>
    request<{ scanned: number; flagged: number; byKind: Record<string, number>; options: Record<string, unknown> }>(
      'POST',
      `/orgs/${orgId}/forms/${formId}/qc/scan`,
      params,
    ),

  // ------------------------------------------------------------ review queue

  reviewQueue: (
    orgId: string,
    formId: string,
    options: { state?: 'pending' | 'approved' | 'rejected' | 'none' | 'all'; limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (options.state) params.set('state', options.state);
    if (options.limit) params.set('limit', String(options.limit));
    if (options.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return request<ReviewQueue>('GET', `/orgs/${orgId}/forms/${formId}/review${query ? `?${query}` : ''}`);
  },
  reviewResponse: (orgId: string, formId: string, responseId: string) =>
    request<ReviewDetail>('GET', `/orgs/${orgId}/forms/${formId}/review/${responseId}`),
  reviewAction: (
    orgId: string,
    formId: string,
    responseId: string,
    payload: { action: 'claim' | 'comment' | 'approve' | 'reject' | 'reopen'; note?: string },
  ) =>
    request<{ response: ReviewItem }>(
      'POST',
      `/orgs/${orgId}/forms/${formId}/review/${responseId}`,
      payload,
    ),
  correctResponse: (
    orgId: string,
    formId: string,
    responseId: string,
    payload: { corrections: ReviewCorrection[]; note?: string },
  ) =>
    request<{
      responseId: string;
      reviewState: string;
      corrections: ReviewCorrection[];
      answers: Record<string, unknown>;
    }>('POST', `/orgs/${orgId}/forms/${formId}/review/${responseId}/corrections`, payload),

  // -------------------------------------------------------------- datasets

  datasets: (orgId: string) =>
    request<{ datasets: DatasetSummary[] }>('GET', `/orgs/${orgId}/datasets`),
  createDataset: (orgId: string, payload: { code: string; name: string; kind: 'data' | 'cases' | 'enumerators'; uniqueField?: string }) =>
    request<{ dataset: DatasetSummary }>('POST', `/orgs/${orgId}/datasets`, payload),
  dataset: (orgId: string, datasetId: string, options: { limit?: number; offset?: number } = {}) =>
    request<{
      dataset: DatasetSummary;
      rows: DatasetRowRecord[];
      total: number;
      limit: number;
      offset: number;
    }>(
      'GET',
      `/orgs/${orgId}/datasets/${datasetId}?limit=${options.limit ?? 100}&offset=${options.offset ?? 0}`,
    ),
  importDatasetRows: (
    orgId: string,
    datasetId: string,
    payload: { mode: 'replace' | 'append' | 'merge' | 'clear'; rows: Array<Record<string, unknown>> },
  ) =>
    request<{ mode: string; imported: number; total: number; columns: string[] }>(
      'PUT',
      `/orgs/${orgId}/datasets/${datasetId}/rows`,
      payload,
    ),
  archiveDataset: (orgId: string, datasetId: string) =>
    request<void>('DELETE', `/orgs/${orgId}/datasets/${datasetId}`),
  datasetAttachments: (orgId: string, formId: string, versionId: string) =>
    request<{ datasets: DatasetAttachment[] }>(
      'GET',
      `/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets`,
    ),
  attachDataset: (
    orgId: string,
    formId: string,
    versionId: string,
    payload: {
      datasetId: string;
      keyQuestion?: string | null;
      publish?: boolean;
      mapping?: Record<string, string>;
    },
  ) =>
    request<{ dataset: DatasetAttachment }>(
      'POST',
      `/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets`,
      payload,
    ),
  detachDataset: (orgId: string, formId: string, versionId: string, attachmentId: string) =>
    request<void>(
      'DELETE',
      `/orgs/${orgId}/forms/${formId}/versions/${versionId}/datasets/${attachmentId}`,
    ),
  raiseFlag: (
    orgId: string,
    formId: string,
    responseId: string,
    payload: { questionId?: string; severity: 'info' | 'warn' | 'severe'; note: string },
  ) =>
    request<{ queued: boolean; reason?: string }>(
      'POST',
      `/orgs/${orgId}/forms/${formId}/responses/${responseId}/flags`,
      payload,
    ),
};

export function apiUrl(path: string): string {
  return `${ROOT}${path}`;
}

/** Downloads a generated file (an export, or a spreadsheet) with the session cookie attached. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${ROOT}${path}`, { credentials: 'include' });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string; reason?: string } | null;
    throw new ApiError(res.status, detail?.error ?? 'download_failed', detail?.reason);
  }
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = match?.[1] ?? fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * Authorise one file, and come back with a URL that can upload that file alone.
 *
 * `questionId` is the question's **name**, not its id: a name is what an answer is
 * keyed by, and the server matches this against it.
 */
export async function authoriseAttachment(
  token: string,
  responseId: string,
  input: {
    questionId: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    /** Only for an `audio audit` field: when the recording actually began. */
    audit?: { startedAt: string; durationSeconds?: number };
  },
): Promise<AttachmentAuthorisation> {
  return attachmentRequest<AttachmentAuthorisation>(
    'POST',
    `/collect/${encodeURIComponent(token)}/responses/${encodeURIComponent(responseId)}/attachments`,
    input,
  );
}

/**
 * Send the bytes, and nothing else.
 *
 * This is the one call in this file that does not go to `/api/v1`: the file travels
 * from this browser straight to object storage. `credentials: 'omit'` is deliberate
 * even though the store is normally another origin — a self-hosted bucket can share
 * one, and the signature over the path, the query and the content type is the whole
 * of the authority, so a cookie here would only widen what a leaked URL can do.
 */
export async function uploadAttachment(authorisation: AttachmentAuthorisation, file: Blob): Promise<void> {
  const res = await fetch(authorisation.uploadUrl, {
    method: 'PUT',
    headers: authorisation.headers,
    body: file,
    credentials: 'omit',
  });
  if (!res.ok) {
    // A store refuses in XML; the code inside it is the only useful part.
    const body = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
    throw new ApiError(res.status, code ?? 'upload_failed', `The file could not be uploaded (${res.status}).`);
  }
}

/** Look at what arrived, and only then call it an answer. */
export async function completeAttachment(
  token: string,
  responseId: string,
  attachmentId: string,
): Promise<AttachmentReceipt> {
  return attachmentRequest<AttachmentReceipt>(
    'POST',
    `/collect/${encodeURIComponent(token)}/responses/${encodeURIComponent(responseId)}/attachments/${encodeURIComponent(attachmentId)}/complete`,
  );
}

/**
 * `request`, plus the words these two routes use for a refusal.
 *
 * The shared helper knows `message`; an attachment refusal arrives as `message`
 * from the route that authorises an upload and as `detail` from the route that
 * completes one. Reading only one of them is how a file control ends up telling a
 * respondent the word "error" instead of the server's own sentence.
 */
async function attachmentRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ROOT}${path}`, {
    method,
    credentials: 'include',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = (parsed ?? {}) as { error?: string; message?: string; detail?: string };
    throw new ApiError(res.status, detail.error ?? 'error', detail.message ?? detail.detail, parsed);
  }
  return parsed as T;
}
