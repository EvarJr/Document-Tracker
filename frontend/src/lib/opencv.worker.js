// Classic (non-module) Web Worker. Runs OpenCV.js entirely off the main
// thread — this is what actually prevents the "Page Unresponsive" freeze,
// independent of how well-optimized the detection code is. Even a
// worst-case image can only ever block this worker thread, never the UI.

self.importScripts('https://docs.opencv.org/4.9.0/opencv.js');

const cvReady = new Promise((resolve) => {
  if (self.cv && self.cv.Mat) {
    resolve();
  } else {
    self.cv['onRuntimeInitialized'] = () => resolve();
  }
});

self.onmessage = async (e) => {
  if (e.data.type !== 'process') return;

  await cvReady;
  const cv = self.cv;
  const { buffer, width, height } = e.data;

  try {
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const srcMat = cv.matFromImageData(imageData);

    self.postMessage({ type: 'stage', stage: 'DETECTING' });
    const result = detectDocumentCorners(cv, srcMat);

    if (!result) {
      srcMat.delete();
      self.postMessage({
        type: 'error',
        message: 'Could not detect document edges clearly. Try a photo with more contrast between the page and background.',
      });
      return;
    }

    const { corners, confidence } = result;
    const skewAngle = computeSkewAngle(corners);

    self.postMessage({ type: 'stage', stage: 'ALIGNING' });

    const outputW = 1000;
    const outputH = Math.round(outputW * 1.294);
    const flatMat = warpToFlat(cv, srcMat, corners, outputW, outputH);

    // cv.imshow() checks `instanceof HTMLCanvasElement` internally, and that
    // global doesn't exist at all inside a Worker (not just falsy — genuinely
    // undefined), so referencing it throws a ReferenceError. We avoid calling
    // cv.imshow() entirely and build ImageData ourselves instead. flatMat is
    // RGBA (4 channels) after warpPerspective, which matches ImageData's
    // format exactly, so this is just a direct buffer copy.
    const rgbaData = new Uint8ClampedArray(flatMat.data);
    const flatImageData = new ImageData(rgbaData, outputW, outputH);

    const offCanvas = new OffscreenCanvas(outputW, outputH);
    const offCtx = offCanvas.getContext('2d');
    offCtx.putImageData(flatImageData, 0, 0);
    const flatBitmap = offCanvas.transferToImageBitmap();

    srcMat.delete();
    flatMat.delete();

    self.postMessage(
      {
        type: 'result',
        corners,
        confidence,
        skewAngle,
        flatBitmap,
        workW: width,
        workH: height,
      },
      [flatBitmap]
    );
  } catch (err) {
    self.postMessage({ type: 'error', message: 'Processing failed: ' + err.message });
  }
};

// --- CV pipeline (duplicated from documentDetection.js — classic workers
// can't use ES module imports, so this is intentionally self-contained) ---

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