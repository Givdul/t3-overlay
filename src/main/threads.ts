import type { ThemeStorage } from "../shared/theme";
import type { SidebarThread, ThreadSource } from "../shared/types";
import { startCdpFeed } from "./cdp";
import { AuthExpiredError, openShellStream } from "./rpc";
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
  /** Only with the debugging port; without it the panel keeps its own theme. */
  onThemeStorage: (storage: ThemeStorage) => void;
  onAuthExpired: () => void;
  onLost: () => void;
}

/** Thread list for this PC only, from the local server's shell stream. */
export function startLocalFeed(options: FeedOptions): ThreadFeed {
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

      stopStream = await openShellStream(options.server, options.token, {
        onValue: (value) => {
          if (!stopped && model.apply(value) && model.hasSnapshot) options.onThreads(sortSidebar(model.sidebar()), "local");
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

/** Every machine through T3's debugging port when it is open, otherwise this PC only. */
export function startThreadFeed(options: FeedOptions): ThreadFeed {
  let inner: ThreadFeed | null = null;
  let stopped = false;

  void startCdpFeed({
    port: options.debugPort,
    onThreads: (threads) => options.onThreads(threads, "all-machines"),
    onThemeStorage: options.onThemeStorage,
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
