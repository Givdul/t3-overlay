import { X } from "lucide-react";
import type { PreviewImage } from "./useImagePreview";

/** An image opened from the timeline, drawn over the panel rather than in a window of its own. */
export function ImagePreview({ image, onClose }: { image: PreviewImage | null; onClose: () => void }) {
  if (image === null) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={image.name}
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-black/80 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <img
        src={image.url}
        alt={image.name}
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl shadow-black/60"
      />
      <div className="flex max-w-full items-center gap-2 text-[11px] text-white/80">
        <span className="min-w-0 truncate">{image.name}</span>
        <button
          type="button"
          title="Close image"
          aria-label="Close image"
          onClick={onClose}
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
