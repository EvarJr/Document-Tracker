import { useRef, useCallback } from 'react';

// Renders 4 draggable corner handles + connecting quad on top of the
// preview image. Coordinates are in "working" pixel space (dims.w x dims.h),
// same space the detection ran in — the SVG viewBox handles the scaling
// to whatever size the image is actually displayed at.
export default function CornerEditor({ corners, dims, onChange }) {
  const svgRef = useRef(null);
  const draggingIndex = useRef(null);

  const clientToPoint = useCallback(
    (clientX, clientY) => {
      const rect = svgRef.current.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * dims.w;
      const y = ((clientY - rect.top) / rect.height) * dims.h;
      return {
        x: Math.min(Math.max(x, 0), dims.w),
        y: Math.min(Math.max(y, 0), dims.h),
      };
    },
    [dims]
  );

  const onPointerDown = (index) => (e) => {
    e.preventDefault();
    draggingIndex.current = index;
    e.target.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (draggingIndex.current === null) return;
    const point = clientToPoint(e.clientX, e.clientY);
    const next = corners.map((c, i) => (i === draggingIndex.current ? point : c));
    onChange(next);
  };

  const onPointerUp = (e) => {
    if (draggingIndex.current === null) return;
    draggingIndex.current = null;
    e.target.releasePointerCapture?.(e.pointerId);
  };

  return (
    <svg
      ref={svgRef}
      className="corner-editor"
      viewBox={`0 0 ${dims.w} ${dims.h}`}
      preserveAspectRatio="none"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <polygon
        points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
        className="editor-polygon"
      />
      {corners.map((pt, i) => (
        <circle
          key={i}
          cx={pt.x}
          cy={pt.y}
          r={14}
          className="editor-handle"
          onPointerDown={onPointerDown(i)}
        />
      ))}
    </svg>
  );
}
