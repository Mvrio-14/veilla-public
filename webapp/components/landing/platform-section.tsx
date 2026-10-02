"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import Image from "next/image";
import Link from "next/link";
import { SIGN_UP_HREF } from "@/lib/routes";
import { SignalAgentVisual } from "./signal-visual";

/**
 * The overview section — what Veilla is, and the two products inside it.
 *
 * A centred title, a short centred line, a deliberately large gap, then
 * the two products side by side on the page itself. No card: no fill, no
 * border, no radius around a column. The gap is what separates them.
 *
 * ## Only one is lit
 *
 * The two references this is built from each do half of it. One puts its
 * products in a row, all equally present; the other lights exactly one
 * at a time but stacks them in a list, so they are never seen together.
 * Crossing the two is the point of this section: both products are on
 * screen, and the eye is told which one to read.
 *
 * Desk holds that state at rest — it is the product that can be bought
 * today. Pointing at the other hands it over, and it stays handed over:
 * the pick outlives the pointer, so scrolling away does not undo the
 * reader's choice. One custom property, `--dim`, carries every visible
 * consequence of it.
 *
 * ## Where the breathing comes from
 *
 * The gap between the heading and the products is much larger than it
 * looks like it should be, and that is the point: the two columns are a
 * choice, and a choice needs a moment of quiet in front of it.
 */
export function LandingPlatformSection({
  onContactClick,
}: {
  onContactClick: () => void;
}) {
  const t = useTranslations("landing.platform");
  const rowRef = React.useRef<HTMLDivElement>(null);

  /**
   * Remembers which product the reader last pointed at.
   *
   * Following `:hover` alone would revert the lit column the moment the
   * pointer left — a reader who chose Signal and scrolled on would find
   * Desk selected again, as though their choice had been overruled.
   * Recording the pick on the row makes it a decision that outlives the
   * gesture.
   *
   * It writes an attribute through a ref rather than setting state: the
   * value is only read by CSS, so a re-render would buy nothing and cost
   * one on every pass of the pointer.
   */
  React.useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const columns = Array.from(
      row.querySelectorAll<HTMLElement>(".landing-product"),
    );
    const pick = columns.map((column, index) => {
      const handler = () => {
        row.dataset.picked = String(index);
      };
      column.addEventListener("pointerenter", handler);
      return handler;
    });
    return () =>
      columns.forEach((column, index) =>
        column.removeEventListener("pointerenter", pick[index]),
      );
  }, []);

  return (
    <section id="products" className="px-12 pb-32 pt-16 max-[1180px]:px-10 max-[980px]:px-8 max-[980px]:pb-24 max-[980px]:pt-12 max-[720px]:px-5">
      <div className="mx-auto max-w-[1280px]">
        {/* No reveal on the heading or on the line under it. The statement
            above them lights word by word as the reader arrives, and a
            block fade here played a second, coarser animation straight
            after it — two different ways of appearing, a moment apart,
            which read as a stutter rather than as one movement. Both are
            simply present, and only the reading moves. */}
        <h2 className="max-w-[25ch] font-accent text-[clamp(30px,3.6vw,46px)] font-normal leading-[1.12] tracking-[-0.018em] text-text">
          {t("title")}
        </h2>

        {/* The line under the title earns its place by telling the reader
            which column to read. Both products sit on the same collection,
            and what separates them is direction: in one the reader looks,
            in the other it looks for them. Saying that here means neither
            column has to explain what it is before saying what it does. */}
        <p className="mt-6 max-w-[58ch] text-[17px] leading-[1.55] text-text-2 max-[720px]:text-[15px]">
          {t("sub")}
        </p>

        {/* The title and its line belong to the two columns below them, so
            the gap is smaller than the one that separates whole sections.
            It was 96px, then 64 — both still read as section spacing, and
            the heading floated between the statement above and the
            products below rather than introducing them. The products come
            up to meet it; the heading does not move down, or the gap above
            it would close instead. */}
        <div
          ref={rowRef}
          className="landing-products mt-10 flex max-[980px]:mt-8 max-[980px]:flex-col"
        >
          <Product
            name={t("news.name")}
            body={t("news.body")}
            cta={t("news.cta")}
            href={SIGN_UP_HREF}
            tone="sand"
          >
            {/* Inset from the top and the left, bleeding off the right
                and the bottom. The ground shows on two sides only, which
                is what makes the tile read as a window onto a larger
                screen rather than a box with a picture in it — and it
                matches how Signal sits on the same ground.

                Inside that box the shot is anchored top-left and scaled
                past it rather than fitted: a product shot scaled to fit
                becomes grey texture. */}
            <div className="landing-product-shot">
              <Image
                src="/landing/cards/news-views.webp"
                alt=""
                fill
                sizes="(max-width: 980px) 140vw, 56vw"
                className="origin-top-left scale-[1.4] object-cover object-left-top"
              />
            </div>
          </Product>

          <Product
            name={t("signal.name")}
            body={t("signal.body")}
            cta={t("signal.cta")}
            onClick={onContactClick}
          >
            <SignalAgentVisual />
          </Product>
        </div>
      </div>
    </section>
  );
}

/**
 * One product: the name, a line, the visual, and then the way in. The
 * reading order is the point — the reader is told what the thing is,
 * shown it, and only then asked to act, so the button closes the case
 * the picture has just made instead of interrupting it. It also leaves
 * the tile as the largest thing between the heading and the button,
 * which is where the attention should go.
 *
 * The call to action is a `Link` for the product that exists and a
 * `button` for the one that opens the sales form — same shape, different
 * element, because a dialog trigger is not a navigation.
 */
function Product({
  name,
  body,
  cta,
  href,
  onClick,
  tone,
  children,
  ref,
}: {
  name: string;
  body: string;
  cta: string;
  href?: string;
  onClick?: () => void;
  /** Which wash the screenshot stands on. Blue when unset. */
  tone?: "sand";
  children: React.ReactNode;
  ref?: React.Ref<HTMLElement>;
}) {
  const label = (
    <>
      {cta}
      <span className="landing-product-arrow" aria-hidden>
        →
      </span>
    </>
  );

  const ctaClasses = `
    landing-product-cta mt-6 inline-flex items-center gap-2
    text-[14px] font-medium text-text no-underline
  `;

  return (
    // Two elements, not one. The article is the flex item and carries the
    // divider; the inner box carries the scale. Drawing the rule on the
    // element that scales would scale the rule with it, and a hairline
    // that thickens as its column grows is not a hairline.
    <article className="landing-product" ref={ref}>
      <div className="landing-product-inner">
        <h3 className="landing-product-name font-accent text-[32px] font-medium leading-[1.15] tracking-[-0.015em] text-text max-[720px]:text-[26px]">
          {name}
        </h3>

        <p className="landing-product-body mt-4 text-[16px] leading-[1.55] text-text-2">
          {body}
        </p>

        {/* The wash is picked by attribute rather than by style, so the
            colours live in one place with the blue ones they mirror. */}
        <div
          className="landing-product-visual mt-10 max-[720px]:mt-8"
          data-tone={tone}
        >
          <div className="landing-product-frame">{children}</div>
        </div>

        {href ? (
          <Link href={href} className={ctaClasses}>
            {label}
          </Link>
        ) : (
          <button type="button" onClick={onClick} className={ctaClasses}>
            {label}
          </button>
        )}
      </div>
    </article>
  );
}
