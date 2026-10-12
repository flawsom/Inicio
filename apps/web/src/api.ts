/**
 * Browser API client.
 *
 * Everything goes through `/api/v1` (proxied to the API in dev, same-origin in
 * production) and carries the session cookie. The one rule that matters here: the
 * export and download endpoints return bytes, so they are fetched as blobs rather
 * than parsed as JSON.
 */
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
  generatedAt: string;
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

  /** Public collection: no session, the token is the credential. */
  collectForm: (token: string) =>
    request<{ form: { id: string; title: string; version: number; definition: Definition } }>('GET', `/collect/${token}`),
  startResponse: (token: string) => request<{ responseId: string }>('POST', `/collect/${token}/responses`, {}),
  saveResponse: (token: string, responseId: string, answers: Record<string, unknown>) =>
    request<{ missing: string[]; invalid: string[] }>('PATCH', `/collect/${token}/responses/${responseId}`, { answers }),
  submitResponse: (token: string, responseId: string, answers: Record<string, unknown>) =>
    request<{ status: string }>('POST', `/collect/${token}/responses/${responseId}/submit`, { answers }),
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
