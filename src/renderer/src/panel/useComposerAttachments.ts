import { useEffect, useRef, useState } from "react";
import { attachmentLimit, attachmentTooLargeMessage, isImageAttachment } from "../../../shared/attachments";
import type { PanelAttachmentReply, PanelAttachmentUploads, PanelReply } from "../../../shared/panel";

// The composer's attachments: a local thumbnail and T3's uploaded record, kept apart from the
// writer's text so `Composer` only draws them. Files go to main, which holds the token, and come
// back as the records a turn references (packages/contracts/src/chatAttachment.ts).

/** One file on its way to the server, or uploaded and waiting for the send. */
export interface DraftAttachment {
  /** Local identity while the upload runs; the server's id arrives on the reply. */
  key: string;
  id: string | null;
  type: "image" | "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "failed";
  /** An image's inline thumbnail: the page's CSP allows data: images, not blob: ones. */
  preview: string | null;
}

export interface ComposerAttachments {
  attachments: DraftAttachment[];
  addFiles(files: File[]): void;
  remove(attachment: DraftAttachment): void;
  /** Drops every chip after a successful send. */
  clear(): void;
}

interface Options {
  /** The open thread, so an attachment never travels to the next one. */
  threadKey: string;
  /** The server's upload capability; null keeps every file out. */
  capability: PanelAttachmentUploads | null;
  /** True while the message itself is being sent. */
  active: boolean;
  onError(message: string | null): void;
  onBusy(busy: boolean): void;
}

export function useComposerAttachments(options: Options): ComposerAttachments {
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const current = useRef(options);
  current.current = options;

  // The card stays open while a chip is on it, and its send button waits for the uploads.
  useEffect(() => {
    current.current.onBusy(current.current.active || attachments.length > 0);
  }, [options.active, attachments.length]);

  // A thread switch drops the drafts it would otherwise carry over; an upload that finishes after
  // the switch leaves the new thread's list alone.
  useEffect(() => {
    setAttachments([]);
    current.current.onError(null);
  }, [options.threadKey]);

  async function upload(files: File[]) {
    const capability = current.current.capability;

    if (capability === null || files.length === 0) return;
    const threadKey = current.current.threadKey;
    current.current.onError(null);

    for (const file of files) {
      const mimeType = file.type.toLowerCase() || "application/octet-stream";
      const name = file.name || (isImageAttachment(mimeType) ? "image" : "file");
      const limit = attachmentLimit(capability.maxUploadBytes, mimeType);

      // The descriptor's limit is checkable before the bytes cross the IPC: refuse without uploading.
      if (file.size > limit) {
        current.current.onError(attachmentTooLargeMessage(name, limit));
        continue;
      }

      let data: ArrayBuffer;

      try {
        data = await file.arrayBuffer();
      } catch {
        current.current.onError(`'${name}' could not be read`);
        continue;
      }

      const key = crypto.randomUUID();
      const type = isImageAttachment(mimeType) ? "image" : "file";
      const preview = type === "image" ? imageDataUrl(new Uint8Array(data), mimeType) : null;
      const draft: DraftAttachment = { key, id: null, type, name, mimeType, sizeBytes: data.byteLength, status: "uploading", preview };
      setAttachments((list) => [...list, draft]);

      let reply: PanelAttachmentReply | PanelReply;

      try {
        reply = await window.overlay.panel({ type: "attach", name, mimeType, sizeBytes: data.byteLength, data });
      } catch (error) {
        reply = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      // The reader moved to another thread meanwhile: this upload belongs to the thread it started on.
      if (current.current.threadKey !== threadKey) continue;

      // An `ok` reply without an attachment is a send's, which this command never makes.
      const uploaded = reply.ok && "attachment" in reply ? reply.attachment : null;
      const failure = reply.ok ? (uploaded === null ? "T3 did not accept the upload" : null) : reply.error;

      setAttachments((list) =>
        list.map((attachment) => {
          if (attachment.key !== key) return attachment;

          return failure !== null || uploaded === null
            ? { ...attachment, status: "failed" }
            : { ...attachment, id: uploaded.id, type: uploaded.type === "image" ? "image" : "file", status: "ready" };
        }),
      );

      if (failure !== null) current.current.onError(failure);
    }
  }

  function remove(attachment: DraftAttachment) {
    setAttachments((list) => list.filter((candidate) => candidate.key !== attachment.key));
  }

  function clear() {
    setAttachments([]);
  }

  return {
    attachments,
    addFiles(files) {
      void upload(files);
    },
    remove,
    clear,
  };
}

/** A data: URL for the composer's tile; pieces keep fromCharCode off the argument limit. */
function imageDataUrl(bytes: Uint8Array, mimeType: string): string {
  const piece = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += piece) {
    binary += String.fromCharCode(...bytes.subarray(index, index + piece));
  }

  return `data:${mimeType};base64,${btoa(binary)}`;
}
