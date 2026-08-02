// Classic (non-module) Web Worker. Runs OpenCV.js entirely off the main
// thread. Split into two steps so the user can correct auto-detected
// corners before the (irreversible, re-runnable-but-wasteful) warp step:
//   1. 'detect' -> finds a best-guess quad, returns corners + confidence
//   2. 'warp'   -> takes user-confirmed corners, produces the flattened image

self.importScripts('https://docs.opencv.org/4.9.0/opencv.js');

const cvReady = new Promise((resolve) => {
  if (self.cv && self.cv.Mat) {
    resolve();
  } else {
    self.cv['onRuntimeInitialized'] = () => resolve();
  }
});

self.onmessage = async (e) => {
  await cvReady;
  const cv = self.cv;
  const { type } = e.data;

  if (type === 'detect') {
    const { buffer, width, height } = e.data;
    try {
      const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
      const srcMat = cv.matFromImageData(imageData);
      const result = detectDocumentCorners(cv, srcMat);
      srcMat.delete();

      self.postMessage({
        type: 'detect-result',
        corners: result ? result.corners : null,
        confidence: result ? result.confidence : 0,
      });
    } catch (err) {
      self.postMessage({ type: 'error', message: 'Detection failed: ' + err.message });
    }
    return;
  }

  if (type === 'warp') {
    const { buffer, width, height, corners } = e.data;
    try {
      const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
      const srcMat = cv.matFromImageData(imageData);

      const skewAngle = computeSkewAngle(corners);
      const outputW = 1000;
      const outputH = Math.round(outputW * 1.294);
      const flatMat = warpToFlat(cv, srcMat, corners, outputW, outputH);

      // cv.imshow() checks `instanceof HTMLCanvasElement`, which doesn't
      // exist in a Worker — build ImageData manually instead. flatMat is
      // RGBA after warpPerspective, matching ImageData's format exactly.
      const rgbaData = new Uint8ClampedArray(flatMat.data);
      const flatImageData = new ImageData(rgbaData, outputW, outputH);
      const offCanvas = new OffscreenCanvas(outputW, outputH);
      const offCtx = offCanvas.getContext('2d');
      offCtx.putImageData(flatImageData, 0, 0);
      const flatBitmap = offCanvas.transferToImageBitmap();

      srcMat.delete();
      flatMat.delete();

      self.postMessage({ type: 'warp-result', flatBitmap, skewAngle }, [flatBitmap]);
    } catch (err) {
      self.postMessage({ type: 'error', message: 'Warp failed: ' + err.message });
    }
    return;
  }
};

// --- CV pipeline (self-contained — classic workers can't use ES imports) ---

function detectDocumentCorners(cv, srcMat) {
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

    const imageArea = srcMat.rows * srcMat.cols;
    const minAreaThreshold = imageArea * 0.15;
    const count = contours.size();

    for (let i = 0; i < count; i++) {
      const cnt = contours.get(i);
      const rect = cv.boundingRect(cnt);
      const roughArea = rect.width * rect.height;

      if (roughArea < minAreaThreshold) {
        cnt.delete();
        continue;
      }

      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.02 * peri, true);

      if (approx.rows === 4) {
        const area = cv.contourArea(approx);
        if (area > maxArea && area > minAreaThreshold) {
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
      points.push({ x: bestApprox.data32S[i * 2], y: bestApprox.data32S[i * 2 + 1] });
    }
    bestApprox.delete();

    return {
      corners: orderPoints(points),
      confidence: Math.min(0.99, maxArea / imageArea),
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

function orderPoints(pts) {
  const bySum = [...pts].sort((a, b) => a.x + a.y - (b.x + b.y));
  const tl = bySum[0];
  const br = bySum[3];
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  const tr = byDiff[0];
  const bl = byDiff[3];
  return [tl, tr, br, bl];
}

function computeSkewAngle(corners) {
  const [tl, tr] = corners;
  const dx = tr.x - tl.x;
  const dy = tr.y - tl.y;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

function warpToFlat(cv, srcMat, corners, outputWidth, outputHeight) {
  const [tl, tr, br, bl] = corners;

  const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
  ]);
  const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0, outputWidth, 0, outputWidth, outputHeight, 0, outputHeight,
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
