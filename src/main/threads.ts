import type { WebContents } from "electron";
import type { SidebarThread, ThreadSource } from "../shared/types";
import { startGuestFeed } from "./cdp";
import { AuthExpiredError, openShellStream } from "./rpc";
import { ShellModel, sortSidebar } from "./shell";
import type { T3Server } from "./t3";

export interface ThreadFeed {
  /** The panel's webview once it shows T3's own page, or null when it stops showing it. */
  setGuest(contents: WebContents | null): void;
  stop(): void;
}

export interface FeedOptions {
  server: T3Server;
  token: string;
  onThreads: (threads: SidebarThread[], source: ThreadSource) => void;
  onAuthExpired: () => void;
  onLost: () => void;
}

/** Thread list for this PC only, from the local server's shell stream. */
function startLocalFeed(options: FeedOptions, onThreads: (threads: SidebarThread[]) => void): { stop(): void } {
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
          if (!stopped && model.apply(value) && model.hasSnapshot) onThreads(sortSidebar(model.sidebar()));
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

/**
 * Every machine the panel's T3 page is connected to, read from that page. Until it has loaded, or when it
 * knows no machine, this PC only. The local stream always runs: it is how the overlay notices T3 going away.
 */
export function startThreadFeed(options: FeedOptions): ThreadFeed {
  let localThreads: SidebarThread[] | null = null;
  let guestThreads: SidebarThread[] | null = null;
  let guest: { stop(): void } | null = null;

  const emit = () => {
    if (guestThreads) options.onThreads(guestThreads, "all-machines");
    else if (localThreads) options.onThreads(localThreads, "local");
  };

  const local = startLocalFeed(options, (threads) => {
    localThreads = threads;
    if (!guestThreads) emit();
  });

  return {
    setGuest(contents) {
      guest?.stop();
      guest = null;
      guestThreads = null;
      if (contents) {
        guest = startGuestFeed({
          contents,
          onThreads: (threads) => {
            guestThreads = threads;
            emit();
          },
        });
      }
      emit();
    },
    stop() {
      local.stop();
      guest?.stop();
    },
  };
}
