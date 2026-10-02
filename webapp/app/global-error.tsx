"use client";

// Last-resort boundary: catches errors thrown in the root layout itself,
// which the route-group error.tsx can't reach. It replaces the whole
// document, so it must render its own <html>/<body>. Kept deliberately
// minimal — no app providers, no design tokens — because by the time this
// fires, the app shell may be the thing that failed.
import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="fr">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
          background: "#0a0a0a",
          color: "#ededed",
          margin: 0,
        }}
      >
        <div style={{ textAlign: "center", maxWidth: 420, padding: "0 24px" }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
            Une erreur est survenue
          </h2>
          <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 20 }}>
            Recharge la page pour réessayer.
          </p>
          <button
            onClick={() => reset()}
            style={{
              fontSize: 14,
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #333",
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
            }}
          >
            Réessayer
          </button>
        </div>
      </body>
    </html>
  );
}
