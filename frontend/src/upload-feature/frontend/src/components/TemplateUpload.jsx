import { useCallback, useEffect, useRef, useState } from 'react';
import CornerEditor from './CornerEditor.jsx';
import FieldBoxEditor from './FieldBoxEditor.jsx';
import './TemplateUpload.css';

const STAGES = ['UPLOADING', 'DETECTING', 'REVIEW', 'ALIGNING', 'DONE'];
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export default function TemplateUpload() {
  const [stage, setStage] = useState(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState(null);
  const [log, setLog] = useState([]);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [flatSrc, setFlatSrc] = useState(null);
  const [editableCorners, setEditableCorners] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [previewDims, setPreviewDims] = useState({ w: 0, h: 0 });
  const [showFieldEditor, setShowFieldEditor] = useState(false);

  const fileInputRef = useRef(null);
  const workerRef = useRef(null);
  const fileMetaRef = useRef(null);
  const rawBufferRef = useRef(null); // kept copy of pixel data, since transferred buffers get detached

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
    setEditableCorners(null);
    setConfidence(null);
    rawBufferRef.current = null;
    setShowFieldEditor(false);
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

      const MAX_DIM = 1000;
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const workW = Math.round(img.width * scale);
      const workH = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = workW;
      canvas.height = workH;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, workW, workH);
      const imageData = ctx.getImageData(0, 0, workW, workH);

      // Keep our own copy — the buffer we send to the worker gets transferred
      // (detached) and we need pixel data again later for the warp step.
      rawBufferRef.current = imageData.data.buffer.slice(0);

      setPreviewDims({ w: workW, h: workH });
      fileMetaRef.current = {
        filename: file.name,
        dimensions: `${img.width} × ${img.height} px`,
        fileSize: formatBytes(file.size),
      };

      pushLog('Edge detection pass');
      setProgress(35);
      setStage('DETECTING');

      workerRef.current.postMessage(
        { type: 'detect', buffer: imageData.data.buffer, width: workW, height: workH },
        [imageData.data.buffer]
      );
    } catch (err) {
      console.error(err);
      setError('Something went wrong reading this image. Please try again.');
      setStage(null);
    }
  }, []);

  const confirmAndFlatten = useCallback(() => {
    if (!editableCorners || !rawBufferRef.current) return;

    setStage('ALIGNING');
    setProgress(80);
    pushLog('Perspective warp');

    // Send a fresh copy so our kept reference stays intact in case this needs retrying.
    const bufferCopy = rawBufferRef.current.slice(0);
    workerRef.current.postMessage(
      {
        type: 'warp',
        buffer: bufferCopy,
        width: previewDims.w,
        height: previewDims.h,
        corners: editableCorners,
      },
      [bufferCopy]
    );
  }, [editableCorners, previewDims]);

  useEffect(() => {
    const worker = workerRef.current;
    if (!worker) return;

    const onMessage = (e) => {
      const msg = e.data;

      if (msg.type === 'error') {
        setError(msg.message);
        setStage(null);
        return;
      }

      if (msg.type === 'detect-result') {
        pushLog('Corner localization' + (msg.corners ? '' : ' — no confident match, defaulted to full-page bounds'));
        setConfidence(msg.confidence);

        const corners = msg.corners || defaultCorners(previewDims.w, previewDims.h);
        setEditableCorners(corners);
        setStage('REVIEW');
        setProgress(55);
        return;
      }

      if (msg.type === 'warp-result') {
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
          confidence: ((confidence ?? 0) * 100).toFixed(1),
        });

        pushLog('Output rendered');
        setProgress(100);
        setStage('DONE');
      }
    };

    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewDims, confidence]);

  const onInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  if (showFieldEditor && flatSrc) {
    const suggestedName = fileMetaRef.current?.filename
      ? fileMetaRef.current.filename.replace(/\.[^/.]+$/, '')
      : '';
    return (
      <FieldBoxEditor
        imageSrc={flatSrc}
        initialTemplateName={suggestedName}
        onBack={() => setShowFieldEditor(false)}
      />
    );
  }

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
            <div className="image-wrap" style={{ maxWidth: previewDims.w || 600 }}>
              <img src={previewSrc} alt="Uploaded document" />
              {editableCorners && stage === 'REVIEW' && (
                <CornerEditor
                  corners={editableCorners}
                  dims={previewDims}
                  onChange={setEditableCorners}
                />
              )}
            </div>
          )}

          {stage === 'REVIEW' && (
            <div className="review-controls">
              {confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD && (
                <p className="review-warning">
                  Auto-detection wasn't confident about the page edges — drag the corner handles to match the actual document before continuing.
                </p>
              )}
              {confidence !== null && confidence >= LOW_CONFIDENCE_THRESHOLD && (
                <p className="review-hint">Drag any corner to fine-tune, then confirm.</p>
              )}
              <button className="confirm-btn" onClick={confirmAndFlatten}>
                Confirm &amp; flatten
              </button>
            </div>
          )}

          {flatSrc && (
            <div className="result-wrap">
              <div className="result-label mono-label">FLATTENED OUTPUT</div>
              <img src={flatSrc} alt="Flattened document" className="flat-img" />
              <button className="confirm-btn" style={{ marginTop: 16 }} onClick={() => setShowFieldEditor(true)}>
                Continue to field editor →
              </button>
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

          {!meta && !fileMetaRef.current && (
            <p className="meta-empty">Upload a document to see analysis here.</p>
          )}

          {fileMetaRef.current && (
            <>
              <MetaRow label="FILENAME" value={fileMetaRef.current.filename} />
              <MetaRow label="DIMENSIONS" value={fileMetaRef.current.dimensions} />
              <MetaRow label="FILE SIZE" value={fileMetaRef.current.fileSize} />
            </>
          )}

          {confidence !== null && !meta && (
            <>
              <p className="mono-label panel-title" style={{ marginTop: 24 }}>ANALYSIS</p>
              <MetaRow
                label="AUTO-DETECT CONFIDENCE"
                value={`${(confidence * 100).toFixed(1)}%`}
                accent={confidence < LOW_CONFIDENCE_THRESHOLD ? 'red' : 'green'}
              />
            </>
          )}

          {meta && (
            <>
              <p className="mono-label panel-title" style={{ marginTop: 24 }}>ANALYSIS</p>
              <MetaRow label="SKEW ANGLE" value={`${meta.skewAngle}°`} accent="red" />
              <MetaRow label="CORNERS DETECTED" value={`${meta.cornersDetected} corners`} accent="blue" />
              <MetaRow label="CONFIDENCE" value={`${meta.confidence}%`} accent="green" />
            </>
          )}

          {log.length > 0 && (
            <>
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

function defaultCorners(w, h) {
  const margin = 0.05;
  return [
    { x: w * margin, y: h * margin },
    { x: w * (1 - margin), y: h * margin },
    { x: w * (1 - margin), y: h * (1 - margin) },
    { x: w * margin, y: h * (1 - margin) },
  ];
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
