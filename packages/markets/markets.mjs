/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { analyzeWindows, preferTogetherDirection } from './lib/market.mjs';

const api = window.konjugateLauncher;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const signed = (value, digits = 1) => `${value > 0.05 ? '+' : value < -0.05 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;

// Every host call answers { ok: true, ... } or { ok: false, message }; turn the second into an exception.
async function call(promise) {
    const response = await promise;
    if (!response.ok) throw new Error(response.message);
    return response;
}

const state = {
    manifest: null, importer: null, files: [], read: null, analysis: null, kept: new Set(), built: null,
    scenarioId: null, entity: null, run: null, busy: false, windowLength: null, history: [], refresh: { minutes: 0, timer: null }
};
const linkKey = (link) => `${link.kind}\u0000${link.source}\u0000${link.target}`;
const edgeKey = (edge) => `${edge.provenance === 'correlationOnly' ? 'together' : 'lagged'}\u0000${edge.sourceColumn}\u0000${edge.targetColumn}`;
// The analysis names a series column with a safe version of its name (see inferenceCsv in lib/market.mjs); this puts the name back.
const nice = (column) => state.read?.data.names.find((name) => name.replace(/[^A-Za-z0-9_.-]+/g, '_') === column) ?? column;
const niceKey = (key) => key.split('\u0000').slice(1).map(nice).join(' → ');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

// ---- steps ------------------------------------------------------------------------------------------------

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
        const done = { data: state.read, links: state.built, whatif: state.run }[button.dataset.step];
        button.classList.toggle('done', Boolean(done));
    }
}

for (const button of document.querySelectorAll('.step')) button.addEventListener('click', () => show(button.dataset.step));
document.addEventListener('click', (event) => {
    const page = event.target.closest('[data-page]')?.dataset.page;
    if (page) call(api.openPage(page)).catch((error) => console.error(error));
});

// ---- step 1: your series ----------------------------------------------------------------------------------

const notice = (kind, html) => `<div class="notice ${kind}"><div>${html}</div></div>`;

function renderSlot() {
    const slot = $('#seriesSlot');
    const files = state.files;
    slot.innerHTML = `
        <div class="title">${escapeHtml(state.importer.files[0].label)} <span class="badge required">At least two</span></div>
        <p class="description">${escapeHtml(state.importer.files[0].description)}</p>
        <div class="file-list">${files.length ? files.map((file) => `<div class="file-line"><span class="name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}${file.sample ? ' (sample)' : file.fetched ? ' (fetched)' : ''}</span><button class="button link" type="button" data-remove="${escapeHtml(file.name)}">Remove</button></div>`).join('') : '<div class="file-line"><span class="empty">No files chosen</span></div>'}</div>
        <div class="actions" style="margin-top: 4px"><button class="button" type="button" id="addFiles">${files.length ? 'Add more files…' : 'Choose files…'}</button></div>`;
    $('#readData').disabled = state.busy || files.length < 2;
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
    Object.assign(state, { read: null, analysis: null, kept: new Set(), built: null, run: null, history: [], windowLength: null });
    $('#importResult').replaceChildren();
    $('#importStatus').replaceChildren();
    $('#linkResult').replaceChildren();
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

$('#readData').addEventListener('click', readData);

// ---- fetching from the internet ---------------------------------------------------------------------------

const sources = {
    yahoo: {
        hint: 'Yahoo Finance tickers, for example SPY, ^GSPC (S&P 500), BZ=F (Brent crude), GC=F (gold), ^TNX (ten-year yield), EURUSD=X. Adjusted closes are used. Yahoo\'s terms restrict commercial use, so use this to evaluate.',
        url: (symbol, years) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${years}y&interval=1d`
    },
    fred: {
        hint: 'FRED series ids, for example DGS10 (ten-year yield), DEXUSEU (dollar per euro), DCOILBRENTEU (Brent crude).',
        url: (symbol, years) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(symbol)}&cosd=${new Date(Date.now() - years * 366 * 86400000).toISOString().slice(0, 10)}`
    },
    stooq: {
        hint: 'Stooq symbols, for example spy.us, ^spx, eurusd. Stooq may ask for a browser check and refuse a program; if it does, use another source.',
        url: (symbol) => `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol.toLowerCase())}&i=d`
    }
};

function renderFetchHint() {
    const hosts = state.manifest.network.hosts.join(', ');
    $('#fetchHint').textContent = `${sources[$('#fetchSource').value].hint} This window may reach only ${hosts}.`;
}
$('#fetchSource').addEventListener('change', renderFetchHint);

$('#fetchNow').addEventListener('click', async () => {
    const source = sources[$('#fetchSource').value];
    const symbols = [...new Set($('#fetchSymbols').value.split(',').map((symbol) => symbol.trim()).filter(Boolean))];
    if (!symbols.length) { $('#fetchStatus').innerHTML = notice('error', 'Type at least one symbol.'); return; }
    const years = Number($('#fetchRange').value);
    state.busy = true;
    $('#fetchNow').disabled = true;
    const failures = [];
    try {
        if (state.files.some((file) => file.sample)) await call(api.clearFile(state.importer.importerId, 'series'));
        for (const [index, symbol] of symbols.entries()) {
            $('#fetchStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>Fetching ${escapeHtml(symbol)} (${index + 1} of ${symbols.length})…</span></div>`;
            try { await call(api.fetchFile(state.importer.importerId, 'series', source.url(symbol, years), `${symbol}.csv`)); } catch (error) { failures.push(`${symbol}: ${error.message}`); }
        }
        await syncFiles();
        invalidateData();
        $('#fetchStatus').innerHTML = failures.length ? notice('warning', `<strong>${failures.length === 1 ? 'One symbol' : `${failures.length} symbols`} could not be fetched.</strong><ul>${failures.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`) : '';
        if (state.files.length >= 2) await readData();
    } catch (error) {
        $('#fetchStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        $('#fetchNow').disabled = false;
        renderSlot();
    }
});

