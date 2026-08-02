// Core CV pipeline: find the 4 corners of a document in a photo, then
// warp/flatten it to a straight-on rectangular view.

/**
 * Finds the largest 4-sided contour in the image — assumed to be the document.
 * Returns [topLeft, topRight, bottomRight, bottomLeft] as {x, y} points in
 * the source image's pixel coordinates, or null if nothing suitable was found.
 */
export function detectDocumentCorners(cv, srcMat) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edged = new cv.Mat();
  const dilated = new cv.Mat();
  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  let bestApprox = null;
  let maxArea = 0;

  try {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edged, 75, 200);
    cv.dilate(edged, dilated, kernel);

    cv.findContours(dilated, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        const area = cv.contourArea(approx);
        // Require the candidate to cover a meaningful chunk of the frame,
        // otherwise stray rectangles (a phone case corner, a shadow) win.
        const imageArea = srcMat.rows * srcMat.cols;
        if (area > maxArea && area > imageArea * 0.15) {
          maxArea = area;
          if (bestApprox) bestApprox.delete();
          bestApprox = approx;
        } else {
          approx.delete();
        }
      } else {
        approx.delete();
      }
      cnt.delete();
    }

    if (!bestApprox) return null;

    const points = [];
    for (let i = 0; i < 4; i++) {
      points.push({
        x: bestApprox.data32S[i * 2],
        y: bestApprox.data32S[i * 2 + 1],
      });
    }
    bestApprox.delete();

    return {
      corners: orderPoints(points),
      confidence: Math.min(0.99, maxArea / (srcMat.rows * srcMat.cols)),
    };
  } finally {
    gray.delete();
    blurred.delete();
    edged.delete();
    dilated.delete();
    kernel.delete();
    contours.delete();
    hierarchy.delete();
  }
}

// Sorts 4 arbitrary points into [topLeft, topRight, bottomRight, bottomLeft]
function orderPoints(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];

  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const tr = byDiff[0];
  const bl = byDiff[3];

  return [tl, tr, br, bl];
}

/** Angle in degrees of the top edge relative to horizontal — for display only. */
export function computeSkewAngle(corners) {
  const [tl, tr] = corners;
  const dx = tr.x - tl.x;
  const dy = tr.y - tl.y;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/** Warps the source image so the given 4 corners become a flat rectangle. */
export function warpToFlat(cv, srcMat, corners, outputWidth = 1000, outputHeight = 1294) {
  const [tl, tr, br, bl] = corners;

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y,
    tr.x, tr.y,
    br.x, br.y,
    bl.x, bl.y,
  ]);

  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outputWidth, 0,
    outputWidth, outputHeight,
    0, outputHeight,
  ]);

  const M = cv.getPerspectiveTransform(srcTri, dstTri);
  const dst = new cv.Mat();
  cv.warpPerspective(
    srcMat,
    dst,
    M,
    new cv.Size(outputWidth, outputHeight),
    cv.INTER_LINEAR,
    cv.BORDER_CONSTANT,
    new cv.Scalar()
  );

  srcTri.delete();
  dstTri.delete();
  M.delete();

  return dst;
}
