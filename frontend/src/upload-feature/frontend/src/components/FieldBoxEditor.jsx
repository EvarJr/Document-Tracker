import { useState, useRef, useCallback, useEffect } from 'react';
import './FieldBoxEditor.css';

const FIELD_TYPES = ['text', 'number', 'date', 'checkbox'];
const MIN_BOX_SIZE = 12;

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `field_${Date.now()}_${idCounter}`;
}

export default function FieldBoxEditor({ imageSrc, initialTemplateName = '', onBack }) {
  const [imgDims, setImgDims] = useState({ w: 0, h: 0 });
  const [fields, setFields] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [templateName, setTemplateName] = useState(initialTemplateName);
  const [drawingBox, setDrawingBox] = useState(null);
  const [savedMsg, setSavedMsg] = useState(null);

  const svgRef = useRef(null);
  const dragState = useRef(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImgDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = imageSrc;
  }, [imageSrc]);

  const clientToPoint = useCallback(
    (clientX, clientY) => {
      const rect = svgRef.current.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * imgDims.w;
      const y = ((clientY - rect.top) / rect.height) * imgDims.h;
      return {
        x: Math.min(Math.max(x, 0), imgDims.w),
        y: Math.min(Math.max(y, 0), imgDims.h),
      };
    },
    [imgDims]
  );

  const selectedField = fields.find((f) => f.id === selectedId) || null;

  const onBackgroundPointerDown = (e) => {
    if (e.target !== svgRef.current) return; // ignore clicks on an existing box/handle
    const start = clientToPoint(e.clientX, e.clientY);
    dragState.current = { mode: 'create', start };
    setSelectedId(null);
    e.target.setPointerCapture(e.pointerId);
  };

  const onSvgPointerMove = (e) => {
    const ds = dragState.current;
    if (!ds) return;
    const point = clientToPoint(e.clientX, e.clientY);

    if (ds.mode === 'create') {
      setDrawingBox({
        x: Math.min(ds.start.x, point.x),
        y: Math.min(ds.start.y, point.y),
        w: Math.abs(point.x - ds.start.x),
        h: Math.abs(point.y - ds.start.y),
      });
    } else if (ds.mode === 'move') {
      const dx = point.x - ds.lastPoint.x;
      const dy = point.y - ds.lastPoint.y;
      ds.lastPoint = point;
      setFields((prev) =>
        prev.map((f) =>
          f.id === ds.id
            ? { ...f, x: clamp(f.x + dx, 0, imgDims.w - f.w), y: clamp(f.y + dy, 0, imgDims.h - f.h) }
            : f
        )
      );
    } else if (ds.mode === 'resize') {
      setFields((prev) => prev.map((f) => (f.id === ds.id ? resizeBox(f, ds.handle, point, imgDims) : f)));
    }
  };

  const onSvgPointerUp = (e) => {
    const ds = dragState.current;
    if (!ds) return;

    if (ds.mode === 'create' && drawingBox && drawingBox.w > MIN_BOX_SIZE && drawingBox.h > MIN_BOX_SIZE) {
      const id = nextId();
      setFields((prev) => [
        ...prev,
        { id, ...drawingBox, name: `field_${prev.length + 1}`, type: 'text' },
      ]);
      setSelectedId(id);
    }

    setDrawingBox(null);
    dragState.current = null;
    e.target.releasePointerCapture?.(e.pointerId);
  };

  const startMove = (field) => (e) => {
    e.stopPropagation();
    setSelectedId(field.id);
    dragState.current = { mode: 'move', id: field.id, lastPoint: clientToPoint(e.clientX, e.clientY) };
    e.target.setPointerCapture(e.pointerId);
  };

  const startResize = (field, handle) => (e) => {
    e.stopPropagation();
    setSelectedId(field.id);
    dragState.current = { mode: 'resize', id: field.id, handle };
    e.target.setPointerCapture(e.pointerId);
  };

  const updateSelectedField = (patch) => {
    if (!selectedId) return;
    setFields((prev) => prev.map((f) => (f.id === selectedId ? { ...f, ...patch } : f)));
  };

  const deleteField = (id) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const saveTemplate = () => {
    const template = {
      name: templateName || 'Untitled template',
      createdAt: new Date().toISOString(),
      imageWidth: imgDims.w,
      imageHeight: imgDims.h,
      fields: fields.map((f) => ({
        name: f.name,
        type: f.type,
        // Normalized 0-1 coordinates so this template still works if the
        // flattened output is ever re-scaled later in the pipeline.
        x: f.x / imgDims.w,
        y: f.y / imgDims.h,
        w: f.w / imgDims.w,
        h: f.h / imgDims.h,
      })),
    };

    // Interim storage until Google Drive integration lands (next roadmap item):
    // keep a local copy so a future "Templates" library page can list these.
    try {
      localStorage.setItem(`template:${Date.now()}`, JSON.stringify(template));
      setSavedMsg('Saved locally on this device. A downloadable copy was also created.');
    } catch {
      setSavedMsg('Could not save locally — a downloadable copy was still created below.');
    }

    downloadJson(template, `${slugify(template.name)}.json`);
  };

  return (
    <div className="field-editor-page">
      <div className="field-editor-header">
        {onBack && (
          <button className="back-btn" onClick={onBack}>← Back</button>
        )}
        <h1>Field editor</h1>
        <input
          className="template-name-input"
          placeholder="Template name (e.g. Standard Invoice)"
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
        />
        <button className="save-template-btn" onClick={saveTemplate} disabled={fields.length === 0}>
          Save template
        </button>
      </div>

      <div className="field-editor-body">
        <div className="editor-canvas-area">
          {imgDims.w > 0 ? (
            <div className="editor-image-wrap">
              <img src={imageSrc} alt="Template" draggable={false} />
              <svg
                ref={svgRef}
                className="field-svg"
                viewBox={`0 0 ${imgDims.w} ${imgDims.h}`}
                preserveAspectRatio="none"
                onPointerDown={onBackgroundPointerDown}
                onPointerMove={onSvgPointerMove}
                onPointerUp={onSvgPointerUp}
              >
                {fields.map((f, i) => (
                  <FieldBox
                    key={f.id}
                    field={f}
                    index={i}
                    selected={f.id === selectedId}
                    onSelect={() => setSelectedId(f.id)}
                    onStartMove={startMove(f)}
                    onStartResize={(handle) => startResize(f, handle)}
                  />
                ))}
                {drawingBox && (
                  <rect
                    x={drawingBox.x}
                    y={drawingBox.y}
                    width={drawingBox.w}
                    height={drawingBox.h}
                    className="drawing-box"
                  />
                )}
              </svg>
            </div>
          ) : (
            <p className="mono-label">Loading image…</p>
          )}

          <p className="editor-hint mono-label">DRAG ON THE IMAGE TO DRAW A FIELD BOX</p>
        </div>

        <aside className="field-panel">
          <p className="mono-label panel-title">FIELDS ({fields.length})</p>

          {fields.length === 0 && (
            <p className="meta-empty">No fields yet. Draw a box on the document to add one.</p>
          )}

          <ul className="field-list">
            {fields.map((f, i) => (
              <li key={f.id} className={f.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(f.id)}>
                <span className="mono-label">FIELD_{String(i + 1).padStart(2, '0')}</span>
                <span className="field-list-name">{f.name}</span>
                <button
                  className="delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteField(f.id);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>

          {selectedField && (
            <div className="field-props">
              <p className="mono-label panel-title" style={{ marginTop: 20 }}>FIELD PROPERTIES</p>

              <label className="prop-label mono-label">NAME</label>
              <input
                className="prop-input"
                value={selectedField.name}
                onChange={(e) => updateSelectedField({ name: e.target.value })}
              />

              <label className="prop-label mono-label">TYPE</label>
              <div className="type-segmented">
                {FIELD_TYPES.map((t) => (
                  <button
                    key={t}
                    className={selectedField.type === t ? 'active' : ''}
                    onClick={() => updateSelectedField({ type: t })}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {savedMsg && <p className="saved-msg">{savedMsg}</p>}
        </aside>
      </div>
    </div>
  );
}

function FieldBox({ field, index, selected, onSelect, onStartMove, onStartResize }) {
  const { x, y, w, h } = field;
  const handleSize = 10;
  const handles = [
    { key: 'tl', cx: x, cy: y },
    { key: 'tr', cx: x + w, cy: y },
    { key: 'br', cx: x + w, cy: y + h },
    { key: 'bl', cx: x, cy: y + h },
  ];

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        className={`field-box ${selected ? 'selected' : ''}`}
        onPointerDown={onStartMove}
        onClick={onSelect}
      />
      <text x={x + 4} y={y - 6} className="field-box-label">
        FIELD_{String(index + 1).padStart(2, '0')} · {field.type}
      </text>
      {selected &&
        handles.map((h2) => (
          <rect
            key={h2.key}
            x={h2.cx - handleSize / 2}
            y={h2.cy - handleSize / 2}
            width={handleSize}
            height={handleSize}
            className="resize-handle"
            onPointerDown={onStartResize(h2.key)}
          />
        ))}
    </g>
  );
}

function resizeBox(field, handle, point, dims) {
  let { x, y, w, h } = field;
  const x2 = x + w;
  const y2 = y + h;

  if (handle === 'tl') {
    x = Math.min(point.x, x2 - MIN_BOX_SIZE);
    y = Math.min(point.y, y2 - MIN_BOX_SIZE);
    w = x2 - x;
    h = y2 - y;
  } else if (handle === 'tr') {
    const newX2 = Math.max(point.x, x + MIN_BOX_SIZE);
    y = Math.min(point.y, y2 - MIN_BOX_SIZE);
    w = newX2 - x;
    h = y2 - y;
  } else if (handle === 'br') {
    w = Math.max(point.x, x + MIN_BOX_SIZE) - x;
    h = Math.max(point.y, y + MIN_BOX_SIZE) - y;
  } else if (handle === 'bl') {
    x = Math.min(point.x, x2 - MIN_BOX_SIZE);
    w = x2 - x;
    h = Math.max(point.y, y + MIN_BOX_SIZE) - y;
  }

  x = clamp(x, 0, dims.w);
  y = clamp(y, 0, dims.h);
  w = Math.min(w, dims.w - x);
  h = Math.min(h, dims.h - y);

  return { ...field, x, y, w, h };
}

function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function slugify(str) {
  return (
    str
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '') || 'template'
  );
}
