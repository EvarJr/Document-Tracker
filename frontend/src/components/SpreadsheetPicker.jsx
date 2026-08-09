import { useState } from 'react';
import * as XLSX from 'xlsx';
import './SpreadsheetPicker.css';

const ROWS_PER_PAGE = 50;
const MIN_ROWS_SHOWN = 20; // even a near-empty sheet shows some clickable blank space
const MIN_COLS_SHOWN = 14;

function columnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function cellValue(ws, r, c) {
  const addr = XLSX.utils.encode_cell({ r, c });
  const cell = ws?.[addr];
  return cell?.v !== undefined ? String(cell.v) : '';
}

export default function SpreadsheetPicker({
  workbook,
  fieldCount,
  occupiedRanges, // [{ sheetName, startCol, endCol, label }]
  sheetName,
  cellRef, // currently selected, e.g. "C4" or null
  onChange, // (sheetName, cellRef) => void
}) {
  const sheetNames = workbook.SheetNames;
  const activeSheet = sheetName && sheetNames.includes(sheetName) ? sheetName : sheetNames[0];
  const [visibleRows, setVisibleRows] = useState(ROWS_PER_PAGE);

  const ws = workbook.Sheets[activeSheet];
  const range = ws?.['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };

  const totalRows = Math.max(range.e.r + 1, MIN_ROWS_SHOWN);
  const totalCols = Math.max(range.e.c + 1, MIN_COLS_SHOWN);
  const rowsShown = Math.min(visibleRows, totalRows);

  const sheetOccupied = occupiedRanges.filter((r) => r.sheetName === activeSheet);

  const selected = cellRef && activeSheet === sheetName ? parseSimpleCellRef(cellRef) : null;

  const handleSheetChange = (newSheet) => {
    onChange(newSheet, null); // switching sheets clears the selection - a cell on the old sheet doesn't apply
    setVisibleRows(ROWS_PER_PAGE);
  };

  const handleCellClick = (r, c) => {
    onChange(activeSheet, `${columnLetter(c)}${r + 1}`);
  };

  return (
    <div className="spreadsheet-picker">
      {sheetNames.length > 1 && (
        <div className="sheet-tabs">
          {sheetNames.map((name) => (
            <button
              key={name}
              className={name === activeSheet ? 'active' : ''}
              onClick={() => handleSheetChange(name)}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {sheetOccupied.length > 0 && (
        <div className="occupied-legend mono-label">
          {sheetOccupied.map((r, i) => (
            <span key={i} className="occupied-legend-item">
              <span className="occupied-swatch" /> {columnLetter(r.startCol)}–{columnLetter(r.endCol)}: {r.label}
            </span>
          ))}
        </div>
      )}

      <div className="grid-scroll">
        <table className="preview-grid">
          <thead>
            <tr>
              <th className="corner-cell" />
              {Array.from({ length: totalCols }).map((_, c) => (
                <th key={c} className="mono-label">{columnLetter(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rowsShown }).map((_, r) => (
              <tr key={r}>
                <th className="mono-label row-label">{r + 1}</th>
                {Array.from({ length: totalCols }).map((_, c) => {
                  const isOccupiedCol = sheetOccupied.some((o) => c >= o.startCol && c <= o.endCol);
                  const isSelectedStart = selected && selected.row === r && selected.col === c;
                  const isSelectedSpan =
                    selected && r === selected.row && c >= selected.col && c < selected.col + fieldCount;

                  const classes = [
                    isOccupiedCol ? 'occupied' : '',
                    isSelectedSpan ? 'selected-span' : '',
                    isSelectedStart ? 'selected-start' : '',
                  ].filter(Boolean).join(' ');

                  return (
                    <td key={c} className={classes} onClick={() => handleCellClick(r, c)}>
                      {cellValue(ws, r, c)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {visibleRows < totalRows && (
        <button className="back-btn show-more-btn" onClick={() => setVisibleRows((v) => v + ROWS_PER_PAGE)}>
          Show more rows
        </button>
      )}

      <p className="picker-status mono-label">
        {cellRef ? `SELECTED: ${activeSheet}!${cellRef}` : 'CLICK A CELL TO SET THE START POSITION'}
      </p>
    </div>
  );
}

function parseSimpleCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!match) return null;
  const [, colLetters, rowStr] = match;
  let col = 0;
  for (let i = 0; i < colLetters.length; i++) {
    col = col * 26 + (colLetters.toUpperCase().charCodeAt(i) - 64);
  }
  return { col: col - 1, row: parseInt(rowStr, 10) - 1 };
}
