// Sponsorship disclosure detection. Only *identifiable* sponsorship can be flagged:
// YouTube's own paid-promotion flag, or disclosure wording in the title, description or text.
// Undisclosed sponsorship cannot be detected, and the report says so.

const PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /#\s?ad\b/i, label: '#ad' },
  { pattern: /#\s?sponsored\b/i, label: '#sponsored' },
  { pattern: /#\s?(partner|gifted)\b/i, label: '#partner / #gifted' },
  { pattern: /\bsponsored by\b/i, label: '"sponsored by"' },
  { pattern: /\bthis (video|post|article|review) (is|was) sponsored\b/i, label: 'states it is sponsored' },
  { pattern: /\bpaid (partnership|promotion|collaboration)\b/i, label: 'paid partnership' },
  { pattern: /\bin (paid )?partnership with\b/i, label: '"in partnership with"' },
  { pattern: /\b(gifted|pr package|pr haul|press sample|sent (to )?me (for free|by))\b/i, label: 'gifted product' },
  { pattern: /\baffiliate (link|links|commission|partner)\b/i, label: 'affiliate links' },
  { pattern: /\b(we|i) (may |might )?earn (a |an )?(small )?(affiliate )?commission\b/i, label: 'earns commission' },
  { pattern: /\b(use|with) (my |our )?(discount |promo )?code\b/i, label: 'discount code' },
  { pattern: /\badvertorial\b/i, label: 'advertorial' },
  { pattern: /\bbrand ambassador\b/i, label: 'brand ambassador' },
];

export function detectSponsorship(text: string, paidPlacementFlag?: boolean | null): string[] {
  const signals: string[] = [];
  if (paidPlacementFlag === true) signals.push('YouTube paid-promotion flag');
  for (const { pattern, label } of PATTERNS) {
    if (pattern.test(text) && !signals.includes(label)) signals.push(label);
  }
  return signals;
}
