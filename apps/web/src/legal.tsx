import { useEffect, useState } from 'react';
import { ApiError, api, type LegalDocument, type TermsStatus } from './api';

/**
 * Terms acceptance, the invitation landing page, and the documents themselves.
 *
 * The acceptance step is a gate rather than a footnote: the checkbox starts
 * unchecked, the button stays disabled until it is ticked, and nothing in the
 * workspace is reachable until the server has recorded the acceptance. What gets
 * recorded is the account, the time, the document versions, the hash of the exact
 * text shown, the checkbox wording, and the request context.
 */

export function TermsGate({
  status,
  onAccepted,
}: {
  status: TermsStatus;
  onAccepted: () => void;
}): JSX.Element {
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.acceptTerms(status.terms.version, status.privacy.version);
      onAccepted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not record your acceptance');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth card">
      <div className="eyebrow">Consent</div>
      <h1>Before you continue</h1>
      <p className="muted small">
        These terms explain what you may do with the service and what happens to the data you collect. The privacy
        policy explains what we do with your account data, and how we handle survey responses on your instructions.
      </p>

      <label className="checkbox">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          {status.checkboxText}{' '}
          <a href="/terms" target="_blank" rel="noreferrer">
            Terms of Service
          </a>{' '}
          and{' '}
          <a href="/privacy" target="_blank" rel="noreferrer">
            Privacy Policy
          </a>
          .
        </span>
      </label>

      <div className="row wrap">
        <span className="pill mono">Version {status.terms.version}</span>
        <span className="pill mono">terms {status.terms.hash.slice(0, 12)}</span>
        <span className="pill mono">privacy {status.privacy.hash.slice(0, 12)}</span>
      </div>

      <button type="button" onClick={() => void accept()} disabled={!agreed || busy}>
        {busy ? 'Recording...' : 'Agree and continue'}
      </button>
      <button
        type="button"
        className="ghost"
        onClick={() => {
          void api.logout().finally(() => window.location.assign('/'));
        }}
      >
        Sign out
      </button>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

export function LegalPage({ id }: { id: 'terms' | 'privacy' }): JSX.Element {
  const [doc, setDoc] = useState<LegalDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .legalDocument(id)
      .then((res) => {
        if (!cancelled) setDoc(res.document);
      })
      .catch(() => {
        if (!cancelled) setError('This document could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="card">
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!doc) {
    return (
      <div className="boot">
        <p>Loading...</p>
        <div className="boot-bar" />
      </div>
    );
  }

  return (
    <div className="prose card">
      <div className="eyebrow">Document</div>
      <h1>{doc.title}</h1>
      <div className="row wrap">
        <span className="pill">Version {doc.version}</span>
        <span className="pill">Effective {doc.effectiveDate}</span>
        <span className="pill mono">Hash {doc.hash.slice(0, 16)}</span>
      </div>
      <p>{doc.summary}</p>
      {doc.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 40)}>{paragraph}</p>
          ))}
          {section.bullets && (
            <ul>
              {section.bullets.map((bullet) => (
                <li key={bullet.slice(0, 40)}>{bullet}</li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <p className="muted small">
        <a href="/">Back to the application</a>
      </p>
    </div>
  );
}

/**
 * The page an invitation link opens.
 *
 * Loading this page does not spend the invitation: the link is only consumed when
 * the person presses the button, which sends a POST. Mail scanners and link
 * previews fetch URLs before a human sees them, and an invitation swallowed by a
 * robot would look to the recipient exactly like a broken link.
 */
export function InvitePage({ token }: { token: string }): JSX.Element {
  const [invite, setInvite] = useState<{ email: string; role: string; organisation: string; expiresAt: string } | null>(
    null,
  );
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .invitePreview(token)
      .then((res) => {
        if (!cancelled) setInvite(res.invite);
      })
      .catch(() => {
        if (!cancelled) setInvalid(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const redeem = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.redeemInvite(token);
      // Full reload: the session cookie is new, and the app decides what to show
      // next, including the terms step if it is still outstanding.
      window.location.assign('/');
    } catch (err) {
      setBusy(false);
      setInvalid(true);
      setError(
        err instanceof ApiError && err.status === 410
          ? 'This invitation has already been used or has expired.'
          : 'This invitation could not be accepted.',
      );
    }
  };

  if (invalid) {
    return (
      <div className="auth card">
        <div className="eyebrow">Invitation</div>
        <h1>Invitation not usable</h1>
        <p className="muted">
          {error ?? 'This link is not valid.'} Invitation links can be used once and expire. Ask the person who invited
          you to send a new one.
        </p>
        <p className="muted small">
          <a href="/">Go to the sign in page</a>
        </p>
      </div>
    );
  }

  if (!invite) {
    return (
      <div className="boot">
        <p>Loading...</p>
        <div className="boot-bar" />
      </div>
    );
  }

  return (
    <div className="auth card">
      <header className="screen-head">
        <div>
          <div className="eyebrow">Invitation</div>
          <h1>Join {invite.organisation}</h1>
          <p className="muted">
            You have been invited as <span className="pill">{invite.role}</span> for{' '}
            <span className="mono">{invite.email}</span>.
          </p>
        </div>
      </header>
      <div className="card">
        <p className="muted small">
          This link works once and expires on {new Date(invite.expiresAt).toLocaleString()}. Pressing the button below
          signs you in and uses it.
        </p>
      </div>
      <button type="button" onClick={() => void redeem()} disabled={busy}>
        {busy ? 'Joining...' : `Join ${invite.organisation}`}
      </button>
      <p className="muted small">
        By joining you will be asked to accept the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>{' '}
        and the <a href="/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
      </p>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
