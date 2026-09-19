/* Copyright © 2026 Zenin Easa Panthakkalakath */

const api = window.konjugateLauncher;
const $ = (selector) => document.querySelector(selector);
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const percent = (value) => `${Math.round(value)}%`;
// Failure days are read off a simulation that steps in tenths of a day, and shift by a day or two if the step is made finer, so they are
// given to the nearest day and called approximate.
const day = (time) => String(Math.round(time));
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// Every host call answers { ok: true, ... } or { ok: false, message }; turn the second into an exception.
async function call(promise) {
    const response = await promise;
    if (!response.ok) throw new Error(response.message);
    return response;
}

const state = { manifest: null, importer: null, files: {}, imported: null, scenarioId: null, entity: null, run: null, busy: false };

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
    const steps = { data: true, scenario: Boolean(state.imported), results: Boolean(state.run), learn: true };
    for (const button of document.querySelectorAll('.step')) {
        button.disabled = !steps[button.dataset.step];
        button.classList.toggle('done', (button.dataset.step === 'data' && Boolean(state.imported)) || (button.dataset.step === 'scenario' && Boolean(state.run)));
    }
}

for (const button of document.querySelectorAll('.step')) button.addEventListener('click', () => show(button.dataset.step));
document.addEventListener('click', (event) => {
    const page = event.target.closest('[data-page]')?.dataset.page;
    if (page) call(api.openPage(page)).catch((error) => console.error(error));
});

// ---- step 1: your data ------------------------------------------------------------------------------------

function renderSlots() {
    const slots = $('#slots');
    slots.replaceChildren();
    for (const file of state.importer.files) {
        const chosen = state.files[file.role];
        const card = document.createElement('div');
        card.className = 'card slot';
        card.innerHTML = `
            <div class="title">${escapeHtml(file.label)} <span class="badge ${file.required ? 'required' : ''}">${file.required ? 'Required' : 'Optional'}</span></div>
            <p class="description">${escapeHtml(file.description)}</p>
            <div class="file-line">${chosen
                ? `<span class="name" title="${escapeHtml(chosen.name)}">${escapeHtml(chosen.name)}${chosen.sample ? ' (sample)' : ''}</span><span class="empty">${number.format(chosen.bytes)} bytes</span>`
                : '<span class="empty">No file chosen</span>'}</div>
            <div class="actions" style="margin-top: 4px">
                <button class="button" type="button" data-choose="${file.role}">${chosen ? 'Choose another…' : 'Choose file…'}</button>
                ${chosen ? `<button class="button link" type="button" data-clear="${file.role}">Remove</button>` : ''}
            </div>`;
        slots.append(card);
    }
    $('#checkData').disabled = state.busy || !state.importer.files.filter((file) => file.required).every((file) => state.files[file.role]);
}

