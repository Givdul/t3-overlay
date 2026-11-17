import { useEffect, useState } from "react";

// One image attachment's thumbnail URL. Main mints it from T3's asset route with the bearer token it
// holds, so the renderer only ever sees the signed URL T3's own web client puts in an `<img>`
// (packages/contracts/src/rpc.ts, assetsCreateUrl and how apps/web/src/assets/assetUrls.ts resolves one).

export interface AttachmentUrlState {
  /** The signed URL, or null while main mints it or when minting failed. */
  url: string | null;
  /** Why no URL could be minted. The row keeps its chip in that case. */
  error: string | null;
  /** Asks main for a fresh URL; a signed one expires, and an image can outlive it. */
  retry(): void;
}

/** Two retries cover an expired URL; a third failure is T3's to explain. */
const MAX_ATTEMPTS = 3;

export function useAttachmentUrl(attachmentId: string): AttachmentUrlState {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setUrl(null);
    setError(null);

    void window.overlay.panel({ type: "attachmentUrl", attachmentId }).then((reply) => {
      if (cancelled) return;

      if (reply.ok && "url" in reply) setUrl(reply.url);
      else if (!reply.ok) setError(reply.error);
      else setError("T3 did not return an asset URL");
    });

    return () => {
      cancelled = true;
    };
  }, [attachmentId, attempt]);

  return {
    url,
    error,
    retry() {
      setAttempt((current) => (current < MAX_ATTEMPTS - 1 ? current + 1 : current));
    },
  };
}
