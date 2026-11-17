import { useEffect, useState } from "react";
import type { PanelManagedPolicy, PanelModelProvider, PanelThreadCommand } from "../../../shared/panel";

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

/** Reads `server.getConfig`'s provider list and policy once per thread and project; main owns the socket and the token. */
export function useModelCatalog(threadKey: string, projectId: string | null = null): ModelCatalog {
  const [providers, setProviders] = useState<PanelModelProvider[] | null>(null);
  const [policy, setPolicy] = useState<PanelManagedPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // The thread's project picks the checkout whose own skills the provider scan adds.
    const command: PanelThreadCommand = { type: "models" };

    if (projectId !== null) command.projectId = projectId;

    void window.overlay.panel(command).then((reply) => {
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
  }, [threadKey, projectId]);

  return { providers, policy, error, reportError: setError };
}