$('#slots').addEventListener('click', async (event) => {
    const role = event.target.dataset.choose;
    const clear = event.target.dataset.clear;
    try {
        if (role) {
            const result = await call(api.chooseFile(state.importer.importerId, role));
            if (!result.chosen) return;
            state.files[role] = { name: result.name, bytes: result.bytes, sample: false };
        } else if (clear) {
            await call(api.clearFile(state.importer.importerId, clear));
            delete state.files[clear];
        } else return;
        invalidateData();
    } catch (error) {
        $('#importStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
});

function invalidateData() {
    state.imported = null;
    state.run = null;
    state.scenarioId = state.scenarioId ?? state.manifest.scenarios[0]?.scenarioId ?? null;
    $('#importResult').replaceChildren();
    $('#importStatus').replaceChildren();
    renderSlots();
    refreshSteps();
}

$('#useSample').addEventListener('click', async () => {
    try {
        await call(api.useSample(state.importer.importerId));
        const manifest = await call(api.getManifest());
        state.files = manifest.files;
        invalidateData();
        await checkData();
    } catch (error) {
        $('#importStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
});

$('#checkData').addEventListener('click', checkData);

async function checkData() {
    state.busy = true;
    renderSlots();
    $('#importStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Checking your data and building the model…</span></div>';
    $('#importResult').replaceChildren();
    try {
        const result = await call(api.runImport(state.importer.importerId));
        $('#importStatus').replaceChildren();
        if (result.imported) {
            state.imported = { report: result.report, entities: result.entities };
            state.run = null;
            state.entity = null;
        } else state.imported = null;
        renderImportResult(result.report, result.imported);
    } catch (error) {
        $('#importStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
        state.busy = false;
        renderSlots();
        refreshSteps();
    }
}

const where = (item) => [item.file, item.line ? `line ${item.line}` : null, item.column].filter(Boolean).join(' · ');

function renderImportResult(report, imported) {
    const target = $('#importResult');
    let html = '';
    if (report.errors.length) {
        html += `<div class="notice error"><div><strong>${report.errors.length === 1 ? 'One problem needs fixing' : `${report.errors.length} problems need fixing`} before the model can be built.</strong>
            <ul>${report.errors.slice(0, 25).map((item) => `<li><span class="where">${escapeHtml(where(item))}</span>${escapeHtml(item.message)}</li>`).join('')}</ul>
            ${report.errors.length > 25 ? `<p class="lede">…and ${report.errors.length - 25} more.</p>` : ''}
            <p class="lede" style="margin-top: 8px">Fix the file and choose it again, or see <button class="button link" type="button" data-page="dataFormat">the data format</button>.</p></div></div>`;
    }
    if (report.warnings.length) {
        html += `<div class="notice warning"><div><strong>${report.warnings.length === 1 ? 'One thing to know' : `${report.warnings.length} things to know`}</strong>
            <ul>${report.warnings.slice(0, 12).map((item) => `<li>${item.line ? `<span class="where">${escapeHtml(where(item))}</span>` : ''}${escapeHtml(item.message)}</li>`).join('')}</ul></div></div>`;
    }
    if (imported) {
        const { summary } = report;
        html += `<div class="notice ok"><div><strong>Your data is ready.</strong> ${summary.institutions} institutions, ${summary.exposures} interbank exposures${summary.exposuresEstimated ? ' (estimated)' : ''}.</div></div>
            <div class="grid tiles" style="margin-top: 16px">
                <div class="tile"><div class="label">Institutions</div><div class="value">${summary.institutions}</div></div>
                <div class="tile"><div class="label">Total assets</div><div class="value">${number.format(summary.totalAssets)}</div><div class="sub">millions</div></div>
                <div class="tile"><div class="label">Total equity</div><div class="value">${number.format(summary.totalEquity)}</div><div class="sub">${percent((100 * summary.totalEquity) / summary.totalAssets)} of assets</div></div>
                <div class="tile"><div class="label">Interbank lending</div><div class="value">${number.format(summary.totalInterbank)}</div><div class="sub">${summary.exposuresEstimated ? 'estimated links' : `${summary.exposures} links`}</div></div>
            </div>
            <h3>Institutions</h3>
            <div class="card" style="padding: 6px 10px"><table><thead><tr><th>Institution</th><th>Assets</th><th>Equity</th><th>Equity / assets</th><th>Lent to banks</th><th>Borrowed from banks</th></tr></thead><tbody>
            ${report.institutions.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${number.format(row.assets)}</td><td>${number.format(row.equity)}</td><td>${(100 * row.equityRatio).toFixed(1)}%</td><td>${number.format(row.interbankAssets)}</td><td>${number.format(row.interbankLiabilities)}</td></tr>`).join('')}
            </tbody></table></div>
            <details class="detail" style="margin-top: 14px"><summary>Assumptions the model makes about your data</summary><ul>${Object.entries(report.assumptions).map(([key, value]) => `<li><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</li>`).join('')}</ul>
            <p class="lede">These are starting points, not calibrated to your institutions. <button class="button link" type="button" data-page="assumptions">Read more</button></p></details>
            <div class="actions"><button class="button primary" type="button" id="toScenarios">Choose a scenario</button></div>`;
    }
    target.innerHTML = html;
    $('#toScenarios')?.addEventListener('click', () => { renderScenarios(); show('scenario'); });
}

// ---- step 2: scenario -------------------------------------------------------------------------------------

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

function entitiesBySize() {
    const sizes = new Map(state.imported.report.institutions.map((item) => [item.name, item.assets]));
    return [...state.imported.entities].sort((left, right) => (sizes.get(right) ?? 0) - (sizes.get(left) ?? 0));
}

function renderScenarioDetail() {
    const scenario = state.manifest.scenarios.find((item) => item.scenarioId === state.scenarioId);
    const detail = $('#scenarioDetail');
    if (!scenario || !state.imported) { detail.classList.add('hidden'); $('#runScenario').disabled = true; return; }
    const entities = entitiesBySize();
    if (scenario.choose && !entities.includes(state.entity)) state.entity = entities[0];
    const effects = scenario.effects.map((line) => line.replaceAll('{entity}', scenario.choose ? state.entity : ''));
    detail.classList.remove('hidden');
    detail.innerHTML = `${scenario.choose ? `<label class="field" style="margin-top: 0">${escapeHtml(scenario.choose.label)}
            <select id="entityChoice">${entities.map((name) => `<option ${name === state.entity ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></label>` : ''}
        <h3 style="margin-top: ${scenario.choose ? 18 : 0}px">What this changes</h3>
        <ul>${effects.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>
        <p class="lede" style="margin-top: 8px">The model runs for ${scenario.runTime} days. The shock starts on day ${scenario.forkAt}; everything before that is identical to the baseline.</p>`;
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
        const data = await call(api.runScenario(scenario.scenarioId, { entity: scenario.choose ? state.entity : null, signals: ['equity', 'reserves'] }));
        state.run = { scenario, data, summary: summarize(data) };
        $('#runStatus').replaceChildren();
        renderResults();
        refreshSteps();
        show('results');
    } catch (error) {
        $('#runStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
        state.busy = false;
        $('#runScenario').disabled = false;
    }
});

// ---- step 3: results --------------------------------------------------------------------------------------

// Per-institution outcome from the equity series of the baseline and the scenario.
function summarize(data) {
    const [baseline, scenario] = data.branches;
    const rows = state.imported.report.institutions.map((institution) => {
        const base = baseline.series[institution.name]?.equity ?? [];
        const stressed = scenario.series[institution.name]?.equity ?? [];
        const start = stressed[0]?.[1] ?? institution.equity;
        const firstBelowZero = (series) => series.find(([, value]) => value < 0)?.[0] ?? null;
        const cash = scenario.series[institution.name]?.reserves ?? [];
        const lowestCash = cash.length ? Math.min(...cash.map(([, value]) => value)) : institution.cash;
        return {
            name: institution.name, assets: institution.assets, start, lowestCash, lowestCashShare: institution.deposits ? lowestCash / institution.deposits : null,
            baselineEnd: base.at(-1)?.[1] ?? start, scenarioEnd: stressed.at(-1)?.[1] ?? start,
            baselineFailure: firstBelowZero(base), scenarioFailure: firstBelowZero(stressed),
            base, stressed
        };
    });
    const insolvent = rows.filter((row) => row.scenarioFailure !== null);
    const baselineInsolvent = rows.filter((row) => row.baselineFailure !== null);
    const lossOf = (row) => row.start - row.scenarioEnd;
    const totalLoss = rows.reduce((sum, row) => sum + lossOf(row), 0);
    const baselineLoss = rows.reduce((sum, row) => sum + (row.start - row.baselineEnd), 0);
    const firstFailure = [...insolvent].sort((left, right) => left.scenarioFailure - right.scenarioFailure)[0] ?? null;
    const worst = [...rows].sort((left, right) => lossOf(right) - lossOf(left))[0];
    return { rows, insolvent, baselineInsolvent, totalLoss, baselineLoss, firstFailure, worst, lossOf };
}

function renderResults() {
    const { scenario, data, summary } = state.run;
    const total = summary.rows.length;
    const stress = scenario.choose ? ` on ${data.entity}` : '';
    $('#title-results').textContent = `${scenario.name}${stress}`;
    $('#headline').textContent = summary.insolvent.length
        ? `${summary.insolvent.length} of ${total} institutions become insolvent${summary.baselineInsolvent.length ? ` (${summary.baselineInsolvent.length} in the baseline)` : ' (none in the baseline)'}. The first is ${summary.firstFailure.name}, around day ${day(summary.firstFailure.scenarioFailure)}. Total equity falls by ${number.format(summary.totalLoss)} million, against ${number.format(summary.baselineLoss)} million with no shock.`
        : `No institution becomes insolvent. Total equity falls by ${number.format(summary.totalLoss)} million, against ${number.format(summary.baselineLoss)} million with no shock; the hardest hit is ${summary.worst.name}, which loses ${number.format(summary.lossOf(summary.worst))} million.`;
    $('#tiles').innerHTML = `
        <div class="tile ${summary.insolvent.length ? 'bad' : 'good'}"><div class="label">Insolvent institutions</div><div class="value">${summary.insolvent.length} of ${total}</div><div class="sub">baseline: ${summary.baselineInsolvent.length}</div></div>
        <div class="tile ${summary.firstFailure ? 'bad' : ''}"><div class="label">First failure</div><div class="value">${summary.firstFailure ? `~ Day ${day(summary.firstFailure.scenarioFailure)}` : 'None'}</div><div class="sub">${summary.firstFailure ? escapeHtml(summary.firstFailure.name) : 'in this run'}</div></div>
        <div class="tile"><div class="label">Equity lost</div><div class="value">${number.format(summary.totalLoss)}</div><div class="sub">millions · baseline ${number.format(summary.baselineLoss)}</div></div>
        <div class="tile"><div class="label">Hardest hit</div><div class="value" style="font-size: 18px">${escapeHtml(summary.worst.name)}</div><div class="sub">loses ${number.format(summary.lossOf(summary.worst))} million</div></div>`;
    const estimated = state.imported.report.summary.exposuresEstimated;
    $('#assumptionsBox').innerHTML = `${estimated ? '<div class="notice warning"><div><strong>The exposures were estimated, not given.</strong> Who lent to whom decides how a run spreads, and an estimated network can spread it very differently from the real one, so read this as one possible network, not the answer. Supply an exposures file for anything that matters.</div></div>' : ''}
        <details class="detail"><summary>What drives this result</summary>
        <p class="lede" style="margin-top: 6px">None of these is calibrated to your institutions. The first block is what this scenario changes; the second is what the model assumes everywhere.</p>
        <ul>${scenario.effects.map((line) => `<li>${escapeHtml(line.replaceAll('{entity}', data.entity ?? ''))}</li>`).join('')}</ul>
        <ul>${Object.entries(state.imported.report.assumptions).map(([key, value]) => `<li><b>${escapeHtml(key)}:</b> ${escapeHtml(value)}</li>`).join('')}</ul>
        <p class="lede">Failure days are approximate, to about a day or two: they shift a little if the simulation steps are made finer. The order in which institutions fail is what to rely on. <button class="button link" type="button" data-page="assumptions">Read more</button></p></details>`;
    renderChart(summary, data);
    const sorted = [...summary.rows].sort((left, right) => summary.lossOf(right) - summary.lossOf(left));
    $('#resultTable').innerHTML = `<thead><tr><th>Institution</th><th>Starting equity</th><th>Baseline, end</th><th>Scenario, end</th><th>Change</th><th>Lowest cash</th><th>Status</th></tr></thead><tbody>${sorted.map((row) => {
        const change = row.scenarioEnd - row.start;
        return `<tr><td>${escapeHtml(row.name)}</td><td>${number.format(row.start)}</td><td>${number.format(row.baselineEnd)}</td><td class="${row.scenarioEnd < 0 ? 'negative' : ''}">${number.format(row.scenarioEnd)}</td><td class="${change < -0.5 ? 'negative' : ''}">${change < -0.5 ? '−' : change > 0.5 ? '+' : ''}${number.format(Math.abs(change))}</td><td>${number.format(row.lowestCash)}${row.lowestCashShare === null ? '' : ` <span class="empty">(${(100 * row.lowestCashShare).toFixed(1)}% of deposits)</span>`}</td><td>${row.scenarioFailure === null ? '<span class="status ok">Solvent</span>' : `<span class="status bad">Insolvent from about day ${day(row.scenarioFailure)}</span>`}</td></tr>`;
    }).join('')}</tbody>`;
}

const palette = ['#45c6b8', '#e6b04a', '#ee8a7e', '#8fb4ff', '#c79bff'];

// Equity as a share of the starting level for the most affected institutions: the scenario as a solid
// line over the baseline as a dashed one, so the point where they part is where the shock bites.
function renderChart(summary, data) {
    const shown = [...summary.rows].sort((left, right) => summary.lossOf(right) - summary.lossOf(left)).slice(0, 5);
    const width = 860;
    const height = 300;
    const margin = { top: 12, right: 16, bottom: 28, left: 46 };
    const ratio = (row, series) => series.map(([time, value]) => [time, row.start ? (100 * value) / row.start : 0]);
    const lines = shown.map((row, index) => ({ row, color: palette[index], scenario: ratio(row, row.stressed), baseline: ratio(row, row.base) }));
    const values = lines.flatMap((line) => [...line.scenario, ...line.baseline].map(([, value]) => value));
    const low = Math.min(-10, Math.floor(Math.min(...values) / 20) * 20);
    const high = Math.max(110, Math.ceil(Math.max(...values) / 20) * 20);
    const maxTime = data.runTime;
    const x = (time) => margin.left + (time / maxTime) * (width - margin.left - margin.right);
    const y = (value) => margin.top + ((high - value) / (high - low)) * (height - margin.top - margin.bottom);
    const path = (points) => points.map(([time, value], index) => `${index ? 'L' : 'M'}${x(time).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    const yTicks = [];
    for (let value = Math.ceil(low / 20) * 20; value <= high; value += 20) yTicks.push(value);
    const xTicks = [];
    for (let time = 0; time <= maxTime; time += maxTime > 40 ? 10 : 5) xTicks.push(time);
    $('#chart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Equity of the most affected institutions over time, as a share of starting equity">
        ${yTicks.map((value) => `<line class="gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}"${value === 0 ? ' stroke="#ee8a7e" stroke-opacity=".6"' : ''}/><text x="${margin.left - 8}" y="${y(value) + 4}" text-anchor="end">${value}%</text>`).join('')}
        ${xTicks.map((time) => `<text x="${x(time)}" y="${height - 8}" text-anchor="middle">${time}</text>`).join('')}
        <text x="${margin.left - 8}" y="${height - 8}" text-anchor="end">day</text>
        <line x1="${x(data.forkTime)}" x2="${x(data.forkTime)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#8aa1af" stroke-dasharray="3 4"/>
        <text x="${x(data.forkTime) + 6}" y="${margin.top + 10}">shock starts</text>
        ${lines.map((line) => `<path d="${path(line.baseline)}" fill="none" stroke="${line.color}" stroke-width="1.5" stroke-dasharray="5 4" opacity=".55"/><path d="${path(line.scenario)}" fill="none" stroke="${line.color}" stroke-width="2.4"/>`).join('')}
        <line id="cursor" x1="0" x2="0" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#d9e6ec" stroke-opacity=".5" visibility="hidden"/>
        <rect id="hit" x="${margin.left}" y="${margin.top}" width="${width - margin.left - margin.right}" height="${height - margin.top - margin.bottom}" fill="transparent"/>
    </svg>`;
    $('#legend').innerHTML = `${lines.map((line) => `<span><i style="border-color:${line.color}"></i>${escapeHtml(line.row.name)}</span>`).join('')}<span><i class="dashed" style="border-color:#8aa1af"></i>baseline (dashed)</span>`;
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
        readout.textContent = `Day ${day(Math.round(time * 2) / 2)}: ${lines.map((line) => `${line.row.name} ${percent(at(line.scenario))}`).join(' · ')}`;
    });
    $('#hit').addEventListener('mouseleave', () => { $('#cursor').setAttribute('visibility', 'hidden'); });
}

$('#openCanvas').addEventListener('click', async () => {
    try {
        await call(api.openInCanvas(state.run.scenario.scenarioId));
        $('#exportStatus').innerHTML = '<div class="notice ok">Opened in the main Konjugate window, with the baseline and the scenario as two branches.</div>';
    } catch (error) {
        $('#exportStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
});

$('#exportResults').addEventListener('click', async () => {
    const { summary } = state.run;
    const csvField = (value) => (/[",\n]/.test(String(value)) ? `"${String(value).replaceAll('"', '""')}"` : String(value));
    const lines = ['institution,starting_equity,baseline_end_equity,scenario_end_equity,change,insolvent_from_day'];
    for (const row of summary.rows) lines.push([row.name, row.start, row.baselineEnd, row.scenarioEnd, row.scenarioEnd - row.start, row.scenarioFailure ?? ''].map(csvField).join(','));
    try {
        const result = await call(api.exportResults(state.run.scenario.scenarioId, { summaryCsv: `${lines.join('\n')}\n` }));
        $('#exportStatus').innerHTML = result.exported
            ? `<div class="notice ok"><div><strong>Saved.</strong> ${result.files.map(escapeHtml).join(', ')} are in ${escapeHtml(result.folder)}. The run manifest records the versions, the hashes of your files and the model, and the changes applied.</div></div>`
            : '';
    } catch (error) {
        $('#exportStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
});

$('#anotherScenario').addEventListener('click', () => { renderScenarios(); show('scenario'); });

// ---- step 4: learn ----------------------------------------------------------------------------------------

const blurbs = {
    gettingStarted: 'A five-minute walk-through: load data, run a scenario, read the comparison.',
    dataFormat: 'The two files, their columns and units, and every check that is made on them.',
    assumptions: 'What the model simplifies, what it assumes about your data, and what it has not been tested against.'
};

function renderLearn() {
    $('#learnCards').innerHTML = state.manifest.pages.map((page) => `<div class="card"><h3 style="margin: 0; color: var(--text); text-transform: none; letter-spacing: 0; font-size: 16px">${escapeHtml(page.label)}</h3><p>${escapeHtml(blurbs[page.pageId] ?? '')}</p><div class="actions" style="margin-top: 4px"><button class="button" type="button" data-page="${escapeHtml(page.pageId)}">Open</button></div></div>`).join('');
}

// ---- start ------------------------------------------------------------------------------------------------

(async () => {
    try {
        state.manifest = await call(api.getManifest());
        [state.importer] = state.manifest.importers;
        state.files = state.manifest.files;
        state.scenarioId = state.manifest.scenarios[0]?.scenarioId ?? null;
        renderSlots();
        renderLearn();
        refreshSteps();
        if (state.manifest.imported) {
            state.imported = { report: state.manifest.imported.report, entities: state.manifest.imported.entities };
            renderImportResult(state.manifest.imported.report, true);
            refreshSteps();
        }
    } catch (error) {
        $('#importStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    }
})();
