/**
 * The scan step, and the honest vocabulary for not having one.
 *
 * An upload that nobody looks at is a file from the internet sitting on a
 * researcher's disk, so the path has a scan and a status that reflects what
 * actually happened:
 *
 *   clean      a scanner read the bytes and said so
 *   infected   a scanner read the bytes and named what it found; the object is deleted
 *   error      a scanner was configured but could not answer
 *   skipped    no scanner is configured for this deployment
 *
 * `error` and `skipped` exist precisely so that `clean` never means "we hoped".
 * A deployment without a scanner keeps working — and says, on the record, that
 * these files were stored unscanned, which is a decision an operator can make
 * and a tenant can read.
 *
 * The protocol is clamd's INSTREAM: the literal `zINSTREAM\0`, then the bytes as
 * length-prefixed chunks (4-byte big-endian) with a zero-length chunk to end, and
 * a reply of `stream: OK` or `stream: <Signature> FOUND`. ClamAV is the scanner
 * named in this project's own compose profile, which is why it is the one
 * implemented rather than a hypothetical interface.
 */
import { connect } from 'node:net';
import { env } from '../env.js';

export type ScanStatus = 'clean' | 'infected' | 'error' | 'skipped';

export interface ScanResult {
  status: ScanStatus;
  detail: string;
  /** The signature name, when a scanner found something. */
  signature?: string;
}

const CHUNK_BYTES = 64 * 1024;

export const scannerConfigured = (): boolean => Boolean(env.CLAMD_HOST);

/** The status to record when there is no scanner, phrased for the console to repeat. */
export const unscanned: ScanResult = {
  status: 'skipped',
  detail: 'no scanner is configured for this deployment, so these bytes were stored unscanned',
};

/**
 * Whether this deployment accepts a file no scanner has read.
 *
 * `skipped` and `error` are both "unscanned", and both stay on the row as what
 * they are - this decides only whether such a file may become an answer. It is a
 * policy rather than something derived from the environment on purpose: a
 * deployment with no scanner has decided to accept unscanned files, and naming
 * that decision is what lets an operator tell "we chose this" apart from "somebody
 * forgot CLAMD_HOST".
 */
export const scanPolicy = (): 'allow_unscanned' | 'require' => env.ATTACHMENT_SCAN_POLICY;

export const unscannedAccepted = (): boolean => scanPolicy() === 'allow_unscanned';

function parseReply(reply: string): ScanResult {
  const text = reply.replace(/\0/g, '').trim();
  const stream = /^stream:\s*(.*)$/i.exec(text);
  const verdict = (stream?.[1] ?? text).trim();
  if (/^OK$/i.test(verdict)) {
    return { status: 'clean', detail: 'the scanner read these bytes and found nothing' };
  }
  const found = /^(.+)\s+FOUND$/i.exec(verdict);
  if (found) {
    return {
      status: 'infected',
      detail: `the scanner identified this file as ${found[1]}`,
      signature: found[1]!,
    };
  }
  return { status: 'error', detail: `the scanner answered "${verdict || 'nothing'}"` };
}

/**
 * Send the bytes to a clamd and read its verdict.
 *
 * Every failure mode that is not a verdict — a refused connection, a timeout, a
 * closed socket — is `error`, never `clean`. There is deliberately no path
 * through this function that reports a file clean without a scanner saying so.
 */
export async function scanBytes(bytes: Buffer): Promise<ScanResult> {
  if (!scannerConfigured()) return unscanned;
  const timeout = env.CLAMD_TIMEOUT_MS;

  return new Promise<ScanResult>((resolve) => {
    let settled = false;
    let reply = '';
    const finish = (result: ScanResult): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    const socket = connect({ host: env.CLAMD_HOST!, port: env.CLAMD_PORT });
    socket.setTimeout(timeout);
    socket.on('timeout', () =>
      finish({ status: 'error', detail: `the scanner did not answer within ${timeout} ms` }),
    );
    socket.on('error', (err: Error) =>
      finish({ status: 'error', detail: `the scanner could not be reached: ${err.message}` }),
    );
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8');
      if (reply.includes('\0') || reply.includes('\n') || /(OK|FOUND|ERROR)$/i.test(reply)) {
        finish(parseReply(reply));
      }
    });
    socket.on('close', () => {
      if (reply) finish(parseReply(reply));
      else finish({ status: 'error', detail: 'the scanner closed the connection without a verdict' });
    });

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.byteLength, 0);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
  });
}
