/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { baskets } from './lib/baskets.mjs';
import { drawChart, palette, sparkline } from './lib/charts.mjs';
import { analyzeWindows, preferTogetherDirection, toChanges } from './lib/market.mjs';

const api = window.konjugateLauncher;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const signed = (value, digits = 1) => `${value > 0.5 * 10 ** -digits ? '+' : value < -0.5 * 10 ** -digits ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const notice = (kind, html) => `<div class="notice ${kind}"><div>${html}</div></div>`;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (days) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// Every host call answers { ok: true, ... } or { ok: false, message }; turn the second into an exception.
async function call(promise) {
    const response = await promise;
    if (!response.ok) throw new Error(response.message);
    return response;
}

const state = {
    manifest: null, importer: null, files: [], selection: new Map(), searchType: 'all',
    read: null, excluded: new Set(), range: { from: 0, to: 0 },
    analysis: null, kept: new Set(), built: null, windowLength: null,
    scenarioId: null, entity: null, horizon: 21, drivers: new Set(), run: null,
    busy: false, history: [], refresh: { minutes: 0, timer: null }
};

// ---- steps and tabs ---------------------------------------------------------------------------------------

function show(step) {
    for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === `panel-${step}`);
    for (const button of document.querySelectorAll('.step')) {
        if (button.dataset.step === step) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
    }
    $('main').scrollTop = 0;
}

function refreshSteps() {
    const steps = { data: true, links: Boolean(state.read), whatif: Boolean(state.built), results: Boolean(state.run), learn: true };
    for (const button of document.querySelectorAll('.step')) {
        button.disabled = !steps[button.dataset.step];
        button.classList.toggle('done', Boolean({ data: state.read, links: state.built, whatif: state.run }[button.dataset.step]));
    }
}

for (const button of document.querySelectorAll('.step')) button.addEventListener('click', () => show(button.dataset.step));
document.addEventListener('click', (event) => {
    const page = event.target.closest('[data-page]')?.dataset.page;
    if (page) call(api.openPage(page)).catch((error) => console.error(error));
});

function showTab(name) {
    for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.toggle('hidden', panel.id !== `tab-${name}`);
}
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => showTab(tab.dataset.tab));

// ---- the selection to fetch -------------------------------------------------------------------------------

const kindNames = { EQUITY: 'Stock', ETF: 'Fund', MUTUALFUND: 'Fund', INDEX: 'Index', FUTURE: 'Future', CURRENCY: 'Currency', CRYPTOCURRENCY: 'Crypto' };
const typeFilters = [['all', 'All'], ['EQUITY', 'Stocks'], ['fund', 'Funds'], ['INDEX', 'Indices'], ['FUTURE', 'Futures'], ['CURRENCY', 'Currencies'], ['CRYPTOCURRENCY', 'Crypto']];
const seriesName = (entry) => (entry.label && entry.label !== entry.symbol ? `${entry.label} (${entry.symbol})` : entry.symbol);

function addToSelection(entry) {
    state.selection.set(entry.symbol, { source: 'yahoo', ...entry });
    renderTray();
}

function removeFromSelection(symbol) {
    state.selection.delete(symbol);
    renderTray();
}

function renderTray() {
    const entries = [...state.selection.values()];
    $('#trayCount').textContent = String(entries.length);
    $('#trayChips').innerHTML = entries.length
        ? entries.map((entry) => `<span class="chip">${escapeHtml(entry.label && entry.label !== entry.symbol ? `${entry.label} · ${entry.symbol}` : entry.symbol)}<button class="x" type="button" data-unselect="${escapeHtml(entry.symbol)}" aria-label="Remove ${escapeHtml(entry.symbol)}">×</button></span>`).join('')
        : '<span class="empty">Nothing chosen yet. Search, or add a group.</span>';
    $('#fetchNow').disabled = state.busy || !entries.length;
    $('#clearSelection').disabled = !entries.length;
    renderFetchNote();
    for (const box of document.querySelectorAll('[data-pick]')) box.checked = state.selection.has(box.dataset.pick);
    renderBasketButtons();
}

$('#trayChips').addEventListener('click', (event) => { if (event.target.dataset.unselect) removeFromSelection(event.target.dataset.unselect); });
$('#clearSelection').addEventListener('click', () => { state.selection.clear(); renderTray(); });

// ---- search -----------------------------------------------------------------------------------------------

let searchTimer = null;
let searchToken = 0;
let lastResults = [];

function renderSearchTypes() {
    $('#searchTypes').innerHTML = typeFilters.map(([value, label]) => `<button class="chip" type="button" data-type="${value}" aria-pressed="${state.searchType === value}">${label}</button>`).join('');
}
$('#searchTypes').addEventListener('click', (event) => {
    const type = event.target.dataset.type;
    if (!type) return;
    state.searchType = type;
    renderSearchTypes();
    renderSearchResults();
});

function renderSearchResults() {
    const shown = lastResults.filter((quote) => state.searchType === 'all' || quote.quoteType === state.searchType || (state.searchType === 'fund' && ['ETF', 'MUTUALFUND'].includes(quote.quoteType)));
    $('#searchResults').innerHTML = shown.length ? shown.map((quote) => `<label class="result"><input type="checkbox" data-pick="${escapeHtml(quote.symbol)}" data-label="${escapeHtml(quote.label)}" data-kind="${escapeHtml(quote.quoteType)}" ${state.selection.has(quote.symbol) ? 'checked' : ''}>
        <span><b>${escapeHtml(quote.label)}</b> <span class="sym">${escapeHtml(quote.symbol)}</span><br><span class="empty">${escapeHtml(quote.exchDisp ?? '')}</span></span><span class="kind">${escapeHtml(kindNames[quote.quoteType] ?? quote.quoteType)}</span></label>`).join('') : '';
}

async function runSearch(query) {
    const token = ++searchToken;
    const status = $('#searchStatus');
    if (query.trim().length < 2) { lastResults = []; renderSearchResults(); status.textContent = ''; return; }
    status.textContent = 'Searching…';
    try {
        const response = await call(api.fetchText(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query.trim())}&quotesCount=25&newsCount=0&listsCount=0`));
        if (token !== searchToken) return;
        const quotes = (JSON.parse(response.text).quotes ?? []).filter((quote) => quote.symbol && kindNames[quote.quoteType])
            .map((quote) => ({ ...quote, label: String(quote.shortname ?? quote.longname ?? quote.symbol).replace(/\s+/g, ' ').trim().slice(0, 34) }));
        lastResults = quotes;
        status.textContent = quotes.length ? `${plural(quotes.length, 'match')}. Tick the ones to add.` : 'Nothing matched. Try another name or the exact symbol.';
        renderSearchResults();
    } catch (error) {
        if (token === searchToken) status.textContent = `Search failed: ${error.message}`;
    }
}
$('#searchBox').addEventListener('input', (event) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(event.target.value), 350); });
$('#searchResults').addEventListener('change', (event) => {
    const box = event.target;
    if (!box.dataset.pick) return;
    if (box.checked) addToSelection({ symbol: box.dataset.pick, label: box.dataset.label, kind: box.dataset.kind });
    else removeFromSelection(box.dataset.pick);
});

// ---- groups -----------------------------------------------------------------------------------------------

function renderBaskets() {
    $('#basketList').innerHTML = baskets.map((basket, index) => `<details class="basket" data-basket="${index}"><summary>${escapeHtml(basket.name)} <span class="about">${escapeHtml(basket.about)}</span>
        <button class="button" type="button" data-basket-all="${index}" style="padding: 3px 12px"></button></summary>
        <div class="members">${basket.members.map((member) => `<label class="check"><input type="checkbox" data-pick="${escapeHtml(member.symbol)}" data-label="${escapeHtml(member.label)}"> ${escapeHtml(member.label)} <span class="sym">${escapeHtml(member.symbol)}</span></label>`).join('')}</div></details>`).join('');
    renderBasketButtons();
}

