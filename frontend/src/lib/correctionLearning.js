// Correction-memory learning for OCR results.
//
// This is deliberately NOT a trained neural model - it's a lightweight
// pattern-memory system, scoped per template + per field, built from two
// layers:
//   1. Exact-match memory: "I've seen this exact garbled OCR string
//      before, and you corrected it to X" - highest confidence, applied first.
//   2. Character-substitution learning: by diffing OCR text against its
//      correction across many examples, recurring single-character
//      confusions (e.g. this field's OCR keeps reading "0" as "O") get
//      extracted and applied to new, never-seen-before OCR output.
//
// Suggestions are always just a starting point for the editable field -
// never applied silently without the review screen showing what changed.

const MAX_HISTORY_PER_FIELD = 50;
const MIN_SUBSTITUTION_COUNT = 2; // a substitution needs to have been seen at least this often
const MIN_SUBSTITUTION_RATIO = 2; // ...and be at least this much more common than the next-best alternative

export function emptyCorrectionsDoc(templateId) {
  return { templateId, fields: {} };
}

function ensureField(doc, fieldName) {
  if (!doc.fields[fieldName]) {
    doc.fields[fieldName] = {
      enabled: true,
      history: [],
      stats: { shown: 0, accepted: 0, overridden: 0 },
    };
  }
  return doc.fields[fieldName];
}

export function isFieldLearningEnabled(doc, fieldName) {
  return doc?.fields?.[fieldName]?.enabled !== false;
}

export function setFieldLearningEnabled(doc, fieldName, enabled) {
  const field = ensureField(doc, fieldName);
  field.enabled = enabled;
  return doc;
}

// --- Levenshtein alignment, used to extract character substitutions from a (ocr, corrected) pair ---

function computeEditOps(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'match' });
      i--; j--;
    } else if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
      ops.push({ type: 'sub', from: a[i - 1], to: b[j - 1] });
      i--; j--;
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: 'del', from: a[i - 1] });
      i--;
    } else {
      ops.push({ type: 'ins', to: b[j - 1] });
      j--;
    }
  }
  return ops.reverse();
}

function buildSubstitutionCounts(history) {
  const counts = {}; // "fromChar\u0000toChar" -> count
  for (const { ocr, corrected } of history) {
    if (!ocr || !corrected || ocr === corrected) continue;
    const ops = computeEditOps(ocr, corrected);
    for (const op of ops) {
      if (op.type === 'sub') {
        const key = `${op.from}\u0000${op.to}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
  }
  return counts;
}

// Only keeps a substitution if it's been seen often enough, and isn't
// ambiguous (the same source character correcting to different things
// about equally often) - a deliberately conservative bar, since a wrong
// auto-suggestion is worse than no suggestion.
function buildConfidentSubstitutions(history) {
  const counts = buildSubstitutionCounts(history);
  const byFrom = {};
  for (const key in counts) {
    const [from, to] = key.split('\u0000');
    if (!byFrom[from]) byFrom[from] = [];
    byFrom[from].push({ to, count: counts[key] });
  }

  const best = {};
  for (const from in byFrom) {
    const options = byFrom[from].sort((a, b) => b.count - a.count);
    const top = options[0];
    const second = options[1];
    if (top.count >= MIN_SUBSTITUTION_COUNT && (!second || top.count >= second.count * MIN_SUBSTITUTION_RATIO)) {
      best[from] = top.to;
    }
  }
  return best;
}

function applySubstitutions(text, subMap) {
  if (!text) return text;
  return text.split('').map((ch) => subMap[ch] ?? ch).join('');
}

// Returns a suggested correction string, or null if there's nothing to suggest.
export function suggestCorrection(fieldData, ocrText) {
  if (!fieldData || fieldData.enabled === false) return null;
  const history = fieldData.history || [];
  if (history.length === 0 || !ocrText) return null;

  // Layer 1: exact match - most recent correction for this exact OCR string wins.
  const exactMatches = history.filter((h) => h.ocr === ocrText);
  if (exactMatches.length > 0) {
    return exactMatches[exactMatches.length - 1].corrected;
  }

  // Layer 2: character-substitution pattern, applied to this new (unseen) OCR text.
  const subMap = buildConfidentSubstitutions(history);
  if (Object.keys(subMap).length === 0) return null;

  const suggestion = applySubstitutions(ocrText, subMap);
  return suggestion !== ocrText ? suggestion : null;
}

// Call once per field, at the moment the user confirms a document -
// records the (ocr, corrected) pair if they differ, and updates
// accept/override stats if a suggestion had been shown for this field.
export function recordCorrectionOutcome(doc, fieldName, { rawOcr, suggestion, finalValue }) {
  const field = ensureField(doc, fieldName);

  if (suggestion !== null && suggestion !== undefined) {
    field.stats.shown = (field.stats.shown || 0) + 1;
    if (finalValue === suggestion) {
      field.stats.accepted = (field.stats.accepted || 0) + 1;
    } else {
      field.stats.overridden = (field.stats.overridden || 0) + 1;
    }
  }

  if (rawOcr !== finalValue) {
    field.history.push({ ocr: rawOcr, corrected: finalValue, timestamp: new Date().toISOString() });
    if (field.history.length > MAX_HISTORY_PER_FIELD) {
      field.history = field.history.slice(-MAX_HISTORY_PER_FIELD);
    }
  }

  return doc;
}

export function fieldAccuracyLabel(fieldData) {
  const stats = fieldData?.stats;
  if (!stats || !stats.shown) return null;
  const pct = Math.round((stats.accepted / stats.shown) * 100);
  return `${pct}% of suggestions accepted (${stats.shown} shown)`;
}
