/**
 * Shared placeholder for the Settings sub-tabs that aren't shipped yet
 * (Feeds, Notifications, Profil). Renders a heading + a hint about
 * what's coming. Pure server component, no interactivity.
 */
export function SettingsPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h1 className="text-[18px] font-semibold tracking-[-0.012em] text-text mb-1">
        {title}
      </h1>
      <p className="text-[13px] text-text-3 leading-relaxed">{description}</p>
    </div>
  );
}
