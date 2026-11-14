import type { SidebarThread } from "../shared/types";
import { AuthExpiredError, connect, type T3Requests } from "./rpc";
import { ShellModel, sortSidebar, type ShellItem } from "./shell";
import type { T3Server } from "./t3";

/** One machine's shell stream. Its socket also carries the composer's calls to that machine. */
export interface ThreadFeed extends T3Requests {
  /** The machine's threads and projects, as its shell stream last told them. */
  readonly shell: ShellModel;
  stop(): void;
}

export interface FeedOptions {
  server: T3Server;
  token: string;
  onThreads: (threads: SidebarThread[]) => void;
  onAuthExpired: () => void;
  onLost: () => void;
}

/** Thread list for one machine, from its server's shell stream. */
export function startThreadFeed(options: FeedOptions): ThreadFeed {
  const shell = new ShellModel(options.server.environmentId, options.server.label);
  let rpc: T3Requests | null = null;
  let stopStream: (() => void) | null = null;
  let stopped = false;

  void (async () => {
    try {
      const connection = await connect<ShellItem>(options.server, options.token);

      stopStream = () => connection.close();
      connection.stream("orchestration.subscribeShell", {}, {
        onValue: (value) => {
          if (stopped || !shell.apply(value) || !shell.hasSnapshot) return;

          options.onThreads(sortSidebar(shell.sidebar()));
        },
        onClose: (reason) => {
          rpc = null;
          console.warn(`[t3] ${options.server.label} shell stream closed:`, reason);
          if (!stopped) options.onLost();
        },
      });
      rpc = connection;

      // Stopped while the stream was opening.
      if (stopped) stopStream();
    } catch (error) {
      if (stopped) return;

      if (error instanceof AuthExpiredError) options.onAuthExpired();
      else console.error(`[t3] ${options.server.label} shell stream failed`, error);
      options.onLost();
    }
  })();

  function connected(): T3Requests {
    if (rpc === null) throw new Error(`${options.server.label} is not connected`);

    return rpc;
  }

  return {
    shell,
    request: <T>(tag: string, payload: object) => connected().request<T>(tag, payload),
    command: (tag: string, payload: object) => connected().command(tag, payload),
    stop() {
      stopped = true;
      rpc = null;
      stopStream?.();
    },
  };
}
