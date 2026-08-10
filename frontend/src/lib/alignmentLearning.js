// Learns two things per template, from what the user actually corrects
// auto-detection to:
//   1. Corner-detection bias: if this template's photos tend to get
//      auto-detected corners that are consistently off in the same
//      direction (e.g. a shadow that's always in the same spot for this
//      particular scanning setup), that's a learnable, reusable bias -
//      unlike the raw per-photo geometry itself, which varies shot to shot.
//   2. Alignment-offset bias: the manual "drag to align the first row"
//      nudge tends to be similar scan after scan for the same physical
//      document type and capture setup, so the learned average becomes
//      the new starting offset instead of always starting at zero.
//
// Both are running averages, not a trained model - simple, transparent,
// and (like the OCR correction memory) always just a starting point the
// user can override, never applied silently without being visible.

export function emptyAlignmentDoc(templateId) {
  return {
    templateId,
    enabled: true,
    cornerBias: { count: 0, deltas: [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }] },
    alignmentBias: { count: 0, offset: { dx: 0, dy: 0 } },
  };
}

export function isAlignmentLearningEnabled(doc) {
  return doc?.enabled !== false;
}

export function setAlignmentLearningEnabled(doc, enabled) {
  return { ...doc, enabled };
}

// --- Corner-detection bias ---

// Nudges freshly auto-detected corners by the learned average delta,
// scaled to this image's actual working dimensions (the bias is stored
// as a fraction of width/height, since different photos can have
// different working resolutions).
export function applyCornerBias(doc, rawCorners, dims) {
  if (!doc || !isAlignmentLearningEnabled(doc) || !doc.cornerBias || doc.cornerBias.count < 2) {
    return rawCorners;
  }
  return rawCorners.map((pt, i) => {
    const bias = doc.cornerBias.deltas[i] || { dx: 0, dy: 0 };
    return {
      x: pt.x + bias.dx * dims.w,
      y: pt.y + bias.dy * dims.h,
    };
  });
}

// Call at the moment the user confirms corners - compares the FINAL
// confirmed corners against the RAW (unbiased) detection this round,
// since that's the true residual error the algorithm actually made,
// regardless of what starting point we showed the user.
export function recordCornerCorrection(doc, rawCorners, confirmedCorners, dims) {
  const base = doc || emptyAlignmentDoc(null);
  const prevCount = base.cornerBias?.count || 0;
  const prevDeltas = base.cornerBias?.deltas || [{ dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }, { dx: 0, dy: 0 }];
  const newCount = prevCount + 1;

  const newDeltas = prevDeltas.map((prev, i) => {
    const raw = rawCorners[i];
    const confirmed = confirmedCorners[i];
    const sampleDx = (confirmed.x - raw.x) / dims.w;
    const sampleDy = (confirmed.y - raw.y) / dims.h;
    // Incremental mean: newAvg = oldAvg + (sample - oldAvg) / n
    return {
      dx: prev.dx + (sampleDx - prev.dx) / newCount,
      dy: prev.dy + (sampleDy - prev.dy) / newCount,
    };
  });

  return { ...base, cornerBias: { count: newCount, deltas: newDeltas } };
}

// --- Alignment-offset bias ---

export function getAlignmentOffsetDefault(doc) {
  if (!doc || !isAlignmentLearningEnabled(doc) || !doc.alignmentBias || doc.alignmentBias.count < 2) {
    return { dx: 0, dy: 0 };
  }
  return { ...doc.alignmentBias.offset };
}

// Call at the moment the user confirms alignment - the final offset they
// land on (regardless of what we pre-filled) IS the sample to learn from.
export function recordAlignmentCorrection(doc, finalOffset) {
  const base = doc || emptyAlignmentDoc(null);
  const prevCount = base.alignmentBias?.count || 0;
  const prevOffset = base.alignmentBias?.offset || { dx: 0, dy: 0 };
  const newCount = prevCount + 1;

  const newOffset = {
    dx: prevOffset.dx + (finalOffset.dx - prevOffset.dx) / newCount,
    dy: prevOffset.dy + (finalOffset.dy - prevOffset.dy) / newCount,
  };

  return { ...base, alignmentBias: { count: newCount, offset: newOffset } };
}

export function alignmentLearningSummary(doc) {
  const cornerCount = doc?.cornerBias?.count || 0;
  const alignCount = doc?.alignmentBias?.count || 0;
  if (cornerCount === 0 && alignCount === 0) return null;
  return `Learned from ${Math.max(cornerCount, alignCount)} past scan${Math.max(cornerCount, alignCount) === 1 ? '' : 's'}`;
}
