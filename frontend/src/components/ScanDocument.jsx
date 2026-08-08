import { useCallback, useEffect, useRef, useState } from 'react';
import { createWorker } from 'tesseract.js';
import { API_BASE_URL } from '../config.js';
import { authFetch, loginWithGoogle } from '../lib/auth.js';
import CornerEditor from './CornerEditor.jsx';
import AlignmentOffsetEditor from './AlignmentOffsetEditor.jsx';
import { buildNewWorkbook, appendRowToWorkbook, findConflictingMapping, parseCellRef, toCellRef } from '../lib/excelExport.js';
import './ScanDocument.css';

const FLAT_W = 1000;
const FLAT_H = Math.round(FLAT_W * 1.294); // must match backend/worker's flatten output size

function newBatchItem(id, file) {
  return {
    id,
    file,
    previewSrc: null,
    previewDims: { w: 0, h: 0 },
    stage: null, // UPLOADING | DETECTING | REVIEW_CORNERS | ALIGNING_WARP | ALIGN_FIELDS | DONE
    error: null,
    editableCorners: null,
    confidence: null,
    flatSrc: null,
    alignOffset: { dx: 0, dy: 0 },
  };
}

export default function ScanDocument({ user, authChecked }) {
  const [phase, setPhase] = useState('select'); // select | prep | ocr | review

  // --- template selection ---
  const [templates, setTemplates] = useState(null);
  const [templatesError, setTemplatesError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState(null);
  const [loadingTemplate, setLoadingTemplate] = useState(false);

  // --- batch prep (per-image: upload -> detect -> correct corners -> flatten -> align offset) ---
  const [batch, setBatch] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  // --- OCR + review ---
  const [ocrProgressText, setOcrProgressText] = useState('');
  const [allResults, setAllResults] = useState([]); // parallel array to batch
  const [reviewIndex, setReviewIndex] = useState(0);

  // --- export (Excel) ---
  const [exportMapping, setExportMapping] = useState(null); // null = not checked yet / none exists
  const [mappingChecked, setMappingChecked] = useState(false);
  const [exportSetupMode, setExportSetupMode] = useState(null); // null | 'new' | 'existing'
  const [existingFiles, setExistingFiles] = useState(null);
  const [existingFileChoice, setExistingFileChoice] = useState(''); // Drive file id, or '' for "upload new"
  const [startCellInput, setStartCellInput] = useState('A1');
  const [uploadFileForExport, setUploadFileForExport] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [addedDocs, setAddedDocs] = useState({}); // reviewIndex -> true, once added to Excel

  const workerCvRef = useRef(null);
  const rawBuffersRef = useRef({}); // id -> ArrayBuffer copy (kept off React state - large binary data)
  const awaitingIndexRef = useRef(null); // which batch index the worker's next response belongs to

  useEffect(() => {
    workerCvRef.current = new Worker(new URL('../lib/opencv.worker.js', import.meta.url), { type: 'classic' });
    return () => workerCvRef.current?.terminate();
  }, []);

  const patchItem = (index, patch) => {
    setBatch((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

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
      setSelectedTemplateId(t.id);
      setPhase('prep');
      setBatch([]);
    } catch (err) {
      console.error(err);
      setTemplatesError('Could not open that template. Try again.');
    } finally {
      setLoadingTemplate(false);
    }
  };

  // --- per-item processing (mirrors TemplateUpload's detect/warp pipeline) ---

  const processItem = useCallback(async (index, item) => {
    patchItem(index, { stage: 'UPLOADING', error: null });

    try {
      const dataUrl = await readFileAsDataUrl(item.file);
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

      rawBuffersRef.current[item.id] = imageData.data.buffer.slice(0);

      patchItem(index, { previewSrc: dataUrl, previewDims: { w: workW, h: workH }, stage: 'DETECTING' });

      awaitingIndexRef.current = index;
      workerCvRef.current.postMessage(
        { type: 'detect', buffer: imageData.data.buffer, width: workW, height: workH },
        [imageData.data.buffer]
      );
    } catch (err) {
      console.error(err);
      patchItem(index, { error: 'Could not read this image. Please try again.', stage: null });
    }
  }, []);

  const onFilesChosen = (files) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    const items = fileArray.map((f, i) => newBatchItem(`${Date.now()}_${i}`, f));
    setBatch(items);
    setCurrentIndex(0);
    // item is passed directly (not read back from state), so there's no
    // risk of this seeing a stale/empty `batch` from before setBatch above
    // has actually applied.
    processItem(0, items[0]);
  };

  const confirmCorners = (index) => {
    const item = batch[index];
    if (!item?.editableCorners) return;

    patchItem(index, { stage: 'ALIGNING_WARP' });
    const buffer = rawBuffersRef.current[item.id];
    const bufferCopy = buffer.slice(0);
    awaitingIndexRef.current = index;
    workerCvRef.current.postMessage(
      {
        type: 'warp',
        buffer: bufferCopy,
        width: item.previewDims.w,
        height: item.previewDims.h,
        corners: item.editableCorners,
      },
      [bufferCopy]
    );
  };

  const confirmAlignment = (index) => {
    patchItem(index, { stage: 'DONE' });
    const nextIndex = index + 1;
    if (nextIndex < batch.length) {
      setCurrentIndex(nextIndex);
      processItem(nextIndex, batch[nextIndex]);
    } else {
      setPhase('ocr');
    }
  };

  useEffect(() => {
    const w = workerCvRef.current;
    if (!w) return;

    const onMessage = (e) => {
      const msg = e.data;
      const index = awaitingIndexRef.current;
      if (index === null) return;

      if (msg.type === 'error') {
        patchItem(index, { error: msg.message, stage: null });
        return;
      }
      if (msg.type === 'detect-result') {
        const item = batch[index];
        const dims = item?.previewDims || { w: 0, h: 0 };
        patchItem(index, {
          confidence: msg.confidence,
          editableCorners: msg.corners || defaultCorners(dims.w, dims.h),
          stage: 'REVIEW_CORNERS',
        });
        return;
      }
      if (msg.type === 'warp-result') {
        const outCanvas = document.createElement('canvas');
        outCanvas.width = msg.flatBitmap.width;
        outCanvas.height = msg.flatBitmap.height;
        outCanvas.getContext('2d').drawImage(msg.flatBitmap, 0, 0);
        patchItem(index, { flatSrc: outCanvas.toDataURL('image/png'), stage: 'ALIGN_FIELDS' });
      }
    };

    w.addEventListener('message', onMessage);
    return () => w.removeEventListener('message', onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch]);

  // --- batch OCR, once every item has confirmed corners + alignment ---

  const runBatchOcr = useCallback(async () => {
    const worker = await createWorker('eng');
    const results = [];

    try {
      for (let docIndex = 0; docIndex < batch.length; docIndex++) {
        const item = batch[docIndex];
        const img = await loadImage(item.flatSrc);
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = FLAT_W;
        fullCanvas.height = FLAT_H;
        fullCanvas.getContext('2d').drawImage(img, 0, 0, FLAT_W, FLAT_H);

        const fields = selectedTemplate.fields || [];
        const docResults = [];

        for (let i = 0; i < fields.length; i++) {
          const f = fields[i];
          setOcrProgressText(
            `Document ${docIndex + 1} of ${batch.length} — field ${i + 1} of ${fields.length}: ${f.name}`
          );

          const px = clampInt(f.x * FLAT_W + item.alignOffset.dx, 0, FLAT_W - 1);
          const py = clampInt(f.y * FLAT_H + item.alignOffset.dy, 0, FLAT_H - 1);
          const pw = Math.max(1, Math.min(Math.round(f.w * FLAT_W), FLAT_W - px));
          const ph = Math.max(1, Math.min(Math.round(f.h * FLAT_H), FLAT_H - py));

          const cropCanvas = document.createElement('canvas');
          cropCanvas.width = pw;
          cropCanvas.height = ph;
          cropCanvas.getContext('2d').drawImage(fullCanvas, px, py, pw, ph, 0, 0, pw, ph);

          let ocrCanvas = cropCanvas;
          let diagnostics = null;
          try {
            const cropData = cropCanvas.getContext('2d').getImageData(0, 0, pw, ph);
            const pre = await requestPreprocess(workerCvRef.current, cropData.data.buffer, pw, ph);
            diagnostics = pre.diagnostics;
            const preCanvas = document.createElement('canvas');
            preCanvas.width = pre.width;
            preCanvas.height = pre.height;
            preCanvas.getContext('2d').putImageData(
              new ImageData(new Uint8ClampedArray(pre.buffer), pre.width, pre.height),
              0, 0
            );
            ocrCanvas = preCanvas;
          } catch (err) {
            console.error('Preprocessing failed for field', f.name, err);
          }

          let text = '';
          let ocrConfidence = 0;
          try {
            const { data } = await worker.recognize(ocrCanvas);
            text = (data.text || '').trim();
            ocrConfidence = data.confidence ?? 0;
          } catch (err) {
            console.error('OCR failed for field', f.name, err);
          }

          docResults.push({ name: f.name, type: f.type, value: text, lowConfidence: ocrConfidence < 60, diagnostics });
        }

        results.push(docResults);
      }
    } finally {
      await worker.terminate();
    }

    setAllResults(results);
    setOcrProgressText('');
    setReviewIndex(0);
    setPhase('review');
  }, [batch, selectedTemplate]);

  useEffect(() => {
    if (phase === 'ocr') runBatchOcr();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const updateResult = (docIndex, fieldIndex, value) => {
    setAllResults((prev) =>
      prev.map((doc, di) => (di === docIndex ? doc.map((r, fi) => (fi === fieldIndex ? { ...r, value } : r)) : doc))
    );
  };

  // --- export (Excel) ---

  useEffect(() => {
    if (phase !== 'review' || !selectedTemplateId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`);
        if (cancelled) return;
        if (res.ok) {
          const mapping = await res.json();
          setExportMapping(mapping);
        } else {
          setExportMapping(null);
        }
      } catch (err) {
        console.error(err);
        setExportMapping(null);
      } finally {
        if (!cancelled) setMappingChecked(true);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, selectedTemplateId]);

  const fieldOrder = (selectedTemplate?.fields || []).map((f) => f.name);

  const valuesForDoc = (docIndex) => {
    const doc = allResults[docIndex] || [];
    return Object.fromEntries(doc.map((r) => [r.name, r.value]));
  };

  const loadExistingFilesList = async () => {
    setExportBusy(true);
    setExportError(null);
    try {
      const res = await authFetch(`${API_BASE_URL}/exports`);
      if (!res.ok) throw new Error('Could not list existing Excel files.');
      const data = await res.json();
      setExistingFiles(data.exports || []);
    } catch (err) {
      console.error(err);
      setExportError('Could not load your existing Excel files.');
    } finally {
      setExportBusy(false);
    }
  };

  const createNewExportFile = async (docIndex) => {
    setExportBusy(true);
    setExportError(null);
    try {
      const { arrayBuffer, mapping } = buildNewWorkbook(fieldOrder, valuesForDoc(docIndex));
      const filename = `${(selectedTemplate.name || 'export').replace(/[^\w\-]+/g, '_')}.xlsx`;

      const form = new FormData();
      form.append('file', new Blob([arrayBuffer], { type: 'application/octet-stream' }), filename);
      form.append('filename', filename);

      const uploadRes = await authFetch(`${API_BASE_URL}/exports`, { method: 'POST', body: form });
      if (!uploadRes.ok) throw new Error('Failed to upload the new Excel file to Drive.');
      const uploaded = await uploadRes.json();

      const fullMapping = { ...mapping, templateId: selectedTemplateId, workbookFileId: uploaded.id };

      const mapRes = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fullMapping),
      });
      if (!mapRes.ok) throw new Error('Created the file, but failed to save the export mapping.');

      setExportMapping(fullMapping);
      setExportSetupMode(null);
      setAddedDocs((prev) => ({ ...prev, [docIndex]: true }));
    } catch (err) {
      console.error(err);
      setExportError(err.message || 'Could not create the Excel file.');
    } finally {
      setExportBusy(false);
    }
  };

  const useExistingExportFile = async (docIndex) => {
    setExportBusy(true);
    setExportError(null);
    try {
      let fileId = existingFileChoice;
      let downloadedBytes = null;

      if (!fileId && uploadFileForExport) {
        const form = new FormData();
        form.append('file', uploadFileForExport, uploadFileForExport.name);
        form.append('filename', uploadFileForExport.name);
        const uploadRes = await authFetch(`${API_BASE_URL}/exports`, { method: 'POST', body: form });
        if (!uploadRes.ok) throw new Error('Failed to upload that file to Drive.');
        const uploaded = await uploadRes.json();
        fileId = uploaded.id;
        downloadedBytes = await uploadFileForExport.arrayBuffer();
      }

      if (!fileId) throw new Error('Choose an existing file or upload one first.');

      let startCell;
      try {
        // Validate the cell reference is well-formed before going further
        // (parseCellRef throws on anything malformed, e.g. "5C" or "C").
        const p = parseCellRef(startCellInput);
        startCell = toCellRef(p.col, p.row);
      } catch {
        throw new Error(`"${startCellInput}" isn't a valid cell reference (try something like C4).`);
      }

      const proposedMapping = {
        templateId: selectedTemplateId,
        workbookFileId: fileId,
        sheetName: 'Sheet1',
        startCell,
        fieldOrder,
        nextRow: parseCellRef(startCell).row + 1,
      };

      const allMappingsRes = await authFetch(`${API_BASE_URL}/export-mappings`);
      const allMappingsData = allMappingsRes.ok ? await allMappingsRes.json() : { mappings: [] };
      const conflict = findConflictingMapping(proposedMapping, allMappingsData.mappings || [], selectedTemplateId);
      if (conflict) {
        throw new Error(
          `That range overlaps with "${conflict.templateId}"'s data in this file. Pick a different start cell.`
        );
      }

      if (!downloadedBytes) {
        const fileRes = await authFetch(`${API_BASE_URL}/exports/${fileId}`);
        if (!fileRes.ok) throw new Error('Could not read the existing file from Drive.');
        downloadedBytes = await fileRes.arrayBuffer();
      }

      const { arrayBuffer, updatedMapping } = appendRowToWorkbook(downloadedBytes, proposedMapping, valuesForDoc(docIndex));

      const putRes = await authFetch(`${API_BASE_URL}/exports/${fileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: arrayBuffer,
      });
      if (!putRes.ok) throw new Error('Failed to save the updated file back to Drive.');

      const mapRes = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedMapping),
      });
      if (!mapRes.ok) throw new Error('Saved the file, but failed to save the export mapping.');

      setExportMapping(updatedMapping);
      setExportSetupMode(null);
      setAddedDocs((prev) => ({ ...prev, [docIndex]: true }));
    } catch (err) {
      console.error(err);
      setExportError(err.message || 'Could not save to that Excel file.');
    } finally {
      setExportBusy(false);
    }
  };

  const confirmAddToExcel = async (docIndex) => {
    if (!exportMapping) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const fileRes = await authFetch(`${API_BASE_URL}/exports/${exportMapping.workbookFileId}`);
      if (!fileRes.ok) throw new Error('Could not read the Excel file from Drive.');
      const bytes = await fileRes.arrayBuffer();

      const { arrayBuffer, updatedMapping } = appendRowToWorkbook(bytes, exportMapping, valuesForDoc(docIndex));

      const putRes = await authFetch(`${API_BASE_URL}/exports/${exportMapping.workbookFileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: arrayBuffer,
      });
      if (!putRes.ok) throw new Error('Failed to save the updated file back to Drive.');

      const mapRes = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedMapping),
      });
      if (!mapRes.ok) throw new Error('Saved the row, but failed to update the export mapping.');

      setExportMapping(updatedMapping);
      setAddedDocs((prev) => ({ ...prev, [docIndex]: true }));
    } catch (err) {
      console.error(err);
      setExportError(err.message || 'Could not add this record to Excel.');
    } finally {
      setExportBusy(false);
    }
  };

  const downloadCurrentExport = async () => {
    if (!exportMapping) return;
    try {
      const res = await authFetch(`${API_BASE_URL}/exports/${exportMapping.workbookFileId}`);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(selectedTemplate?.name || 'export').replace(/[^\w\-]+/g, '_')}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setExportError('Could not download the file.');
    }
  };

  const scanMoreWithTemplate = () => {
    setBatch([]);
    setCurrentIndex(0);
    setAllResults([]);
    setReviewIndex(0);
    setAddedDocs({});
    setExportSetupMode(null);
    setExportError(null);
    setPhase('prep');
  };

  const startOver = () => {
    setSelectedTemplate(null);
    setSelectedTemplateId(null);
    setBatch([]);
    setCurrentIndex(0);
    setAllResults([]);
    setReviewIndex(0);
    setExportMapping(null);
    setMappingChecked(false);
    setExportSetupMode(null);
    setExistingFiles(null);
    setExistingFileChoice('');
    setStartCellInput('A1');
    setUploadFileForExport(null);
    setExportError(null);
    setAddedDocs({});
    setPhase('select');
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
              <button key={t.id} className="template-picker-card" onClick={() => pickTemplate(t)} disabled={loadingTemplate}>
                {t.name.replace(/\.json$/, '')}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (phase === 'prep') {
    if (batch.length === 0) {
      return (
        <div className="scan-page">
          <div className="scan-header">
            <h1>Scan: {selectedTemplate?.name}</h1>
            <button className="back-btn" onClick={startOver}>← Choose different template</button>
          </div>
          <div className="scan-canvas-area">
            <label className="dropzone">
              <input
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => e.target.files && onFilesChosen(e.target.files)}
              />
              <div className="dropzone-text">
                <p className="mono-label">DROP OR CLICK TO UPLOAD ONE OR MORE FILLED DOCUMENTS</p>
                <p className="scan-subtitle">You can select multiple photos at once — each gets aligned before scanning.</p>
              </div>
            </label>
          </div>
        </div>
      );
    }

    const item = batch[currentIndex];
    const total = batch.length;

    return (
      <div className="scan-page">
        <div className="scan-header">
          <h1>Document {currentIndex + 1} of {total}</h1>
          {item.stage && <span className="mono-label stage-label">{item.stage.replace(/_/g, ' ')}...</span>}
          <button className="back-btn" onClick={startOver}>← Choose different template</button>
        </div>

        <p className="scan-subtitle">
          Correct edges and alignment for every document before scanning begins — document {currentIndex + 1} of {total}.
        </p>

        <div className="scan-canvas-area">
          {item.previewSrc && (item.stage === 'DETECTING' || item.stage === 'REVIEW_CORNERS') && (
            <div className="image-wrap" style={{ maxWidth: item.previewDims.w || 600 }}>
              <img src={item.previewSrc} alt="Uploaded scan" />
              {item.editableCorners && item.stage === 'REVIEW_CORNERS' && (
                <CornerEditor
                  corners={item.editableCorners}
                  dims={item.previewDims}
                  onChange={(corners) => patchItem(currentIndex, { editableCorners: corners })}
                />
              )}
            </div>
          )}

          {item.stage === 'REVIEW_CORNERS' && (
            <div className="review-controls">
              {item.confidence !== null && item.confidence < 0.5 && (
                <p className="review-warning">Low-confidence detection — drag the corners to match the page edges.</p>
              )}
              <button className="confirm-btn" onClick={() => confirmCorners(currentIndex)}>Confirm edges</button>
            </div>
          )}

          {item.stage === 'ALIGN_FIELDS' && item.flatSrc && (
            <div className="align-step">
              <p className="scan-subtitle">
                Drag the image to line up the highlighted first row with the actual field positions, then confirm.
              </p>
              <div style={{ maxWidth: 600, margin: '0 auto' }}>
                <AlignmentOffsetEditor
                  imageSrc={item.flatSrc}
                  fields={selectedTemplate.fields || []}
                  dims={{ w: FLAT_W, h: FLAT_H }}
                  offset={item.alignOffset}
                  onOffsetChange={(offset) => patchItem(currentIndex, { alignOffset: offset })}
                />
              </div>
              <div className="review-controls">
                <button
                  className="back-btn"
                  onClick={() => patchItem(currentIndex, { alignOffset: { dx: 0, dy: 0 } })}
                >
                  Reset alignment
                </button>
                <button className="confirm-btn" onClick={() => confirmAlignment(currentIndex)}>
                  Confirm alignment {currentIndex + 1 < total ? '→ next document' : '→ start scanning'}
                </button>
              </div>
            </div>
          )}

          {item.error && <div className="scan-error">{item.error}</div>}
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
  const doc = batch[reviewIndex];
  const results = allResults[reviewIndex] || [];

  return (
    <div className="scan-page">
      <div className="scan-header">
        <h1>Review extracted data</h1>
        {batch.length > 1 && (
          <div className="doc-nav">
            <button disabled={reviewIndex === 0} onClick={() => setReviewIndex((i) => i - 1)}>← Prev</button>
            <span className="mono-label">DOCUMENT {reviewIndex + 1} OF {batch.length}</span>
            <button disabled={reviewIndex === batch.length - 1} onClick={() => setReviewIndex((i) => i + 1)}>Next →</button>
          </div>
        )}
        <button className="back-btn" onClick={scanMoreWithTemplate}>Scan more with this template</button>
        <button className="back-btn" onClick={startOver}>← Choose different template</button>
      </div>

      <div className="review-grid">
        <img src={doc.flatSrc} alt="Scanned document" className="review-image" />

        <div className="review-fields">
          {results.map((r, i) => (
            <div key={i} className="review-row">
              <label className="mono-label review-label">
                {r.name} · {r.type}
                {r.lowConfidence && <span className="low-confidence-flag"> ⚠ low confidence</span>}
              </label>
              {r.diagnostics?.corrections?.length > 0 && (
                <p className="diagnostics-line mono-label">ADJUSTMENTS: {r.diagnostics.corrections.join(', ')}</p>
              )}
              <input
                className={`review-input ${r.lowConfidence ? 'flagged' : ''}`}
                value={r.value}
                onChange={(e) => updateResult(reviewIndex, i, e.target.value)}
              />
            </div>
          ))}

          <div className="export-section">
            {!mappingChecked && <p className="mono-label">CHECKING EXCEL EXPORT SETUP...</p>}

            {mappingChecked && !exportMapping && !exportSetupMode && (
              <div className="export-setup-prompt">
                <p className="scan-subtitle">This template isn't linked to an Excel file yet.</p>
                <div className="export-setup-choices">
                  <button className="confirm-btn" onClick={() => setExportSetupMode('new')}>
                    Create new Excel file
                  </button>
                  <button
                    className="back-btn export-choice-btn"
                    onClick={() => { setExportSetupMode('existing'); loadExistingFilesList(); }}
                  >
                    Use an existing Excel file
                  </button>
                </div>
              </div>
            )}

            {exportSetupMode === 'new' && (
              <div className="export-setup-panel">
                <p className="scan-subtitle">
                  Creates a new file with headers ({fieldOrder.join(', ')}) and this document as the first row.
                </p>
                <div className="review-controls">
                  <button className="back-btn" onClick={() => setExportSetupMode(null)}>Cancel</button>
                  <button className="confirm-btn" onClick={() => createNewExportFile(reviewIndex)} disabled={exportBusy}>
                    {exportBusy ? 'Creating…' : 'Create & add this record'}
                  </button>
                </div>
              </div>
            )}

            {exportSetupMode === 'existing' && (
              <div className="export-setup-panel">
                <label className="mono-label">EXISTING FILES IN DRIVE</label>
                {existingFiles === null && <p className="mono-label">LOADING...</p>}
                {existingFiles && existingFiles.length > 0 && (
                  <select
                    className="review-input"
                    value={existingFileChoice}
                    onChange={(e) => setExistingFileChoice(e.target.value)}
                  >
                    <option value="">— Upload a new file instead —</option>
                    {existingFiles.map((f) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                )}
                {!existingFileChoice && (
                  <input
                    type="file"
                    accept=".xlsx"
                    onChange={(e) => setUploadFileForExport(e.target.files?.[0] || null)}
                  />
                )}
                <label className="mono-label" style={{ marginTop: 12, display: 'block' }}>
                  START CELL (e.g. C4)
                </label>
                <input
                  className="review-input"
                  value={startCellInput}
                  onChange={(e) => setStartCellInput(e.target.value.toUpperCase())}
                  placeholder="A1"
                />
                <p className="scan-subtitle">
                  Fields will be written starting here, using {fieldOrder.length} column{fieldOrder.length === 1 ? '' : 's'}: {fieldOrder.join(', ')}
                </p>
                <div className="review-controls">
                  <button className="back-btn" onClick={() => setExportSetupMode(null)}>Cancel</button>
                  <button className="confirm-btn" onClick={() => useExistingExportFile(reviewIndex)} disabled={exportBusy}>
                    {exportBusy ? 'Saving…' : 'Use this file & add record'}
                  </button>
                </div>
              </div>
            )}

            {exportError && <p className="scan-error">{exportError}</p>}

            {exportMapping && !exportSetupMode && (
              <div className="export-actions">
                {addedDocs[reviewIndex] ? (
                  <p className="added-confirmation">✓ Added to Excel</p>
                ) : (
                  <button className="confirm-btn" onClick={() => confirmAddToExcel(reviewIndex)} disabled={exportBusy}>
                    {exportBusy ? 'Adding…' : 'Confirm & add to Excel'}
                  </button>
                )}
                <a
                  className="back-btn"
                  href={`https://drive.google.com/file/d/${exportMapping.workbookFileId}/view`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View in Drive
                </a>
                <button className="back-btn" onClick={downloadCurrentExport}>Download .xlsx</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function requestPreprocess(worker, buffer, width, height) {
  return new Promise((resolve, reject) => {
    const handler = (e) => {
      const msg = e.data;
      if (msg.type === 'preprocess-result') {
        worker.removeEventListener('message', handler);
        resolve(msg);
      } else if (msg.type === 'preprocess-error') {
        worker.removeEventListener('message', handler);
        reject(new Error(msg.message));
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({ type: 'preprocess', buffer, width, height }, [buffer]);
  });
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

function clampInt(v, min, max) {
  return Math.round(Math.min(Math.max(v, min), max));
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
