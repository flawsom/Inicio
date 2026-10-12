/**
 * Offline-first collection: the shapes shared by the store, the sync runner and
 * the renderer.
 *
 * The invariant everything here exists to protect (SPEC §16): NO SILENT DATA
 * LOSS. An answer typed on a device with no network must reach the server
 * eventually, exactly once, and a disagreement about its value must be visible
 * rather than quietly resolved.
 */

/** What the device knows about one distribution link's response. */
export interface StoredDraft {
  /** The distribution token this draft belongs to. */
  token: string;
  /**
   * The device's own stable id for this response. It becomes the response id on
   * the server, which is what makes a retried sync idempotent.
   */
  clientId: string;
  /** The server's id, once it has acknowledged the response. */
  responseId: string | null;
  /** The answers as they exist on the device — the only copy while offline. */
  answers: Record<string, unknown>;
  /** The last answers the server confirmed, used to detect a real conflict. */
  base: Record<string, unknown>;
  /** Question names edited since the last acknowledged sync. */
  dirty: string[];
  status: 'in_progress' | 'submitted' | 'screened_out' | 'quota_full';
  updatedAt: string;
  /** When the server last confirmed this draft. */
  syncedAt: string | null;
  outbox: Outbox;
}

/**
 * The durable queue.
 *
 * It is deliberately *not* a list of every keystroke: a save supersedes the
 * previous save (they carry the whole answer set), so the queue stays tiny and
 * a flaky link cannot build up a backlog of stale payloads. A submit supersedes
 * a pending save for the same reason.
 */
export interface Outbox {
  /** The response still has to be created on the server (or resumed). */
  create: boolean;
  save: PendingPayload | null;
  submit: PendingPayload | null;
  /** Failed attempts since the last success, for backoff. */
  attempts: number;
  /** Epoch ms before which a retry is pointless. */
  nextAttemptAt: number;
  /** The last failure, in words a person can act on. */
  lastError: string | null;
}

export interface PendingPayload {
  answers: Record<string, unknown>;
  base: Record<string, unknown>;
}

/** The published definition, cached so the form can open with no network at all. */
export interface CachedForm {
  token: string;
  title: string;
  version: number;
  definition: unknown;
  linkKind: string;
  cachedAt: string;
}

export type SyncPhase =
  | 'local'      // saved on this device, nothing waiting
  | 'queued'     // changes waiting, the server has not confirmed them
  | 'syncing'    // a sync is in flight
  | 'synced'     // the server has everything
  | 'offline'    // no network; answers are safe on the device
  | 'error'      // the last attempt failed for a reason worth showing
  | 'done';      // submitted and acknowledged

export interface SyncOutcome {
  phase: SyncPhase;
  missing: string[];
  invalid: string[];
  conflicts: number;
  status: StoredDraft['status'];
  error: string | null;
}
