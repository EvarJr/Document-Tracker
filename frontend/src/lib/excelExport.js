import * as XLSX from 'xlsx';

// --- Cell reference math (A1 <-> {col, row}, 0-indexed internally) ---

export function parseCellRef(ref) {
  const match = /^([A-Z]+)(\d+)$/i.exec(ref.trim());
  if (!match) throw new Error(`Invalid cell reference: ${ref}`);
  const [, colLetters, rowStr] = match;
  return { col: columnLetterToIndex(colLetters.toUpperCase()), row: parseInt(rowStr, 10) - 1 };
}

export function toCellRef(col, row) {
  return `${indexToColumnLetter(col)}${row + 1}`;
}

function columnLetterToIndex(letters) {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

function indexToColumnLetter(index) {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// --- Collision check ---

// Two mappings only ever conflict if they point at the same file+sheet -
// column ranges are the real partition boundary here, since a template's
// rows grow downward indefinitely as more documents get scanned. Row
// position alone isn't a safe way to judge "clear," since today's empty
// space below another template's last row is tomorrow's collision.
export function columnRangesOverlap(mappingA, mappingB) {
  if (mappingA.workbookFileId !== mappingB.workbookFileId) return false;
  if ((mappingA.sheetName || 'Sheet1') !== (mappingB.sheetName || 'Sheet1')) return false;

  const a = parseCellRef(mappingA.startCell);
  const b = parseCellRef(mappingB.startCell);
  const aEndCol = a.col + mappingA.fieldOrder.length - 1;
  const bEndCol = b.col + mappingB.fieldOrder.length - 1;

  return a.col <= bEndCol && b.col <= aEndCol;
}

export function findConflictingMapping(proposedMapping, existingMappings, excludeTemplateId) {
  return existingMappings.find(
    (m) => m.templateId !== excludeTemplateId && columnRangesOverlap(proposedMapping, m)
  );
}

// --- Workbook building ---

// Brand-new workbook, header row at A1, no collision risk possible since
// nothing else references a file that doesn't exist yet.
export function buildNewWorkbook(fieldOrder, values) {
  const wb = XLSX.utils.book_new();
  const headerRow = fieldOrder;
  const dataRow = fieldOrder.map((name) => values[name] ?? '');
  const ws = XLSX.utils.aoa_to_sheet([headerRow, dataRow]);
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');

  const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return {
    arrayBuffer,
    mapping: {
      sheetName: 'Sheet1',
      startCell: 'A1',
      fieldOrder,
      nextRow: 2, // 0-indexed row 2 = the 3rd row = right after header+first data row
    },
  };
}

// Appends one row to an existing workbook at the position described by
// `mapping`. Writes the header row too, but only if that exact row looks
// empty — protects against clobbering a header that's already there
// (e.g. if this is the very first write into an existing, previously
// unrelated spreadsheet the user pointed us at).
export function appendRowToWorkbook(existingArrayBuffer, mapping, values) {
  const wb = XLSX.read(existingArrayBuffer, { type: 'array' });
  const sheetName = mapping.sheetName || 'Sheet1';

  let ws = wb.Sheets[sheetName];
  if (!ws) {
    ws = XLSX.utils.aoa_to_sheet([[]]);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const start = parseCellRef(mapping.startCell);

  // Write header row once, only if that cell is currently empty.
  const headerCellRef = toCellRef(start.col, start.row);
  const headerCellExists = !!ws[headerCellRef] && ws[headerCellRef].v !== undefined && ws[headerCellRef].v !== '';
  if (!headerCellExists) {
    mapping.fieldOrder.forEach((name, i) => {
      const ref = toCellRef(start.col + i, start.row);
      ws[ref] = { t: 's', v: name };
    });
  }

  // Write the data row at mapping.nextRow (0-indexed, relative to the sheet).
  const dataRowIndex = mapping.nextRow;
  mapping.fieldOrder.forEach((name, i) => {
    const ref = toCellRef(start.col + i, dataRowIndex);
    const value = values[name] ?? '';
    ws[ref] = { t: 's', v: String(value) };
  });

  // Recompute the sheet's !ref range so the new cells are actually included
  // when the file is opened elsewhere (Sheets/Excel), not just present in
  // the underlying cell object.
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  range.s.c = Math.min(range.s.c, start.col);
  range.s.r = Math.min(range.s.r, start.row);
  range.e.c = Math.max(range.e.c, start.col + mapping.fieldOrder.length - 1);
  range.e.r = Math.max(range.e.r, dataRowIndex);
  ws['!ref'] = XLSX.utils.encode_range(range);

  const arrayBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return {
    arrayBuffer,
    updatedMapping: { ...mapping, nextRow: dataRowIndex + 1 },
  };
}
