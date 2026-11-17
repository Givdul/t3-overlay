import { useEffect, useState } from "react";
import type { PanelQueuedMessage, PanelView } from "../../../shared/panel";

// A queued message being rewritten in the composer. It is not part of the projection: T3 keeps an edit
// in a composer draft of its own, and ends it when the run it belongs to leaves the queue.

export interface QueuedEdit {
  /** The run whose message the composer is rewriting. */
  runId: string;
  /** The draft the composer held before the edit, put back if the user cancels. */
  restoreText: string;
}

export interface QueuedEditState {
  edit: QueuedEdit | null;
  begin(message: PanelQueuedMessage, restoreText: string): void;
  clear(): void;
}

/** The open queued-message edit, scoped to the panel's target. */
export function useQueuedEdit(targetKey: string, view: PanelView | null): QueuedEditState {
  const [edit, setEdit] = useState<QueuedEdit | null>(null);

  // A new thread starts clean, like the panel's other per-target state.
  useEffect(() => {
    setEdit(null);
  }, [targetKey]);

  // The run started or was cancelled from elsewhere, so its message is no longer queued. The text stays
  // in the composer, as T3 keeps a changed edit rather than discarding the words.
  useEffect(() => {
    if (edit === null) return;

    if (view === null || view.queued.some((message) => message.runId === edit.runId)) return;

    setEdit(null);
  }, [edit, view]);

  return {
    edit,
    begin(message, restoreText) {
      setEdit({ runId: message.runId, restoreText });
    },
    clear() {
      setEdit(null);
    },
  };
}
