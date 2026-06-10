/** A horse-bit mark — the thing reins attach to. On-theme for a control plane. */
export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="7" cy="16" r="5" stroke="currentColor" strokeWidth="2.2" />
      <circle cx="25" cy="16" r="5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M12 16 H20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M16 12 V20" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}
