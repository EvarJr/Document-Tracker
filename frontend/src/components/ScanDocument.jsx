import { useCallback, useEffect, useRef, useState } from 'react';
import { createWorker } from 'tesseract.js';
import { API_BASE_URL } from '../config.js';
import { authFetch, loginWithGoogle } from '../lib/auth.js';
import CornerEditor from './CornerEditor.jsx';
import './ScanDocument.css';

const FLAT_W = 1000;
const FLAT_H = Math.round(FLAT_W * 1.294); // must match backend/worker's flatten output size
const CAPTURE_STAGES = ['UPLOADING', 'DETECTING', 'REVIEW', 'ALIGNING', 'DONE'];

export default function ScanDocument({ user, authChecked }) {
  const [phase, setPhase] = useState('select'); // select | capture | ocr | review

  // --- template selection ---
  const [templates, setTemplates] = useState(null);
  const [templatesError, setTemplatesError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);

  // --- capture (upload -> detect -> correct -> flatten), same pattern as TemplateUpload ---
  const [stage, setStage] = useState(null);
  const [progress, setProgress] = useState(0);
  const [captureError, setCaptureError] = useState(null);
  const [previewSrc, setPreviewSrc] = useState(null);
  const [flatSrc, setFlatSrc] = useState(null);
  const [editableCorners, setEditableCorners] = useState(null);
  const [confidence, setConfidence] = useState(null);
  const [previewDims, setPreviewDims] = useState({ w: 0, h: 0 });

  const workerCvRef = useRef(null); // opencv.worker.js instance
  const rawBufferRef = useRef(null);

  // --- OCR ---
  const [ocrProgressText, setOcrProgressText] = useState('');
  const [results, setResults] = useState([]); // [{name, type, value, lowConfidence}]

  useEffect(() => {
    workerCvRef.current = new Worker(new URL('../lib/opencv.worker.js', import.meta.url), { type: 'classic' });
    return () => workerCvRef.current?.terminate();
  }, []);

  const loadTemplates = useCallback(async () => {
    setTemplatesError(null);
    try {
      const res = await authFetch(`${API_BASE_URL}/templates`);
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch (err) {
      console.error(err);
      setTemplatesError('Could not load templates from Drive.');
    }
  }, []);

  useEffect(() => {
    if (user) loadTemplates();
  }, [user, loadTemplates]);

  const pickTemplate = async (t) => {
    setLoadingTemplate(true);
    try {
      const res = await authFetch(`${API_BASE_URL}/templates/${t.id}`);
      if (!res.ok) throw new Error('Failed to load template content');
      const content = await res.json();
      setSelectedTemplate(content);
      setPhase('capture');
    } catch (err) {
      console.error(err);
      setTemplatesError('Could not open that template. Try again.');
    } finally {
      setLoadingTemplate(false);
    }
  };

  // --- capture handlers (mirrors TemplateUpload's pipeline) ---

  const resetCapture = () => {
    setStage(null);
    setProgress(0);
    setCaptureError(null);
    setPreviewSrc(null);
    setFlatSrc(null);
    setEditableCorners(null);
    setConfidence(null);
    rawBufferRef.current = null;
  };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    resetCapture();
    setStage('UPLOADING');
    setProgress(15);

    try {
      const dataUrl = await readFileAsDataUrl(file);
      setPreviewSrc(dataUrl);
      const img = await loadImage(dataUrl);

      const MAX_DIM = 1000;
      const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height));
      const workW = Math.round(img.width * scale);
      const workH = Math.round(img.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = workW;
      canvas.height = workH;
      canvas.getContext('2d').drawImage(img, 0, 0, workW, workH);
      const imageData = canvas.getContext('2d').getImageData(0, 0, workW, workH);

      rawBufferRef.current = imageData.data.buffer.slice(0);
      setPreviewDims({ w: workW, h: workH });

      setStage('DETECTING');
      setProgress(40);
      workerCvRef.current.postMessage(
        { type: 'detect', buffer: imageData.data.buffer, width: workW, height: workH },
        [imageData.data.buffer]
      );
    } catch (err) {
      console.error(err);
      setCaptureError('Could not read this image. Please try again.');
      setStage(null);
    }
  }, []);

  const confirmAndFlatten = useCallback(() => {
    if (!editableCorners || !rawBufferRef.current) return;
    setStage('ALIGNING');
    setProgress(80);
    const bufferCopy = rawBufferRef.current.slice(0);
    workerCvRef.current.postMessage(
      { type: 'warp', buffer: bufferCopy, width: previewDims.w, height: previewDims.h, corners: editableCorners },
      [bufferCopy]
    );
  }, [editableCorners, previewDims]);

  useEffect(() => {
    const w = workerCvRef.current;
    if (!w) return;

    const onMessage = (e) => {
      const msg = e.data;
      if (msg.type === 'error') {
        setCaptureError(msg.message);
        setStage(null);
        return;
      }
      if (msg.type === 'detect-result') {
        setConfidence(msg.confidence);
        setEditableCorners(msg.corners || defaultCorners(previewDims.w, previewDims.h));
        setStage('REVIEW');
        setProgress(55);
        return;
      }
      if (msg.type === 'warp-result') {
        const outCanvas = document.createElement('canvas');
        outCanvas.width = msg.flatBitmap.width;
        outCanvas.height = msg.flatBitmap.height;
        outCanvas.getContext('2d').drawImage(msg.flatBitmap, 0, 0);
        setFlatSrc(outCanvas.toDataURL('image/png'));
        setProgress(100);
        setStage('DONE');
      }
    };

    w.addEventListener('message', onMessage);
    return () => w.removeEventListener('message', onMessage);
  }, [previewDims]);

  // --- OCR extraction, once flattened ---

  const runOcr = useCallback(async () => {
    if (!flatSrc || !selectedTemplate) return;
    setPhase('ocr');

    const img = await loadImage(flatSrc);
    const fullCanvas = document.createElement('canvas');
    fullCanvas.width = FLAT_W;
    fullCanvas.height = FLAT_H;
    fullCanvas.getContext('2d').drawImage(img, 0, 0, FLAT_W, FLAT_H);

    const worker = await createWorker('eng');
    const collected = [];

    try {
      const fields = selectedTemplate.fields || [];
      for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        setOcrProgressText(`Reading field ${i + 1} of ${fields.length}: ${f.name}`);

        const px = Math.round(f.x * FLAT_W);
        const py = Math.round(f.y * FLAT_H);
        const pw = Math.round(f.w * FLAT_W);
        const ph = Math.round(f.h * FLAT_H);

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = pw;
        cropCanvas.height = ph;
        cropCanvas.getContext('2d').drawImage(fullCanvas, px, py, pw, ph, 0, 0, pw, ph);

        let text = '';
        let ocrConfidence = 0;
        try {
          const { data } = await worker.recognize(cropCanvas);
          text = (data.text || '').trim();
          ocrConfidence = data.confidence ?? 0;
        } catch (err) {
          console.error('OCR failed for field', f.name, err);
        }

        collected.push({
          name: f.name,
          type: f.type,
          value: text,
          lowConfidence: ocrConfidence < 60,
        });
      }
    } finally {
      await worker.terminate();
    }

    setResults(collected);
    setOcrProgressText('');
    setPhase('review');
  }, [flatSrc, selectedTemplate]);

  const updateResult = (index, value) => {
    setResults((prev) => prev.map((r, i) => (i === index ? { ...r, value } : r)));
  };

  const startOver = () => {
    setPhase('select');
    setSelectedTemplate(null);
    resetCapture();
    setResults([]);
  };

  // --- render ---

  if (!authChecked) {
    return <div className="scan-page"><p className="mono-label">CHECKING SIGN-IN STATUS...</p></div>;
  }

  if (!user) {
    return (
      <div className="scan-page">
        <div className="signin-prompt">
          <p>Sign in with Google to scan a document against your saved templates.</p>
          <button className="auth-btn primary" onClick={loginWithGoogle}>Sign in with Google</button>
        </div>
      </div>
    );
  }

  if (phase === 'select') {
    return (
      <div className="scan-page">
        <h1>Scan a document</h1>
        <p className="scan-subtitle">Choose which template this document matches.</p>

        {templatesError && <p className="scan-error">{templatesError}</p>}
        {templates === null && !templatesError && <p className="mono-label">LOADING TEMPLATES...</p>}
        {templates && templates.length === 0 && (
          <p className="scan-empty">No templates saved yet. Create one from Upload &amp; process first.</p>
        )}

        {templates && templates.length > 0 && (
          <div className="template-picker-grid">
            {templates.map((t) => (
              <button
                key={t.id}
                className="template-picker-card"
                onClick={() => pickTemplate(t)}
                disabled={loadingTemplate}
              >
                {t.name.replace(/\.json$/, '')}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (phase === 'capture') {
    return (
      <div className="scan-page">
        <div className="scan-header">
          <h1>Scan: {selectedTemplate?.name}</h1>
          {stage && <span className="mono-label stage-label">{stage}...</span>}
          <button className="back-btn" onClick={startOver}>← Choose different template</button>
        </div>

        <div
          className="scan-canvas-area"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
        >
          {!previewSrc && (
            <label className="dropzone">
              <input type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
              <p className="mono-label">DROP OR CLICK TO UPLOAD THE FILLED DOCUMENT</p>
            </label>
          )}

          {previewSrc && !flatSrc && (
            <div className="image-wrap" style={{ maxWidth: previewDims.w || 600 }}>
              <img src={previewSrc} alt="Uploaded scan" />
              {editableCorners && stage === 'REVIEW' && (
                <CornerEditor corners={editableCorners} dims={previewDims} onChange={setEditableCorners} />
              )}
            </div>
          )}

          {stage === 'REVIEW' && (
            <div className="review-controls">
              {confidence !== null && confidence < 0.5 && (
                <p className="review-warning">Low-confidence detection — drag the corners to match the page edges.</p>
              )}
              <button className="confirm-btn" onClick={confirmAndFlatten}>Confirm &amp; flatten</button>
            </div>
          )}

          {flatSrc && (
            <div className="result-wrap">
              <img src={flatSrc} alt="Flattened scan" className="flat-img" />
              <button className="confirm-btn" style={{ marginTop: 16 }} onClick={runOcr}>
                Extract fields with OCR →
              </button>
            </div>
          )}

          {captureError && <div className="scan-error">{captureError}</div>}

          {stage && (
            <div className="progress-block">
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="progress-stages">
                {CAPTURE_STAGES.map((s) => (
                  <span key={s} className={`mono-label ${CAPTURE_STAGES.indexOf(s) <= CAPTURE_STAGES.indexOf(stage) ? 'stage-active' : ''}`}>{s}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (phase === 'ocr') {
    return (
      <div className="scan-page">
        <h1>Reading fields…</h1>
        <p className="mono-label">{ocrProgressText}</p>
        <div className="ocr-spinner" />
      </div>
    );
  }

  // phase === 'review'
  return (
    <div className="scan-page">
      <div className="scan-header">
        <h1>Review extracted data</h1>
        <button className="back-btn" onClick={startOver}>← Scan another</button>
      </div>

      <div className="review-grid">
        <img src={flatSrc} alt="Scanned document" className="review-image" />

        <div className="review-fields">
          {results.map((r, i) => (
            <div key={i} className="review-row">
              <label className="mono-label review-label">
                {r.name} · {r.type}
                {r.lowConfidence && <span className="low-confidence-flag"> ⚠ low confidence</span>}
              </label>
              <input
                className={`review-input ${r.lowConfidence ? 'flagged' : ''}`}
                value={r.value}
                onChange={(e) => updateResult(i, e.target.value)}
              />
            </div>
          ))}

          <p className="scan-note">
            Excel export isn't wired up yet — that's the next piece. For now, this confirms the full scan → align → OCR → review pipeline works end to end.
          </p>
        </div>
      </div>
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
