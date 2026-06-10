/** Small presentation helpers shared across the console UI. */

export function usd(amount: string | undefined): string {
  if (amount === undefined) return '$0.00';
  const n = Number(amount);
  const decimals = n !== 0 && n < 0.01 ? 4 : 2;
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
}

/** First 6 + last 4 of a hash-like string, joined with an ellipsis. */
export function midHash(h: string | undefined, head = 6, tail = 4): string {
  if (!h) return '—';
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  if (clean.length <= head + tail) return h;
  return `${clean.slice(0, head)}…${clean.slice(-tail)}`;
}

export function clockTime(iso: string | undefined): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function relTime(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (secs < 1) return 'now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function latency(ms: number | undefined): string {
  if (ms === undefined) return '—';
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : `${ms.toFixed(2)}ms`;
}
