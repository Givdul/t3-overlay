import type { ThemeTokens } from "../shared/tokens";
import type { SidebarProject, SidebarThread, ThreadSource } from "../shared/types";
import { startCdpFeed, type ShellItemLike } from "./cdp";
import { AuthExpiredError, connect, type T3Rpc } from "./rpc";
import { ShellModel, sortSidebar } from "./shell";
import type { T3Server } from "./t3";

export interface ThreadFeed {
  stop(): void;
}

export interface FeedOptions {
  server: T3Server;
  token: string;
  debugPort: number;
  onThreads: (threads: SidebarThread[], source: ThreadSource) => void;
  /** Only with the debugging port; without it the panel uses the fallback palette. */
  onTokens: (tokens: Partial<ThemeTokens>) => void;
  /** This machine's projects, so the panel can label threads and resolve their checkout. */
  onProjects: (projects: SidebarProject[]) => void;
  onAuthExpired: () => void;
  onLost: () => void;
}

/** Thread list for this PC only, from the local server's shell stream. */
export function startLocalFeed(options: FeedOptions): ThreadFeed {
  let stopStream: (() => void) | null = null;
  let rpc: T3Rpc<ShellItemLike, never> | null = null;
  let stopped = false;

  void (async () => {
    try {
      const model = new ShellModel(options.server.environmentId, options.server.label);

      rpc = await connect<ShellItemLike, never>(options.server, options.token);

      if (stopped) {
        rpc.close();

        return;
      }

      stopStream = rpc.stream(
        "orchestration.subscribeShell",
        {},
        {
          onValue: (value) => {
            if (stopped || !model.apply(value) || !model.hasSnapshot) return;
            options.onThreads(sortSidebar(model.sidebar()), "local");
            options.onProjects(model.projects());
          },
          onClose: (reason) => {
            console.warn("[t3] shell stream closed:", reason);

            if (!stopped) options.onLost();
          },
        },
      );
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
      // The shell socket is this feed's own: stopping the feed must not leave it open.
      rpc?.close();
      rpc = null;
    },
  };
}

/** Every machine through T3's debugging port when it is open, otherwise this PC only. */
export function startThreadFeed(options: FeedOptions): ThreadFeed {
  let inner: ThreadFeed | null = null;
  let stopped = false;

  void startCdpFeed({
    port: options.debugPort,
    environmentId: options.server.environmentId,
    onThreads: (threads) => options.onThreads(threads, "all-machines"),
    onTokens: options.onTokens,
    onProjects: options.onProjects,
    onClose: () => {
      if (!stopped) options.onLost();
    },
  })
    .catch((error) => {
      console.error("[t3] debugging port feed failed", error);
      return null;
    })
    .then((cdp) => {
      if (stopped) cdp?.stop();
      else inner = cdp ?? startLocalFeed(options);
    });

  return {
    stop() {
      stopped = true;
      inner?.stop();
    },
  };
}
