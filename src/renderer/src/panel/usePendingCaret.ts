import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A text box caret that waits for React to write new text: a transcript arrives through a state update,
 * so its caret can only be placed once that value is in the DOM. Call the returned function right after
 * setting the text.
 */
export function usePendingCaret(text: string, target: RefObject<HTMLTextAreaElement | null>) {
  const pending = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = pending.current;

    if (caret === null) return;
    pending.current = null;
    target.current?.focus();
    target.current?.setSelectionRange(caret, caret);
  }, [text, target]);

  return (caret: number) => {
    pending.current = caret;
  };
}