function renderBasketButtons() {
    for (const button of document.querySelectorAll('[data-basket-all]')) {
        const basket = baskets[Number(button.dataset.basketAll)];
        const all = basket.members.every((member) => state.selection.has(member.symbol));
        button.textContent = all ? 'Remove all' : `Add all ${basket.members.length}`;
    }
}

$('#basketList').addEventListener('click', (event) => {
    const index = event.target.dataset.basketAll;
    if (index === undefined) return;
    event.preventDefault();
    const basket = baskets[Number(index)];
    const all = basket.members.every((member) => state.selection.has(member.symbol));
    for (const member of basket.members) {
        if (all) state.selection.delete(member.symbol);
        else state.selection.set(member.symbol, { source: 'yahoo', symbol: member.symbol, label: member.label });
    }
    renderTray();
});
$('#basketList').addEventListener('change', (event) => {
    const box = event.target;
    if (!box.dataset.pick) return;
    if (box.checked) addToSelection({ symbol: box.dataset.pick, label: box.dataset.label });
    else removeFromSelection(box.dataset.pick);
});

// ---- typed symbols ----------------------------------------------------------------------------------------

const sourceHints = {
    yahoo: 'Yahoo Finance symbols, for example SPY, ^GSPC (S&P 500), BZ=F (Brent crude), GC=F (gold), ^TNX (ten-year yield), EURUSD=X. Search finds the right symbol from a name.',
    fred: 'FRED series ids, for example DGS10 (ten-year yield), DEXUSEU (dollar per euro), DCOILBRENTEU (Brent crude). Daily or slower.',
    stooq: 'Stooq symbols, for example spy.us, ^spx, eurusd. Daily. Stooq may ask for a browser check and refuse a program; if it does, use another source.'
};
function renderSymbolHint() {
    $('#symbolHint').textContent = `${sourceHints[$('#symbolSource').value]} This window may reach only ${state.manifest.network.hosts.join(', ')}.`;
}
$('#symbolSource').addEventListener('change', renderSymbolHint);
$('#addSymbols').addEventListener('click', () => {
    const source = $('#symbolSource').value;
    for (const symbol of $('#symbolBox').value.split(/[\s,;]+/).map((item) => item.trim()).filter(Boolean)) addToSelection({ source, symbol, label: symbol });
    $('#symbolBox').value = '';
});

// ---- what to fetch, and how far back ----------------------------------------------------------------------

// Yahoo keeps about two years of hourly bars and about sixty days of five-minute bars.
const intradayLimits = { '1h': 729, '5m': 59 };
const presetRanges = [['1 year', 365], ['2 years', 730], ['5 years', 1826], ['10 years', 3652], ['As far back as exists', null]];

function renderPresets() {
    const intraday = intradayLimits[$('#fetchBars').value];
    $('#rangePresets').innerHTML = presetRanges.filter(([, days]) => !intraday || (days !== null && days <= intraday))
        .map(([label, days]) => `<button class="chip" type="button" data-preset="${days ?? 'max'}">${label}</button>`).join('')
        + (intraday ? `<button class="chip" type="button" data-preset="${intraday}">The longest available (${intraday} days)</button>` : '');
}

function applyBarLimits() {
    const limit = intradayLimits[$('#fetchBars').value];
    const from = $('#fetchFrom');
    from.min = limit ? daysAgo(limit) : '';
    if (limit && (!from.value || from.value < from.min)) from.value = from.min;
    renderPresets();
    renderFetchNote();
}

$('#fetchBars').addEventListener('change', applyBarLimits);
$('#fetchFrom').addEventListener('change', renderFetchNote);
$('#fetchTo').addEventListener('change', () => { $('#fetchLatest').checked = false; renderFetchNote(); });
$('#fetchLatest').addEventListener('change', () => { if ($('#fetchLatest').checked) $('#fetchTo').value = today(); renderFetchNote(); });
$('#rangePresets').addEventListener('click', (event) => {
    const preset = event.target.dataset.preset;
    if (!preset) return;
    $('#fetchFrom').value = preset === 'max' ? '1970-01-01' : daysAgo(Number(preset));
    $('#fetchTo').value = today();
    $('#fetchLatest').checked = true;
    renderFetchNote();
});

function renderFetchNote() {
    const bars = $('#fetchBars').value;
    const notYahoo = [...state.selection.values()].some((entry) => entry.source !== 'yahoo');
    const parts = [];
    if (bars !== '1d') parts.push(`${bars === '1h' ? 'Hourly' : 'Five-minute'} bars are limited to the last ${intradayLimits[bars]} days, and only Yahoo Finance serves them.`);
    if (notYahoo && bars !== '1d') parts.push('FRED and Stooq series are always daily, so they cannot be lined up with intraday bars.');
    if (state.selection.size > 12) parts.push(`${state.selection.size} series will take a little while to fetch, a few at a time.`);
    if (state.selection.size > 40) parts.push('At most 40 series can be analysed at once.');
    $('#fetchNote').textContent = parts.join(' ');
}

function fetchUrl(entry) {
    const bars = entry.source === 'yahoo' ? $('#fetchBars').value : '1d';
    const from = $('#fetchFrom').value || daysAgo(730);
    const latest = $('#fetchLatest').checked;
    const to = $('#fetchTo').value || today();
    if (entry.source === 'fred') return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(entry.symbol)}&cosd=${from}${latest ? '' : `&coed=${to}`}`;
    if (entry.source === 'stooq') return `https://stooq.com/q/d/l/?s=${encodeURIComponent(entry.symbol.toLowerCase())}&i=d&d1=${from.replaceAll('-', '')}${latest ? '' : `&d2=${to.replaceAll('-', '')}`}`;
    const start = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
    // "Up to the latest" asks for a far-future end, so fetching the same address again later brings newer bars.
    const end = latest ? 4102444800 : Math.floor(Date.parse(`${to}T00:00:00Z`) / 1000) + 86400;
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(entry.symbol)}?period1=${Math.max(0, start)}&period2=${end}&interval=${bars}`;
}

$('#fetchNow').addEventListener('click', async () => {
    const entries = [...state.selection.values()];
    if (!entries.length) return;
    state.busy = true;
    $('#fetchNow').disabled = true;
    const failures = [];
    let fetched = 0;
    try {
        if (state.files.some((file) => file.sample)) await call(api.clearFile(state.importer.importerId, 'series'));
        // A few at a time: gentle on the source, and quick enough.
        const queue = [...entries];
        const worker = async () => {
            for (let entry = queue.shift(); entry; entry = queue.shift()) {
                $('#fetchStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>Fetching ${escapeHtml(entry.symbol)} (${fetched + failures.length + 1} of ${entries.length})…</span></div>`;
                try {
                    await call(api.fetchFile(state.importer.importerId, 'series', fetchUrl(entry), `${seriesName(entry)}.csv`));
                    fetched += 1;
                    state.selection.delete(entry.symbol);
                } catch (error) { failures.push(`${entry.symbol}: ${error.message}`); }
                await wait(150);
            }
        };
        await Promise.all([worker(), worker(), worker()]);
        await syncFiles();
        invalidateData();
        renderTray();
        $('#fetchStatus').innerHTML = failures.length ? notice('warning', `<strong>${plural(failures.length, 'symbol')} could not be fetched and ${failures.length === 1 ? 'is' : 'are'} still in your selection.</strong><ul>${failures.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`) : '';
        if (state.files.length >= 2) await readData();
    } catch (error) {
        $('#fetchStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        renderTray();
        renderSlot();
    }
});

// ---- files ------------------------------------------------------------------------------------------------

