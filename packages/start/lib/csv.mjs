/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A small, dependency-free CSV reader: quoted fields, doubled quotes, CRLF or LF, a leading BOM and
// blank lines. Returns { header, rows } where each row keeps its 1-based line number in the file so
// an error can point at the row the user sees in their spreadsheet (the header is line 1).
export function parseCsv(text) {
    const source = String(text ?? '').replace(/^﻿/, '');
    const records = [];
    let field = '';
    let record = [];
    let inQuotes = false;
    let line = 1;
    let recordLine = 1;
    const endField = () => { record.push(field); field = ''; };
    const endRecord = () => {
        endField();
        if (record.some((value) => value.trim() !== '')) records.push({ line: recordLine, values: record });
        record = [];
        recordLine = line + 1;
    };
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        if (inQuotes) {
            if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
            else if (character === '"') inQuotes = false;
            else { field += character; if (character === '\n') line += 1; }
        } else if (character === '"') inQuotes = true;
        else if (character === ',') endField();
        else if (character === '\r') continue;
        else if (character === '\n') { endRecord(); line += 1; recordLine = line; }
        else field += character;
    }
    if (field !== '' || record.length) endRecord();
    if (!records.length) return { header: [], rows: [] };
    const [{ values: header }, ...rest] = records;
    return { header: header.map((name) => name.trim()), rows: rest.map(({ line: rowLine, values }) => ({ line: rowLine, values })) };
}

// Normalizes a column heading for matching: case, spaces, dashes and underscores do not matter.
export function normalizeHeading(heading) {
    return String(heading).toLowerCase().replace(/[\s_\-]+/g, '');
}
