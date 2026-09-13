/**
 * Private document store for KYC pieces (blueprint §4.7). Keys — never public
 * URLs — are persisted on KycSubmission; access goes through a short-lived
 * signed URL.
 */
export interface StoredDocument {
  key: string;
  contentType: string;
  size: number;
}

export interface DocumentStoragePort {
  put(key: string, content: Buffer, contentType: string): Promise<StoredDocument>;
  /** URL valid for `ttlSeconds` (default 15 min). */
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string>;
  delete(key: string): Promise<void>;
}

export const DOCUMENT_STORAGE = Symbol('DOCUMENT_STORAGE');

export const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function contentTypeForKey(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  const found = Object.entries(DOCUMENT_CONTENT_TYPES).find(([, e]) => e === ext);
  return found ? found[0] : 'application/octet-stream';
}

/** Keys are flat file names: `<submissionId>-<kind>-<random>.<ext>` — no path separators. */
export const DOCUMENT_KEY_RE = /^[A-Za-z0-9_-]{1,200}\.[a-z0-9]{1,8}$/;
