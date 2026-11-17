/** TicketGhar mark: house outline with a ticket perforation and door notch. */
export function Logo({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#D90429" />
      <path d="M32 12 L52 28 L52 50 L12 50 L12 28 Z" fill="#fff" />
      <circle cx="12" cy="36" r="3.5" fill="#D90429" />
      <circle cx="52" cy="36" r="3.5" fill="#D90429" />
      <path d="M17 36 H47" stroke="#D90429" strokeWidth="2.5" strokeDasharray="4 3" />
      <rect x="28" y="40" width="8" height="10" rx="2.5" fill="#D90429" />
    </svg>
  );
}
