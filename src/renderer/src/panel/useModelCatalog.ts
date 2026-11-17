import { useEffect, useState } from "react";
import type { PanelManagedPolicy, PanelModelProvider } from "../../../shared/panel";

// The composer's catalog read through main: the providers and models a thread can switch to, the options
// each model declares, and the policy that caps its permission modes. It syncs with something outside
// React, so it lives here rather than in the component.

export interface ModelCatalog {
  /** Null until the server's provider list arrives. */
  providers: PanelModelProvider[] | null;
  /** The administrator's cap on permission modes; null when none applies or until the read lands. */
  policy: PanelManagedPolicy | null;
  /** Why the read failed. */
  error: string | null;
  reportError(message: string | null): void;
}

/** Reads `server.getConfig`'s provider list and policy once per thread; main owns the socket and the token. */
export function useModelCatalog(threadKey: string): ModelCatalog {
  const [providers, setProviders] = useState<PanelModelProvider[] | null>(null);
  const [policy, setPolicy] = useState<PanelManagedPolicy | null>(null);
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
        setPolicy(reply.policy);
        setError(null);
      }
    });

    return () => {
      live = false;
    };
  }, [threadKey]);

  return { providers, policy, error, reportError: setError };
}
