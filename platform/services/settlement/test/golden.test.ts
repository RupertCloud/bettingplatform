import { describe, expect, it } from 'vitest';
import { choose, combinations, lineCount, NAMED_SYSTEMS, parseOdds, type LegOutcome } from '@bp/common';
import { betReturn, legFactor, lineReturn, type GradedLeg } from '../src/grading.js';

// Leg shorthands: odds as decimal strings, parsed exactly.
const W = (o: string): GradedLeg => ({ outcome: 'WON', odds: parseOdds(o) });
const L = (o = '2'): GradedLeg => ({ outcome: 'LOST', odds: parseOdds(o) });
const V = (o = '2'): GradedLeg => ({ outcome: 'VOID', odds: parseOdds(o) });
const HW = (o: string): GradedLeg => ({ outcome: 'HALF_WON', odds: parseOdds(o) });
const HL = (o = '2'): GradedLeg => ({ outcome: 'HALF_LOST', odds: parseOdds(o) });
const DH = (o: string, numerator: number, denominator: number): GradedLeg =>
  ({ outcome: 'DEAD_HEAT', odds: parseOdds(o), deadHeat: { numerator, denominator } });

const SINGLE = [1];
const DOUBLE = [2];
const TREBLE = [3];
const { TRIXIE, PATENT, YANKEE, LUCKY_15, LUCKY_31, GOLIATH } = NAMED_SYSTEMS as Record<string, { legs: number; sizes: number[] }>;

type Case = [name: string, unitStake: bigint, sizes: number[], legs: GradedLeg[], expected: bigint];

