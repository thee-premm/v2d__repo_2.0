/** The Vote2Dine mark: a meal token (notched coupon) carrying a tick. */
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="28" height="28" rx="4" fill="currentColor" opacity="0.14" />
      <rect x="2.75" y="2.75" width="26.5" height="26.5" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2 12.5a3.5 3.5 0 0 1 0 7M30 12.5a3.5 3.5 0 0 0 0 7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 16.5l4 4 8-9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <BrandMark />
      {!compact && (
        <span className="brand-word">
          Vote<b>2</b>Dine
        </span>
      )}
    </span>
  );
}