function problemList(report) {
    return report.errors.map((item) => `<li>${item.file ? `<span class="where">${escapeHtml(item.file)}</span>` : ''}${escapeHtml(item.message)}</li>`).join('');
}

async function readData() {
    state.busy = true;
    renderSlot();
    $('#importStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Reading your series…</span></div>';
    $('#importResult').replaceChildren();
    try {
        const result = await call(api.runImport(state.importer.importerId, { stage: 'read' }));
        $('#importStatus').replaceChildren();
        if (!result.data) {
            state.read = null;
            $('#importResult').innerHTML = notice('error', `<strong>${result.report.errors.length === 1 ? 'One problem needs fixing' : `${result.report.errors.length} problems need fixing`}.</strong><ul>${problemList(result.report)}</ul>`);
        } else {
            state.read = { data: result.data, report: result.report };
            state.analysis = null;
            state.built = null;
            state.run = null;
            renderReadResult();
        }
    } catch (error) {
        $('#importStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        renderSlot();
        refreshSteps();
    }
}

function renderReadResult() {
    const { data, report } = state.read;
    const { summary } = report;
    const warnings = report.warnings.length ? notice('warning', `<strong>${report.warnings.length === 1 ? 'One thing to know' : `${report.warnings.length} things to know`}</strong><ul>${report.warnings.map((item) => `<li>${item.file ? `<span class="where">${escapeHtml(item.file)}</span>` : ''}${escapeHtml(item.message)}</li>`).join('')}</ul>`) : '';
    $('#importResult').innerHTML = `${notice('ok', `<strong>Your series are ready.</strong> ${plural(summary.series, 'series')}, ${plural(summary.bars, 'bar')} of changes, from ${escapeHtml(summary.from)} to ${escapeHtml(summary.to)}.`)}${warnings}
        <h3>Series</h3>
        <div class="card" style="padding: 6px 10px"><table><thead><tr><th>Series</th><th>Read as</th><th>Latest change</th><th>Typical daily move</th></tr></thead><tbody>
        ${data.names.map((name, index) => {
            const column = data.columns[index];
            const mean = column.reduce((sum, value) => sum + value, 0) / column.length;
            const spread = Math.sqrt(column.reduce((sum, value) => sum + (value - mean) ** 2, 0) / column.length);
            const isReturn = data.kinds[index] === 'log return';
            const format = (value) => (isReturn ? `${signed(100 * value, 2)}%` : signed(value, 3));
            return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(data.kinds[index])}</td><td>${format(column.at(-1))}</td><td>${isReturn ? `${(100 * spread).toFixed(2)}%` : spread.toFixed(3)}</td></tr>`;
        }).join('')}
        </tbody></table></div>
        <div class="actions"><button class="button primary" type="button" id="toLinks">Look for links</button></div>`;
    $('#toLinks').addEventListener('click', () => { renderLinkControls(); show('links'); });
}

// ---- step 2: links ----------------------------------------------------------------------------------------

function windowChoices() {
    const bars = state.read.data.dates.length;
    return [60, 120, 250, 500].filter((length) => length * 2 <= bars);
}

function renderLinkControls() {
    const choices = windowChoices();
    if (!choices.length) {
        $('#linkControls').innerHTML = `<p>${escapeHtml(`Only ${state.read.data.dates.length} bars are available, which is too few to compare separate stretches of history. Use series with at least 120 bars.`)}</p>`;
        return;
    }
    if (!choices.includes(state.windowLength)) state.windowLength = choices.includes(120) ? 120 : choices[0];
    $('#linkControls').innerHTML = `<label class="field" style="margin-top: 0">Length of each stretch of history
            <select id="windowLength">${choices.map((length) => `<option value="${length}" ${length === state.windowLength ? 'selected' : ''}>${length} bars</option>`).join('')}</select></label>
        <p class="lede" style="margin-top: 8px">${escapeHtml(`Stretches end at the latest bar and step back without overlapping, up to 8 of them. Longer stretches find steadier links but react more slowly to change.`)}</p>
        <div class="actions"><button class="button primary" type="button" id="findLinks">${state.analysis ? 'Look again' : 'Find links'}</button></div>`;
    $('#windowLength').addEventListener('change', (event) => { state.windowLength = Number(event.target.value); });
    $('#findLinks').addEventListener('click', () => findLinks());
}

// The engine runs one window at a time through the host; a failed window fails the whole analysis.
async function findLinks({ quiet = false } = {}) {
    const { data } = state.read;
    const changes = { names: data.names, dates: data.dates, columns: data.columns, kinds: data.kinds };
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
        const spread = new Map(data.names.map((name, index) => {
            const column = data.columns[index];
            const mean = column.reduce((sum, value) => sum + value, 0) / column.length;
            return [name.replace(/[^A-Za-z0-9_.-]+/g, '_'), Math.sqrt(column.reduce((sum, value) => sum + (value - mean) ** 2, 0) / column.length)];
        }));
        analysis.together = preferTogetherDirection(analysis.together, (name) => spread.get(name));
        state.analysis = analysis;
        // Keep, to begin with, the links that were there in the newest stretch and held up across the others.
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
        ${notice('ok', `<strong>${(analysis.windows.length === 1 ? '1 stretch' : `${analysis.windows.length} stretches`)} of ${state.windowLength} bars examined</strong>, from ${escapeHtml(first.from)} to ${escapeHtml(last.to)}.${analysis.overlapping ? ' The stretches overlap, so the counts below overstate how steady a link is.' : ''}`)}
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
    const { analysis } = state;
    const newest = analysis.reports[0];
    const keptEdges = newest.edges.filter((edge) => state.kept.has(edgeKey(edge)));
    state.busy = true;
    $('#buildStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Building the model…</span></div>';
    try {
        const result = await call(api.runImport(state.importer.importerId, { stage: 'build', edges: keptEdges, selfTerms: newest.selfTerms }));
        if (!result.imported) throw new Error(result.report.errors.map((item) => item.message).join(' ') || 'The model could not be built.');
        state.built = { report: result.report, entities: result.entities };
        state.run = null;
        $('#buildStatus').innerHTML = notice('ok', `<strong>Model built</strong> from ${plural(result.report.summary.links, 'link')}.${result.report.warnings.length ? `<ul>${result.report.warnings.map((item) => `<li>${escapeHtml(item.message)}</li>`).join('')}</ul>` : ''} <button class="button link" type="button" id="toWhatIf">Choose a what-if</button>`);
        $('#toWhatIf').addEventListener('click', () => { renderScenarios(); show('whatif'); });
        renderScenarios();
    } catch (error) {
        $('#buildStatus').innerHTML = notice('error', escapeHtml(error.message));
    } finally {
        state.busy = false;
        refreshSteps();
    }
}

// ---- keeping up to date -----------------------------------------------------------------------------------

function recordHistory() {
    const links = [...state.analysis.links, ...state.analysis.together].map((link) => ({ key: linkKey(link), text: niceKey(linkKey(link)), label: link.label, latest: link.latest }));
    const previous = state.history[0];
    const steady = (entry) => new Set(entry.links.filter((link) => link.latest && (link.label === 'stable' || link.label === 'sometimes')).map((link) => link.key));
    const now = steady({ links });
    const before = previous ? steady(previous) : null;
    state.history.unshift({
        at: new Date(), to: state.analysis.windows[0].to, links,
        added: before ? [...now].filter((key) => !before.has(key)) : [], dropped: before ? [...before].filter((key) => !now.has(key)) : [],
        text: niceKey
    });
    state.history.length = Math.min(state.history.length, 20);
}

function renderRefresh() {
    const fromFiles = state.files.length > 0 && !state.files.some((file) => file.sample);
    const card = $('#refreshCard');
    card.classList.remove('hidden');
    const rows = state.history.map((entry, index) => `<tr><td>${entry.at.toLocaleTimeString()}</td><td>${escapeHtml(entry.to)}</td><td>${plural(entry.links.filter((link) => link.latest && (link.label === 'stable' || link.label === 'sometimes')).length, 'steady link')}</td>
        <td>${index === state.history.length - 1 ? 'First look' : `${entry.added.length ? `New: ${entry.added.map((key) => escapeHtml(entry.text(key))).join(', ')}. ` : ''}${entry.dropped.length ? `Gone: ${entry.dropped.map((key) => escapeHtml(entry.text(key))).join(', ')}.` : ''}${!entry.added.length && !entry.dropped.length ? 'No change.' : ''}`}</td></tr>`).join('');
    card.innerHTML = `<h3 style="margin-top: 0">Keep it up to date</h3>
        <p class="lede">${fromFiles ? 'Reads your files again (or fetches the series again), looks for links again and rebuilds, so the model follows the market.' : 'The sample series never change. Choose your own files to keep the analysis up to date as they change.'} It runs only while this window is open.</p>
        <div class="actions" style="margin-top: 10px"><button class="button" type="button" id="rebuildNow" ${fromFiles ? '' : 'disabled'}>Reload and rebuild now</button>
        <label class="inline">Every <select id="refreshEvery" ${fromFiles ? '' : 'disabled'}>${[0, 5, 15, 30, 60].map((minutes) => `<option value="${minutes}" ${minutes === state.refresh.minutes ? 'selected' : ''}>${minutes ? `${minutes} minutes` : 'never (manual)'}</option>`).join('')}</select></label></div>
        <div id="refreshNote" class="empty" style="margin-top: 8px" aria-live="polite"></div>
        ${state.history.length > 1 ? `<h3>Earlier looks</h3><table><thead><tr><th>At</th><th>Data to</th><th>Steady links</th><th>What changed</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
    $('#rebuildNow').addEventListener('click', () => rebuild('manual'));
    $('#refreshEvery').addEventListener('change', (event) => { setRefresh(Number(event.target.value)); });
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
        const result = await call(api.runImport(state.importer.importerId, { stage: 'read' }));
        if (!result.data) throw new Error(result.report.errors.map((item) => item.message).join(' '));
        state.read = { data: result.data, report: result.report };
        renderReadResult();
        state.busy = false;
        const kept = state.built ? new Set(state.kept) : null;
        await findLinks({ quiet: true });
        if (kept) {
            // The model is rebuilt from the same choices of links, wherever they are still present.
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

// ---- step 3: what if --------------------------------------------------------------------------------------

function renderScenarios() {
    const list = $('#scenarioList');
    list.replaceChildren();
    for (const scenario of state.manifest.scenarios) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'scenario';
        button.setAttribute('aria-pressed', String(scenario.scenarioId === state.scenarioId));
        button.dataset.scenario = scenario.scenarioId;
        button.innerHTML = `<b>${escapeHtml(scenario.name)}</b><span>${escapeHtml(scenario.description)}</span>`;
        list.append(button);
    }
    renderScenarioDetail();
}

$('#scenarioList').addEventListener('click', (event) => {
    const id = event.target.closest('[data-scenario]')?.dataset.scenario;
    if (!id) return;
    state.scenarioId = id;
    renderScenarios();
});

function renderScenarioDetail() {
    const scenario = state.manifest.scenarios.find((item) => item.scenarioId === state.scenarioId);
    const detail = $('#scenarioDetail');
    if (!scenario || !state.built) { detail.classList.add('hidden'); $('#runScenario').disabled = true; return; }
    const entities = state.built.entities;
    if (scenario.choose && !entities.includes(state.entity)) state.entity = entities[0];
    const effects = scenario.effects.map((line) => line.replaceAll('{entity}', state.entity ?? ''));
    detail.classList.remove('hidden');
    detail.innerHTML = `${scenario.choose ? `<label class="field" style="margin-top: 0">${escapeHtml(scenario.choose.label)}
            <select id="entityChoice">${entities.map((name) => `<option ${name === state.entity ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}
        <h3 style="margin-top: ${scenario.choose ? 18 : 0}px">What this changes</h3>
        <ul>${effects.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        <p class="lede" style="margin-top: 8px">The model runs for ${scenario.runTime} bars from the latest bar. The shock arrives at bar ${scenario.forkAt}; everything before that is identical to the run with no shock.</p>`;
    $('#entityChoice')?.addEventListener('change', (event) => { state.entity = event.target.value; renderScenarioDetail(); });
    $('#runScenario').disabled = state.busy;
}

api.onProgress((progress) => {
    if (state.busy) $('#runStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>${escapeHtml(progress.message)}</span></div>`;
});

$('#runScenario').addEventListener('click', async () => {
    const scenario = state.manifest.scenarios.find((item) => item.scenarioId === state.scenarioId);
    state.busy = true;
    $('#runScenario').disabled = true;
    $('#runStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Starting…</span></div>';
    try {
        const data = await call(api.runScenario(scenario.scenarioId, { entity: scenario.choose ? state.entity : null, signals: ['lvl'] }));
        state.run = { scenario, data, entity: scenario.choose ? state.entity : null };
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

// The running price change is a log change; the extra change the shock caused is the scenario's minus the baseline's.
function summarize(data) {
    const [baseline, scenario] = data.branches;
    const percentOf = (points) => points.map(([time, value]) => [time, 100 * (Math.exp(value ?? 0) - 1)]);
    const rows = state.read.data.names.map((name) => {
        const base = percentOf(baseline.series[name]?.lvl ?? []);
        const stressed = percentOf(scenario.series[name]?.lvl ?? []);
        const extra = stressed.map(([time, value], index) => [time, value - (base[index]?.[1] ?? 0)]);
        const peak = extra.reduce((best, point) => (Math.abs(point[1]) > Math.abs(best[1]) ? point : best), [0, 0]);
        return { name, extra, end: extra.at(-1)?.[1] ?? 0, peak: peak[1], peakAt: peak[0], baselineEnd: base.at(-1)?.[1] ?? 0, scenarioEnd: stressed.at(-1)?.[1] ?? 0 };
    });
    const shocked = state.run?.entity ?? null;
    const others = rows.filter((row) => row.name !== shocked).sort((left, right) => Math.abs(right.end) - Math.abs(left.end));
    return { rows: [...rows].sort((left, right) => Math.abs(right.end) - Math.abs(left.end)), others, shocked };
}

function renderResults() {
    const { scenario, data } = state.run;
    const summary = summarize(data);
    state.run.summary = summary;
    const [lead] = summary.others;
    const own = summary.rows.find((row) => row.name === summary.shocked);
    const moved = summary.others.filter((row) => Math.abs(row.end) >= 0.1);
    $('#title-results').textContent = scenario.name + (summary.shocked ? `: ${summary.shocked}` : '');
    $('#headline').textContent = summary.shocked
        ? `${summary.shocked} ends ${signed(own.end)}% from the shock after ${data.runTime} bars. ${moved.length ? `${moved.length === 1 ? '1 other series moves' : `${moved.length} other series move`} by 0.1% or more; the biggest is ${lead.name} at ${signed(lead.end)}%.` : 'No other series moves by as much as 0.1%: the links you kept do not carry the shock anywhere.'}`
        : `${moved.length === 1 ? '1 series moves' : `${moved.length} series move`} by 0.1% or more against the run with no shock; the biggest is ${lead.name} at ${signed(lead.end)}%.`;
    $('#tiles').innerHTML = [
        summary.shocked ? `<div class="tile"><div class="label">Shocked series</div><div class="value">${signed(own.end)}%</div><div class="sub">${escapeHtml(summary.shocked)}, after ${data.runTime} bars</div></div>` : `<div class="tile"><div class="label">Series moved</div><div class="value">${moved.length}</div><div class="sub">by 0.1% or more</div></div>`,
        `<div class="tile ${lead && lead.end < -0.1 ? 'bad' : lead && lead.end > 0.1 ? 'good' : ''}"><div class="label">Biggest knock-on</div><div class="value">${lead ? `${signed(lead.end)}%` : '—'}</div><div class="sub">${lead ? escapeHtml(lead.name) : ''}</div></div>`,
        `<div class="tile"><div class="label">Links used</div><div class="value">${state.built.report.summary.links}</div><div class="sub">of ${state.analysis?.links.length ?? 0} found</div></div>`,
        `<div class="tile"><div class="label">Data to</div><div class="value" style="font-size: 18px">${escapeHtml(state.read.report.summary.to)}</div><div class="sub">${plural(state.read.report.summary.bars, 'bar')} of history</div></div>`
    ].join('');
    $('#resultTable').innerHTML = `<thead><tr><th>Series</th><th>Extra change after ${data.runTime} bars</th><th>Largest extra change</th><th>With shock</th><th>With no shock</th></tr></thead><tbody>${summary.rows.map((row) => `<tr><td>${escapeHtml(row.name)}${row.name === summary.shocked ? ' <span class="badge">shocked</span>' : ''}</td><td class="${row.end < -0.05 ? 'negative' : ''}">${signed(row.end, 2)}%</td><td>${signed(row.peak, 2)}% at bar ${row.peakAt}</td><td>${signed(row.scenarioEnd, 2)}%</td><td>${signed(row.baselineEnd, 2)}%</td></tr>`).join('')}</tbody>`;
    renderChart(data, summary);
}

const palette = ['#45c6b8', '#e6b04a', '#ee8a7e', '#8fb2ff', '#c39bf0', '#9bd66b'];

function renderChart(data, summary) {
    const width = 860;
    const height = 300;
    const margin = { left: 52, right: 16, top: 16, bottom: 30 };
    const shown = summary.rows.slice(0, 5);
    const lines = shown.map((row, index) => ({ row, color: palette[index] }));
    const values = lines.flatMap((line) => line.row.extra.map(([, value]) => value));
    const step = (span) => (span > 20 ? 5 : span > 8 ? 2 : span > 3 ? 1 : span > 1 ? 0.5 : 0.1);
    const spread = Math.max(0.5, Math.max(...values, 0) - Math.min(...values, 0));
    const tick = step(spread);
    const low = Math.floor(Math.min(...values, 0) / tick) * tick;
    const high = Math.ceil(Math.max(...values, 0) / tick) * tick || tick;
    const maxTime = data.runTime;
    const x = (time) => margin.left + (time / maxTime) * (width - margin.left - margin.right);
    const y = (value) => margin.top + ((high - value) / (high - low)) * (height - margin.top - margin.bottom);
    const path = (points) => points.map(([time, value], index) => `${index ? 'L' : 'M'}${x(time).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const yTicks = [];
    for (let value = low; value <= high + 1e-9; value += tick) yTicks.push(Number(value.toFixed(3)));
    const xTicks = [];
    for (let time = 0; time <= maxTime; time += maxTime > 40 ? 10 : 5) xTicks.push(time);
    $('#chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Extra price change caused by the shock, by series, over time">
        ${yTicks.map((value) => `<line class="gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}"${value === 0 ? ' stroke="#8aa1af" stroke-opacity=".6"' : ''}/><text x="${margin.left - 8}" y="${y(value) + 4}" text-anchor="end">${value}%</text>`).join('')}
        ${xTicks.map((time) => `<text x="${x(time)}" y="${height - 8}" text-anchor="middle">${time}</text>`).join('')}
        <text x="${width - margin.right}" y="${height - 8}" text-anchor="end">bars</text>
        <line x1="${x(data.forkTime)}" x2="${x(data.forkTime)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#8aa1af" stroke-dasharray="3 4"/>
        ${lines.map((line) => `<path d="${path(line.row.extra)}" fill="none" stroke="${line.color}" stroke-width="2.4"/>`).join('')}
        <line id="cursor" x1="0" x2="0" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#d9e6ec" stroke-opacity=".5" visibility="hidden"/>
        <rect id="hit" x="${margin.left}" y="${margin.top}" width="${width - margin.left - margin.right}" height="${height - margin.top - margin.bottom}" fill="transparent"/>
    </svg>`;
    $('#legend').innerHTML = lines.map((line) => `<span><i style="border-color:${line.color}"></i>${escapeHtml(line.row.name)}</span>`).join('');
    const svg = $('#chart svg');
    const readout = $('#readout');
    readout.textContent = 'Move over the chart to read values.';
    $('#hit').addEventListener('mousemove', (event) => {
        const box = svg.getBoundingClientRect();
        const time = Math.min(maxTime, Math.max(0, ((event.clientX - box.left) / box.width * width - margin.left) / (width - margin.left - margin.right) * maxTime));
        const cursor = $('#cursor');
        cursor.setAttribute('x1', x(time));
        cursor.setAttribute('x2', x(time));
        cursor.setAttribute('visibility', 'visible');
        const at = (points) => points.reduce((best, point) => (Math.abs(point[0] - time) < Math.abs(best[0] - time) ? point : best))[1];
        readout.textContent = `Bar ${Math.round(time)}: ${lines.map((line) => `${line.row.name} ${signed(at(line.row.extra), 2)}%`).join(' · ')}`;
    });
    $('#hit').addEventListener('mouseleave', () => { $('#cursor').setAttribute('visibility', 'hidden'); });
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
    const { summary } = state.run;
    const csvField = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));
    const lines = ['series,extra_change_percent,largest_extra_change_percent,largest_at_bar,change_with_shock_percent,change_with_no_shock_percent'];
    for (const row of summary.rows) lines.push([row.name, row.end, row.peak, row.peakAt, row.scenarioEnd, row.baselineEnd].map(csvField).join(','));
    try {
        const result = await call(api.exportResults(state.run.scenario.scenarioId, { summaryCsv: `${lines.join('\n')}\n` }));
        $('#exportStatus').innerHTML = result.exported
            ? notice('ok', `<strong>Saved.</strong> ${result.files.map(escapeHtml).join(', ')} are in ${escapeHtml(result.folder)}. The run manifest records the versions, the hashes of your files and the model, and the changes applied.`)
            : '';
    } catch (error) {
        $('#exportStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
});

$('#anotherScenario').addEventListener('click', () => { renderScenarios(); show('whatif'); });

// ---- step 5: learn ----------------------------------------------------------------------------------------

const blurbs = {
    gettingStarted: 'A five-minute walk-through: load series, find links, shock one, read the comparison.',
    dataFormat: 'What the files need, how dates and decimals are read, and what is repaired or left out.',
    assumptions: 'What links mean, why they come and go, how the what-if is built, and what it has not been tested against.'
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
        renderSlot();
        renderFetchHint();
        renderLearn();
        refreshSteps();
    } catch (error) {
        $('#importStatus').innerHTML = notice('error', escapeHtml(error.message));
    }
})();
