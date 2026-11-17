// The composer's attachment rules, shared by main (which refuses an oversized upload) and the panel
// (which refuses it before uploading). The caps are T3's own turn-send limits
// (packages/contracts/src/chatAttachment.ts, PROVIDER_SEND_TURN_*).

import type { PanelAttachmentUploads } from "./panel";

/** T3 accepts these as image attachments; anything else uploads as a file. */
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

/** The attachment fields of T3's environment descriptor (packages/contracts/src/environment.ts). */
export interface AttachmentCapabilities {
  attachmentUploads?: boolean;
  fileAttachments?: { maxUploadBytes?: number };
}

/** The descriptor's attachment capability; absent, off, or a bad limit says the panel hides its attach control. */
export function readAttachmentUploads(capabilities: AttachmentCapabilities | undefined): PanelAttachmentUploads | null {
  const maxUploadBytes = capabilities?.fileAttachments?.maxUploadBytes;

  if (capabilities?.attachmentUploads !== true || maxUploadBytes === undefined || maxUploadBytes <= 0) return null;

  return { maxUploadBytes };
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** T3's image uploads take only its four formats; an SVG or a HEIC pastes in as a file. */
export function isImageAttachment(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

/** What one upload may weigh: the server's advertised limit, capped by T3's per-kind contract. */
export function attachmentLimit(maxUploadBytes: number, mimeType: string): number {
  return Math.min(maxUploadBytes, isImageAttachment(mimeType) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES);
}

export function formatAttachmentSize(sizeBytes: number): string {
  const kilobytes = Math.max(1, Math.ceil(sizeBytes / 1024));

  // Choose the unit after rounding, so 1023.5 KB reads "1.0 MB", not "1024 KB".
  return kilobytes >= 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : `${kilobytes} KB`;
}

/** T3's own refusal wording (packages/client-runtime/src/state/attachments.ts). */
export function attachmentTooLargeMessage(name: string, maxUploadBytes: number): string {
  const limit =
    maxUploadBytes >= 1024 * 1024 && maxUploadBytes % (1024 * 1024) === 0
      ? `${maxUploadBytes / (1024 * 1024)} MB`
      : maxUploadBytes >= 1024 && maxUploadBytes % 1024 === 0
        ? `${maxUploadBytes / 1024} KB`
        : `${maxUploadBytes} ${maxUploadBytes === 1 ? "byte" : "bytes"}`;

  return `'${name}' exceeds the ${limit} attachment limit.`;
}
