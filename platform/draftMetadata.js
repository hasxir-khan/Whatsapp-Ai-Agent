// Filenames and old wizard payloads can contain phone numbers, requests, or
// payment instructions. A resume screen only needs to know what was learned.
import { isoTime, numeric } from '../src/services/reportContract.js';
export function draftMetadata(raw) {
  const documents = Array.isArray(raw?.documents) ? raw.documents.slice(0, 20) : [];
  return {
    documents: documents.map((d, i) => ({
      name: `Document ${i + 1}`,
      bytes: numeric(d?.bytes),
      chunks: d?.chunks == null ? null : numeric(d.chunks),
      at: isoTime(d?.at),
    })),
  };
}
