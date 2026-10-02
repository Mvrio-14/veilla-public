import { redirect } from "next/navigation";

/** Signal opens on its decisions. */
export default function SignalPage() {
  redirect("/signal/decisions");
}