const GOLDEN: Case[] = [
  // Appendix A (SRS 8.5)
  ['Appendix A treble 1.80/2.10/1.50 with leg 2 VOID', 10_000n, TREBLE, [W('1.80'), V('2.10'), W('1.50')], 27_000n],
  ['Appendix A same with leg 3 HALF_LOST (AH -0.25)', 10_000n, TREBLE, [W('1.80'), V('2.10'), HL('1.50')], 9_000n],
  // Singles, every outcome
  ['single WON 2.50', 1_000n, SINGLE, [W('2.50')], 2_500n],
  ['single LOST', 1_000n, SINGLE, [L('2.50')], 0n],
  ['single VOID returns stake', 1_000n, SINGLE, [V('2.50')], 1_000n],
  ['single HALF_WON 1.90', 1_000n, SINGLE, [HW('1.90')], 1_450n],
  ['single HALF_LOST', 1_000n, SINGLE, [HL('1.90')], 500n],
  ['single DEAD_HEAT 5.00 two-way', 1_000n, SINGLE, [DH('5', 1, 2)], 2_500n],
  ['single DEAD_HEAT 7.00 three-way rounds down', 1_000n, SINGLE, [DH('7', 1, 3)], 2_333n],
  ['single DEAD_HEAT 3.00 two places of three', 1_000n, SINGLE, [DH('3', 2, 3)], 2_000n],
  ['single DEAD_HEAT 4.00 four-way returns stake', 10_000n, SINGLE, [DH('4', 1, 4)], 10_000n],
  ['single WON at minimum odds 1.0001 rounds down', 1n, SINGLE, [W('1.0001')], 1n],
  ['single WON 1.3333 stake 3 rounds down', 3n, SINGLE, [W('1.3333')], 3n],
  ['single HALF_WON 2.05 stake 1 rounds down', 1n, SINGLE, [HW('2.05')], 1n],
  ['single HALF_LOST stake 1 rounds to zero', 1n, SINGLE, [HL()], 0n],
  ['single VOID stake 1', 1n, SINGLE, [V()], 1n],
  ['single WON 1000.00', 1n, SINGLE, [W('1000')], 1_000n],
  // Asian quarter lines
  ['AH -0.25 home wins: WON 1.95', 10_000n, SINGLE, [W('1.95')], 19_500n],
  ['AH -0.25 draw: HALF_LOST', 10_000n, SINGLE, [HL('1.95')], 5_000n],
  ['AH +0.25 draw: HALF_WON 1.85', 10_000n, SINGLE, [HW('1.85')], 14_250n],
  ['Over 2.75 with 3 goals: HALF_WON 2.00', 10_000n, SINGLE, [HW('2.00')], 15_000n],
  ['Over 2.75 with 2 goals: LOST', 10_000n, SINGLE, [L('2.00')], 0n],
  ['Over 2.25 with 2 goals: HALF_LOST', 10_000n, SINGLE, [HL('1.90')], 5_000n],
  ['AH -0.75 win by one: HALF_WON 2.10', 10_000n, SINGLE, [HW('2.10')], 15_500n],
  // Doubles
  ['double WON WON', 1_000n, DOUBLE, [W('2'), W('3')], 6_000n],
  ['double WON LOST', 1_000n, DOUBLE, [W('2'), L('3')], 0n],
  ['double WON VOID becomes single', 1_000n, DOUBLE, [W('2'), V('3')], 2_000n],
  ['double VOID VOID returns stake', 1_000n, DOUBLE, [V(), V()], 1_000n],
  ['double HALF_WON WON', 1_000n, DOUBLE, [HW('1.90'), W('2')], 2_900n],
  ['double HALF_LOST WON', 1_000n, DOUBLE, [HL(), W('2')], 1_000n],
  ['double HALF_LOST HALF_LOST', 1_000n, DOUBLE, [HL(), HL()], 250n],
  ['double DEAD_HEAT WON', 1_000n, DOUBLE, [DH('5', 1, 2), W('2')], 5_000n],
  ['double HALF_WON HALF_WON rounds once', 1_000n, DOUBLE, [HW('1.95'), HW('1.85')], 2_101n],
  ['double DEAD_HEAT 6.00 1/3 with HALF_WON 2.00', 100n, DOUBLE, [DH('6', 1, 3), HW('2')], 300n],
  // Trebles and accumulators
  ['treble all WON 1.80/2.10/1.50', 10_000n, TREBLE, [W('1.80'), W('2.10'), W('1.50')], 56_700n],
  ['treble one LOST', 10_000n, TREBLE, [W('1.80'), L('2.10'), W('1.50')], 0n],
  ['treble all VOID', 10_000n, TREBLE, [V(), V(), V()], 10_000n],
  ['treble 1.10 x3 stake 7 rounds once (9.317)', 7n, TREBLE, [W('1.1'), W('1.1'), W('1.1')], 9n],
  ['treble 1.50 x3 stake 3 rounds once (10.125)', 3n, TREBLE, [W('1.5'), W('1.5'), W('1.5')], 10n],
  ['four-fold with VOID and HALF_LOST', 1_000n, [4], [W('2'), V(), HL(), W('3')], 3_000n],
  ['30-fold at 1.10', 100n, [30], Array.from({ length: 30 }, () => W('1.1')), 1_744n],
  // Trixie: 4 lines
  ['Trixie all WON 2/3/4', 100n, TRIXIE!.sizes, [W('2'), W('3'), W('4')], 5_000n],
  ['Trixie one LOST', 100n, TRIXIE!.sizes, [W('2'), W('3'), L('4')], 600n],
  ['Trixie two LOST', 100n, TRIXIE!.sizes, [W('2'), L('3'), L('4')], 0n],
  ['Trixie one VOID', 100n, TRIXIE!.sizes, [W('2'), W('3'), V('4')], 1_700n],
  ['Trixie all VOID returns 4 stakes', 100n, TRIXIE!.sizes, [V(), V(), V()], 400n],
  // Patent: 7 lines
  ['Patent all WON 2/3/4', 100n, PATENT!.sizes, [W('2'), W('3'), W('4')], 5_900n],
  ['Patent one winner', 100n, PATENT!.sizes, [W('2'), L('3'), L('4')], 200n],
  ['Patent two winners', 100n, PATENT!.sizes, [W('2'), W('3'), L('4')], 1_100n],
  ['Patent HALF_WON WON LOST', 100n, PATENT!.sizes, [HW('2'), W('3'), L('4')], 900n],
  ['Patent rounds per line (stake 1, 1.50 x3)', 1n, PATENT!.sizes, [W('1.5'), W('1.5'), W('1.5')], 12n],
  ['Patent all VOID returns 7 stakes', 100n, PATENT!.sizes, [V(), V(), V()], 700n],
  // Yankee: 11 lines
  ['Yankee all WON 2/3/4/5', 10n, YANKEE!.sizes, [W('2'), W('3'), W('4'), W('5')], 3_450n],
  ['Yankee one LOST', 10n, YANKEE!.sizes, [W('2'), W('3'), W('4'), L('5')], 500n],
  ['Yankee two LOST', 10n, YANKEE!.sizes, [W('2'), W('3'), L('4'), L('5')], 60n],
  ['Yankee one VOID', 10n, YANKEE!.sizes, [W('2'), W('3'), W('4'), V('5')], 1_090n],
  ['Yankee all VOID returns 11 stakes', 10n, YANKEE!.sizes, [V(), V(), V(), V()], 110n],
  // Lucky 15: 15 lines
  ['Lucky 15 all WON 2/3/4/5', 10n, LUCKY_15!.sizes, [W('2'), W('3'), W('4'), W('5')], 3_590n],
  ['Lucky 15 one winner', 10n, LUCKY_15!.sizes, [W('2'), L(), L(), L()], 20n],
  ['Lucky 15 all LOST', 10n, LUCKY_15!.sizes, [L(), L(), L(), L()], 0n],
  ['Lucky 15 all VOID returns 15 stakes', 10n, LUCKY_15!.sizes, [V(), V(), V(), V()], 150n],
  ['Lucky 31 all WON at 2.00', 1n, LUCKY_31!.sizes, Array.from({ length: 5 }, () => W('2')), 242n],
  // Goliath: 247 lines
  ['Goliath all VOID returns 247 stakes', 10n, GOLIATH!.sizes, Array.from({ length: 8 }, () => V()), 2_470n],
  ['Goliath all LOST', 10n, GOLIATH!.sizes, Array.from({ length: 8 }, () => L()), 0n],
  ['Goliath all WON at 2.00 (3^8 - 17)', 1n, GOLIATH!.sizes, Array.from({ length: 8 }, () => W('2')), 6_544n],
  ['Goliath one LOST, rest 2.00 (3^7 - 15)', 1n, GOLIATH!.sizes, [...Array.from({ length: 7 }, () => W('2')), L()], 2_172n],
  ['doubles from 4 (n-from-m) all VOID', 5n, DOUBLE, [V(), V(), V(), V()], 30n],
];

