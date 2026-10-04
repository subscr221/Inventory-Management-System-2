import type { PendingPhoto, PendingPhotoStore } from '../local-db/pending-photos';

/**
 * Story 8.9 (Task 9.2, D14): the platform's one request ceiling (src/middleware/body.ts
 * MAX_BODY_SIZE, nginx client_max_body_size 10m). There is no photo-specific limit; only a photo
 * above this is re-encoded, so a report never strands on its photo.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The types the attachment store accepts (checked against the magic bytes server-side). */
export const ACCEPTED_PHOTO_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
] as const;

export type UploadOutcome = 'stored' | 'reencode' | 'retry';

/**
 * 200 and 201 mean the server holds these bytes. 409 ATTACHMENT_CONFLICT means the server already
 * holds a photo under this device-minted id (only this device knows the id, so it is this photo,
 * typically an earlier re-encode whose local delete did not complete): settled too. 413 and 415
 * are answered by re-encoding as JPEG once. Everything else (offline, 401, 403, 5xx) retries on
 * the next pass.
 */
export function classifyUploadResponse(status: number, errorCode: string | null): UploadOutcome {
  if (status === 200 || status === 201) return 'stored';
  if (status === 409 && errorCode === 'ATTACHMENT_CONFLICT') return 'stored';
  if (status === 413 || status === 415) return 'reencode';
  return 'retry';
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface UploadDeps {
  store: PendingPhotoStore;
  /** The signed-in user; other people's photos wait for them. */
  ownerUserId: string;
  fetch: Fetcher;
  /** Re-encode to a JPEG that fits MAX_UPLOAD_BYTES, or null when the device cannot. */
  reencode?: (blob: Blob) => Promise<Blob | null>;
}

function needsReencode(photo: { blob: Blob; contentType: string }): boolean {
  return (
    photo.blob.size > MAX_UPLOAD_BYTES ||
    !(ACCEPTED_PHOTO_TYPES as readonly string[]).includes(photo.contentType)
  );
}

async function put(
  fetcher: Fetcher,
  attachmentId: string,
  blob: Blob,
  contentType: string,
): Promise<UploadOutcome> {
  try {
    const response = await fetcher(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': contentType },
      body: blob,
    });
    let code: string | null = null;
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
      code = typeof body?.error_code === 'string' ? body.error_code : null;
    }
    return classifyUploadResponse(response.status, code);
  } catch {
    return 'retry';
  }
}

async function uploadOne(photo: PendingPhoto, deps: UploadDeps): Promise<boolean> {
  let blob = photo.blob;
  let contentType = photo.contentType;
  let reencoded = false;
  const reencode = async (): Promise<boolean> => {
    if (reencoded || !deps.reencode) return false;
    reencoded = true;
    const jpeg = await deps.reencode(photo.blob).catch(() => null);
    if (!jpeg || jpeg.size > MAX_UPLOAD_BYTES) return false;
    blob = jpeg;
    contentType = 'image/jpeg';
    return true;
  };
  if (needsReencode(photo) && !(await reencode())) return false;
  let outcome = await put(deps.fetch, photo.attachmentId, blob, contentType);
  if (outcome === 'reencode' && (await reencode())) {
    outcome = await put(deps.fetch, photo.attachmentId, blob, contentType);
  }
  if (outcome !== 'stored') return false;
  await deps.store.remove(photo.attachmentId);
  return true;
}

/** One pass over the queue, oldest first. Never throws; a failed photo waits for the next pass. */
export async function uploadPendingPhotos(
  deps: UploadDeps,
): Promise<{ stored: number; pending: number }> {
  let photos: PendingPhoto[];
  try {
    photos = (await deps.store.list()).filter((photo) => photo.ownerUserId === deps.ownerUserId);
  } catch {
    return { stored: 0, pending: 0 };
  }
  let stored = 0;
  for (const photo of photos) {
    try {
      if (await uploadOne(photo, deps)) stored += 1;
    } catch {
      // Keep it for the next pass.
    }
  }
  return { stored, pending: photos.length - stored };
}

/**
 * Browser re-encode: draw the image and export JPEG, lowering quality then size until it fits.
 * Returns null where the browser cannot decode the file (for example HEIC on Chrome); that photo
 * stays queued rather than being lost.
 */
export async function reencodeAsJpeg(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    return null;
  }
  try {
    let scale = 1;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const quality = attempt < 3 ? 0.9 - attempt * 0.1 : 0.7;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      if (jpeg.size <= MAX_UPLOAD_BYTES) return jpeg;
      if (attempt >= 2) scale *= 0.8;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
