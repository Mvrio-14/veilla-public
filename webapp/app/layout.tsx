import type { Metadata } from "next";
import {
  Inter,
  JetBrains_Mono,
  Jost,
  Newsreader,
  Plus_Jakarta_Sans,
  Poppins,
} from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// 300 is here for the core statement, which is set light. Measured off
// the reference: what reads as "thin" on those pages is weight 300 with
// tight tracking, not a different typeface.
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// The wordmark — the word "VEILLA" beside the eye, wherever the brand
// renders (landing, topbar, login, legal). Next dedupes, so loading it at
// the root is the right place.
const poppins = Poppins({
  variable: "--font-wordmark",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Landing display face — the hero, section and legal headlines. Kept
// separate from the wordmark face (Poppins) so each can change alone.
const jost = Jost({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

// The page's one expressive face, and it earns its place three times:
// the hero's claim, the four figures, and the word that cycles in the
// core statement. Nothing else. Measured on the nearest reference, the
// serif carries 19 of its 117 text elements — the H1 and the numbers —
// while every section heading, even at 28px, stays in the sans. A styled
// face used everywhere is a second body font; used at a sixth of the
// page it is a voice.
//
// Newsreader is a text face cut for news, which is the least arbitrary
// serif to put on this page. The upright is for the headline and the
// figures; the italic is the cycling word, and it is a real italic
// rather than a slant — the browser's synthetic oblique shears the
// letterforms instead of redrawing them, which shows at that size.
const newsreader = Newsreader({
  variable: "--font-accent",
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
});

// The landing's large text — the statements, the closing title, the card
// labels. Not a stylistic whim: Inter's lowercase stands at 0.753 of its
// cap height, measured, against 0.727 for a standard grotesque. That
// ratio is what makes it legible at 13px and what makes it read as
// stretched upward at 56. Plus Jakarta Sans sits lower and wider, which
// is the whole reason it is here.
//
// Body, interface and anything under about 20px stay on Inter, which is
// drawn for exactly that and which the product itself runs on.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-title",
  subsets: ["latin"],
  weight: ["300", "400", "500"],
});

// The domain this app is served from. It feeds `metadataBase`, which is
// what every canonical URL and every share-preview image path is resolved
// against — so pointing it anywhere else silently advertises another site.
// Not veilla.io: that is a different deployment.
const SITE_URL = "https://news.veilla.io";
const OG_IMAGE = "/landing/veilla-mark-dark.png";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Veilla — Editorial intelligence for newsrooms",
    template: "%s · Veilla",
  },
  description:
    "Veilla monitors the sources you choose, in real time, in every language, and groups them into clear stories. See what's rising, what's changing, and the angle that sets you apart.",
  keywords: [
    "newsroom intelligence",
    "editorial monitoring",
    "news aggregation",
    "media monitoring",
    "press watch",
    "veille presse",
    "veille éditoriale",
    "intelligence rédactionnelle",
    "RSS",
    "newsroom SaaS",
  ],
  authors: [{ name: "Veilla" }],
  // Icons are not declared here: Next 16 picks up `app/icon.svg`,
  // `app/favicon.ico` (16/32/48) and `app/apple-icon.png` from the file
  // system.
  //
  // The tab icon is the bare mark on no ground, so what shows is the logo
  // rather than a badge containing it. Having no ground means taking the
  // colour of whatever the browser paints behind it, so icon.svg carries
  // its own prefers-color-scheme rule and flips to cream on a dark tab
  // strip. The .ico cannot do that — it is raster — and is the fallback
  // for clients that do not read an SVG icon.
  //
  // apple-icon is the exception: iOS ignores alpha, so it keeps an opaque
  // cream plate behind the same black mark.
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Veilla",
    title: "Veilla — Editorial intelligence for newsrooms",
    description:
      "Monitor the sources you choose, in every language, grouped into clear stories. See what's rising, what's changing, and the angle that sets you apart.",
    images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: "Veilla" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Veilla — Editorial intelligence for newsrooms",
    description:
      "Monitor the sources you choose, in every language, grouped into clear stories.",
    images: [OG_IMAGE],
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${jetbrainsMono.variable} ${poppins.variable} ${jost.variable} ${newsreader.variable} ${jakarta.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem={false}
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
