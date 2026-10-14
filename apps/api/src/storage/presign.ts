/**
 * SigV4 presigned URLs, written out rather than imported.
 *
 * Every operation this product needs against object storage is a presigned
 * request: the browser PUTs the bytes straight to the store after the API has
 * authorised the question, the type and the size, and the API itself HEADs,
 * GETs and DELETEs the same way — one signing implementation instead of a client
 * library, a header-signing path and a presigning path that can disagree.
 *
 * Why not `@aws-sdk/client-s3`: it is a large dependency, it would be pulled into
 * the API bundle to sign a query string, and this repository already hand-writes
 * the readers and writers it depends on for exactly this reason (the XLSX reader
 * and writer in `packages/engine`). SigV4 is a documented, fixed algorithm — and
 * unlike a library it can be proven here: the test that covers this file runs a
 * stub store that *recomputes the signature from the incoming request* and
 * refuses anything that does not match, which is the only check that shows a
 * presigned URL is actually valid rather than merely well-shaped.
 *
 * The algorithm, in the order it has to be applied:
 *
 *   1. a canonical request: method, path, sorted query, signed headers, payload
 *   2. its SHA-256, with the algorithm and scope, is the string to sign
 *   3. a date/region/service/request key, derived by HMAC-SHA256, signs it
 *   4. the signature is appended as one more query parameter
 *
 * `UNSIGNED-PAYLOAD` is used deliberately: the body is streamed by the browser
 * over a connection the API never sees, so signing a hash of it is not possible.
 */
import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** The store refuses anything shorter; a week is also the documented maximum. */
const MIN_EXPIRY_SECONDS = 1;
const MAX_EXPIRY_SECONDS = 60 * 60 * 24 * 7;

export interface SigningConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** Base URL, e.g. `https://ep-xxx.storage.example` — path-style addressing. */
  endpoint: string;
  bucket: string;
}

export interface PresignOptions {
  method: 'PUT' | 'GET' | 'HEAD' | 'DELETE';
  /** Object key, without the bucket. Slashes are path separators, not data. */
  key: string;
  expiresInSeconds?: number;
  /**
   * Headers the client is required to send. They are signed, so the store
   * rejects a request that changes or drops them — which is what makes a
   * presigned PUT bound to one content type rather than to "any bytes at all".
   */
  headers?: Record<string, string>;
  /** Extra query parameters. Signed, so they cannot be altered after the fact. */
  query?: Record<string, string>;
  /** Injectable so the signature is deterministic in a test. */
  now?: Date;
}

/**
 * RFC 3986 percent-encoding: unreserved characters stay, everything else becomes
 * uppercase hex. `encodeURIComponent` is close but leaves `!'()*` alone, and SigV4
 * does not — a key with an apostrophe in it would sign one path and request
 * another.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(character) || (!encodeSlash && character === '/')) {
      out += character;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** `2026-10-13T18:00:00.000Z` → `20261013T180000Z`, and from it `20261013`. */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const hmac = (key: Buffer | string, value: string): Buffer =>
  createHmac('sha256', key).update(value, 'utf8').digest();

/** The path the store is asked for: path-style, so the bucket is a segment. */
export function objectPath(bucket: string, key: string): string {
  const segments = [bucket, ...key.split('/')].map((segment) => uriEncode(segment));
  return `/${segments.join('/')}`;
}

export function signedRequest(config: SigningConfig, options: PresignOptions): {
  url: string;
  canonicalRequest: string;
  signature: string;
  signedHeaders: string;
} {
  const now = options.now ?? new Date();
  const expiry = Math.min(
    Math.max(options.expiresInSeconds ?? 900, MIN_EXPIRY_SECONDS),
    MAX_EXPIRY_SECONDS,
  );
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${config.region}/${SERVICE}/aws4_request`;
  const host = new URL(config.endpoint).host;

  // Header names are lowercased and sorted: the canonical form is exact, and a
  // client that sends `Content-Type` is sending the same header as `content-type`.
  const extra = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const signedHeaderNames = ['host', ...Object.keys(extra)].sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${name === 'host' ? host : extra[name]}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const query: Record<string, string> = {
    ...options.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiry),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name]!)}`)
    .join('&');

  const canonicalUri = objectPath(config.bucket, options.key);
  const canonicalRequest = [
    options.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), SERVICE),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  const base = config.endpoint.replace(/\/+$/, '');
  return {
    url: `${base}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    canonicalRequest,
    signature,
    signedHeaders,
  };
}

export function presignUrl(config: SigningConfig, options: PresignOptions): string {
  return signedRequest(config, options).url;
}