function renderSlot() {
    const slot = $('#seriesSlot');
    const files = state.files;
    slot.innerHTML = `
        <p class="description">${escapeHtml(state.importer.files[0].description)}</p>
        <div class="file-list">${files.length ? files.map((file) => `<div class="file-line"><span class="name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}${file.sample ? ' (sample)' : file.fetched ? ' (fetched)' : ''}</span><button class="button link" type="button" data-remove="${escapeHtml(file.name)}">Remove</button></div>`).join('') : '<div class="file-line"><span class="empty">No files chosen</span></div>'}</div>
        <div class="actions" style="margin-top: 4px"><button class="button" type="button" id="addFiles">${files.length ? 'Add more files…' : 'Choose files…'}</button></div>`;
    $('#readData').disabled = state.busy || files.length < 2;
    $('#readData').textContent = files.length ? `Read my ${files.length} series` : 'Read my series';
}

$('#seriesSlot').addEventListener('click', async (event) => {
    try {
        if (event.target.id === 'addFiles') {
            const result = await call(api.chooseFile(state.importer.importerId, 'series'));
            if (!result.chosen) return;
            if (state.files.some((file) => file.sample)) await call(api.clearFile(state.importer.importerId, 'series'));
        } else if (event.target.dataset.remove) await call(api.clearFile(state.importer.importerId, 'series', event.target.dataset.remove));
        else return;
        await syncFiles();
        invalidateData();
    } catch (error) {
        $('#importStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
});

async function syncFiles() {
    const manifest = await call(api.getManifest());
    state.files = manifest.files.series ?? [];
}

function invalidateData() {
    stopRefresh();
    Object.assign(state, { read: null, analysis: null, kept: new Set(), built: null, run: null, history: [], windowLength: null, excluded: new Set() });
    for (const id of ['#importResult', '#importStatus', '#previewArea', '#linkResult']) $(id).replaceChildren();
    $('#refreshCard').classList.add('hidden');
    renderSlot();
    refreshSteps();
}

$('#useSample').addEventListener('click', async () => {
    try {
        await call(api.useSample(state.importer.importerId));
        await syncFiles();
        invalidateData();
        await readData();
    } catch (error) {
        $('#importStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
});

$('#readData').addEventListener('click', () => readData());

// ---- reading, and the preview -----------------------------------------------------------------------------

const problemList = (report) => report.errors.map((item) => `<li>${item.file ? `<span class="where">${escapeHtml(item.file)}</span>` : ''}${escapeHtml(item.message)}</li>`).join('');
const kindOf = (name) => state.read.data.kinds[state.read.data.names.indexOf(name)];
const isReturn = (name) => kindOf(name) === 'log return';
// A change in a price is written in percent; a change in a rate or spread in the rate's own points.
const change = (name, value, digits = 1) => (isReturn(name) ? `${signed(value, digits)}%` : `${signed(value, digits + 1)} pts`);

async function readData({ keepRange = false } = {}) {
    const previous = keepRange && state.read ? { from: state.read.data.dates[state.range.from], to: state.read.data.dates[state.range.to], toWasLast: state.range.to === state.read.data.dates.length - 1 } : null;
    state.busy = true;
    renderSlot();
    $('#importStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Reading your series…</span></div>';
    try {
        const result = await call(api.runImport(state.importer.importerId, { stage: 'read', exclude: [...state.excluded] }));
        $('#importStatus').replaceChildren();
        if (!result.data) {
            state.read = null;
            $('#importResult').innerHTML = notice('error', `<strong>${result.report.errors.length === 1 ? 'One problem needs fixing' : `${result.report.errors.length} problems need fixing`}.</strong><ul>${problemList(result.report)}</ul>`);
            $('#previewArea').replaceChildren();
        } else {
            state.read = { data: result.data, report: result.report };
            const { dates } = result.data;
            const nearest = (date, fallback) => { const index = dates.findIndex((candidate) => candidate >= date); return index < 0 ? fallback : index; };
            state.range = previous
                ? { from: nearest(previous.from, 0), to: previous.toWasLast ? dates.length - 1 : Math.max(0, Math.min(dates.length - 1, dates.findLastIndex((candidate) => candidate <= previous.to))) }
                : { from: 0, to: dates.length - 1 };
            if (!previous) Object.assign(state, { analysis: null, built: null, run: null });
            renderPreview();
        }
    } catch (error) {
        $('#importStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        renderSlot();
        refreshSteps();
    }
}

// The levels of the chosen range, and the changes between its bars.
function view() {
    const { names, dates, columns } = state.read.data;
    const { from, to } = state.range;
    const cropped = { names, dates: dates.slice(from, to + 1), columns: columns.map((column) => column.slice(from, to + 1)) };
    return { cropped, changes: toChanges(cropped) };
}

function spanText(bars) {
    const { dates } = state.read.data;
    const first = Date.parse(dates[0].replace(' ', 'T'));
    const last = Date.parse(dates.at(-1).replace(' ', 'T'));
    if (!Number.isFinite(first) || !Number.isFinite(last) || dates.length < 2) return '';
    const days = (bars * (last - first)) / (dates.length - 1) / 86400000;
    if (days < 1.5) return `about ${Math.max(1, Math.round(days * 24))} hours`;
    if (days < 21) return `about ${Math.round(days)} days`;
    if (days < 70) return `about ${Math.round(days / 7)} weeks`;
    if (days < 700) return `about ${Math.round(days / 30.4)} months`;
    return `about ${(days / 365).toFixed(1)} years`;
}

function renderPreview() {
    const { data, report } = state.read;
    const warnings = report.warnings.length ? notice('warning', `<strong>${report.warnings.length === 1 ? 'One thing to know' : `${report.warnings.length} things to know`}</strong><ul>${report.warnings.map((item) => `<li>${item.file ? `<span class="where">${escapeHtml(item.file)}</span>` : ''}${escapeHtml(item.message)}</li>`).join('')}</ul>`) : '';
    const lostMost = [...data.lost].sort((a, b) => b.lost - a.lost)[0];
    $('#importResult').innerHTML = `${notice('ok', `<strong>Your series are ready to check.</strong> ${data.names.length} series share ${plural(data.dates.length, 'bar')}, from ${escapeHtml(data.dates[0])} to ${escapeHtml(data.dates.at(-1))}.`)}${warnings}`
        + (lostMost && lostMost.lost > data.dates.length * 0.25 ? notice('warning', `<strong>${escapeHtml(lostMost.name)} has ${plural(lostMost.lost, 'bar')} the others do not</strong>, so the shared calendar is shorter than it could be. Switch it off below to get the others' full history back.`) : '');
    $('#previewArea').innerHTML = `
        <div class="card range-card" id="rangeCard"></div>
        <h3>Preview</h3>
        <p class="lede" style="margin: 0">Each series on its own scale. The shaded part is the range that will be used. Switch a series off to leave it out.</p>
        <div class="preview-grid" id="previewGrid"></div>
        <div class="actions"><button class="button primary" type="button" id="toLinks">Look for links in this range</button></div>`;
    renderRange();
    renderGrid();
    $('#toLinks').addEventListener('click', () => { renderLinkControls(); show('links'); });
}

