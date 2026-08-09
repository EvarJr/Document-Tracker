import { useCallback, useEffect, useRef, useState } from 'react';
import { createWorker } from 'tesseract.js';
import { API_BASE_URL } from '../config.js';
import { authFetch, loginWithGoogle } from '../lib/auth.js';
import CornerEditor from './CornerEditor.jsx';
import AlignmentOffsetEditor from './AlignmentOffsetEditor.jsx';
import SpreadsheetPicker from './SpreadsheetPicker.jsx';
import { buildNewWorkbook, appendRowToWorkbook, findConflictingMapping, flattenAllDestinations, readWorkbook, parseCellRef, toCellRef } from '../lib/excelExport.js';
import {
  emptyCorrectionsDoc,
  isFieldLearningEnabled,
  setFieldLearningEnabled,
  suggestCorrection,
  recordCorrectionOutcome,
  fieldAccuracyLabel,
} from '../lib/correctionLearning.js';
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
  // A template can have MULTIPLE saved destinations (different files/cell
  // ranges) - the user picks which one to write to each time, and can add
  // more at any point. This is deliberately not locked to a single file
  // after first setup.
  const [exportDestinations, setExportDestinations] = useState([]);
  const [selectedDestinationId, setSelectedDestinationId] = useState(null);
  const [mappingChecked, setMappingChecked] = useState(false);
  const [exportSetupMode, setExportSetupMode] = useState(null); // null | 'new' | 'existing'
  const [existingFiles, setExistingFiles] = useState(null);
  const [existingFileChoice, setExistingFileChoice] = useState(''); // Drive file id, or '' for "upload new"
  const [startCellInput, setStartCellInput] = useState('A1');
  const [startSheetInput, setStartSheetInput] = useState('Sheet1');
  const [previewWorkbook, setPreviewWorkbook] = useState(null);
  const [previewOccupiedRanges, setPreviewOccupiedRanges] = useState([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [uploadFileForExport, setUploadFileForExport] = useState(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [addedDocs, setAddedDocs] = useState({}); // `${docIndex}_${destinationId}` -> true, once added to that specific destination

  // --- correction-memory learning (per template, per field) ---
  const [corrections, setCorrections] = useState(null);
  const [correctionsLoaded, setCorrectionsLoaded] = useState(false);

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
      const list = data.templates || [];

      const enriched = await Promise.all(
        list.map(async (t) => {
          try {
            const contentRes = await authFetch(`${API_BASE_URL}/templates/${t.id}`);
            if (!contentRes.ok) return t;
            const content = await contentRes.json();
            return { ...t, thumbnail: content.thumbnail || null, fieldCount: (content.fields || []).length };
          } catch {
            return t;
          }
        })
      );

      setTemplates(enriched);
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

      // Load correction history now (not on entering review) so
      // suggestions are ready the moment OCR results come back.
      setCorrectionsLoaded(false);
      try {
        const corrRes = await authFetch(`${API_BASE_URL}/corrections/${t.id}`);
        if (corrRes.ok) {
          setCorrections(await corrRes.json());
        } else {
          setCorrections(emptyCorrectionsDoc(t.id));
        }
      } catch (err) {
        console.error(err);
        setCorrections(emptyCorrectionsDoc(t.id));
      } finally {
        setCorrectionsLoaded(true);
      }
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

          const fieldCorrections = corrections?.fields?.[f.name];
          const suggestion = suggestCorrection(fieldCorrections, text);
          const value = suggestion !== null && suggestion !== undefined ? suggestion : text;

          docResults.push({
            name: f.name,
            type: f.type,
            value,
            rawOcr: text,
            suggestion,
            lowConfidence: ocrConfidence < 60,
            diagnostics,
          });
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
  }, [batch, selectedTemplate, corrections]);

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
          const data = await res.json();
          let destinations = data.destinations;

          if (!destinations) {
            // Backward-compat: earlier versions saved one flat mapping
            // object directly (no destinations array). Wrap it so
            // existing saved data keeps working under the new model.
            destinations = data.workbookFileId
              ? [{ ...data, id: 'dest_legacy', label: data.label || 'Existing export' }]
              : [];
          }

          setExportDestinations(destinations);
          setSelectedDestinationId(destinations.length > 0 ? destinations[destinations.length - 1].id : null);
        } else {
          setExportDestinations([]);
          setSelectedDestinationId(null);
        }
      } catch (err) {
        console.error(err);
        setExportDestinations([]);
        setSelectedDestinationId(null);
      } finally {
        if (!cancelled) setMappingChecked(true);
      }
    })();

    return () => { cancelled = true; };
  }, [phase, selectedTemplateId]);

  const fieldOrder = (selectedTemplate?.fields || []).map((f) => f.name);
  const selectedDestination = exportDestinations.find((d) => d.id === selectedDestinationId) || null;

  const saveDestinations = async (updatedDestinations) => {
    await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ templateId: selectedTemplateId, destinations: updatedDestinations }),
    });
  };

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

  const computeOccupiedRanges = async (fileId) => {
    try {
      const res = await authFetch(`${API_BASE_URL}/export-mappings`);
      const data = res.ok ? await res.json() : { mappings: [] };
      const flat = flattenAllDestinations(data.mappings || []);
      return flat
        .filter((d) => d.workbookFileId === fileId)
        .map((d) => {
          const start = parseCellRef(d.startCell);
          return {
            sheetName: d.sheetName || 'Sheet1',
            startCol: start.col,
            endCol: start.col + d.fieldOrder.length - 1,
            label: d.label || d.templateId,
          };
        });
    } catch (err) {
      console.error('Failed to compute occupied ranges', err);
      return [];
    }
  };

  const loadPreviewForExistingFile = async (fileId) => {
    setPreviewLoading(true);
    setPreviewWorkbook(null);
    try {
      const [fileRes, occupied] = await Promise.all([
        authFetch(`${API_BASE_URL}/exports/${fileId}`),
        computeOccupiedRanges(fileId),
      ]);
      if (!fileRes.ok) throw new Error('Could not load that file for preview.');
      const bytes = await fileRes.arrayBuffer();
      const wb = readWorkbook(bytes);
      setPreviewWorkbook(wb);
      setPreviewOccupiedRanges(occupied);
      setStartSheetInput(wb.SheetNames[0]);
      setStartCellInput('');
    } catch (err) {
      console.error(err);
      setExportError('Could not preview that file.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const loadPreviewForUploadedFile = async (file) => {
    setPreviewLoading(true);
    setPreviewWorkbook(null);
    try {
      const bytes = await file.arrayBuffer();
      const wb = readWorkbook(bytes);
      setPreviewWorkbook(wb);
      setPreviewOccupiedRanges([]); // brand-new-to-us file, nothing else can reference it yet
      setStartSheetInput(wb.SheetNames[0]);
      setStartCellInput('');
    } catch (err) {
      console.error(err);
      setExportError('Could not read that file — is it a valid .xlsx?');
    } finally {
      setPreviewLoading(false);
    }
  };

  const closeExportSetup = () => {
    setExportSetupMode(null);
    setExistingFileChoice('');
    setUploadFileForExport(null);
    setPreviewWorkbook(null);
    setPreviewOccupiedRanges([]);
    setStartCellInput('A1');
    setStartSheetInput('Sheet1');
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

      const newDestination = {
        ...mapping,
        id: `dest_${Date.now()}`,
        label: filename,
        workbookFileId: uploaded.id,
      };
      const updatedDestinations = [...exportDestinations, newDestination];

      const mapRes = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: selectedTemplateId, destinations: updatedDestinations }),
      });
      if (!mapRes.ok) throw new Error('Created the file, but failed to save the export mapping.');

      setExportDestinations(updatedDestinations);
      setSelectedDestinationId(newDestination.id);
      closeExportSetup();
      await persistCorrectionsForDoc(docIndex);
      setAddedDocs((prev) => ({ ...prev, [`${docIndex}_${newDestination.id}`]: true }));
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

      const proposedDestination = {
        id: `dest_${Date.now()}`,
        label: existingFiles?.find((f) => f.id === fileId)?.name || uploadFileForExport?.name || 'Excel file',
        workbookFileId: fileId,
        sheetName: startSheetInput || 'Sheet1',
        startCell,
        fieldOrder,
        nextRow: parseCellRef(startCell).row + 1,
      };

      const allMappingsRes = await authFetch(`${API_BASE_URL}/export-mappings`);
      const allMappingsData = allMappingsRes.ok ? await allMappingsRes.json() : { mappings: [] };
      const flatExisting = flattenAllDestinations(allMappingsData.mappings || []);
      // Check against everything, including this template's own other
      // destinations — two destinations pointing at overlapping columns
      // in the same file is a real conflict regardless of which template
      // created them.
      const conflict = findConflictingMapping(proposedDestination, flatExisting, null);
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

      const { arrayBuffer, updatedMapping } = appendRowToWorkbook(downloadedBytes, proposedDestination, valuesForDoc(docIndex));

      const putRes = await authFetch(`${API_BASE_URL}/exports/${fileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: arrayBuffer,
      });
      if (!putRes.ok) throw new Error('Failed to save the updated file back to Drive.');

      const updatedDestinations = [...exportDestinations, updatedMapping];
      const mapRes = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: selectedTemplateId, destinations: updatedDestinations }),
      });
      if (!mapRes.ok) throw new Error('Saved the file, but failed to save the export mapping.');

      setExportDestinations(updatedDestinations);
      setSelectedDestinationId(updatedMapping.id);
      closeExportSetup();
      await persistCorrectionsForDoc(docIndex);
      setAddedDocs((prev) => ({ ...prev, [`${docIndex}_${updatedMapping.id}`]: true }));
    } catch (err) {
      console.error(err);
      setExportError(err.message || 'Could not save to that Excel file.');
    } finally {
      setExportBusy(false);
    }
  };

  // Records the (OCR, final-value) outcome for every field in a document,
  // then saves the updated correction history to Drive. Called at the
  // exact moment a document is confirmed - this IS the "verification
  // confirmation" point the learning is keyed off of.
  const persistCorrectionsForDoc = async (docIndex) => {
    if (!corrections || !selectedTemplateId) return;
    const docResults = allResults[docIndex] || [];

    let updated = corrections;
    for (const r of docResults) {
      updated = recordCorrectionOutcome(updated, r.name, {
        rawOcr: r.rawOcr ?? r.value,
        suggestion: r.suggestion ?? null,
        finalValue: r.value,
      });
    }
    setCorrections({ ...updated });

    try {
      await authFetch(`${API_BASE_URL}/corrections/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
    } catch (err) {
      // Non-fatal - the Excel record still succeeded either way, this just
      // means the learning update didn't save this time.
      console.error('Failed to save correction history', err);
    }
  };

  const toggleFieldLearning = async (fieldName, enabled) => {
    if (!corrections) return;
    const updated = setFieldLearningEnabled({ ...corrections }, fieldName, enabled);
    setCorrections({ ...updated });
    try {
      await authFetch(`${API_BASE_URL}/corrections/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
    } catch (err) {
      console.error('Failed to save learning toggle', err);
    }
  };

  const confirmAddToExcel = async (docIndex) => {
    if (!selectedDestination) return;
    setExportBusy(true);
    setExportError(null);
    try {
      const fileRes = await authFetch(`${API_BASE_URL}/exports/${selectedDestination.workbookFileId}`);
      if (!fileRes.ok) throw new Error('Could not read the Excel file from Drive.');
      const bytes = await fileRes.arrayBuffer();

      const { arrayBuffer, updatedMapping } = appendRowToWorkbook(bytes, selectedDestination, valuesForDoc(docIndex));

      const putRes = await authFetch(`${API_BASE_URL}/exports/${selectedDestination.workbookFileId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: arrayBuffer,
      });
      if (!putRes.ok) throw new Error('Failed to save the updated file back to Drive.');

      const updatedDestinations = exportDestinations.map((d) => (d.id === selectedDestination.id ? updatedMapping : d));

      const mapRes = await authFetch(`${API_BASE_URL}/export-mappings/${selectedTemplateId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateId: selectedTemplateId, destinations: updatedDestinations }),
      });
      if (!mapRes.ok) throw new Error('Saved the row, but failed to update the export mapping.');

      setExportDestinations(updatedDestinations);
      await persistCorrectionsForDoc(docIndex);
      setAddedDocs((prev) => ({ ...prev, [`${docIndex}_${selectedDestination.id}`]: true }));
    } catch (err) {
      console.error(err);
      setExportError(err.message || 'Could not add this record to Excel.');
    } finally {
      setExportBusy(false);
    }
  };

  const downloadCurrentExport = async () => {
    if (!selectedDestination) return;
    try {
      const res = await authFetch(`${API_BASE_URL}/exports/${selectedDestination.workbookFileId}`);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedDestination.label || 'export.xlsx';
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
    setExportDestinations([]);
    setSelectedDestinationId(null);
    setMappingChecked(false);
    setExportSetupMode(null);
    setExistingFiles(null);
    setExistingFileChoice('');
    setStartCellInput('A1');
    setUploadFileForExport(null);
    setExportError(null);
    setAddedDocs({});
    setCorrections(null);
    setCorrectionsLoaded(false);
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
                <div className="template-picker-thumb">
                  {t.thumbnail ? (
                    <img src={t.thumbnail} alt={t.name} />
                  ) : (
                    <div className="template-picker-noimg mono-label">NO PREVIEW</div>
                  )}
                </div>
                <span className="template-picker-name">{t.name.replace(/\.json$/, '')}</span>
                {t.fieldCount !== undefined && (
                  <span className="mono-label template-picker-meta">{t.fieldCount} FIELDS</span>
                )}
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
          {results.map((r, i) => {
            const fieldLearning = corrections?.fields?.[r.name];
            const learningEnabled = isFieldLearningEnabled(corrections, r.name);
            const accuracyLabel = fieldAccuracyLabel(fieldLearning);
            const suggestionApplied = r.suggestion && r.suggestion !== r.rawOcr;

            return (
              <div key={i} className="review-row">
                <div className="review-label-row">
                  <label className="mono-label review-label">
                    {r.name} · {r.type}
                    {r.lowConfidence && <span className="low-confidence-flag"> ⚠ low confidence</span>}
                  </label>
                  <label className="learning-toggle mono-label">
                    <input
                      type="checkbox"
                      checked={learningEnabled}
                      onChange={(e) => toggleFieldLearning(r.name, e.target.checked)}
                    />
                    LEARNING
                  </label>
                </div>

                {r.diagnostics?.corrections?.length > 0 && (
                  <p className="diagnostics-line mono-label">ADJUSTMENTS: {r.diagnostics.corrections.join(', ')}</p>
                )}

                {suggestionApplied && (
                  <p className="suggestion-line mono-label">
                    OCR READ: "{r.rawOcr}" → SUGGESTED: "{r.suggestion}"
                  </p>
                )}

                {accuracyLabel && <p className="accuracy-line mono-label">{accuracyLabel}</p>}

                <input
                  className={`review-input ${r.lowConfidence ? 'flagged' : ''} ${suggestionApplied ? 'suggested' : ''}`}
                  value={r.value}
                  onChange={(e) => updateResult(reviewIndex, i, e.target.value)}
                />
              </div>
            );
          })}

          <div className="export-section">
            {!mappingChecked && <p className="mono-label">CHECKING EXCEL EXPORT SETUP...</p>}

            {mappingChecked && exportDestinations.length === 0 && !exportSetupMode && (
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

            {mappingChecked && exportDestinations.length > 0 && !exportSetupMode && (
              <div className="destination-picker">
                <label className="mono-label">ADD THIS RECORD TO</label>
                <select
                  className="review-input"
                  value={selectedDestinationId || ''}
                  onChange={(e) => setSelectedDestinationId(e.target.value)}
                >
                  {exportDestinations.map((d) => (
                    <option key={d.id} value={d.id}>{d.label} · {d.startCell}</option>
                  ))}
                </select>
                <div className="destination-add-links">
                  <button className="back-btn" onClick={() => setExportSetupMode('new')}>+ New Excel file</button>
                  <button
                    className="back-btn"
                    onClick={() => { setExportSetupMode('existing'); loadExistingFilesList(); }}
                  >
                    + Another existing file
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
                  <button className="back-btn" onClick={closeExportSetup}>Cancel</button>
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
                    onChange={(e) => {
                      const fileId = e.target.value;
                      setExistingFileChoice(fileId);
                      setUploadFileForExport(null);
                      if (fileId) loadPreviewForExistingFile(fileId);
                      else { setPreviewWorkbook(null); setPreviewOccupiedRanges([]); }
                    }}
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
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null;
                      setUploadFileForExport(file);
                      if (file) loadPreviewForUploadedFile(file);
                      else { setPreviewWorkbook(null); setPreviewOccupiedRanges([]); }
                    }}
                  />
                )}

                {previewLoading && <p className="mono-label" style={{ marginTop: 12 }}>LOADING PREVIEW...</p>}

                {previewWorkbook && !previewLoading && (
                  <SpreadsheetPicker
                    workbook={previewWorkbook}
                    fieldCount={fieldOrder.length}
                    occupiedRanges={previewOccupiedRanges}
                    sheetName={startSheetInput}
                    cellRef={startCellInput}
                    onChange={(sheet, cell) => { setStartSheetInput(sheet); setStartCellInput(cell || ''); }}
                  />
                )}

                {previewWorkbook && !previewLoading && (
                  <details className="manual-override">
                    <summary className="mono-label">Type a cell reference manually instead</summary>
                    <input
                      className="review-input"
                      value={startCellInput}
                      onChange={(e) => setStartCellInput(e.target.value.toUpperCase())}
                      placeholder="A1"
                    />
                  </details>
                )}

                <p className="scan-subtitle">
                  Fields will be written starting at the selected cell, using {fieldOrder.length} column{fieldOrder.length === 1 ? '' : 's'}: {fieldOrder.join(', ')}
                </p>
                <div className="review-controls">
                  <button className="back-btn" onClick={closeExportSetup}>Cancel</button>
                  <button
                    className="confirm-btn"
                    onClick={() => useExistingExportFile(reviewIndex)}
                    disabled={exportBusy || !startCellInput}
                  >
                    {exportBusy ? 'Saving…' : 'Use this file & add record'}
                  </button>
                </div>
              </div>
            )}

            {exportError && <p className="scan-error">{exportError}</p>}

            {selectedDestination && !exportSetupMode && (
              <div className="export-actions">
                {selectedDestination && addedDocs[`${reviewIndex}_${selectedDestination.id}`] ? (
                  <p className="added-confirmation">✓ Added to {selectedDestination.label}</p>
                ) : (
                  <button className="confirm-btn" onClick={() => confirmAddToExcel(reviewIndex)} disabled={exportBusy}>
                    {exportBusy ? 'Adding…' : `Confirm & add to ${selectedDestination.label}`}
                  </button>
                )}
                <a
                  className="back-btn"
                  href={`https://drive.google.com/file/d/${selectedDestination.workbookFileId}/view`}
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
