import { useEffect, useState } from "react";
import type { PanelModelProvider } from "../../../shared/panel";

// The composer's model picker reads T3's provider catalog through main. It syncs with something outside
// React, so it lives here rather than in the component.

export interface ModelCatalog {
  /** Null until the server's provider list arrives. */
  providers: PanelModelProvider[] | null;
  /** Why the read or the last pick failed. */
  error: string | null;
  reportError(message: string | null): void;
}

/** Reads `server.getConfig`'s provider list once per thread; main owns the socket and the token. */
export function useModelCatalog(threadKey: string): ModelCatalog {
  const [providers, setProviders] = useState<PanelModelProvider[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    void window.overlay.panel({ type: "models" }).then((reply) => {
      if (!live) return;

      if (!reply.ok) {
        setError(reply.error);

        return;
      }

      if ("providers" in reply) {
        setProviders(reply.providers);
        setError(null);
      }
    });

    return () => {
      live = false;
    };
  }, [threadKey]);

  return { providers, error, reportError: setError };
}