function renderRange() {
    const { dates } = state.read.data;
    const { from, to } = state.range;
    const held = dates.length - 1 - to;
    $('#rangeCard').innerHTML = `<div class="title">Range to use</div>
        <p class="lede" style="margin: 4px 0 0"><b>${escapeHtml(dates[from])}</b> to <b>${escapeHtml(dates[to])}</b> · ${plural(to - from, 'bar')} (${spanText(to - from)})${held > 0 ? ` · the last ${plural(held, 'bar')} (${spanText(held)}) are held back, so what happens next can be compared with what the model expects` : ''}</p>
        <div class="sliders"><input type="range" id="rangeFrom" min="0" max="${dates.length - 1}" value="${from}" aria-label="Start of the range"><input type="range" id="rangeTo" min="0" max="${dates.length - 1}" value="${to}" aria-label="End of the range, the as-of date"></div>
        <div class="chips" id="rangeQuick">
            <button class="chip" type="button" data-quick="all">Use everything</button>
            <button class="chip" type="button" data-quick="year">Only the last year</button>
            <button class="chip" type="button" data-quick="hold1">Hold back the last month</button>
            <button class="chip" type="button" data-quick="hold3">Hold back the last 3 months</button>
        </div>`;
    const clampRange = (nextFrom, nextTo) => {
        const minimum = Math.min(40, dates.length - 1);
        let f = Math.max(0, Math.min(nextFrom, dates.length - 1 - minimum));
        const t = Math.min(dates.length - 1, Math.max(nextTo, f + minimum));
        if (t - f < minimum) f = Math.max(0, t - minimum);
        state.range = { from: f, to: t };
        Object.assign(state, { analysis: null, built: null, run: null });
        $('#linkResult').replaceChildren();
        refreshSteps();
        renderRange();
        renderGrid();
    };
    $('#rangeFrom').addEventListener('input', (event) => clampRange(Number(event.target.value), state.range.to));
    $('#rangeTo').addEventListener('input', (event) => clampRange(state.range.from, Number(event.target.value)));
    $('#rangeQuick').addEventListener('click', (event) => {
        const quick = event.target.dataset.quick;
        if (!quick) return;
        const last = dates.length - 1;
        const spanDays = Math.max(1, (Date.parse(dates.at(-1).replace(' ', 'T')) - Date.parse(dates[0].replace(' ', 'T'))) / 86400000);
        const back = (days) => Math.round((days * last) / spanDays);
        if (quick === 'all') clampRange(0, last);
        else if (quick === 'year') clampRange(last - back(365), last);
        else clampRange(state.range.from, last - back(quick === 'hold1' ? 30 : 91));
    });
}

// A level to a readable number of digits: 4,202.7 for a large price, 0.6357 for a small one.
const level = (value) => (Math.abs(value) >= 1000 ? value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : String(Number(value.toPrecision(5))));

function renderGrid() {
    const { names, kinds, columns, dates } = state.read.data;
    const { from, to } = state.range;
    $('#previewGrid').innerHTML = names.map((name, index) => {
        const column = columns[index];
        const start = column[from];
        const end = column[to];
        const total = kinds[index] === 'log return' ? `${signed(100 * (end / start - 1))}%` : `${signed(end - start, 2)} pts`;
        return `<div class="preview"><div class="head"><span class="n" title="${escapeHtml(name)}">${escapeHtml(name)}</span><span class="chip">${kinds[index] === 'log return' ? 'price' : 'rate'}</span></div>
            ${sparkline(column, { from, to })}
            <div class="stats"><span>${total}</span><span>${level(end)} on ${escapeHtml(dates[to].slice(0, 10))}</span></div>
            <label class="check"><input type="checkbox" data-use="${escapeHtml(name)}" checked> Use in the analysis</label></div>`;
    }).join('');
}

$('#previewArea').addEventListener('change', async (event) => {
    const name = event.target.dataset.use;
    if (name === undefined) return;
    if (!event.target.checked) state.excluded.add(name); else state.excluded.delete(name);
    // Switching a series off lines the rest up again, since it may have been what shortened the shared calendar.
    for (const box of document.querySelectorAll('[data-use]')) box.disabled = true;
    Object.assign(state, { analysis: null, built: null, run: null });
    $('#linkResult').replaceChildren();
    await readData({ keepRange: true });
});

// ---- step 2: links ----------------------------------------------------------------------------------------

const linkKey = (link) => `${link.kind}|${link.source}|${link.target}`;
const edgeKey = (edge) => `${edge.provenance === 'correlationOnly' ? 'together' : 'lagged'}|${edge.sourceColumn}|${edge.targetColumn}`;
// The analysis names a series column with a safe version of its name (see inferenceCsv in lib/market.mjs); this puts the name back.
const safeName = (name) => name.replace(/[^A-Za-z0-9_.-]+/g, '_');
const nice = (column) => state.read?.data.names.find((name) => safeName(name) === column) ?? column;
const niceKey = (key) => key.split('|').slice(1).map(nice).join(' → ');

function windowChoices() {
    const bars = state.range.to - state.range.from;
    return [60, 120, 250, 500, 1000, 2000].filter((length) => length * 2 <= bars);
}

function renderLinkControls() {
    const choices = windowChoices();
    const { dates } = state.read.data;
    const held = dates.length - 1 - state.range.to;
    const asOf = `<p class="lede" style="margin: 0 0 10px">Learning from <b>${escapeHtml(dates[state.range.from])}</b> to <b>${escapeHtml(dates[state.range.to])}</b>${held > 0 ? `; the last ${plural(held, 'bar')} are held back for comparison` : ''}. <button class="button link" type="button" id="changeRange">Change the range</button></p>`;
    if (!choices.length) {
        $('#linkControls').innerHTML = `${asOf}<p>${escapeHtml(`Only ${state.range.to - state.range.from} bars are in the range, too few to compare separate stretches of history. Widen the range or use series with more history.`)}</p>`;
        $('#changeRange').addEventListener('click', () => show('data'));
        return;
    }
    if (!choices.includes(state.windowLength)) state.windowLength = choices.includes(120) ? 120 : choices[0];
    $('#linkControls').innerHTML = `${asOf}<label class="field" style="margin-top: 0">Length of each stretch of history
            <select id="windowLength">${choices.map((length) => `<option value="${length}" ${length === state.windowLength ? 'selected' : ''}>${length} bars (${spanText(length)})</option>`).join('')}</select></label>
        <p class="lede" style="margin-top: 8px">Stretches end at the as-of date and step back without overlapping, up to 8 of them. Longer stretches find steadier links but react more slowly to change.</p>
        <div class="actions"><button class="button primary" type="button" id="findLinks">${state.analysis ? 'Look again' : 'Find links'}</button></div>`;
    $('#changeRange').addEventListener('click', () => show('data'));
    $('#windowLength').addEventListener('change', (event) => { state.windowLength = Number(event.target.value); });
    $('#findLinks').addEventListener('click', () => findLinks());
}

