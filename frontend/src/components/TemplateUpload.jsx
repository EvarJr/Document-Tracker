import { useCallback, useRef, useState } from 'react';
import { loadOpenCv } from '../lib/opencv-loader.js';
import { detectDocumentCorners, computeSkewAngle, warpToFlat } from '../lib/documentDetection.js';
import './TemplateUpload.css';

const STAGES = ['UPLOADING', 'DETECTING', 'ALIGNING', 'DONE'];

export default function TemplateUpload() {
  const [stage, setStage] = useState(null); // null until a file is picked
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [log, setLog] = useState([]);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [flatSrc, setFlatSrc] = useState(null);
  const [overlayCorners, setOverlayCorners] = useState(null); // scaled to preview size
  const [previewDims, setPreviewDims] = useState({ w: 0, h: 0 });

  const fileInputRef = useRef(null);

  const pushLog = (msg) => setLog((prev) => [...prev, msg]);

  const reset = () => {
    setStage(null);
    setProgress(0);
    setError(null);
    setMeta(null);
    setLog([]);
    setPreviewSrc(null);
    setFlatSrc(null);
    setOverlayCorners(null);
  };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    reset();
    setStage('UPLOADING');
    setProgress(10);
    setLog(['File received']);

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPreviewSrc(dataUrl);

      const img = await loadImage(dataUrl);
      setProgress(25);

      // Cap working resolution for performance — keeps OpenCV fast even on large phone photos.
      const MAX_DIM = 1400;
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const workW = Math.round(img.width * scale);
      const workH = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = workW;
      canvas.height = workH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, workW, workH);

      setStage('DETECTING');
      setProgress(40);
      pushLog('Edge detection pass');

      const cv = await loadOpenCv();
      const srcMat = cv.imread(canvas);

      const result = detectDocumentCorners(cv, srcMat);

      if (!result) {
        srcMat.delete();
        setError('Could not detect document edges clearly. Try a photo with more contrast between the page and background.');
        setStage(null);
        return;
      }

      pushLog('Corner localization');
      setProgress(60);

      const { corners, confidence } = result;
      const skew = computeSkewAngle(corners);

      // Scale corners to preview display size (preview is shown at natural img size via CSS, so use workW/workH ratio)
      setPreviewDims({ w: workW, h: workH });
      setOverlayCorners(corners);

      setStage('ALIGNING');
      setProgress(80);
      pushLog('Perspective warp');

      const outputW = 1000;
      const outputH = Math.round(outputW * 1.294); // roughly letter/A4 ratio
      const flatMat = warpToFlat(cv, srcMat, corners, outputW, outputH);

      const outCanvas = document.createElement('canvas');
      cv.imshow(outCanvas, flatMat);
      setFlatSrc(outCanvas.toDataURL('image/png'));

      srcMat.delete();
      flatMat.delete();

      setMeta({
        filename: file.name,
        dimensions: `${img.width} × ${img.height} px`,
        fileSize: formatBytes(file.size),
        skewAngle: skew.toFixed(1),
        cornersDetected: 4,
        confidence: (confidence * 100).toFixed(1),
      });

      pushLog('Output rendered');
      setProgress(100);
      setStage('DONE');
    } catch (err) {
      console.error(err);
      setError('Something went wrong processing this image. Please try again.');
      setStage(null);
    }
  }, []);

  const onInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <div className="upload-page">
      <div className="upload-header">
        <h1>Upload &amp; preprocess</h1>
        {stage && <span className="mono-label stage-label">{stage}...</span>}
        {stage && (
          <button className="reset-btn" onClick={reset}>RESET ×</button>
        )}
      </div>

      <div className="upload-body">
        <div
          className="canvas-area"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
        >
          {!previewSrc && (
            <label className="dropzone">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onInputChange}
                hidden
              />
              <div className="dropzone-bracket tl" />
              <div className="dropzone-bracket tr" />
              <div className="dropzone-bracket bl" />
              <div className="dropzone-bracket br" />
              <p className="mono-label">DROP OR CLICK TO UPLOAD</p>
              <p className="dropzone-hint">A photo of a blank document template</p>
            </label>
          )}

          {previewSrc && !flatSrc && (
            <div
              className="image-wrap"
              style={{ maxWidth: previewDims.w || 600 }}
            >
              <img src={previewSrc} alt="Uploaded document" />
              {overlayCorners && (
                <CornerOverlay corners={overlayCorners} dims={previewDims} />
              )}
            </div>
          )}

          {flatSrc && (
            <div className="result-wrap">
              <div className="result-label mono-label">FLATTENED OUTPUT</div>
              <img src={flatSrc} alt="Flattened document" className="flat-img" />
            </div>
          )}

          {error && <div className="error-banner">{error}</div>}

          {stage && (
            <div className="progress-block">
              <div className="progress-row">
                <span className="mono-label progress-status">{stage}...</span>
                <span className="mono-label">{progress}%</span>
              </div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="progress-stages">
                {STAGES.map((s) => (
                  <span
                    key={s}
                    className={`mono-label ${STAGES.indexOf(s) <= STAGES.indexOf(stage) ? 'stage-active' : ''}`}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="meta-panel">
          <p className="mono-label panel-title">FILE METADATA</p>

          {!meta && <p className="meta-empty">Upload a document to see analysis here.</p>}

          {meta && (
            <>
              <MetaRow label="FILENAME" value={meta.filename} />
              <MetaRow label="DIMENSIONS" value={meta.dimensions} />
              <MetaRow label="FILE SIZE" value={meta.fileSize} />

              <p className="mono-label panel-title" style={{ marginTop: 24 }}>ANALYSIS</p>
              <MetaRow label="SKEW ANGLE" value={`${meta.skewAngle}°`} accent="red" />
              <MetaRow label="CORNERS DETECTED" value={`${meta.cornersDetected} corners`} accent="blue" />
              <MetaRow label="CONFIDENCE" value={`${meta.confidence}%`} accent="green" />

              <p className="mono-label panel-title" style={{ marginTop: 24 }}>PROCESS LOG</p>
              <ul className="process-log">
                {log.map((entry, i) => (
                  <li key={i}>✓ {entry}</li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function MetaRow({ label, value, accent }) {
  return (
    <div className="meta-row">
      <p className="mono-label">{label}</p>
      <p className={`meta-value ${accent ? `accent-${accent}` : ''}`}>{value}</p>
    </div>
  );
}

function CornerOverlay({ corners, dims }) {
  // corners are in working-canvas pixel space; dims.w/h match that same space,
  // and the <img> is displayed at that same natural size via CSS, so coordinates map 1:1.
  const bracketSize = 24;
  return (
    <svg
      className="corner-overlay"
      viewBox={`0 0 ${dims.w} ${dims.h}`}
      preserveAspectRatio="none"
    >
      {corners.map((pt, i) => (
        <Bracket key={i} x={pt.x} y={pt.y} size={bracketSize} index={i} />
      ))}
      <polygon
        points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
        className="corner-polygon"
      />
    </svg>
  );
}

// Draws an L-shaped bracket oriented toward the inside of the quad for each corner (0=TL,1=TR,2=BR,3=BL)
function Bracket({ x, y, size, index }) {
  const dirs = [
    [1, 1],   // top-left: arms go right and down
    [-1, 1],  // top-right: arms go left and down
    [-1, -1], // bottom-right: arms go left and up
    [1, -1],  // bottom-left: arms go right and up
  ];
  const [dx, dy] = dirs[index];
  return (
    <path
      d={`M ${x} ${y + size * dy} L ${x} ${y} L ${x + size * dx} ${y}`}
      className="corner-bracket"
    />
  );
}

// --- helpers ---

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
