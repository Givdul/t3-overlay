import type { SidebarThread } from "../shared/types";
import { AuthExpiredError, connect } from "./rpc";
import { ShellModel, sortSidebar, type ShellItem } from "./shell";
import type { T3Server } from "./t3";

export interface ThreadFeed {
  stop(): void;
}

/** A project's checkout, as T3 knows it. */
export interface ProjectWorkspace {
  projectId: string;
  workspaceRoot: string;
}

export interface FeedOptions {
  server: T3Server;
  token: string;
  onThreads: (threads: SidebarThread[]) => void;
  /** The shell's projects: main opens one in T3 when the panel's `+` asks for a new thread. */
  onProjects: (projects: ProjectWorkspace[]) => void;
  onAuthExpired: () => void;
  onLost: () => void;
}

/** Thread list for this PC only, from the local server's shell stream. */
export function startThreadFeed(options: FeedOptions): ThreadFeed {
  let stopStream: (() => void) | null = null;
  let stopped = false;

  void (async () => {
    try {
      // SAFETY: T3's environment descriptor always names its environmentId; label is optional.
      const descriptor = (await (await fetch(`${options.server.origin}/.well-known/t3/environment`)).json()) as {
        environmentId: string;
        label?: string;
      };

      const model = new ShellModel(descriptor.environmentId, descriptor.label ?? "This PC");
      const rpc = await connect<ShellItem, never>(options.server, options.token);

      stopStream = () => rpc.close();
      rpc.stream("orchestration.subscribeShell", {}, {
        onValue: (value) => {
          if (stopped || !model.apply(value) || !model.hasSnapshot) return;

          options.onThreads(sortSidebar(model.sidebar()));
          options.onProjects(model.projectWorkspaces());
        },
        onClose: (reason) => {
          console.warn("[t3] shell stream closed:", reason);
          if (!stopped) options.onLost();
        },
      });

      // Stopped while the stream was opening.
      if (stopped) stopStream();
    } catch (error) {
      if (stopped) return;

      if (error instanceof AuthExpiredError) options.onAuthExpired();
      else console.error("[t3] shell stream failed", error);
      options.onLost();
    }
  })();

  return {
    stop() {
      stopped = true;
      stopStream?.();
    },
  };
}
