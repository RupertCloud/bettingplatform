import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  AppError, choose, combinations, formatOdds, fromMinor, lineCount, migrate, multiplyOdds,
  parseOdds, payout, testDb, toMinor, toProblem, withTx,
} from '../src/index.js';

describe('money', () => {
  it('parses and formats per currency decimals', () => {
    expect(toMinor('12.5', 'EUR')).toBe(1250n);
    expect(toMinor('1000', 'XAF')).toBe(1000n);
    expect(fromMinor(1250n, 'EUR')).toBe('12.50');
    expect(fromMinor(-5n, 'EUR')).toBe('-0.05');
    expect(fromMinor(1000n, 'XAF')).toBe('1000');
  });
  it('rejects excess precision and junk', () => {
    expect(() => toMinor('1.5', 'XAF')).toThrow(AppError);
    expect(() => toMinor('1e3', 'EUR')).toThrow(AppError);
  });
});

describe('odds', () => {
  it('is exact', () => {
    expect(parseOdds('1.8')).toBe(18_000n);
    expect(formatOdds(parseOdds('2.10'))).toBe('2.1');
    expect(multiplyOdds(parseOdds('1.8'), parseOdds('1.5'))).toBe(27_000n);
    expect(payout(10_000n, parseOdds('2.7'))).toBe(27_000n);
    expect(payout(3n, parseOdds('1.5'))).toBe(4n); // 4.5 rounds down
  });
  it('rejects odds at or below 1', () => {
    expect(() => parseOdds('1')).toThrow(AppError);
    expect(() => parseOdds('1.00001')).toThrow(AppError);
  });
});

describe('bet types', () => {
  it('counts lines', () => {
    expect(choose(4, 2)).toBe(6n);
    expect(lineCount(4, [2, 3, 4])).toBe(11n); // Yankee
    expect(lineCount(8, [2, 3, 4, 5, 6, 7, 8])).toBe(247n); // Goliath
    expect(combinations(3, 2)).toEqual([[0, 1], [0, 2], [1, 2]]);
  });
  it('rejects bad sizes', () => {
    expect(() => lineCount(3, [4])).toThrow(AppError);
    expect(() => lineCount(3, [2, 2])).toThrow(AppError);
  });
});

describe('errors', () => {
  it('hides internal errors', () => {
    expect(toProblem(new Error('db password is x')).detail).toBe('An unexpected error occurred.');
    expect(toProblem(new AppError('limit', 422, 'over')).status).toBe(422);
  });
});

describe('db', () => {
  it('migrates once, returns bigint and retries serialization failures', async () => {
    const dir = fileURLToPath(new URL('./migrations', import.meta.url));
    const db = await testDb('common', dir);
    try {
      expect(await migrate(db.pool, db.schema, dir)).toEqual([]);
      await db.pool.query('INSERT INTO counter (id, n) VALUES (1, 9007199254740993)');
      const { rows } = await db.pool.query('SELECT n FROM counter');
      expect(rows[0].n).toBe(9007199254740993n);
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withTx(db.pool, (c) => c.query('UPDATE counter SET n = n + 1 WHERE id = 1'), 'SERIALIZABLE'),
        ),
      );
      const after = await db.pool.query('SELECT n FROM counter');
      expect(after.rows[0].n).toBe(9007199254741001n);
    } finally {
      await db.drop();
    }
  });
});