async function findLinks({ quiet = false } = {}) {
    const { changes } = view();
    state.busy = true;
    if (!quiet) $('#linkStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Looking for links…</span></div>';
    try {
        const infer = async (csv, config) => {
            const response = await call(api.infer(csv, config));
            return { edges: response.edges, selfTerms: response.selfTerms };
        };
        const analysis = await analyzeWindows(changes, { length: state.windowLength, count: 8 }, infer, (progress) => {
            if (!quiet) $('#linkStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>Looking at stretch ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…</span></div>`;
        });
        // Which way a same-bar pair points is not in the data; the one into the more volatile series is ticked.
        const spread = new Map(changes.names.map((name, index) => {
            const column = changes.columns[index];
            const mean = column.reduce((sum, value) => sum + value, 0) / column.length;
            return [safeName(name), Math.sqrt(column.reduce((sum, value) => sum + (value - mean) ** 2, 0) / column.length)];
        }));
        analysis.together = preferTogetherDirection(analysis.together, (name) => spread.get(name));
        state.analysis = analysis;
        const worthKeeping = (link) => link.latest && (link.label === 'stable' || link.label === 'sometimes');
        state.kept = new Set([...analysis.links.filter(worthKeeping), ...analysis.together.filter((link) => worthKeeping(link) && link.preferred)].map(linkKey));
        state.built = null;
        state.run = null;
        recordHistory();
        $('#linkStatus').replaceChildren();
        renderLinks();
        renderRefresh();
    } catch (error) {
        $('#linkStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        refreshSteps();
    }
}

const labelText = { stable: 'Steady', sometimes: 'Comes and goes', unstable: 'Unsteady', 'too few windows to say': 'Too few stretches' };
const labelClass = { stable: 'ok', sometimes: 'warn', unstable: 'bad', 'too few windows to say': 'warn' };

function linkRows(rows, together) {
    return rows.map((link) => {
        const key = linkKey(link);
        const usable = link.latest;
        return `<tr class="${usable ? '' : 'faded'}"><td><input type="checkbox" data-link="${escapeHtml(key)}" ${state.kept.has(key) ? 'checked' : ''} ${usable ? '' : 'disabled'} aria-label="Use ${escapeHtml(nice(link.source))} to ${escapeHtml(nice(link.target))}"></td>
            <td>${escapeHtml(nice(link.source))} → ${escapeHtml(nice(link.target))}</td>
            <td>${link.sign > 0 ? 'moves with it' : link.sign < 0 ? 'moves against it' : 'mixed'}${link.signAgreement < 0.9 ? ' <span class="empty">(direction varies)</span>' : ''}</td>
            ${together ? '' : `<td>${link.lag} bar${link.lag === 1 ? '' : 's'}</td>`}
            <td>${link.appearances} of ${link.windows}</td>
            <td><span class="status ${labelClass[link.label]}">${labelText[link.label]}</span>${usable ? '' : ' <span class="empty">not in the newest stretch</span>'}</td></tr>`;
    }).join('');
}

function renderLinks() {
    const { analysis } = state;
    const first = analysis.windows.at(-1);
    const last = analysis.windows[0];
    $('#linkResult').innerHTML = `
        ${notice('ok', `<strong>${analysis.windows.length === 1 ? '1 stretch' : `${analysis.windows.length} stretches`} of ${state.windowLength} bars examined</strong>, from ${escapeHtml(first.from)} to ${escapeHtml(last.to)}.${analysis.overlapping ? ' The stretches overlap, so the counts below overstate how steady a link is.' : ''}`)}
        <h3>Leads and lags</h3>
        <p class="lede" style="margin: 0 0 8px">One series' move helps predict another's move a bar later.</p>
        ${analysis.links.length ? `<div class="card" style="padding: 6px 10px"><table id="linkTable"><thead><tr><th>Use</th><th>Link</th><th>Effect</th><th>Delay</th><th>Seen in</th><th>How steady</th></tr></thead><tbody>${linkRows(analysis.links, false)}</tbody></table></div>`
            : notice('warning', '<strong>No lead-lag links were found.</strong> That is a real answer: on daily data, liquid markets rarely lead each other by a whole bar. Series that trade at different hours, or move more slowly, are likelier to.')}
        <h3>Moves together in the same bar</h3>
        <p class="lede" style="margin: 0 0 8px">Series that move in step. The data cannot say which drives which, so where both directions appear the one into the more volatile series is ticked, the way a beta is read (gold miners follow gold).</p>
        ${analysis.together.length ? `<div class="card" style="padding: 6px 10px"><table id="togetherTable"><thead><tr><th>Use</th><th>Link</th><th>Effect</th><th>Seen in</th><th>How steady</th></tr></thead><tbody>${linkRows(analysis.together, true)}</tbody></table></div>`
            : notice('warning', '<strong>No same-bar co-movement was found.</strong>')}
        <details class="detail"><summary>How to read this</summary><ul>
            <li>A link means the data show a relationship, judged on data the fit had not seen. It does not prove one series causes the other.</li>
            <li>Steady means it appeared in most stretches with the same direction. Comes and goes and Unsteady links are weaker evidence, and are left out unless you tick them.</li>
            <li>Only links present in the newest stretch can be used, since the model is built from it.</li>
            <li>Lead-lag links with a delay of more than one bar may be missed.</li>
            <li>In the model, a same-bar link makes the follower respond within about a bar of the driver moving, by the size shown in the effect. A lead-lag link makes it respond about a bar later.</li>
        </ul></details>
        <div class="actions"><button class="button primary" type="button" id="buildModel">Build the model with ${plural(state.kept.size, 'link')}</button></div>
        <div id="buildStatus" aria-live="polite"></div>`;
    for (const id of ['#linkTable', '#togetherTable']) {
        $(id)?.addEventListener('change', (event) => {
            const key = event.target.dataset.link;
            if (key === undefined) return;
            if (event.target.checked) state.kept.add(key); else state.kept.delete(key);
            state.built = null;
            state.run = null;
            $('#buildModel').textContent = `Build the model with ${plural(state.kept.size, 'link')}`;
            refreshSteps();
        });
    }
    $('#buildModel').addEventListener('click', buildModel);
}

async function buildModel() {
    const newest = state.analysis.reports[0];
    const keptEdges = newest.edges.filter((edge) => state.kept.has(edgeKey(edge)));
    const { dates } = state.read.data;
    state.busy = true;
    $('#buildStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Building the model…</span></div>';
    try {
        const result = await call(api.runImport(state.importer.importerId, {
            stage: 'build', edges: keptEdges, selfTerms: newest.selfTerms, exclude: [...state.excluded], from: dates[state.range.from], to: dates[state.range.to]
        }));
        if (!result.imported) throw new Error(result.report.errors.map((item) => item.message).join(' ') || 'The model could not be built.');
        state.built = { report: result.report, entities: result.entities };
        state.run = null;
        state.drivers = defaultDrivers();
        $('#buildStatus').innerHTML = notice('ok', `<strong>Model built</strong> from ${plural(result.report.summary.links, 'link')}, as of ${escapeHtml(dates[state.range.to])}.${result.report.warnings.length ? `<ul>${result.report.warnings.map((item) => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>` : ''} <button class="button link" type="button" id="toWhatIf">Look ahead</button>`);
        $('#toWhatIf').addEventListener('click', () => { renderScenarios(); show('whatif'); });
        renderScenarios();
    } catch (error) {
        $('#buildStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        refreshSteps();
    }
}

// The series that have a kept link going out of them are the natural ones to replay.
function defaultDrivers() {
    const sources = new Set([...state.kept].map((key) => nice(key.split('|')[1])));
    return new Set([...sources].filter((name) => state.built.entities.includes(name)));
}

// ---- keeping up to date -----------------------------------------------------------------------------------

function recordHistory() {
    const links = [...state.analysis.links, ...state.analysis.together].map((link) => ({ key: linkKey(link), label: link.label, latest: link.latest }));
    const previous = state.history[0];
    const steady = (entry) => new Set(entry.links.filter((link) => link.latest && (link.label === 'stable' || link.label === 'sometimes')).map((link) => link.key));
    const now = steady({ links });
    const before = previous ? steady(previous) : null;
    state.history.unshift({
        at: new Date(), to: state.analysis.windows[0].to, links,
        added: before ? [...now].filter((key) => !before.has(key)) : [], dropped: before ? [...before].filter((key) => !now.has(key)) : []
    });
    state.history.length = Math.min(state.history.length, 20);
}

function renderRefresh() {
    const fromFiles = state.files.length > 0 && !state.files.some((file) => file.sample);
    const card = $('#refreshCard');
    card.classList.remove('hidden');
    const rows = state.history.map((entry, index) => `<tr><td>${entry.at.toLocaleTimeString()}</td><td>${escapeHtml(entry.to)}</td><td>${plural(entry.links.filter((link) => link.latest && (link.label === 'stable' || link.label === 'sometimes')).length, 'steady link')}</td>
        <td>${index === state.history.length - 1 ? 'First look' : `${entry.added.length ? `New: ${entry.added.map((key) => escapeHtml(niceKey(key))).join(', ')}. ` : ''}${entry.dropped.length ? `Gone: ${entry.dropped.map((key) => escapeHtml(niceKey(key))).join(', ')}.` : ''}${!entry.added.length && !entry.dropped.length ? 'No change.' : ''}`}</td></tr>`).join('');
    card.innerHTML = `<h3 style="margin-top: 0">Keep it up to date</h3>
        <p class="lede">${fromFiles ? 'Reads your files again (or fetches the series again), looks for links again and rebuilds, so the model follows the market. If the range ends at the latest bar it grows with the data; if you held bars back it stays where you put it.' : 'The sample series never change. Choose or fetch your own series to keep the analysis up to date.'} It runs only while this window is open.</p>
        <div class="actions" style="margin-top: 10px"><button class="button" type="button" id="rebuildNow" ${fromFiles ? '' : 'disabled'}>Reload and rebuild now</button>
        <label class="inline">Every <select id="refreshEvery" ${fromFiles ? '' : 'disabled'}>${[0, 5, 15, 30, 60].map((minutes) => `<option value="${minutes}" ${minutes === state.refresh.minutes ? 'selected' : ''}>${minutes ? `${minutes} minutes` : 'never (manual)'}</option>`).join('')}</select></label></div>
        <div id="refreshNote" class="empty" style="margin-top: 8px" aria-live="polite"></div>
        ${state.history.length > 1 ? `<h3>Earlier looks</h3><table><thead><tr><th>At</th><th>Data to</th><th>Steady links</th><th>What changed</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
    $('#rebuildNow').addEventListener('click', () => rebuild('manual'));
    $('#refreshEvery').addEventListener('change', (event) => setRefresh(Number(event.target.value)));
}

function stopRefresh() {
    if (state.refresh.timer) clearInterval(state.refresh.timer);
    state.refresh.timer = null;
    state.refresh.minutes = 0;
}

function setRefresh(minutes) {
    if (state.refresh.timer) clearInterval(state.refresh.timer);
    state.refresh.timer = null;
    state.refresh.minutes = minutes;
    if (minutes) state.refresh.timer = setInterval(() => rebuild('timer'), minutes * 60000);
    $('#refreshNote').textContent = minutes ? `Will reload and rebuild every ${minutes} minutes while this window is open.` : '';
}

// A tick that arrives while the previous rebuild is still running is skipped, not queued.
async function rebuild(reason) {
    const note = () => $('#refreshNote');
    if (state.busy) { if (note()) note().textContent = `${reason === 'timer' ? 'A scheduled rebuild was skipped' : 'Wait a moment'}: the previous one is still running.`; return; }
    try {
        state.busy = true;
        const reloaded = await call(api.reloadFiles(state.importer.importerId));
        if (reloaded.missing.length) throw new Error(`These files could not be read again: ${reloaded.missing.join(', ')}.`);
        state.busy = false;
        const kept = state.built ? new Set(state.kept) : null;
        await readData({ keepRange: true });
        if (!state.read) throw new Error('The series could not be read again.');
        renderLinkControls();
        state.busy = false;
        await findLinks({ quiet: true });
        if (kept) {
            const present = new Set([...state.analysis.links, ...state.analysis.together].filter((link) => link.latest).map(linkKey));
            state.kept = new Set([...kept].filter((key) => present.has(key)));
            renderLinks();
            await buildModel();
        }
        renderRefresh();
        $('#refreshNote').textContent = `Rebuilt at ${new Date().toLocaleTimeString()}${reloaded.changed ? ` from ${plural(reloaded.changed, 'changed file')}` : ', the files had not changed'}.`;
    } catch (error) {
        state.busy = false;
        if (note()) note().textContent = error.message;
    }
}

// ---- step 3: look ahead -----------------------------------------------------------------------------------

const horizons = [5, 10, 21, 63, 126];

function remainingBars() {
    return state.read.data.dates.length - 1 - state.range.to;
}

function renderScenarios() {
    const remaining = remainingBars();
    const asOf = state.read.data.dates[state.range.to];
    $('#whatifLede').textContent = `The model was built from data up to ${asOf}. ${remaining > 0 ? `${plural(remaining, 'bar')} after that are held back, so you can replay what really happened and compare.` : 'To compare a run with what really happened, hold some recent bars back on the first step.'}`;
    if (state.scenarioId === 'replay' && remaining < 5) state.scenarioId = state.manifest.scenarios[0].scenarioId;
    const list = $('#scenarioList');
    list.replaceChildren();
    for (const scenario of state.manifest.scenarios) {
        const disabled = scenario.scenarioId === 'replay' && remaining < 5;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scenario';
        button.disabled = disabled;
        button.setAttribute('aria-pressed', String(scenario.scenarioId === state.scenarioId && !disabled));
        button.dataset.scenario = scenario.scenarioId;
        button.innerHTML = `<b>${escapeHtml(scenario.name)}</b><span>${escapeHtml(scenario.description)}${disabled ? ' Needs at least 5 bars held back after the as-of date.' : ''}</span>`;
        list.append(button);
    }
    renderScenarioDetail();
}

$('#scenarioList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-scenario]');
    if (!button || button.disabled) return;
    state.scenarioId = button.dataset.scenario;
    renderScenarios();
});

function renderScenarioDetail() {
    const scenario = state.manifest.scenarios.find((item) => item.scenarioId === state.scenarioId);
    const detail = $('#scenarioDetail');
    if (!scenario || !state.built) { detail.classList.add('hidden'); $('#runScenario').disabled = true; return; }
    const entities = state.built.entities;
    const replay = scenario.scenarioId === 'replay';
    if (scenario.choose && !entities.includes(state.entity)) state.entity = entities[0];
    const limit = replay ? Math.min(remainingBars(), 126) : 126;
    const options = [...new Set([...horizons.filter((value) => value <= limit), ...(replay && remainingBars() <= 126 ? [remainingBars()] : [])])].sort((a, b) => a - b);
    if (!options.includes(state.horizon)) state.horizon = options.includes(21) ? 21 : options.at(-1);
    const effects = scenario.effects.map((line) => line.replaceAll('{entity}', state.entity ?? ''));
    detail.classList.remove('hidden');
    detail.innerHTML = `${scenario.choose ? `<label class="field" style="margin-top: 0">${escapeHtml(scenario.choose.label)}
            <select id="entityChoice">${entities.map((name) => `<option ${name === state.entity ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}
        ${replay ? `<div class="title">Series to replay</div><p class="lede" style="margin: 2px 0 0">Their real moves are played through the model. The ones ticked by default have a kept link going out of them.</p>
            <div class="driver-list">${entities.map((name) => `<label class="check"><input type="checkbox" data-driver="${escapeHtml(name)}" ${state.drivers.has(name) ? 'checked' : ''}> ${escapeHtml(name)}</label>`).join('')}</div>` : ''}
        <label class="field" style="margin-top: ${scenario.choose || replay ? 16 : 0}px">How far ahead
            <select id="horizonChoice">${options.map((value) => `<option value="${value}" ${value === state.horizon ? 'selected' : ''}>${value} bars (${spanText(value)})</option>`).join('')}</select></label>
        <h3 style="margin-top: 18px">What this does</h3>
        <ul>${effects.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        ${!replay && scenario.choose && !isReturn(state.entity) ? '<p class="lede" style="margin-top: 8px">This series is a rate, so the shock is in points, not percent: 0.05 is five basis points.</p>' : ''}`;
    $('#entityChoice')?.addEventListener('change', (event) => { state.entity = event.target.value; renderScenarioDetail(); });
    $('#horizonChoice').addEventListener('change', (event) => { state.horizon = Number(event.target.value); });
    for (const box of detail.querySelectorAll('[data-driver]')) {
        box.addEventListener('change', () => {
            if (box.checked) state.drivers.add(box.dataset.driver); else state.drivers.delete(box.dataset.driver);
            $('#runScenario').disabled = state.busy || !state.drivers.size;
        });
    }
    $('#runScenario').disabled = state.busy || (replay && !state.drivers.size);
}

api.onProgress((progress) => {
    if (state.busy) $('#runStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>${escapeHtml(progress.message)}</span></div>`;
});

// What each series really did after the as-of date: the change over each bar.
function actualPaths(horizon) {
    const { names, columns } = state.read.data;
    const start = state.range.to;
    return Object.fromEntries(names.map((name, index) => {
        const column = columns[index];
        return [name, Array.from({ length: horizon }, (_, k) => (isReturn(name) ? Math.log(column[start + k + 1] / column[start + k]) : column[start + k + 1] - column[start + k]))];
    }));
}

$('#runScenario').addEventListener('click', async () => {
    const scenario = state.manifest.scenarios.find((item) => item.scenarioId === state.scenarioId);
    const replay = scenario.scenarioId === 'replay';
    state.busy = true;
    $('#runScenario').disabled = true;
    $('#runStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Starting…</span></div>';
    try {
        const options = { entity: scenario.choose ? state.entity : null, signals: ['lvl'], runTime: state.horizon };
        let actual = null;
        if (replay) {
            actual = actualPaths(state.horizon);
            const drivers = [...state.drivers];
            // Each real return is held for its own bar.
            options.supplied = { entities: drivers, samples: Object.fromEntries(drivers.map((name) => [name, actual[name].flatMap((value, k) => [[k + 0.001, value], [k + 0.999, value]])])) };
        }
        const data = await call(api.runScenario(scenario.scenarioId, options));
        state.run = { scenario, data, replay, entity: scenario.choose ? state.entity : null, horizon: state.horizon, drivers: replay ? [...state.drivers] : [], actual };
        $('#runStatus').replaceChildren();
        renderResults();
        refreshSteps();
        show('results');
    } catch (error) {
        $('#runStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        $('#runScenario').disabled = false;
    }
});

// ---- step 4: results --------------------------------------------------------------------------------------

// The running change is a log change for a price and a plain change for a rate.
const toDisplay = (name, value) => (isReturn(name) ? 100 * (Math.exp(value ?? 0) - 1) : (value ?? 0));

function summarizeShock(data) {
    const [baseline, scenario] = data.branches;
    const rows = state.read.data.names.map((name) => {
        const base = (baseline.series[name]?.lvl ?? []).map(([time, value]) => [time, toDisplay(name, value)]);
        const stressed = (scenario.series[name]?.lvl ?? []).map(([time, value]) => [time, toDisplay(name, value)]);
        const extra = stressed.map(([time, value], index) => [time, value - (base[index]?.[1] ?? 0)]);
        const peak = extra.reduce((best, point) => (Math.abs(point[1]) > Math.abs(best[1]) ? point : best), [0, 0]);
        return { name, extra, end: extra.at(-1)?.[1] ?? 0, peak: peak[1], peakAt: peak[0], baselineEnd: base.at(-1)?.[1] ?? 0, scenarioEnd: stressed.at(-1)?.[1] ?? 0 };
    });
    const shocked = state.run.entity;
    const others = rows.filter((row) => row.name !== shocked).sort((left, right) => Math.abs(right.end) - Math.abs(left.end));
    return { rows: [...rows].sort((left, right) => Math.abs(right.end) - Math.abs(left.end)), others, shocked };
}

// Replayed real moves against what happened: for each series that was not itself replayed, how far the model was from the
// actual outcome, and how far a guess of no change would have been.
function summarizeReplay(data) {
    const [, scenario] = data.branches;
    const run = state.run;
    const rows = state.read.data.names.map((name) => {
        const path = (scenario.series[name]?.lvl ?? []).map(([time, value]) => [time, toDisplay(name, value)]);
        let running = 0;
        const actualPath = [[0, 0], ...run.actual[name].map((value, k) => {
            running += value;
            return [k + 1, toDisplay(name, running)];
        })];
        const simulated = path.at(-1)?.[1] ?? 0;
        const actual = actualPath.at(-1)[1];
        const driver = run.drivers.includes(name);
        // A series counts only if the model moved it at all; otherwise its guess is the no-change guess.
        const moved = Math.abs(simulated) >= (isReturn(name) ? 0.05 : 0.005);
        return { name, path, actualPath, simulated, actual, driver, scored: !driver && moved, closer: Math.abs(actual - simulated) < Math.abs(actual), sameSide: Math.sign(actual) === Math.sign(simulated) };
    });
    return { rows, scored: rows.filter((row) => row.scored), drivers: rows.filter((row) => row.driver) };
}

function renderResults() {
    if (state.run.replay) renderReplayResults(); else renderShockResults();
    $('#resultFootnote').textContent = state.run.replay
        ? 'The model is fed only the real moves of the series you chose. Beating a guess of no change on one or two series is a data point, not proof: prices are noisy, and a model that finds nothing looks the same as a guess of no change.'
        : 'This is what the links found in past data imply for a shock, not a forecast. Open in Konjugate shows both runs in the full canvas, where every equation can be inspected.';
}

function renderShockResults() {
    const { scenario, data } = state.run;
    const summary = summarizeShock(data);
    state.run.summary = summary;
    const [lead] = summary.others;
    const own = summary.rows.find((row) => row.name === summary.shocked);
    const moved = summary.others.filter((row) => Math.abs(row.end) >= (isReturn(row.name) ? 0.1 : 0.01));
    $('#title-results').textContent = scenario.name + (summary.shocked ? `: ${summary.shocked}` : '');
    const count = moved.length === 1 ? '1 other series moves' : `${moved.length} other series move`;
    $('#headline').textContent = summary.shocked
        ? `${summary.shocked} ends ${change(summary.shocked, own.end)} from the shock after ${data.runTime} bars. ${moved.length ? `${count} noticeably; the biggest is ${lead.name} at ${change(lead.name, lead.end)}.` : 'No other series moves noticeably: the links you kept do not carry the shock anywhere.'}`
        : `${moved.length === 1 ? '1 series moves' : `${moved.length} series move`} noticeably against the run with no shock; the biggest is ${lead.name} at ${change(lead.name, lead.end)}.`;
    $('#tiles').innerHTML = [
        summary.shocked ? `<div class="tile"><div class="label">Shocked series</div><div class="value">${change(summary.shocked, own.end)}</div><div class="sub">${escapeHtml(summary.shocked)}, after ${data.runTime} bars</div></div>` : `<div class="tile"><div class="label">Series moved</div><div class="value">${moved.length}</div><div class="sub">noticeably</div></div>`,
        `<div class="tile ${lead && lead.end < -0.1 ? 'bad' : lead && lead.end > 0.1 ? 'good' : ''}"><div class="label">Biggest knock-on</div><div class="value">${lead ? change(lead.name, lead.end) : '—'}</div><div class="sub">${lead ? escapeHtml(lead.name) : ''}</div></div>`,
        `<div class="tile"><div class="label">Links used</div><div class="value">${state.built.report.summary.links}</div><div class="sub">of ${state.analysis ? state.analysis.links.length + state.analysis.together.length : 0} found</div></div>`,
        `<div class="tile"><div class="label">As of</div><div class="value" style="font-size: 18px">${escapeHtml(state.read.data.dates[state.range.to])}</div><div class="sub">${plural(state.range.to - state.range.from, 'bar')} of history</div></div>`
    ].join('');
    $('#chartTitle').textContent = 'Extra change caused by the shock, against a run with no shock (percent for prices, points for rates)';
    $('#tableTitle').textContent = 'All series';
    $('#resultTable').innerHTML = `<thead><tr><th>Series</th><th>Extra change after ${data.runTime} bars</th><th>Largest extra change</th><th>With shock</th><th>With no shock</th></tr></thead><tbody>${summary.rows.map((row) => `<tr><td>${escapeHtml(row.name)}${row.name === summary.shocked ? ' <span class="badge">shocked</span>' : ''}</td><td class="${row.end < -0.05 ? 'negative' : ''}">${change(row.name, row.end, 2)}</td><td>${change(row.name, row.peak, 2)} at bar ${row.peakAt}</td><td>${change(row.name, row.scenarioEnd, 2)}</td><td>${change(row.name, row.baselineEnd, 2)}</td></tr>`).join('')}</tbody>`;
    const moving = summary.rows.filter((row) => Math.abs(row.peak) >= (isReturn(row.name) ? 0.05 : 0.005) || row.name === summary.shocked);
    const shown = (moving.length ? moving : summary.rows).slice(0, 6);
    const lines = shown.map((row, index) => ({ name: row.name, color: palette[index % palette.length], points: row.extra }));
    $('#legend').innerHTML = lines.map((line) => `<span><i style="border-color:${line.color}"></i>${escapeHtml(line.name)}</span>`).join('');
    drawChart($('#chart'), $('#readout'), { series: lines, maxX: data.runTime, markX: data.forkTime, format: (value) => `${Number(value.toPrecision(3))}` });
}

function renderReplayResults() {
    const { scenario, data, horizon } = state.run;
    const summary = summarizeReplay(data);
    state.run.summary = summary;
    const wins = summary.scored.filter((row) => row.closer);
    const names = summary.drivers.map((row) => row.name).join(', ');
    $('#title-results').textContent = `${scenario.name}: ${names}`;
    $('#headline').textContent = summary.scored.length
        ? `With the real moves of ${names} replayed for ${horizon} bars, the model was closer than a guess of no change for ${wins.length} of ${summary.scored.length} series it moved${summary.scored.length === 1 ? '' : `, and called the direction right for ${summary.scored.filter((row) => row.sameSide).length}`}.`
        : `Nothing but ${names} moved in the model, so there is nothing to compare: none of the links you kept leads out of the series replayed. Replay a different series, or keep more links.`;
    const best = [...summary.scored].sort((a, b) => Math.abs(b.actual) - Math.abs(a.actual))[0];
    $('#tiles').innerHTML = [
        `<div class="tile ${wins.length === summary.scored.length && summary.scored.length ? 'good' : ''}"><div class="label">Closer than no change</div><div class="value">${wins.length} of ${summary.scored.length}</div><div class="sub">series the model moved</div></div>`,
        `<div class="tile"><div class="label">Direction right</div><div class="value">${summary.scored.filter((row) => row.sameSide).length} of ${summary.scored.length}</div><div class="sub">same sign as what happened</div></div>`,
        best ? `<div class="tile"><div class="label">Biggest move</div><div class="value">${change(best.name, best.actual)}</div><div class="sub">${escapeHtml(best.name)} actually; model ${change(best.name, best.simulated)}</div></div>` : '<div class="tile"><div class="label">Biggest move</div><div class="value">—</div></div>',
        `<div class="tile"><div class="label">As of</div><div class="value" style="font-size: 18px">${escapeHtml(state.read.data.dates[state.range.to])}</div><div class="sub">${plural(horizon, 'bar')} replayed</div></div>`
    ].join('');
    $('#chartTitle').textContent = 'What the model expects (solid) and what really happened (dashed), change since the as-of date';
    $('#tableTitle').textContent = 'Model against what happened';
    $('#resultTable').innerHTML = `<thead><tr><th>Series</th><th>What happened</th><th>Model</th><th>Guess of no change</th><th>Closer</th></tr></thead><tbody>${summary.rows.map((row) => `<tr><td>${escapeHtml(row.name)}${row.driver ? ' <span class="badge">replayed</span>' : ''}</td><td>${change(row.name, row.actual, 2)}</td><td>${change(row.name, row.simulated, 2)}</td><td>${change(row.name, 0, 2)}</td>
        <td>${row.driver ? '<span class="empty">held to its real path</span>' : !row.scored ? '<span class="empty">not moved by the model</span>' : row.closer ? '<span class="score-good">model</span>' : '<span class="score-bad">no change</span>'}</td></tr>`).join('')}</tbody>`;
    const shown = (summary.scored.length ? summary.scored : summary.drivers).slice(0, 5);
    const lines = shown.flatMap((row, index) => [{ name: row.name, color: palette[index], points: row.path }, { name: row.name, color: palette[index], points: row.actualPath, dashed: true, width: 2 }]);
    $('#legend').innerHTML = `${shown.map((row, index) => `<span><i style="border-color:${palette[index]}"></i>${escapeHtml(row.name)}</span>`).join('')}<span><i class="dashed" style="border-color:#8aa1af"></i>dashed: what happened</span>`;
    drawChart($('#chart'), $('#readout'), { series: lines, maxX: horizon, markX: 0, format: (value) => `${Number(value.toPrecision(3))}` });
}

$('#openCanvas').addEventListener('click', async () => {
    try {
        await call(api.openInCanvas(state.run.scenario.scenarioId));
        $('#exportStatus').innerHTML = notice('ok', 'Opened in the main Konjugate window, with the run with no shock and the scenario as two branches.');
    } catch (error) {
        $('#exportStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
});

$('#exportResults').addEventListener('click', async () => {
    const { summary, replay } = state.run;
    const csvField = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));
    const lines = replay
        ? ['series,replayed,what_happened,model,no_change_guess,model_closer']
        : ['series,extra_change,largest_extra_change,largest_at_bar,change_with_shock,change_with_no_shock'];
    for (const row of summary.rows) {
        lines.push((replay ? [row.name, row.driver, row.actual, row.simulated, 0, row.scored ? row.closer : ''] : [row.name, row.end, row.peak, row.peakAt, row.scenarioEnd, row.baselineEnd]).map(csvField).join(','));
    }
    try {
        const result = await call(api.exportResults(state.run.scenario.scenarioId, { summaryCsv: `${lines.join('\n')}\n` }));
        $('#exportStatus').innerHTML = result.exported
            ? notice('ok', `<strong>Saved.</strong> ${result.files.map(escapeHtml).join(', ')} are in ${escapeHtml(result.folder)}. The run manifest records the versions, the hashes of your files and the model, the address and time of anything fetched, and the changes applied.`)
            : '';
    } catch (error) {
        $('#exportStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
});

$('#anotherScenario').addEventListener('click', () => { renderScenarios(); show('whatif'); });

// ---- step 5: learn ----------------------------------------------------------------------------------------

const blurbs = {
    gettingStarted: 'A five-minute walk-through: find series, check them, find links, look ahead, compare.',
    dataFormat: 'What the files need, how dates and decimals are read, what is repaired or left out, and how far back each source goes.',
    assumptions: 'What links mean, why they come and go, how the what-if and the replay are built, and what they have not been tested against.'
};

function renderLearn() {
    $('#learnCards').innerHTML = state.manifest.pages.map((page) => `<div class="card"><h3 style="margin: 0; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 16px">${escapeHtml(page.label)}</h3><p>${escapeHtml(blurbs[page.pageId] ?? '')}</p><div class="actions" style="margin-top: 4px"><button class="button" type="button" data-page="${escapeHtml(page.pageId)}">Open</button></div></div>`).join('');
}

// ---- start ------------------------------------------------------------------------------------------------

(async () => {
    try {
        state.manifest = await call(api.getManifest());
        [state.importer] = state.manifest.importers;
        state.files = state.manifest.files.series ?? [];
        state.scenarioId = state.manifest.scenarios[0]?.scenarioId ?? null;
        $('#fetchFrom').value = daysAgo(730);
        $('#fetchTo').value = today();
        renderSearchTypes();
        renderBaskets();
        renderSlot();
        renderTray();
        renderSymbolHint();
        applyBarLimits();
        renderLearn();
        refreshSteps();
    } catch (error) {
        $('#importStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
})();
