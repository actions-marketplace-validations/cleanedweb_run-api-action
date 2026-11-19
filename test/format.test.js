import { describe, expect, it } from 'vitest';
import { serialize, toCsv, toJsonl } from '../src/format.js';

describe('format', () => {
  it('writes pretty JSON with a trailing newline', () => {
    expect(serialize([{ a: 1 }], 'json')).toBe('[\n  {\n    "a": 1\n  }\n]\n');
  });

  it('writes one record per line as JSONL, and nothing for no records', () => {
    expect(toJsonl([{ a: 1 }, { b: 'x\ny' }])).toBe('{"a":1}\n{"b":"x\\ny"}\n');
    expect(toJsonl([])).toBe('');
  });

  it('writes RFC 4180 CSV with the union of columns', () => {
    const csv = toCsv([
      { title: 'a, b', price: 10 },
      { title: 'say "hi"', note: 'line1\nline2', tags: ['x', 'y'], gone: null },
    ]);
    expect(csv).toBe(
      'title,price,note,tags,gone\r\n' + '"a, b",10,,,\r\n' + '"say ""hi""",,"line1\nline2","[""x"",""y""]",\r\n',
    );
  });

  it('writes only a header-less file for no records', () => {
    expect(toCsv([])).toBe('\r\n');
  });
});
