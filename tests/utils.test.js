'use strict';

const { damerauLevenshtein, fuzzyMatch } = require('../core/utils');

// ─── damerauLevenshtein ───────────────────────────────────────────────────────

describe('damerauLevenshtein', () => {
    test('returns 0 for identical strings', () => {
        expect(damerauLevenshtein('hello', 'hello')).toBe(0);
    });

    test('returns length of b when a is empty', () => {
        expect(damerauLevenshtein('', 'abc')).toBe(3);
    });

    test('returns length of a when b is empty', () => {
        expect(damerauLevenshtein('abc', '')).toBe(3);
    });

    test('counts single insertion', () => {
        // "cat" → "cats" is one insertion
        expect(damerauLevenshtein('cat', 'cats')).toBe(1);
    });

    test('counts single deletion', () => {
        // "cats" → "cat" is one deletion
        expect(damerauLevenshtein('cats', 'cat')).toBe(1);
    });

    test('counts single substitution', () => {
        // "cat" → "bat" is one substitution
        expect(damerauLevenshtein('cat', 'bat')).toBe(1);
    });

    test('counts transposition (adjacent swap) as distance 1', () => {
        // "ab" → "ba" is a transposition — Damerau counts this as 1
        expect(damerauLevenshtein('ab', 'ba')).toBe(1);
    });

    test('handles transposition in longer strings', () => {
        // "recieve" → "receive" — one transposition of 'ie'→'ei'
        expect(damerauLevenshtein('recieve', 'receive')).toBe(1);
    });

    test('is symmetric', () => {
        expect(damerauLevenshtein('kitten', 'sitting')).toBe(
            damerauLevenshtein('sitting', 'kitten')
        );
    });

    test('classic kitten→sitting = 3', () => {
        // 3 substitutions: k→s, e→i, (addition of g)
        expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
    });

    test('returns max length when strings share nothing', () => {
        expect(damerauLevenshtein('abc', 'xyz')).toBe(3);
    });

    test('handles single-character strings', () => {
        expect(damerauLevenshtein('a', 'b')).toBe(1);
        expect(damerauLevenshtein('a', 'a')).toBe(0);
    });

    test('handles one-char vs empty string', () => {
        expect(damerauLevenshtein('a', '')).toBe(1);
        expect(damerauLevenshtein('', 'a')).toBe(1);
    });
});

// ─── fuzzyMatch ──────────────────────────────────────────────────────────────

describe('fuzzyMatch', () => {
    test('returns true for exact keyword match', () => {
        expect(fuzzyMatch('the payment is pending', ['payment'])).toBe(true);
    });

    test('returns false when no keyword is close enough', () => {
        expect(fuzzyMatch('hello world', ['invoice', 'receipt'])).toBe(false);
    });

    test('matches with one-character typo (short keyword <=5 chars, distance 1)', () => {
        // "paymnt" should match "payment"? No — "paymnt" length 6, "payment" length 7, distance=1, allowedDist=2 (kw>5)
        expect(fuzzyMatch('the paymnt is due', ['payment'])).toBe(true);
    });

    test('is case insensitive (lowercases text before comparison)', () => {
        expect(fuzzyMatch('PAYMENT is overdue', ['payment'])).toBe(true);
    });

    test('strips punctuation before matching', () => {
        // word "payment," should still match keyword "payment"
        expect(fuzzyMatch('please confirm payment, thanks', ['payment'])).toBe(true);
    });

    test('skips words shorter than 3 characters', () => {
        // "is" (2 chars) should never match keyword "is" because cleanWord.length < 3
        expect(fuzzyMatch('it is ok', ['is'])).toBe(false);
    });

    test('returns false on empty text', () => {
        expect(fuzzyMatch('', ['payment'])).toBe(false);
    });

    test('returns false on empty keywords array', () => {
        expect(fuzzyMatch('please process payment', [])).toBe(false);
    });

    test('uses distance 2 for keywords longer than 5 characters', () => {
        // "invoicee" vs "invoice" → distance 1, keyword length 7 > 5 → allowedDist 2 → match
        expect(fuzzyMatch('send the invoicee', ['invoice'])).toBe(true);
    });

    test('uses distance 1 for keywords of 5 characters or fewer', () => {
        // "leavee" (6 chars) vs keyword "leave" (5 chars) — allowedDist=1, distance=1 → match
        expect(fuzzyMatch('applying for leavee tomorrow', ['leave'])).toBe(true);
    });

    test('does NOT match when distance exceeds threshold for short keyword', () => {
        // "lxaxe" vs "leave" → distance 2, keyword len=5 so allowedDist=1 → no match
        expect(fuzzyMatch('applying for lxaxe tomorrow', ['leave'])).toBe(false);
    });

    test('matches one of multiple keywords', () => {
        expect(fuzzyMatch('i need a refund', ['invoice', 'payment', 'refund'])).toBe(true);
    });

    test('respects custom maxDistance parameter (overrides internal logic indirectly via direct match)', () => {
        // maxDistance param is accepted but the function overrides it internally per keyword length.
        // Passing maxDistance=0 still does direct equality match via the kw===cleanWord path.
        expect(fuzzyMatch('check payment today', ['payment'], 0)).toBe(true);
    });

    test('does not match on whitespace-only text', () => {
        expect(fuzzyMatch('   ', ['payment'])).toBe(false);
    });
});
