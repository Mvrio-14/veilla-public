"use client";

import * as React from "react";
import { LandingHeader } from "./header";
import { LandingHero } from "./hero";
import { LandingFiguresSection } from "./figures-section";
import { LandingCoreSection } from "./core-section";
import { LandingPlatformSection } from "./platform-section";
import { LandingPartnersSection } from "./partners-section";
import { LandingFinalCta } from "./final-cta";
import { LandingFooter } from "./footer";
import { ContactModal } from "@/components/contact/contact-modal";
import { useReveals } from "./use-reveals";

/**
 * Client wrapper that owns the contact-modal state, shared by the closing
 * CTA and the footer. The server-side `app/page.tsx` handles the
 * auth-gated redirect and just mounts this.
 *
 * The header and the hero take no callback: both send people to /login,
 * which needs no state from here. Only the two surfaces that open the
 * sales form are wired.
 */
export function LandingPage() {
  const [contactOpen, setContactOpen] = React.useState(false);
  const openContact = React.useCallback(() => setContactOpen(true), []);

  useReveals();

  return (
    <>
      <LandingHeader />
      <main>
        <LandingHero />
        {/* The hero is pinned with `sticky`, so it does not scroll out of
            the way — everything below has to cover it instead. That needs
            both a stacking order above it and an opaque background of its
            own, otherwise the photograph shows through the gaps between
            sections.

            The top edge is square. It carried a 16px radius, borrowed
            from a reference, to make the panel read as a separate sheet
            sliding over the picture — but a straight edge cuts the
            photograph cleanly and lets the two sections meet without a
            seam drawing attention to itself. */}
        <div id="landing-panel" className="relative z-10 bg-bg">
          <LandingFiguresSection />
          <LandingCoreSection />
          <LandingPlatformSection onContactClick={openContact} />
          <LandingPartnersSection onContactClick={openContact} />
          <LandingFinalCta onContactClick={openContact} />
        </div>
      </main>
      <div className="landing-foot relative z-10">
        <LandingFooter onContactClick={openContact} />
      </div>
      <ContactModal open={contactOpen} onOpenChange={setContactOpen} />
    </>
  );
}
