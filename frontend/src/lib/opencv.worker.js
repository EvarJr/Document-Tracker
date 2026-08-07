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

  if (type === 'preprocess') {
    const { buffer, width, height } = e.data;
    try {
      const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height);
      const srcMat = cv.matFromImageData(imageData);
      const { mat: outMat, diagnostics } = preprocessField(cv, srcMat);
      srcMat.delete();

      const outData = new Uint8ClampedArray(outMat.data);
      const outW = outMat.cols;
      const outH = outMat.rows;
      outMat.delete();

      self.postMessage(
        { type: 'preprocess-result', buffer: outData.buffer, width: outW, height: outH, diagnostics },
        [outData.buffer]
      );
    } catch (err) {
      self.postMessage({ type: 'preprocess-error', message: 'Preprocessing failed: ' + err.message });
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

// Inspects a cropped field image and applies only the corrections it
// actually needs, rather than a fixed filter chain applied to everything:
//   - small crops get upscaled (OCR needs enough pixel height per character)
//   - low-contrast/glary crops get CLAHE (local contrast enhancement)
//   - too dark/bright crops get gamma correction
//   - blurry crops get an unsharp-mask sharpen
//   - everything finishes with adaptive thresholding, which turns whatever
//     lighting conditions the photo had into a clean black-text-on-white
//     image — close to Tesseract's ideal input regardless of the source
function preprocessField(cv, srcMat) {
  const diagnostics = { corrections: [] };
  let current = new cv.Mat();
  cv.cvtColor(srcMat, current, cv.COLOR_RGBA2GRAY);

  // 1. Upscale small crops - OCR accuracy drops sharply once character
  // height falls much below ~25-30px, and a small field box often starts
  // out well under that.
  const targetMinDim = 80;
  const minDim = Math.min(current.rows, current.cols);
  if (minDim > 0 && minDim < targetMinDim) {
    const scale = targetMinDim / minDim;
    const resized = new cv.Mat();
    cv.resize(
      current, resized,
      new cv.Size(Math.round(current.cols * scale), Math.round(current.rows * scale)),
      0, 0, cv.INTER_CUBIC
    );
    current.delete();
    current = resized;
    diagnostics.corrections.push('upscaled');
  }

  // 2. Measure brightness (mean) and contrast (std deviation)
  const meanMat = new cv.Mat();
  const stdMat = new cv.Mat();
  cv.meanStdDev(current, meanMat, stdMat);
  const brightness = meanMat.data64F[0];
  const contrast = stdMat.data64F[0];
  meanMat.delete();
  stdMat.delete();
  diagnostics.brightness = Math.round(brightness);
  diagnostics.contrast = Math.round(contrast);

  // 3. Low contrast (glare, washed-out lighting) -> CLAHE. This corrects
  // contrast LOCALLY across regions rather than uniformly, which matters
  // for uneven lighting like a glary whiteboard photo.
  if (contrast < 40) {
    const clahe = new cv.CLAHE(3.0, new cv.Size(8, 8));
    const out = new cv.Mat();
    clahe.apply(current, out);
    clahe.delete();
    current.delete();
    current = out;
    diagnostics.corrections.push('contrast-enhanced');
  }

  // 4. Too dark or too bright overall -> gamma correction
  if (brightness < 90 || brightness > 200) {
    const gamma = brightness < 90 ? 0.65 : 1.4; // <1 brightens, >1 darkens
    const lut = new cv.Mat(1, 256, cv.CV_8U);
    for (let i = 0; i < 256; i++) {
      lut.data[i] = Math.min(255, Math.max(0, Math.round(Math.pow(i / 255, gamma) * 255)));
    }
    const out = new cv.Mat();
    cv.LUT(current, lut, out);
    lut.delete();
    current.delete();
    current = out;
    diagnostics.corrections.push('brightness-normalized');
  }

  // 5. Blur detection (variance of Laplacian) -> unsharp mask if blurry
  const lap = new cv.Mat();
  cv.Laplacian(current, lap, cv.CV_64F);
  const lapMean = new cv.Mat();
  const lapStd = new cv.Mat();
  cv.meanStdDev(lap, lapMean, lapStd);
  const blurScore = Math.pow(lapStd.data64F[0], 2);
  lap.delete();
  lapMean.delete();
  lapStd.delete();
  diagnostics.blurScore = Math.round(blurScore);

  if (blurScore < 100) {
    const blurred = new cv.Mat();
    cv.GaussianBlur(current, blurred, new cv.Size(0, 0), 3);
    const sharpened = new cv.Mat();
    cv.addWeighted(current, 1.5, blurred, -0.5, 0, sharpened);
    blurred.delete();
    current.delete();
    current = sharpened;
    diagnostics.corrections.push('sharpened');
  }

  // 6. Final adaptive threshold - binarizes to clean black text on white,
  // regardless of what lighting condition the crop started in.
  let blockSize = Math.min(31, (Math.min(current.rows, current.cols) - 1) | 1);
  if (blockSize < 3) blockSize = 3;
  if (blockSize % 2 === 0) blockSize -= 1;

  const thresh = new cv.Mat();
  cv.adaptiveThreshold(
    current, thresh, 255,
    cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
    blockSize, 15
  );
  current.delete();
  current = thresh;
  diagnostics.corrections.push('binarized');

  // Convert back to RGBA - what ImageData/canvas expects downstream
  const rgba = new cv.Mat();
  cv.cvtColor(current, rgba, cv.COLOR_GRAY2RGBA);
  current.delete();

  return { mat: rgba, diagnostics };
}

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
