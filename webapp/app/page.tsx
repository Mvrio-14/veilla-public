import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LandingPage } from "@/components/landing/landing-page";

/**
 * Public landing page. Logged-in visitors are bounced straight to /watch
 * — the marketing copy is for prospects, not for people who already
 * have an account. The actual page renders a client wrapper that owns
 * the demo-modal state across the header / hero / CTA / footer.
 */
export default async function Home() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session) {
    redirect("/watch");
  }

  return <LandingPage />;
}
