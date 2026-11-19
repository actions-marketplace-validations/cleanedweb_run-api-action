/** Serialize records. All formats end with a newline and keep the order the API returned. */

export function toJson(records) {
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function toJsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}

function cell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV. Columns are the union of record keys in first-seen order; nested values become JSON. */
export function toCsv(records) {
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.map(cell).join(',')];
  for (const record of records) lines.push(columns.map((key) => cell(record[key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function serialize(records, format) {
  if (format === 'json') return toJson(records);
  if (format === 'jsonl') return toJsonl(records);
  if (format === 'csv') return toCsv(records);
  throw new Error(`Unknown format ${format}`);
}
