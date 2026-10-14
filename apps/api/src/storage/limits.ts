/**
 * What may be uploaded, and what the file is allowed to be called.
 *
 * The list is explicit and short on purpose. "Anything" is not a type list, and a
 * survey that accepts an arbitrary executable from an anonymous respondent is a
 * distribution channel; every entry here is a format a researcher might
 * plausibly attach to an answer. The question's own type decides which group
 * applies, so a photo question cannot be answered with a spreadsheet.
 *
 * This is the *declared* check. The bytes are checked again, against what the
 * store actually received, before a row is ever marked uploaded — see
 * `platform/collect.ts`.
 */

export const UPLOAD_QUESTION_TYPES = new Set(['image', 'audio', 'video', 'file']);

export const ALLOWED_MIME: Record<string, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/tiff'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
  file: [
    'application/pdf',
    'text/csv',
    'text/plain',
    'application/json',
    'application/zip',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ],
};

export function allowedMimes(questionType: string): readonly string[] {
  return ALLOWED_MIME[questionType] ?? [];
}

export function isUploadQuestion(questionType: string): boolean {
  return UPLOAD_QUESTION_TYPES.has(questionType);
}

/** Case-insensitive, and parameter-free: `image/JPEG` is `image/jpeg`. */
export function mimeAllowed(questionType: string, mime: string): boolean {
  const normalised = mime.split(';')[0]!.trim().toLowerCase();
  return allowedMimes(questionType).includes(normalised);
}

export function normaliseMime(mime: string): string {
  return mime.split(';')[0]!.trim().toLowerCase();
}

/**
 * A filename that is safe to put in an object key.
 *
 * A key is a path in someone else's service: `../` or an absolute path is how an
 * upload becomes a write somewhere else, and control characters are how a log
 * line becomes two. The original is kept in the database for the human, and this
 * is what the store sees — with the extension preserved, because a store that
 * serves `report` instead of `report.pdf` hands back a file nothing will open.
 */
export function safeFilename(input: string): string {
  const basename = input.split(/[\\/]/).pop() ?? '';
  const cleaned = basename
    // eslint-disable-next-line no-control-regex -- the point is to remove them
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(-120);
  return cleaned || 'upload';
}
