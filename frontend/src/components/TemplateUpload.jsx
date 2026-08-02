import { useCallback, useEffect, useRef, useState } from 'react';
import './TemplateUpload.css';

const STAGES = ['UPLOADING', 'DETECTING', 'ALIGNING', 'DONE'];

export default function TemplateUpload() {
  const [stage, setStage] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [log, setLog] = useState([]);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [flatSrc, setFlatSrc] = useState(null);
  const [overlayCorners, setOverlayCorners] = useState(null);
  const [previewDims, setPreviewDims] = useState({ w: 0, h: 0 });

  const fileInputRef = useRef(null);
  const workerRef = useRef(null);
  const fileMetaRef = useRef(null); // holds filename/size/dims between async steps

  // Worker is created once and reused across uploads — avoids re-downloading
  // and re-initializing the OpenCV WASM runtime every time.
  useEffect(() => {
    workerRef.current = new Worker(
      new URL('../lib/opencv.worker.js', import.meta.url),
      { type: 'classic' }
    );
    return () => workerRef.current?.terminate();
  }, []);

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

      const MAX_DIM = 1000; // capped lower than before — keeps the worker fast on any image
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const workW = Math.round(img.width * scale);
      const workH = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = workW;
      canvas.height = workH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, workW, workH);
      const imageData = ctx.getImageData(0, 0, workW, workH);

      setPreviewDims({ w: workW, h: workH });
      fileMetaRef.current = {
        filename: file.name,
        dimensions: `${img.width} × ${img.height} px`,
        fileSize: formatBytes(file.size),
      };

      pushLog('Edge detection pass');
      setProgress(35);

      // Transfer the pixel buffer to the worker (zero-copy) instead of cloning it.
      workerRef.current.postMessage(
        { type: 'process', buffer: imageData.data.buffer, width: workW, height: workH },
        [imageData.data.buffer]
      );
    } catch (err) {
      console.error(err);
      setError('Something went wrong reading this image. Please try again.');
      setStage(null);
    }
  }, []);

  // Wire up worker responses once, outside handleFile, so we don't attach
  // duplicate listeners on every upload.
  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;

    const onMessage = (e) => {
      const msg = e.data;

      if (msg.type === 'stage') {
        if (msg.stage === 'DETECTING') {
          setStage('DETECTING');
          setProgress(50);
          pushLog('Corner localization');
        } else if (msg.stage === 'ALIGNING') {
          setStage('ALIGNING');
          setProgress(75);
          pushLog('Perspective warp');
        }
        return;
      }

      if (msg.type === 'error') {
        setError(msg.message);
        setStage(null);
        return;
      }

      if (msg.type === 'result') {
        setOverlayCorners(msg.corners);

        const outCanvas = document.createElement('canvas');
        outCanvas.width = msg.flatBitmap.width;
        outCanvas.height = msg.flatBitmap.height;
        const ctx = outCanvas.getContext('2d');
        ctx.drawImage(msg.flatBitmap, 0, 0);
        setFlatSrc(outCanvas.toDataURL('image/png'));

        setMeta({
          ...fileMetaRef.current,
          skewAngle: msg.skewAngle.toFixed(1),
          cornersDetected: 4,
          confidence: (msg.confidence * 100).toFixed(1),
        });

        pushLog('Output rendered');
        setProgress(100);
        setStage('DONE');
      }
    };

    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
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

function Bracket({ x, y, size, index }) {
  const dirs = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  const [dx, dy] = dirs[index];
  return (
    <path
      d={`M ${x} ${y + size * dy} L ${x} ${y} L ${x + size * dx} ${y}`}
      className="corner-bracket"
    />
  );
}

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
