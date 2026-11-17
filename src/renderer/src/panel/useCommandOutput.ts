import { useEffect, useState } from "react";
import type { PanelItem } from "../../../shared/panel";

// One expanded command row's output, from T3's own route
// (packages/contracts/src/orchestrationV2.ts, subscribeCommandOutput): T3 sends a bounded tail as a
// `replace` frame and appends after it, then ends the stream once the command settles. A finished row
// gets its persisted output as one final frame (apps/server/src/orchestration-v2/CommandOutputHub.ts), so
// the row follows T3's own tail limit rather than the panel's event cap.

export interface CommandOutputState {
  /** The text to draw; null when the command has written none yet. */
  output: string | null;
  /** Earlier output was dropped to keep T3's tail bounded. */
  truncated: boolean;
  /** Why the output could not be read, when it could not. */
  error: string | null;
}

/** The bounded tail this row has folded in so far. */
interface LiveOutput {
  text: string;
  truncated: boolean;
}

export function useCommandOutput(
  item: PanelItem,
  open: boolean,
  streaming: boolean,
  /** The panel's connection epoch; a new socket reopens this row's stream. */
  connection: number,
): CommandOutputState {
  const [live, setLive] = useState<LiveOutput | null>(null);
  const [full, setFull] = useState<PanelItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  // T3's command-output route serves a finished command too: its one frame is the persisted output,
  // tailed by T3 itself (apps/server/src/orchestration-v2/CommandOutputHub.ts, subscribe). The row opens
  // the stream while it is expanded; collapsing ends it. The stream lives on one socket, so a reconnect
  // (a new `connection`) opens a fresh one, whose first frame is the whole tail again.
  useEffect(() => {
    // No socket is live before T3's first "live"; the fallback below covers a row opened meanwhile.
    if (!open || !streaming || connection === 0) return;

    setError(null);

    let cancelled = false;
    let text = "";
    let truncated = false;
    let carry = "";

    const stopListening = window.overlay.onPanel((message) => {
      if (message.kind !== "commandOutput" || message.itemId !== item.id) return;

      if (message.frame.kind === "replace") {
        text = "";
        truncated = false;
        carry = "";
      }

      const folded = foldEscapes(carry, message.frame.text);
      carry = folded.carry;
      text += folded.text;
      truncated = truncated || message.frame.truncated;
      setLive({ text, truncated });
    });

    void window.overlay.panel({ type: "subscribeCommandOutput", itemId: item.id }).then((reply) => {
      if (!cancelled && !reply.ok) setError(reply.error);
    });

    return () => {
      cancelled = true;
      stopListening();
      // The closed row keeps no tail: reopening reads a fresh one, live or from getTurnItem.
      setLive(null);
      void window.overlay.panel({ type: "unsubscribeCommandOutput", itemId: item.id });
    };
  }, [open, streaming, item.id, connection]);

  // The whole body, for a server with no live command-output route.
  useEffect(() => {
    if (!open || streaming || live !== null || error !== null || item.outputOmitted !== true) return;

    let cancelled = false;
    void window.overlay.panel({ type: "turnItem", itemId: item.id }).then((reply) => {
      if (cancelled) return;

      if (reply.ok && "item" in reply) setFull(reply.item);
      else if (!reply.ok) setError(reply.error);
    });

    return () => {
      cancelled = true;
    };
  }, [open, streaming, live, error, item.id, item.outputOmitted]);

  return {
    output: live?.text ?? full?.output ?? item.output ?? null,
    truncated: live?.truncated ?? false,
    error,
  };
}

/** The visible text one frame contributed, and the start of an escape its end still owes. */
interface FoldedEscapes {
  text: string;
  carry: string;
}

/**
 * T3's frames carry terminal text with escapes (packages/shared/src/terminalOutput.ts). The row has no
 * terminal renderer, so an escape is dropped instead of being drawn as words; one that a frame split in
 * two waits here for its end, as T3's own client folds its pending escape.
 */
function foldEscapes(carry: string, text: string): FoldedEscapes {
  const source = carry + text;
  let output = "";
  let start = 0;

  for (let index = source.indexOf("\x1b"); index !== -1; ) {
    output += source.slice(start, index);
    const end = escapeEnd(source, index);

    if (end === -1) {
      // A malformed sequence must not grow this buffer forever.
      return { text: output, carry: source.length - index > 64 ? "" : source.slice(index) };
    }

    start = end;
    index = source.indexOf("\x1b", start);
  }

  return { text: output + source.slice(start), carry: "" };
}

/** The index just past the escape sequence starting at `at`, or -1 while more text is needed to end it. */
function escapeEnd(source: string, at: number): number {
  const introducer = source[at + 1];

  if (introducer === undefined) return -1;

  // CSI: colours and cursor moves, then one final byte in @–~.
  if (introducer === "[") {
    for (let index = at + 2; index < source.length; index += 1) {
      const code = source.charCodeAt(index);

      if (code >= 0x40 && code <= 0x7e) return index + 1;
    }

    return -1;
  }

  // OSC: titles and hyperlinks, ended by BEL or ST.
  if (introducer === "]") {
    for (let index = at + 2; index < source.length; index += 1) {
      if (source.charCodeAt(index) === 0x07) return index + 1;

      if (source.charCodeAt(index) === 0x1b && source[index + 1] === "\\") return index + 2;
    }

    return -1;
  }

  // ESC and a charset designator carry one more byte (ESC ( B); the rest are two-byte escapes.
  if ("()*+-./#".includes(introducer)) return source.length >= at + 3 ? at + 3 : -1;

  return at + 2;
}
