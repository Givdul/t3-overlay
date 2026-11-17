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
  /**
   * Marks the uploaded chips the send is about to reference, so a thread switch while it is in flight
   * keeps them. Returns their ids, which a failure hands back to `unmarkSent`.
   */
  markSent(): string[];
  /** Puts a failed send's chips back in the draft's hands: a live draft keeps them, a switched-away one releases them. */
  unmarkSent(ids: string[]): void;
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
  const attachmentsNow = useRef(attachments);
  attachmentsNow.current = attachments;
  /** Uploads a sent message references: T3 owns those, so dropping them from the composer keeps them. */
  const sent = useRef(new Set<string>());
  const mounted = useRef(true);

  // The card stays open while a chip is on it, and its send button waits for the uploads.
  useEffect(() => {
    current.current.onBusy(current.current.active || attachments.length > 0);
  }, [options.active, attachments.length]);

  // A thread switch drops the drafts it would otherwise carry over, and releases the uploads it never
  // sent; an upload that finishes after the switch leaves the new thread's list alone.
  useEffect(() => {
    releaseAll(attachmentsNow.current, sent.current);
    sent.current = new Set();
    setAttachments([]);
    current.current.onError(null);
  }, [options.threadKey]);

  // Closing the panel abandons the composer: T3 would delete the same uploads, and never a sent one.
  useEffect(
    () => () => {
      mounted.current = false;
      releaseAll(attachmentsNow.current, sent.current);
    },
    [],
  );

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

      // An `ok` reply without an attachment is a send's, which this command never makes.
      const uploaded = reply.ok && "attachment" in reply ? reply.attachment : null;
      const failure = reply.ok ? (uploaded === null ? "T3 did not accept the upload" : null) : reply.error;

      // The reader moved to another thread, closed the panel, or removed this chip meanwhile: the upload
      // belongs to no draft here, so T3 deletes it as its own composer does.
      const stillDrafted =
        current.current.threadKey === threadKey &&
        mounted.current &&
        attachmentsNow.current.some((candidate) => candidate.key === key);

      if (!stillDrafted) {
        if (uploaded !== null) releaseUpload(uploaded.id);

        continue;
      }

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
    // The ref drops it first, so an unmount before React's next render releases it once, not twice.
    attachmentsNow.current = attachmentsNow.current.filter((candidate) => candidate.key !== attachment.key);
    setAttachments(attachmentsNow.current);

    if (attachment.id !== null) releaseUpload(attachment.id);
  }

  function markSent(): string[] {
    const ids = attachmentsNow.current.flatMap((attachment) => (attachment.id === null ? [] : [attachment.id]));

    for (const id of ids) sent.current.add(id);

    return ids;
  }

  function unmarkSent(ids: string[]) {
    for (const id of ids) {
      sent.current.delete(id);

      // The draft that held it is gone (a switch during the send): T3 would keep an upload no message
      // references, so release it here as the switch's own release would have.
      if (!attachmentsNow.current.some((attachment) => attachment.id === id)) releaseUpload(id);
    }
  }

  function clear() {
    // A successful send hands these uploads to T3; only an abandoned draft deletes them.
    for (const attachment of attachmentsNow.current) {
      if (attachment.id !== null) sent.current.add(attachment.id);
    }

    attachmentsNow.current = [];
    setAttachments([]);
  }

  return {
    attachments,
    addFiles(files) {
      void upload(files);
    },
    remove,
    markSent,
    unmarkSent,
    clear,
  };
}

/** Deletes one upload no message references, as T3's composer releases a dropped attachment. */
function releaseUpload(attachmentId: string) {
  void window.overlay.panel({ type: "releaseAttachment", attachmentId }).catch(() => undefined);
}

/** Releases every uploaded chip that a send did not claim; an unfinished upload has no id to delete yet. */
function releaseAll(attachments: DraftAttachment[], sent: Set<string>) {
  for (const attachment of attachments) {
    if (attachment.id !== null && !sent.has(attachment.id)) releaseUpload(attachment.id);
  }
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
