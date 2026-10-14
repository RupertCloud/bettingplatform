// Money and odds helpers. Money crosses the API as decimal strings; XAF has no decimals.
// Odds are decimal strings such as "2.15"; maths uses integers scaled by 10,000 like the platform.

const ODDS_SCALE = 10_000n;

/** "1500000" -> "1,500,000 XAF". Anything after a decimal point is dropped (XAF has none). */
export const formatXaf = (value) => {
  if (value === null || value === undefined || value === '') return '-';
  const m = /^(-?)(\d+)/.exec(String(value));
  if (!m) return '-';
  const digits = m[2].replace(/^0+(?=\d)/, '');
  return `${m[1]}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} XAF`;
};

/** "2.5" -> 25000n, or null when not valid odds. */
export const parseOdds = (s) => {
  const m = /^(\d{1,6})(?:\.(\d{1,4}))?$/.exec(String(s ?? ''));
  if (!m) return null;
  const v = BigInt(m[1] + (m[2] ?? '').padEnd(4, '0'));
  return v > ODDS_SCALE ? v : null;
};

export const formatOdds = (v) => {
  const whole = v / ODDS_SCALE;
  const frac = (v % ODDS_SCALE).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};

/** Shows odds with at least two decimals: "2" -> "2.00", "1.875" stays. */
export const displayOdds = (s) => {
  const v = parseOdds(s);
  if (v === null) return '-';
  const [w, f = ''] = formatOdds(v).split('.');
  return `${w}.${f.padEnd(2, '0')}`;
};

/** Accumulator odds, multiplied leg by leg and rounded down like the platform. */
export const comboOdds = (oddsList) => {
  let total = ODDS_SCALE;
  for (const s of oddsList) {
    const v = parseOdds(s);
    if (v === null) return null;
    total = (total * v) / ODDS_SCALE;
  }
  return total;
};

/** Stake (whole XAF string) x scaled odds, rounded down. Returns a decimal string. */
export const payout = (stake, scaledOdds) => {
  if (!/^\d{1,15}$/.test(String(stake)) || scaledOdds === null) return null;
  return ((BigInt(stake) * scaledOdds) / ODDS_SCALE).toString();
};

/** Parses a stake typed by the player: digits, optional spaces or commas as separators. */
export const parseStake = (input) => {
  const s = String(input ?? '').replace(/[\s,]/g, '');
  if (!/^\d{1,15}$/.test(s)) return null;
  const n = s.replace(/^0+(?=\d)/, '');
  return n === '0' ? null : n;
};
