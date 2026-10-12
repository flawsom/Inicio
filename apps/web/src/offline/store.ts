import type { CachedForm, StoredDraft } from './types.js';

/**
 * Where a draft lives between syncs.
 *
 * IndexedDB, because that is the browser's durable, transactional store and it
 * survives a tab kill, a crash and an airplane-mode reload. A few environments
 * (private-mode Safari in some versions, and the unit tests) have no usable
 * IndexedDB, so a memory implementation with identical semantics is the fallback
 * — the app degrades to "saved for this session" rather than failing to load.
 */
export interface OfflineStore {
  getDraft(token: string): Promise<StoredDraft | null>;
  putDraft(draft: StoredDraft): Promise<void>;
  removeDraft(token: string): Promise<void>;
  getCachedForm(token: string): Promise<CachedForm | null>;
  putCachedForm(form: CachedForm): Promise<void>;
}

const DB_NAME = 'inicio-collect';
const DB_VERSION = 1;
const DRAFTS = 'drafts';
const FORMS = 'forms';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'));
  });
}

class IndexedDbStore implements OfflineStore {
  constructor(private readonly db: IDBDatabase) {}

  private tx(store: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(store, mode).objectStore(store);
  }

  async getDraft(token: string): Promise<StoredDraft | null> {
    const row = await request<StoredDraft | undefined>(this.tx(DRAFTS, 'readonly').get(token) as IDBRequest<StoredDraft | undefined>);
    return row ?? null;
  }

  async putDraft(draft: StoredDraft): Promise<void> {
    await request(this.tx(DRAFTS, 'readwrite').put(draft, draft.token));
  }

  async removeDraft(token: string): Promise<void> {
    await request(this.tx(DRAFTS, 'readwrite').delete(token));
  }

  async getCachedForm(token: string): Promise<CachedForm | null> {
    const row = await request<CachedForm | undefined>(this.tx(FORMS, 'readonly').get(token) as IDBRequest<CachedForm | undefined>);
    return row ?? null;
  }

  async putCachedForm(form: CachedForm): Promise<void> {
    await request(this.tx(FORMS, 'readwrite').put(form, form.token));
  }
}

/** Same contract, no durability: used when IndexedDB is unavailable (and by tests). */
export class MemoryStore implements OfflineStore {
  protected readonly drafts = new Map<string, string>();
  protected readonly forms = new Map<string, string>();

  async getDraft(token: string): Promise<StoredDraft | null> {
    const raw = this.drafts.get(token);
    return raw ? (JSON.parse(raw) as StoredDraft) : null;
  }
  async putDraft(draft: StoredDraft): Promise<void> {
    this.drafts.set(draft.token, JSON.stringify(draft));
  }
  async removeDraft(token: string): Promise<void> {
    this.drafts.delete(token);
  }
  async getCachedForm(token: string): Promise<CachedForm | null> {
    const raw = this.forms.get(token);
    return raw ? (JSON.parse(raw) as CachedForm) : null;
  }
  async putCachedForm(form: CachedForm): Promise<void> {
    this.forms.set(form.token, JSON.stringify(form));
  }
}

let cached: OfflineStore | null = null;

export function memoryStore(): OfflineStore {
  return new MemoryStore();
}

/**
 * Opens the durable store once per page, falling back to memory if the browser
 * will not give us one. A failure here must never stop a respondent from
 * answering: the fallback keeps the session working, and the UI still reports
 * whether the server has the answers.
 */
export async function openStore(): Promise<OfflineStore> {
  if (cached) return cached;
  if (typeof indexedDB === 'undefined') {
    cached = new MemoryStore();
    return cached;
  }
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const database = open.result;
        if (!database.objectStoreNames.contains(DRAFTS)) database.createObjectStore(DRAFTS, { keyPath: 'token' });
        if (!database.objectStoreNames.contains(FORMS)) database.createObjectStore(FORMS, { keyPath: 'token' });
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error('indexeddb refused to open'));
      open.onblocked = () => reject(new Error('indexeddb blocked'));
    });
    cached = new IndexedDbStore(db);
  } catch {
    cached = new MemoryStore();
  }
  return cached;
}
