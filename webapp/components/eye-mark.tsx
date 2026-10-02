/**
 * EyeMark — the Veilla brand mark: two curves that read as an eye.
 * Drawn inline and filled with `currentColor`, so one element serves both
 * themes; the mark inherits the colour of whatever encloses it and there
 * is no light/dark image pair to keep in sync.
 *
 * `size` is the width in px. The 128×80 viewBox fixes the height at 62.5%
 * of it, so the mark is wider than it is tall — unlike the square badge it
 * replaces, sizing by width is what keeps it optically balanced next to
 * the wordmark.
 *
 * Pass `decorative` where the brand name is already spelled out next to
 * the mark, so screen readers do not announce "Veilla" twice.
 */
export function EyeMark({
  size = 24,
  decorative = false,
  className,
}: {
  size?: number;
  decorative?: boolean;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={Math.round(size * (80 / 128))}
      viewBox="0 0 128 80"
      fill="currentColor"
      className={className}
      {...(decorative
        ? { "aria-hidden": true as const }
        : { role: "img", "aria-label": "Veilla" })}
    >
      <path d="M4 52C12 19 34 4 64 4s52 15 60 48c-17-17-37-25-60-25S21 35 4 52Z" />
      <path d="M39 49c8-5 16-7 25-7 10 0 19 4 27 12-8 10-17 15-27 15-11 0-20-7-25-20Z" />
    </svg>
  );
}
