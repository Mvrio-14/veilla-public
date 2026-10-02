import { NextResponse, type NextRequest } from "next/server";

/**
 * Favicon proxy — `/api/favicon?url=https://www.lemonde.fr/...`
 *
 * A list of sources is far easier to scan with each one's own mark than
 * with monograms. The browser does not fetch it itself: that would tell a
 * third party every domain the reader follows, and one slow host would
 * leave a page of broken images.
 *
 * The icon comes from Google's favicon service, and only from there.
 * Fetching the source's own `/favicon.ico` would be more direct, but it
 * makes this route fetch any host a caller names, internal addresses
 * included; a fixed upstream keeps it from being a way into the network
 * it runs on.
 *
 * A miss returns 204 rather than 404: "no icon" is a normal outcome the
 * client handles by drawing a monogram. Icons change once a rebrand, so
 * the CDN keeps them a week and serves stale for a month.
 */

const FETCH_TIMEOUT_MS = 3500;
const MAX_BYTES = 256 * 1024;
const CACHE_CONTROL =
  "public, max-age=86400, s-maxage=604800, stale-while-revalidate=2592000";

export async function GET(request: NextRequest) {
  let hostname: string;
  try {
    const url = new URL(request.nextUrl.searchParams.get("url") ?? "");
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    hostname = url.hostname;
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  const icon = await fetchImage(
    `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostname)}`,
  );
  if (!icon) {
    return new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  }
  return new NextResponse(icon.body, {
    status: 200,
    headers: { "Content-Type": icon.contentType, "Cache-Control": CACHE_CONTROL },
  });
}

async function fetchImage(
  url: string,
): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const body = await res.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return null;
    return { body, contentType };
  } catch {
    return null;
  }
}
