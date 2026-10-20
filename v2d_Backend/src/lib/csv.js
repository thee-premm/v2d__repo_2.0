/** RFC 4180 CSV parsing/serialisation (quoted fields, embedded commas/quotes/newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  const src = String(text ?? "").replace(/^﻿/, "");
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
    } else {
      field += ch;
    }
    i += 1;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

/** Parse CSV with a header row into objects keyed by normalised header names. */
export function parseCsvRecords(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { headers: [], records: [] };
  const headers = header.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  return {
    headers,
    records: rows.map((r, idx) => ({ line: idx + 2, values: Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? "").trim()])) })),
  };
}

function escapeCell(value) {
  if (value === null || value === undefined) return "";
  let s = typeof value === "number" ? String(value) : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s) && typeof value !== "number") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  return [headers.map(escapeCell).join(","), ...rows.map((r) => r.map(escapeCell).join(","))].join("\r\n");
}
