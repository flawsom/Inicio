import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Invite, type MailStatus } from './api';

/**
 * The administration console.
 *
 * Visible only to an owner or an administrator of the selected organisation, and
 * the server enforces the same rule independently: every call here goes through
 * the organisation scoped guard. Hiding the menu is a courtesy, not the control.
 *
 * The invitation link is displayed once, at the moment it is created, and is
 * never retrievable afterwards. That is deliberate: the server keeps only a hash
 * of the token, so there is nothing to show on a later visit.
 */

interface Member {
  user_id: string;
  email: string;
  role: string;
}

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

function roleSummary(): Array<{ role: string; meaning: string }> {
  return [
    { role: 'owner', meaning: 'Full control, including the roster and deleting the organisation.' },
    { role: 'admin', meaning: 'Manage members and invitations, and use everything else.' },
    { role: 'member', meaning: 'Author forms and collect data. Cannot manage people or invite anyone.' },
    { role: 'viewer', meaning: 'Read and export only. Cannot change anything.' },
  ];
}

export function AdminView({ orgId, canAdminister }: { orgId: string; canAdminister: boolean }): JSX.Element {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [mail, setMail] = useState<MailStatus | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('member');
  const [days, setDays] = useState('7');
  const [freshLink, setFreshLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!canAdminister) return;
    try {
      const [roster, pending, diagnostics] = await Promise.all([
        api.members(orgId),
        api.invites(orgId),
        api.mailDiagnostics(orgId),
      ]);
      setMembers(roster.members as Member[]);
      setInvites(pending.invites);
      setMail(diagnostics.status);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not load the administration console');
    }
  }, [orgId, canAdminister]);

  useEffect(() => {
    void reload();
    // The roster can change from another administrator's session, so re-read it
    // when this tab becomes visible again rather than showing a stale list.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [reload]);

  const createInvite = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.createInvite(orgId, email, role, Number(days));
      setFreshLink({ email: res.invite.email, url: res.url });
      setEmail('');
      setNotice(`Invitation created for ${res.invite.email}. Copy the link before leaving this page.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not create the invitation');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (inviteId: string): Promise<void> => {
    setError(null);
    try {
      await api.revokeInvite(orgId, inviteId);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not revoke the invitation');
    }
  };

  const changeRole = async (userId: string, next: string): Promise<void> => {
    setError(null);
    try {
      await api.memberRole(orgId, userId, next);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not change the role');
    }
  };

  const remove = async (userId: string): Promise<void> => {
    setError(null);
    try {
      await api.removeMember(orgId, userId);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not remove the member');
    }
  };

  if (!canAdminister) {
    return (
      <div className="card">
        <h1>Administration</h1>
        <p className="muted">
          Only an owner or an administrator can manage people and invitations. Your role does not include that access.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <h1>People</h1>
        <p className="muted small">
          Membership is checked on every request, so a change here takes effect immediately rather than at the next sign
          in.
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.user_id}>
                <td className="mono small">{member.email}</td>
                <td>
                  <select value={member.role} onChange={(e) => void changeRole(member.user_id, e.target.value)}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="right">
                  <button type="button" className="ghost" onClick={() => void remove(member.user_id)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <details className="small muted">
          <summary>What each role can do</summary>
          <ul>
            {roleSummary().map((r) => (
              <li key={r.role}>
                <strong>{r.role}</strong>: {r.meaning}
              </li>
            ))}
          </ul>
        </details>
      </div>

      <div className="card">
        <h1>Invitations</h1>
        <p className="muted small">
          An invitation link signs in the invited address once, then stops working. It is bound to that address and
          carries the role you choose here, so it cannot be used by anyone else even if it is forwarded.
        </p>
        <div className="row wrap">
          <input
            type="email"
            placeholder="person@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="1">Expires in 1 day</option>
            <option value="7">Expires in 7 days</option>
            <option value="14">Expires in 14 days</option>
            <option value="30">Expires in 30 days</option>
          </select>
          <button type="button" onClick={() => void createInvite()} disabled={busy || email.length < 5}>
            {busy ? 'Creating...' : 'Create invitation link'}
          </button>
        </div>

        {freshLink && (
          <div className="invitebox">
            <p className="small">
              <strong>Single use link for {freshLink.email}</strong>
            </p>
            <div className="row">
              <input className="mono small" readOnly value={freshLink.url} onFocus={(e) => e.currentTarget.select()} />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(freshLink.url);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="muted small">
              Send it over a channel you trust. It is shown once and cannot be retrieved later, and anyone holding it
              before it is used can join this organisation.
            </p>
          </div>
        )}

        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Expires</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invites.map((invite) => (
              <tr key={invite.id}>
                <td className="mono small">{invite.email}</td>
                <td>{invite.role}</td>
                <td className="small">{new Date(invite.expires_at).toLocaleString()}</td>
                <td className="small">
                  {invite.accepted_at
                    ? 'accepted'
                    : invite.revoked_at
                      ? 'revoked'
                      : invite.pending
                        ? 'pending'
                        : 'expired'}
                </td>
                <td className="right">
                  {invite.pending && (
                    <button type="button" className="ghost" onClick={() => void revoke(invite.id)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {invites.length === 0 && (
              <tr>
                <td colSpan={5} className="muted small">
                  No invitations yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h1>Email delivery</h1>
        <p className="muted small">
          Sign in codes depend on this. The detail below is shown here rather than on the login page, because it is
          operational information.
        </p>
        {mail && (
          <ul className="small">
            <li>
              Transport: <span className="mono">{mail.transport}</span> via {mail.host}:{mail.port}
            </li>
            <li>
              From: <span className="mono">{mail.from}</span>
            </li>
            <li>
              Usable right now: <strong>{mail.reachable ? 'yes' : 'no'}</strong>{' '}
              <span className="muted">
                ({mail.basis === 'none' ? 'nothing sent yet in this process' : mail.basis === 'last-send' ? 'from the last send' : 'from a live check'})
              </span>
            </li>
            <li className="muted">{mail.detail}</li>
          </ul>
        )}
      </div>

      {notice && <p className="small muted">{notice}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
