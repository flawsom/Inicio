/**
 * The object store, reached only through presigned requests.
 *
 * There is no SDK here and no credential is ever handed to a browser: the API
 * authorises a question, a type and a size, signs one URL for exactly that
 * object, and the bytes travel between the browser and the store without passing
 * through a serverless function whose body size limit is a few megabytes.
 *
 * HEAD, GET and DELETE are presigned too, rather than sent with an Authorization
 * header, so there is one signing path to get right instead of two. `headObject`
 * is the interesting one: it is how the API finds out what actually arrived,
 * which is the only size and type worth believing.
 */
import { env } from '../env.js';
import { presignUrl, type SigningConfig } from './presign.js';

export type StorageConfig = SigningConfig;

/** The ceiling for one attachment, from the environment (10 MB by default). */
export const uploadMaxBytes = (): number => env.UPLOAD_MAX_BYTES;

function normaliseEndpoint(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The configured store, or null when there is none.
 *
 * Null is a supported state, not a misconfiguration: the collection API answers
 * `501 storage_not_configured` and the renderer goes on saying that these
 * questions are not collected here. That is the difference between a deployment
 * that cannot store a file and one that silently drops it.
 */
export function storageConfig(): StorageConfig | null {
  const bucket = env.S3_BUCKET;
  const endpoint = env.S3_ENDPOINT ?? env.AWS_ENDPOINT_URL_S3;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    endpoint: normaliseEndpoint(endpoint),
    region: env.S3_REGION ?? env.AWS_REGION ?? 'us-east-1',
    accessKeyId,
    secretAccessKey,
  };
}

export class StorageError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
    this.name = 'StorageError';
  }
}

/** A presigned URL the browser may PUT the bytes to. The type is signed with it. */
export function presignPut(key: string, contentType: string, expiresInSeconds = 900): string {
  const config = storageConfig();
  if (!config) throw new StorageError('storage is not configured');
  return presignUrl(config, {
    method: 'PUT',
    key,
    expiresInSeconds,
    headers: { 'content-type': contentType },
  });
}

/** A short-lived read URL. Used by the API's own GET and by author downloads. */
export function presignGet(key: string, expiresInSeconds = 900, download?: string): string {
  const config = storageConfig();
  if (!config) throw new StorageError('storage is not configured');
  return presignUrl(config, {
    method: 'GET',
    key,
    expiresInSeconds,
    query: download ? { 'response-content-disposition': `attachment; filename="${download}"` } : undefined,
  });
}

export interface StoredObject {
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
}

/**
 * What the store holds for this key, or null when it holds nothing.
 *
 * This is the measurement the API trusts after an upload: a client that declared
 * two kilobytes and sent ten megabytes is discovered here, by asking the thing
 * that received them.
 */
export async function headObject(key: string): Promise<StoredObject | null> {
  const config = storageConfig();
  if (!config) throw new StorageError('storage is not configured');
  const response = await fetch(presignUrl(config, { method: 'HEAD', key, expiresInSeconds: 120 }), {
    method: 'HEAD',
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new StorageError(`the store answered ${response.status} for a HEAD`, `HEAD ${key}`);
  }
  const length = Number(response.headers.get('content-length') ?? '0');
  return {
    sizeBytes: Number.isFinite(length) && length > 0 ? length : 0,
    contentType: response.headers.get('content-type'),
    etag: response.headers.get('etag'),
  };
}

/** The bytes, capped: nothing larger than the ceiling is ever pulled into memory. */
export async function getObjectBytes(key: string, maxBytes = uploadMaxBytes()): Promise<Buffer> {
  const config = storageConfig();
  if (!config) throw new StorageError('storage is not configured');
  const response = await fetch(presignUrl(config, { method: 'GET', key, expiresInSeconds: 300 }), {
    method: 'GET',
  });
  if (!response.ok) {
    throw new StorageError(`the store answered ${response.status} for a GET`, `GET ${key}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new StorageError('the object is larger than the ceiling', `${bytes.byteLength} bytes`);
  }
  return bytes;
}

export async function deleteObject(key: string): Promise<void> {
  const config = storageConfig();
  if (!config) throw new StorageError('storage is not configured');
  const response = await fetch(presignUrl(config, { method: 'DELETE', key, expiresInSeconds: 120 }), {
    method: 'DELETE',
  });
  // A store that answers 404 is telling us the object is already gone, which is
  // what the caller wanted; anything else is a real failure and is raised.
  if (!response.ok && response.status !== 404) {
    throw new StorageError(`the store answered ${response.status} for a DELETE`, `DELETE ${key}`);
  }
}