describe('golden settlement set (NFR-MT-002)', () => {
  it('NFR-MT-002 has at least 60 cases', () => {
    expect(GOLDEN.length).toBeGreaterThanOrEqual(60);
  });

  it.each(GOLDEN)('FR-STL-003 %s', (_name, unitStake, sizes, legs, expected) => {
    expect(betReturn(unitStake, sizes, legs)).toBe(expected);
  });
});

describe('line counts (FR-BET-002, FR-STL-003)', () => {
  const counts: [string, number, number[], bigint][] = [
    ['Single', 1, [1], 1n],
    ['Double', 2, [2], 1n],
    ['Treble', 3, [3], 1n],
    ['Trixie', 3, TRIXIE!.sizes, 4n],
    ['Patent', 3, PATENT!.sizes, 7n],
    ['Yankee', 4, YANKEE!.sizes, 11n],
    ['Lucky 15', 4, LUCKY_15!.sizes, 15n],
    ['Canadian', 5, NAMED_SYSTEMS.CANADIAN!.sizes, 26n],
    ['Lucky 31', 5, LUCKY_31!.sizes, 31n],
    ['Heinz', 6, NAMED_SYSTEMS.HEINZ!.sizes, 57n],
    ['Lucky 63', 6, NAMED_SYSTEMS.LUCKY_63!.sizes, 63n],
    ['Super Heinz', 7, NAMED_SYSTEMS.SUPER_HEINZ!.sizes, 120n],
    ['Goliath', 8, GOLIATH!.sizes, 247n],
  ];
  it.each(counts)('FR-STL-003 %s has the right number of lines', (_n, legs, sizes, expected) => {
    expect(lineCount(legs, sizes)).toBe(expected);
    const enumerated = sizes.reduce((sum, k) => sum + combinations(legs, k).length, 0);
    expect(BigInt(enumerated)).toBe(expected);
    expect(sizes.reduce((s, k) => s + choose(legs, k), 0n)).toBe(expected);
    // An all-void bet returns exactly one unit stake per line.
    expect(betReturn(1n, sizes, Array.from({ length: legs }, () => V()))).toBe(expected);
  });
});

describe('leg factors (FR-STL-002)', () => {
  const odds = parseOdds('1.80');
  const factors: [LegOutcome, bigint, bigint][] = [
    ['WON', 18_000n, 10_000n],
    ['LOST', 0n, 1n],
    ['VOID', 1n, 1n],
    ['HALF_WON', 28_000n, 20_000n],
    ['HALF_LOST', 1n, 2n],
  ];
  it.each(factors)('FR-STL-002 %s factor is exact', (outcome, num, den) => {
    expect(legFactor(outcome, odds)).toEqual({ num, den });
  });
  it('FR-STL-002 DEAD_HEAT factor is odds x numerator / denominator', () => {
    expect(legFactor('DEAD_HEAT', odds, { numerator: 1, denominator: 3 })).toEqual({ num: 18_000n, den: 30_000n });
  });
  it('FR-STL-002 DEAD_HEAT without a valid fraction is rejected', () => {
    expect(() => legFactor('DEAD_HEAT', odds)).toThrow(/DEAD_HEAT/);
    expect(() => legFactor('DEAD_HEAT', odds, { numerator: 3, denominator: 2 })).toThrow(/DEAD_HEAT/);
    expect(() => legFactor('DEAD_HEAT', odds, { numerator: 0, denominator: 2 })).toThrow(/DEAD_HEAT/);
  });
  it('FR-STL-003 rounds down once per line, not per leg', () => {
    // 7 x 1.1^3 = 9.317 -> 9. Rounding after each leg would give 7 -> 7 -> 7 -> 7 and under-pay.
    const f = legFactor('WON', parseOdds('1.1'));
    expect(lineReturn(7n, [f, f, f])).toBe(9n);
  });
  it('FR-STL-003 rejects combination sizes that do not fit the legs', () => {
    expect(() => betReturn(1n, [3], [W('2'), W('2')])).toThrow();
  });
});
