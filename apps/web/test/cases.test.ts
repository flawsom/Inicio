import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/cases';

describe('the CSV reader behind a case import', () => {
  it('reads quoted commas, escaped quotes, CRLF and a trailing newline', () => {
    const parsed = parseCsv(
      'id,head_name,village\r\n' +
        'HH-1,"Amina, the elder",Kigoma\r\n' +
        'HH-2,"Joseph ""Juma""",Mwanza\r\n',
    );
    expect(parsed.columns).toEqual(['id', 'head_name', 'village']);
    expect(parsed.rows).toEqual([
      { id: 'HH-1', head_name: 'Amina, the elder', village: 'Kigoma' },
      { id: 'HH-2', head_name: 'Joseph "Juma"', village: 'Mwanza' },
    ]);
  });

  it('strips a BOM and keeps blank cells as text, not invented values', () => {
    const parsed = parseCsv('\uFEFFid,note\nHH-1,\n');
    expect(parsed.rows).toEqual([{ id: 'HH-1', note: '' }]);
  });

  it('refuses a ragged row instead of padding it silently', () => {
    expect(() => parseCsv('id,name\nHH-1\n')).toThrow(/Row 2 has 1 value/);
  });

  it('refuses duplicate or unusable column names', () => {
    expect(() => parseCsv('id,id\n1,2\n')).toThrow(/same name/);
    expect(() => parseCsv('id,head name\n1,Amina\n')).toThrow(/not a usable column name/);
  });

  it('refuses a header with no rows', () => {
    expect(() => parseCsv('id,name\n')).toThrow(/no data rows/);
  });
});
