/* Copyright © 2026 Zenin Easa Panthakkalakath */

// A small, dependency-free CSV reader: quoted fields, doubled quotes, CRLF or LF, a leading byte-order
// mark, blank lines, and comma, semicolon or tab separators (the delimiter is detected, since Excel in
// many locales writes semicolons). A leading "sep=;" line, which Excel writes, is honoured and dropped.
// Returns { header, rows, delimiter } where each row keeps its 1-based line number in the file so an
// error can point at the row the user sees in their spreadsheet (the header is line 1).
const delimiters = [',', ';', '\t'];
const byteOrderMark = /^﻿/;

// The delimiter that splits the first few non-empty lines into the same number (more than one) of
// fields, ignoring anything inside quotes; a comma if none does.
export function detectDelimiter(text) {
    const lines = String(text).replace(byteOrderMark, '').split(/\r?\n/).filter((line) => line.trim() !== '' && !/^sep=/i.test(line)).slice(0, 8);
    const counts = (delimiter) => lines.map((line) => {
        let inQuotes = false;
        let count = 0;
        for (const character of line) {
            if (character === '"') inQuotes = !inQuotes;
            else if (!inQuotes && character === delimiter) count += 1;
        }
        return count;
    });
    let best = { delimiter: ',', score: 0 };
    for (const delimiter of delimiters) {
        const perLine = counts(delimiter);
        const consistent = perLine.length > 0 && perLine[0] > 0 && perLine.every((count) => count === perLine[0]);
        const score = consistent ? perLine[0] : 0;
        if (score > best.score) best = { delimiter, score };
    }
    return best.delimiter;
}

export function parseCsv(text, { delimiter: forcedDelimiter } = {}) {
    let source = String(text ?? '').replace(byteOrderMark, '');
    let separatorLine = 0;
    const declared = source.match(/^sep=(.)\r?\n/i);
    if (declared) { source = source.slice(declared[0].length); separatorLine = 1; }
    const delimiter = forcedDelimiter ?? (declared ? declared[1] : detectDelimiter(source));
    const records = [];
    let field = '';
    let record = [];
    let inQuotes = false;
    let line = 1 + separatorLine;
    let recordLine = 1 + separatorLine;
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
        else if (character === delimiter) endField();
        else if (character === '\r') continue;
        else if (character === '\n') { endRecord(); line += 1; recordLine = line; }
        else field += character;
    }
    if (field !== '' || record.length) endRecord();
    if (!records.length) return { header: [], rows: [], delimiter };
    const [{ values: header }, ...rest] = records;
    return { header: header.map((name) => name.trim()), rows: rest.map(({ line: rowLine, values }) => ({ line: rowLine, values })), delimiter };
}

// Normalizes a column heading for matching: case, spaces, dashes and underscores do not matter, and a
// trailing unit note such as "(EUR m)" is ignored.
export function normalizeHeading(heading) {
    return String(heading).toLowerCase().replace(/\([^)]*\)/g, '').replace(/[\s_-]+/g, '');
}

// Which character separates the decimals in a column of numbers as written by a spreadsheet: ',' when the
// values look like 1.234,56 or 12,5 and nothing looks like 1,234.56 or 12.5; '.' otherwise (including when
// every value is a whole number, where a lone separator is read as a thousands grouping).
export function detectDecimalSeparator(cells) {
    let comma = 0;
    let dot = 0;
    for (const cell of cells) {
        const value = String(cell ?? '').replace(/[\s '€$£¥]/g, '');
        if (/^-?\d+,\d{1,2}$/.test(value) || /^-?\d{1,3}(\.\d{3})+,\d+$/.test(value)) comma += 1;
        else if (/^-?\d+\.\d{1,2}$/.test(value) || /^-?\d{1,3}(,\d{3})+\.\d+$/.test(value)) dot += 1;
    }
    return comma > 0 && dot === 0 ? ',' : '.';
}

// A number as a spreadsheet writes it: currency symbols, spaces and thousands separators are ignored, an
// accounting-style (1,234) is negative, and the decimal separator is the one given. Returns NaN otherwise.
export function parseLocalizedNumber(text, decimal = '.') {
    let value = String(text ?? '').trim();
    const negative = /^\(.*\)$/.test(value);
    if (negative) value = value.slice(1, -1);
    value = value.replace(/[€$£¥]|\b(EUR|USD|GBP|CHF|JPY)\b/gi, '').replace(/[\s '_]/g, '');
    value = decimal === ',' ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value)) return Number.NaN;
    return negative ? -Number(value) : Number(value);
}
