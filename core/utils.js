/**
 * Calculates the Damerau-Levenshtein distance between two strings.
 * This accounts for insertions, deletions, substitutions, and transpositions.
 */
function damerauLevenshtein(a, b) {
    const n = a.length;
    const m = b.length;
    if (n === 0) return m;
    if (m === 0) return n;

    const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

    for (let i = 0; i <= n; i++) d[i][0] = i;
    for (let j = 0; j <= m; j++) d[0][j] = j;

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(
                d[i - 1][j] + 1,       // deletion
                d[i][j - 1] + 1,       // insertion
                d[i - 1][j - 1] + cost // substitution
            );

            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost); // transposition
            }
        }
    }
    return d[n][m];
}

/**
 * Checks if a message contains any word that is close to a set of keywords
 * based on the Damerau-Levenshtein distance.
 */
function fuzzyMatch(text, keywords, maxDistance = 1) {
    const words = text.toLowerCase().split(/\s+/);
    for (const word of words) {
        // Remove punctuation from the word
        const cleanWord = word.replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, "");
        if (cleanWord.length < 3) continue;

        for (const kw of keywords) {
            // If direct match
            if (cleanWord === kw) return true;
            
            // For longer keywords, allow more distance. For short ones, only 1.
            const allowedDist = (kw.length > 5) ? 2 : 1;
            if (damerauLevenshtein(cleanWord, kw) <= allowedDist) {
                return true;
            }
        }
    }
    return false;
}

module.exports = {
    damerauLevenshtein,
    fuzzyMatch
};
