import { useEffect, useState } from "react";

// A thumbnail opened larger inside the panel, as T3's own timeline opens an image in a dialog
// (apps/web/src/components/chat/ExpandedImagePreview.tsx). Escape closes it before the overlay's own
// Escape, which would close the whole panel.

export interface PreviewImage {
  url: string;
  name: string;
}

export interface ImagePreviewState {
  image: PreviewImage | null;
  open(image: PreviewImage): void;
  close(): void;
}

export function useImagePreview(): ImagePreviewState {
  const [image, setImage] = useState<PreviewImage | null>(null);

  useEffect(() => {
    if (image === null) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      event.stopPropagation();
      setImage(null);
    };

    document.addEventListener("keydown", onKeyDown, true);

    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [image]);

  return {
    image,
    open: setImage,
    close() {
      setImage(null);
    },
  };
}
