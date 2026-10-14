import type { OfflineStore } from './store.js';
import type { StoredDraft } from './types.js';

/**
 * A copy of what is on this device, in a file the person holding it can keep.
 *
 * Everything else in `offline/` protects answers from the network: the draft is written
 * before anything is sent, the queue retries, a disagreement is kept rather than
 * resolved. None of that survives the device itself going away. Clearing a browser's
 * storage, reinstalling the app, moving to a replacement phone, or a tablet that decides
 * to reclaim its disk all take the draft with them, and the answers that had not reached
 * the server yet are gone with no second copy anywhere.
 *
 * So this is the one path that does not need the network, a server, or a session: the
 * draft is written to a file through the browser's own download, and read back through a
 * file the person picks. It is deliberately plain JSON, because the recovery story has to
 * be honest to somebody who is having a bad day: the file says what it is, which link it
 * belongs to, which form and version it was filled in against, and the whole draft with
 * its queue intact, so a restored device carries on sending where it left off rather
 * than starting again.
 *
 * The rules about what may be restored live here, away from any DOM, so they are tested
 * as rules: a copy of a different survey is refused by name, a copy written by a newer
 * app is refused rather than half-read, and a copy older than the answers already on the
 * device never overwrites them.
 */

export const BACKUP_FORMAT = 'inicio.device-copy';
export const BACKUP_VERSION = 1;

export interface DeviceBackup {
  /** The marker that says this file is ours, checked before anything else is trusted. */
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  /** The distribution link this draft belongs to. A copy is only ever for one link. */
  token: string;
  /** What the copy is of, for a person reading the file rather than a program. */
  form: { title: string | null; version: number | null };
  draft: StoredDraft;
}

export function buildBackup(
  draft: StoredDraft,
  form: { title?: string | null; version?: number | null } = {},
  now: Date = new Date(),
): DeviceBackup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    token: draft.token,
    form: { title: form.title ?? null, version: form.version ?? null },
    draft,
  };
}

/** A filename that is safe on every platform, and says which survey it came from. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function fileNameFor(backup: DeviceBackup): string {
  const name = slug(backup.form.title ?? '') || 'answers';
  return `inicio-${name}-${backup.draft.clientId.slice(0, 8)}.json`;
}

export type ParsedBackup = { ok: true; backup: DeviceBackup } | { ok: false; reason: string };

/** The shape test, kept separate so the reason for a refusal is written once. */
export function validateBackup(value: unknown): ParsedBackup {
  const candidate = value as Partial<DeviceBackup> | null;
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: notOurs };
  if (candidate.format !== BACKUP_FORMAT) return { ok: false, reason: notOurs };
  if (typeof candidate.version !== 'number') return { ok: false, reason: notOurs };
  if (candidate.version > BACKUP_VERSION) return { ok: false, reason: fromNewerApp };
  const draft = candidate.draft as StoredDraft | undefined;
  if (!draft || typeof draft !== 'object' || typeof draft.token !== 'string' || draft.token === '') {
    return { ok: false, reason: notOurs };
  }
  if (typeof candidate.token !== 'string' || candidate.token !== draft.token) {
    return { ok: false, reason: notOurs };
  }
  if (typeof draft.answers !== 'object' || draft.answers === null) return { ok: false, reason: notOurs };
  return { ok: true, backup: candidate as DeviceBackup };
}

export function parseBackup(text: string): ParsedBackup {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, reason: unreadable };
  }
  return validateBackup(value);
}

export type RestoreResult = { ok: true; draft: StoredDraft } | { ok: false; reason: string };

/**
 * Put a copy back on the device.
 *
 * `token` is the link that is open right now, and a copy of any other link is refused:
 * restoring one survey's answers onto another survey's page would produce a response
 * full of questions the form does not ask, which the server would then have to refuse at
 * submission time with no way for the person to tell what went wrong.
 */
export async function restoreBackup(
  store: OfflineStore,
  text: string,
  token: string,
): Promise<RestoreResult> {
  const parsed = parseBackup(text);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const backup = parsed.backup;
  if (backup.token !== token) return { ok: false, reason: otherSurvey };

  const existing = await store.getDraft(token);
  if (existing && isLater(existing.updatedAt, backup.draft.updatedAt)) {
    return { ok: false, reason: existingIsNewer };
  }

  // The token in the record is the one being restored onto, not whatever the file said:
  // the store is keyed by token, and a copy that has been renamed on disk must not be
  // able to become a second draft under another name.
  const draft: StoredDraft = { ...backup.draft, token };
  await store.putDraft(draft);
  return { ok: true, draft };
}

/** ISO instants compare correctly as strings; anything unreadable counts as older. */
function isLater(candidate: string, than: string): boolean {
  const a = Date.parse(candidate);
  const b = Date.parse(than);
  if (Number.isNaN(b)) return false;
  if (Number.isNaN(a)) return false;
  return a > b;
}

const unreadable = 'That file could not be read. It is not a copy of saved answers this app wrote.';
const notOurs = 'That file is not a copy of saved answers this app wrote.';
const fromNewerApp =
  'That copy was written by a newer version of this app than the one running here, so it cannot be read on this device.';
const otherSurvey = 'That copy belongs to a different survey link from the one open here, so nothing was restored.';
const existingIsNewer =
  'This device already holds answers newer than that copy, so nothing was replaced. Save a copy of them first if you want to keep them.';
