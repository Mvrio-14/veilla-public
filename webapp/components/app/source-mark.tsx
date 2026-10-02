"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The square that identifies a source in a list — its favicon, or a
 * monogram when there is no icon to be had.
 *
 * The monogram is derived from the name, never hand-authored: initials of
 * the significant words, four characters at most. "Health Canada" → HC,
 * "NICE (United Kingdom)" → NICE, "Le Monde - Planete" → LMP. A curated
 * table would drift the moment a source is renamed.
 *
 * The image is a plain `<img>`, not `next/image`: the source is our own
 * proxy route, sizes are fixed and tiny, and the optimiser would add a
 * second round-trip for no gain. `onError` is what makes the fallback
 * work — a 204 from the proxy renders as a load failure, which is the
 * signal to draw the monogram. An image rendered on the server can fail
 * before React attaches that handler, so the ref also checks, once
 * mounted, whether it has already failed.
 */
export function SourceMark({
  url,
  name,
  size = 40,
  className,
}: {
  /** Any URL on the source's domain — the proxy reduces it to the origin. */
  url?: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  // Which URL failed, not "did it fail" — a row recycled by React for a
  // different source would otherwise inherit the previous source's
  // failure and never try the new icon. Storing the URL makes the reset
  // fall out of the comparison, with no effect to synchronise it.
  const [failedUrl, setFailedUrl] = React.useState<string | null>(null);
  const monogram = React.useMemo(() => toMonogram(name), [name]);

  const showImage = url && failedUrl !== url;

  return (
    <span
      className={cn(
        "grid place-items-center shrink-0 overflow-hidden",
        "font-mono text-text-3 leading-none",
        // The frame exists to hold the monogram, not to frame an icon. A
        // real favicon already carries its own shape — boxing it adds a
        // border the source never had, and a transparent icon ends up
        // looking like it sits in a tile.
        !showImage && "rounded-md border border-border bg-bg-sub",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: monogram.length > 2 ? size * 0.2 : size * 0.26,
      }}
      aria-hidden
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/favicon?url=${encodeURIComponent(url)}`}
          alt=""
          // Full slot, not 55%: that inset existed to leave air inside the
          // frame. With the frame gone it is just empty space around a
          // small icon, which reads as a rendering fault rather than a
          // margin.
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          ref={(img) => {
            if (img?.complete && img.naturalWidth === 0) setFailedUrl(url);
          }}
          onError={() => setFailedUrl(url)}
          style={{ objectFit: "contain" }}
        />
      ) : (
        monogram
      )}
    </span>
  );
}

/** Words that carry no identity and would drown the real initials. */
const NOISE = new Set([
  "the", "le", "la", "les", "de", "du", "des", "of", "and", "et",
  "news", "france", "catalogue", "catalog",
]);

export function toMonogram(name: string): string {
  const words = name
    .replace(/\(.*?\)/g, " ") // "(United Kingdom)" is a qualifier, not identity
    .split(/[\s\-–—_/.]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length > 0 && !NOISE.has(w.toLowerCase()));

  if (words.length === 0) return name.slice(0, 2).toUpperCase();

  // A single word that is already an acronym stands on its own —
  // "NICE" should read NICE, not N.
  if (words.length === 1) return words[0].slice(0, 4).toUpperCase();

  return words
    .slice(0, 4)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}
