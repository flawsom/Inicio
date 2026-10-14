/**
 * The author side of an attachment: what arrived, and a URL to read it.
 *
 * The file itself never passes through the API. A respondent's photo is uploaded
 * directly to object storage against a URL this API signed for that one object,
 * and an author reads it back the same way — so a downloaded 40 MB video is not a
 * 40 MB response body from a serverless function.
 *
 * Two things this route refuses to do. It will not serve a row that is not
 * `uploaded`, and it will not serve an infected one: a file a scanner named stays
 * out of reach whatever else is true about it. A deployment with no store
 * configured answers `501` and says so, rather than handing back a URL that cannot
 * resolve.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { HttpError } from './db.js';
import { requireActor, withActorOrg } from './actors.js';
import { StorageError, presignGet, storageConfig } from '../storage/s3.js';

export const platformAttachmentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Metadata and a short-lived read URL for one attachment.
   *
   * Session-only: `requireActor` without a scope refuses an API key outright
   * (`403 key_not_permitted`), because no scope in this product's vocabulary
   * covers reading the files people attached to their answers.
   */
  app.get(
    '/orgs/:orgId/attachments/:attachmentId',
    async (
      req: FastifyRequest<{ Params: { orgId: string; attachmentId: string } }>,
      reply,
    ) => {
      const actor = await requireActor(req);
      const payload = await withActorOrg(actor, req.params.orgId, async (client) => {
        const { rows } = await client.query<{
          id: string;
          response_id: string;
          question_id: string;
          filename: string;
          mime: string;
          size_bytes: number;
          sha256: string | null;
          scan_status: string;
          status: string;
          storage_key: string;
          uploaded_at: Date;
        }>(
          `SELECT id, response_id, question_id, filename, mime, size_bytes, sha256,
                  scan_status, status, storage_key, uploaded_at
             FROM response_attachment
            WHERE id = $1 AND org_id = $2`,
          [req.params.attachmentId, req.params.orgId],
        );
        const row = rows[0];
        if (!row) throw new HttpError(404, 'not_found');
        if (row.scan_status === 'infected') {
          throw new HttpError(
            409,
            'attachment_infected',
            'this file was identified by the security scan and deleted, so there is nothing to download',
          );
        }
        if (row.status !== 'uploaded') {
          throw new HttpError(
            409,
            'attachment_not_uploaded',
            row.status === 'pending' ? 'the file never finished uploading' : 'this attachment was removed',
          );
        }
        if (!storageConfig()) {
          throw new HttpError(501, 'storage_not_configured', 'this deployment has no object store to read from');
        }

        let downloadUrl: string;
        try {
          downloadUrl = presignGet(row.storage_key, 300, row.filename);
        } catch (err) {
          if (err instanceof StorageError) {
            throw new HttpError(503, 'storage_unavailable', 'the object store could not be asked for a URL');
          }
          throw err;
        }

        return {
          attachmentId: row.id,
          responseId: row.response_id,
          questionId: row.question_id,
          filename: row.filename,
          mime: row.mime,
          sizeBytes: row.size_bytes,
          sha256: row.sha256,
          // The scan verdict travels with the file: a reader who knows it was never
          // scanned can decide what to do about that, and a reader who is not told
          // cannot.
          scanStatus: row.scan_status,
          uploadedAt: row.uploaded_at,
          downloadUrl,
          expiresInSeconds: 300,
        };
      });
      reply.header('cache-control', 'no-store');
      return reply.send(payload);
    },
  );
};
