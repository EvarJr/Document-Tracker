import { useRef } from 'react';
import './AlignmentOffsetEditor.css';

// Renders the template's field boxes as an overlay on top of the flattened
// scan, shifted by `offset`. Dragging anywhere on the image nudges that
// offset uniformly — this corrects residual translation drift left over
// after corner-warping (different print margins, a few pixels of corner
// placement error, etc.), which perspective correction alone can't catch.
// "First row" fields are highlighted as the primary visual anchor, since
// that's usually the easiest place to judge alignment by eye.
export default function AlignmentOffsetEditor({ imageSrc, fields, dims, offset, onOffsetChange }) {
  const containerRef = useRef(null);
  const dragState = useRef(null);

  const onPointerDown = (e) => {
    dragState.current = { startX: e.clientX, startY: e.clientY, startOffset: offset };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!dragState.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const scaleX = dims.w / rect.width;
    const scaleY = dims.h / rect.height;
    const dx = (e.clientX - dragState.current.startX) * scaleX;
    const dy = (e.clientY - dragState.current.startY) * scaleY;
    onOffsetChange({
      dx: dragState.current.startOffset.dx + dx,
      dy: dragState.current.startOffset.dy + dy,
    });
  };

  const onPointerUp = () => {
    dragState.current = null;
  };

  const minY = fields.length ? Math.min(...fields.map((f) => f.y)) : 0;
  const firstRowThreshold = minY + 0.05;

  return (
    <div
      ref={containerRef}
      className="align-offset-wrap"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <img src={imageSrc} alt="Flattened scan" draggable={false} />
      <svg className="align-offset-svg" viewBox={`0 0 ${dims.w} ${dims.h}`} preserveAspectRatio="none">
        {fields.map((f, i) => {
          const x = f.x * dims.w + offset.dx;
          const y = f.y * dims.h + offset.dy;
          const w = f.w * dims.w;
          const h = f.h * dims.h;
          const isFirstRow = f.y <= firstRowThreshold;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={w}
              height={h}
              className={`align-field-box ${isFirstRow ? 'first-row' : ''}`}
            />
          );
        })}
      </svg>
    </div>
  );
}
