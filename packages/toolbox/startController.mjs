/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { assumptionControls, assumptionDefaults, advisoryText, checkValue, formatValue, networkOptions, shockControls } from './lib/scenarioControls.mjs';
import { assumptionSensitivity, failingNames, findBreakingPoint, fragilityText, rankInstitutions, summarizeRun } from './lib/explore.mjs';
import { buildRequest, checkControls, defaultControls } from './lib/scenarioRequest.mjs';

export function initStartController({ api, onModelUpdated, onScenarioRun }) {
    const root = document.querySelector('#view-start');
    if (!root) return;
    const $ = (selector) => root.querySelector(selector);
    const $$ = (selector) => root.querySelectorAll(selector);

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

const state = {
    manifest: null, importer: null, files: {}, imported: null, scenarioId: null, entity: null, run: null, busy: false,
    // Settings: the assumptions and network the user has changed (the model is rebuilt with them), and the shock controls for the scenario.
    model: null, settings: {}, network: 'auto', appliedKey: '{}', controls: null, defaults: null, controlsKey: '', rows: [],
    // Exploring, pinning and the last sensitivity check.
    cancel: false, pinned: null, sensitivity: null, sensitivityKey: '', exploreTab: 'rank'
};

// ---- steps ------------------------------------------------------------------------------------------------

function show(step) {
    for (const panel of $$('.panel')) panel.classList.toggle('active', panel.id === `panel-${step}`);
    for (const button of $$('.step')) {
        if (button.dataset.step === step) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
    }
    $('main').scrollTop = 0;
    if (step === 'explore') renderExplore();
}

function refreshSteps() {
    const steps = { data: true, scenario: Boolean(state.imported), results: Boolean(state.run), explore: Boolean(state.imported), learn: true };
    for (const button of $$('.step')) {
        button.disabled = !steps[button.dataset.step];
        button.classList.toggle('done', (button.dataset.step === 'data' && Boolean(state.imported)) || (button.dataset.step === 'scenario' && Boolean(state.run)));
    }
}

for (const button of $$('.step')) button.addEventListener('click', () => show(button.dataset.step));
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
            state.model = result.data;
            Object.assign(state, { settings: {}, network: 'auto', appliedKey: '{}', controlsKey: '', sensitivity: null, pinned: null });
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
    const key = `${state.scenarioId}|${scenario.choose ? state.entity : ''}`;
    if (state.controlsKey !== key) { initControls(); state.controlsKey = key; }
    renderControls();
}

api.onProgress((progress) => {
    if (state.busy) $('#runStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>${escapeHtml(progress.message)}</span></div>`;
});

const runSignals = ['equity', 'reserves'];

$('#runScenario').addEventListener('click', async () => {
    const scenario = scenarioOf();
    if (!scenario || state.problems?.length) return;
    state.busy = true;
    $('#runScenario').disabled = true;
    $('#runStatus').innerHTML = '<div class="running"><div class="spinner"></div><span>Starting…</span></div>';
    try {
        const request = buildRequest(scenario, state.controls, state.defaults, facilityIndex());
        const options = modelOptions();
        await ensureModel(options);
        const data = await call(api.runScenario(scenario.scenarioId, { entity: scenario.choose ? state.entity : null, signals: runSignals, runTime: request.runTime, overrides: request.overrides }));
        state.run = { scenario, data, summary: summarize(data), request, options, changed: changedList(request) };
        $('#runStatus').replaceChildren();
        renderResults();
        refreshSteps();
        show('results');
    } catch (error) {
        $('#runStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
    } finally {
        state.busy = false;
        $('#runScenario').disabled = Boolean(state.problems?.length);
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
    renderCustomSettings();
    renderPin();
    renderChart(summary, data);
    const sorted = [...summary.rows].sort((left, right) => summary.lossOf(right) - summary.lossOf(left));
    $('#resultTable').innerHTML = `<thead><tr><th>Institution</th><th>Starting equity</th><th>Baseline, end</th><th>Scenario, end</th><th>Change</th><th>Lowest cash</th><th>Status</th></tr></thead><tbody>${sorted.map((row) => {
        const change = row.scenarioEnd - row.start;
        return `<tr><td>${escapeHtml(row.name)}</td><td>${number.format(row.start)}</td><td>${number.format(row.baselineEnd)}</td><td class="${row.scenarioEnd < 0 ? 'negative' : ''}">${row.scenarioEnd < 0 ? `shortfall ${number.format(-row.scenarioEnd)}` : number.format(row.scenarioEnd)}</td><td class="${change < -0.5 ? 'negative' : ''}">${change < -0.5 ? '−' : change > 0.5 ? '+' : ''}${number.format(Math.abs(change))}</td><td>${number.format(row.lowestCash)}${row.lowestCashShare === null ? '' : ` <span class="empty">(${(100 * row.lowestCashShare).toFixed(1)}% of deposits)</span>`}</td><td>${row.scenarioFailure === null ? '<span class="status ok">Solvent</span>' : `<span class="status bad">Insolvent from about day ${day(row.scenarioFailure)}</span>`}</td></tr>`;
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
        await call(api.openInCanvas(state.run.scenario.scenarioId, { focus: true }));
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

// ---- settings ---------------------------------------------------------------------------------------------

const scenarioOf = () => state.manifest.scenarios.find((item) => item.scenarioId === state.scenarioId);
const facilityIndex = () => Object.entries(state.model?.facilityMaximum ?? {}).map(([entity, maximum]) => ({ key: 'emergencyLending', entity, maximum }));
const institutionRow = (name) => state.imported.report.institutions.find((row) => row.name === name);

// What the importer is asked to rebuild the model with: only what differs from the defaults, so a default model is asked for with no options at all.
function modelOptions() {
    const assumptions = Object.fromEntries(Object.entries(state.settings).filter(([key, value]) => value !== assumptionDefaults[key]));
    return { ...(Object.keys(assumptions).length ? { assumptions } : {}), ...(state.network !== 'auto' ? { network: state.network } : {}) };
}

// Rebuilds the model on the host if it was last built with different options. Anything the host had run is released by that, so callers that
// need a result afterwards run again.
function normalizeOptions(options) {
    const assumptions = Object.fromEntries(Object.entries(options.assumptions ?? {}).filter(([key, value]) => value !== assumptionDefaults[key]));
    return { ...(Object.keys(assumptions).length ? { assumptions } : {}), ...(options.network && options.network !== 'auto' ? { network: options.network } : {}) };
}

async function ensureModel(requested) {
    const options = normalizeOptions(requested);
    const key = JSON.stringify(options);
    if (key === state.appliedKey) return;
    const result = await call(api.runImport(state.importer.importerId, options));
    if (!result.imported) throw new Error(result.report.errors.map((error) => error.message).join(' ') || 'The model could not be built with those settings.');
    state.imported = { report: result.report, entities: result.entities };
    state.model = result.data;
    state.appliedKey = key;
}

function initControls() {
    const scenario = scenarioOf();
    if (!scenario || !state.imported) return;
    state.defaults = defaultControls(scenario, { entity: scenario.choose ? state.entity : null, names: entitiesBySize(), haircutDefault: state.model?.haircutDefault ?? 0.1 });
    state.controls = structuredClone(state.defaults);
}

const changedList = (request) => [
    ...request.changed,
    ...assumptionControls.filter((control) => state.settings[control.key] !== undefined && state.settings[control.key] !== control.default).map((control) => `${control.label.toLowerCase()} (${formatValue(control, state.settings[control.key])}, default ${formatValue(control, control.default)})`),
    ...(state.network !== 'auto' ? [`interbank network: ${networkOptions.find((option) => option.key === state.network).label.split(':')[0].toLowerCase()}`] : [])
];

const shown = (control, value) => (control.percent ? Number((100 * value).toPrecision(6)) : value);
const parsed = (control, text) => { const number = Number(text); return text === '' || !Number.isFinite(number) ? Number.NaN : control.percent ? number / 100 : number; };
const approximately = (a, b) => Math.abs(a - b) < 1e-9;

function sliderBounds(control, hardMax) {
    const top = hardMax ?? control.advisoryMax * 2;
    return { min: control.hardMin, max: Math.min(top, Math.max(control.advisoryMax * 2, control.default ?? 0, control.advisoryMax + (control.advisoryMax - control.advisoryMin))) };
}

// One row per setting: a name, a slider, a typed value, a marker when it differs from its default, and a line for a problem, advice or how much it matters.
function settingRow(descriptor) {
    const { id, control, get, defaultValue, hardMax } = descriptor;
    const bounds = sliderBounds(control, hardMax ?? control.hardMax);
    return `<div class="ctl" data-row="${escapeHtml(id)}">
        <label for="n-${escapeHtml(id)}">${escapeHtml(descriptor.label ?? control.label)}<small>${escapeHtml(control.unit ? `${control.percent ? '% ' : ''}${control.unit}` : '')}</small></label>
        <input type="range" id="r-${escapeHtml(id)}" data-input="${escapeHtml(id)}" min="${shown(control, bounds.min)}" max="${shown(control, bounds.max)}" step="${shown(control, control.step)}" value="${shown(control, get())}" aria-label="${escapeHtml(descriptor.label ?? control.label)}, slider">
        <input type="number" id="n-${escapeHtml(id)}" data-input="${escapeHtml(id)}" step="any" value="${shown(control, get())}">
        <span class="marker" data-marker="${escapeHtml(id)}"></span>
        <div class="detail" data-detail="${escapeHtml(id)}">${escapeHtml(control.note ?? '')}</div>
    </div>`;
}

function renderControls() {
    const scenario = scenarioOf();
    const body = $('#controlsBody');
    if (!scenario || !state.controls || !state.imported) { body.replaceChildren(); return; }
    const controls = state.controls;
    const defaults = state.defaults;
    const rows = [];
    const add = (descriptor) => { rows.push(descriptor); return settingRow(descriptor); };
    const names = entitiesBySize();
    const stressedTable = names.map((name) => {
        const row = institutionRow(name);
        const cashShare = row.deposits ? (100 * row.cash) / row.deposits : null;
        const dependence = row.assets ? (100 * (row.interbankAssets + row.interbankLiabilities)) / row.assets : null;
        const on = name in controls.stressed;
        return `<tr><td><input type="checkbox" data-stress="${escapeHtml(name)}" ${on ? 'checked' : ''} aria-label="Stress ${escapeHtml(name)}"></td><td>${escapeHtml(name)}</td>
            <td class="number">${cashShare === null ? '—' : `${cashShare.toFixed(1)}%`}</td><td class="number">${dependence === null ? '—' : `${dependence.toFixed(0)}%`}</td>
            <td class="number"><input type="number" step="any" data-rate="${escapeHtml(name)}" value="${on ? shown(shockControls.withdrawalRate, controls.stressed[name]) : ''}" ${on ? '' : 'disabled'} aria-label="Withdrawal rate for ${escapeHtml(name)}, percent of deposits per day"></td></tr>`;
    }).join('');
    const stressesSomeone = Object.keys(defaults.stressed).length > 0 || scenario.interventions.some((item) => item.parameter === 'withdrawalRate');
    const supportRows = scenario.interventions.some((item) => item.parameter === 'emergencyLending') || controls.support.on;
    let html = '<h4>The shock</h4>';
    if (stressesSomeone) {
        html += `<p class="lede" style="margin: 0">Tick the institutions depositors run on, and set each one's withdrawal rate (percent of deposits a day). The two ratios are plain views of your data, not a likelihood: the model has no idea which institution is likely to be run on.</p>
            <div class="ctable-wrap"><table class="ctable"><thead><tr><th></th><th>Institution</th><th class="number">Cash / deposits</th><th class="number">Interbank / assets</th><th class="number">Withdrawal rate, % a day</th></tr></thead><tbody>${stressedTable}</tbody></table></div>
            <div data-detail="stressed" class="ctl-note lede" style="margin: 6px 0 0"></div>`;
        html += add({ id: 'start', control: shockControls.start, get: () => controls.start, defaultValue: defaults.start, hardMax: Math.max(0, controls.runLength - scenario.forkAt) });
        html += add({ id: 'duration', control: shockControls.duration, get: () => controls.duration, defaultValue: defaults.duration, hardMax: Math.max(0.5, controls.runLength - scenario.forkAt) });
    }
    html += add({ id: 'haircut', control: shockControls.haircut, get: () => controls.haircut, defaultValue: defaults.haircut });
    html += `<div class="ctl" data-row="supportOn"><label for="n-supportOn">Central-bank support<small>lends to the stressed institutions while they are short of cash</small></label><span><input type="checkbox" id="n-supportOn" data-support="on" ${controls.support.on ? 'checked' : ''}> on</span><span></span><span class="marker" data-marker="supportOn"></span></div>`;
    if (controls.support.on || supportRows) {
        html += add({ id: 'supportSize', control: shockControls.supportSize, get: () => controls.support.size, defaultValue: defaults.support.size });
        html += add({ id: 'supportDelay', control: shockControls.supportDelay, get: () => controls.support.delay, defaultValue: defaults.support.delay, hardMax: Math.max(0, controls.runLength - scenario.forkAt) });
    }
    html += add({ id: 'runLength', control: shockControls.runLength, get: () => controls.runLength, defaultValue: defaults.runLength });
    html += `<h4>Assumptions, not calibrated</h4>
        <p class="lede" style="margin: 0">These rebuild the model. None is calibrated to your institutions, and the line under each says what happens to who fails if it is halved or raised by half, once you have checked. <button class="button" type="button" id="checkSensitivity">Check how much each assumption matters</button></p>`;
    for (const control of assumptionControls) html += add({ id: `a:${control.key}`, control, get: () => state.settings[control.key] ?? control.default, defaultValue: control.default, assumption: true });
    html += `<div class="ctl" data-row="network" style="grid-template-columns: minmax(180px, 1.3fr) 1fr auto"><label for="networkChoice">Interbank network<small>who lent to whom, and whether it is used</small></label>
        <select id="networkChoice">${networkOptions.map((option) => `<option value="${option.key}" ${option.key === state.network ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}</select><span class="marker" data-marker="network"></span></div>
        <div class="detail" style="font-size: 12px; color: var(--muted)">The network changes the answer a lot. Compare all four on the Explore step.</div>`;
    body.innerHTML = html;
    state.rows = rows;
    refreshControls();
}

function refreshControls() {
    const scenario = scenarioOf();
    if (!scenario || !state.controls) return;
    const { problems, advice } = checkControls(scenario, state.controls);
    const request = buildRequest(scenario, state.controls, state.defaults, facilityIndex());
    const fresh = state.sensitivity && state.sensitivityKey === sensitivityKey();
    const allProblems = [...problems];
    for (const descriptor of state.rows) {
        const { id, control, get, defaultValue, assumption } = descriptor;
        const value = get();
        const check = checkValue(control, value, descriptor.hardMax ?? control.hardMax);
        const row = $(`[data-row="${CSS.escape(id)}"]`);
        if (!row) continue;
        row.classList.toggle('invalid', !check.ok);
        if (assumption && !check.ok) allProblems.push(check.message);
        $(`[data-marker="${CSS.escape(id)}"]`).innerHTML = approximately(value, defaultValue) ? '' : `changed from ${escapeHtml(formatValue(control, defaultValue))} <button class="button link" type="button" data-reset="${escapeHtml(id)}">reset</button>`;
        const detail = $(`[data-detail="${CSS.escape(id)}"]`);
        const fragile = assumption && state.sensitivity && state.sensitivity.rows.find((entry) => entry.key === control.key);
        const fragileText = fragile ? fragilityText(fragile, state.sensitivity.baseline) : null;
        detail.className = `detail ${!check.ok ? 'problem' : check.advisory ? 'advice' : fragileText?.fragile ? 'fragile' : ''}`;
        detail.innerHTML = !check.ok ? escapeHtml(check.message)
            : `${check.advisory ? `${escapeHtml(advisoryText(control, check.advisory))} ` : ''}${escapeHtml(control.note ?? '')}${fragileText ? ` <br>${fragileText.fragile ? '<b>Fragile.</b> ' : ''}${escapeHtml(fragileText.text)}${fresh ? '' : ' <i>(from an earlier check; out of date)</i>'}` : ''}`;
        const range = $(`#r-${CSS.escape(id)}`);
        const number = $(`#n-${CSS.escape(id)}`);
        if (range && document.activeElement !== range && Number.isFinite(value)) range.value = shown(control, value);
        if (number && document.activeElement !== number && Number.isFinite(value)) number.value = shown(control, value);
    }
    const supportMarker = $('[data-marker="supportOn"]');
    if (supportMarker) supportMarker.innerHTML = state.controls.support.on === state.defaults.support.on ? '' : `changed from ${state.defaults.support.on ? 'on' : 'off'} <button class="button link" type="button" data-reset="supportOn">reset</button>`;
    const networkMarker = $('[data-marker="network"]');
    if (networkMarker) networkMarker.innerHTML = state.network === 'auto' ? '' : `changed from as given <button class="button link" type="button" data-reset="network">reset</button>`;
    const stressedNote = $('[data-detail="stressed"]');
    if (stressedNote) {
        const notes = Object.entries(state.controls.stressed).map(([name, rate]) => { const result = checkValue(shockControls.withdrawalRate, rate); return !result.ok ? result.message.replace('Withdrawal rate', `Withdrawal rate for ${name}`) : result.advisory ? `${name}: ${advisoryText(shockControls.withdrawalRate, result.advisory)}` : ''; }).filter(Boolean);
        stressedNote.textContent = notes.join(' ');
        stressedNote.style.color = notes.some((note) => /cannot be/.test(note)) ? 'var(--danger)' : '';
    }
    state.problems = allProblems;
    const changed = changedList(request);
    $('#controlsBadge').textContent = changed.length ? `${changed.length} changed` : 'defaults';
    $('#controlsBadge').className = `badge${changed.length ? ' required' : ''}`;
    $('#controlProblems').innerHTML = allProblems.length ? `<div class="notice error"><div><strong>These settings cannot be run.</strong><ul>${allProblems.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div></div>` : '';
    $('#runScenario').disabled = state.busy || allProblems.length > 0;
    $('#resetAll').disabled = changed.length === 0;
}

function setSetting(id, value) {
    const controls = state.controls;
    if (id.startsWith('a:')) state.settings[id.slice(2)] = value;
    else if (id === 'start') controls.start = value;
    else if (id === 'duration') controls.duration = value;
    else if (id === 'haircut') controls.haircut = value;
    else if (id === 'supportSize') controls.support.size = value;
    else if (id === 'supportDelay') controls.support.delay = value;
    else if (id === 'runLength') controls.runLength = value;
}

const defaultOf = (id) => (id.startsWith('a:') ? assumptionDefaults[id.slice(2)] : id === 'start' ? state.defaults.start : id === 'duration' ? state.defaults.duration : id === 'haircut' ? state.defaults.haircut : id === 'supportSize' ? state.defaults.support.size : id === 'supportDelay' ? state.defaults.support.delay : state.defaults.runLength);
const controlOf = (id) => state.rows.find((row) => row.id === id)?.control;

$('#controlsBody').addEventListener('input', (event) => {
    const id = event.target.dataset.input;
    if (id !== undefined) {
        const control = controlOf(id);
        const value = event.target.type === 'range' ? parsed(control, event.target.value) : parsed(control, event.target.value);
        if (Number.isFinite(value)) { setSetting(id, event.target.type === 'range' ? Number(value.toPrecision(10)) : value); refreshControls(); }
        return;
    }
    const rate = event.target.dataset.rate;
    if (rate !== undefined) {
        const value = parsed(shockControls.withdrawalRate, event.target.value);
        state.controls.stressed[rate] = Number.isFinite(value) ? value : Number.NaN;
        refreshControls();
    }
});
$('#controlsBody').addEventListener('change', (event) => {
    const stress = event.target.dataset.stress;
    if (stress !== undefined) {
        if (event.target.checked) state.controls.stressed[stress] = state.defaults.stressed[stress] ?? Object.values(state.defaults.stressed)[0] ?? state.controls.stressed[Object.keys(state.controls.stressed)[0]] ?? 0.015;
        else delete state.controls.stressed[stress];
        renderControls();
        return;
    }
    if (event.target.dataset.support === 'on') { state.controls.support.on = event.target.checked; renderControls(); return; }
    if (event.target.id === 'networkChoice') { state.network = event.target.value; refreshControls(); }
});
$('#controlsBody').addEventListener('click', (event) => {
    const reset = event.target.dataset.reset;
    if (reset !== undefined) {
        if (reset === 'supportOn') state.controls.support.on = state.defaults.support.on;
        else if (reset === 'network') state.network = 'auto';
        else if (reset.startsWith('a:')) delete state.settings[reset.slice(2)];
        else setSetting(reset, defaultOf(reset));
        renderControls();
        return;
    }
    if (event.target.id === 'checkSensitivity') runSensitivityCheck().catch((error) => exploreFailed(error));
});

function resetAll() {
    state.settings = {};
    state.network = 'auto';
    initControls();
    renderControls();
}
$('#resetAll').addEventListener('click', resetAll);

// ---- custom settings and pinning on the results page --------------------------------------------------------

function renderCustomSettings() {
    const { changed } = state.run;
    $('#customSettings').innerHTML = changed.length
        ? `<div class="notice warning customSettings"><div><strong>Custom settings: this is not the scenario as declared.</strong> These differ from the defaults, and are recorded in the run manifest when you export.<ul>${changed.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul><button class="button link" type="button" id="backToDefaults">Reset to the defaults</button></div></div>`
        : '';
    $('#backToDefaults')?.addEventListener('click', () => { resetAll(); show('scenario'); });
}

const runLabel = (run) => `${run.scenario.name}${run.scenario.choose ? ` on ${run.data.entity}` : ''}${run.changed.length ? ' (custom settings)' : ''}`;

$('#pinRun').addEventListener('click', () => {
    state.pinned = { label: runLabel(state.run), summary: state.run.summary, changed: state.run.changed };
    renderPin();
});

function renderPin() {
    const box = $('#pinCompare');
    const pinned = state.pinned;
    if (!pinned) { box.replaceChildren(); return; }
    const now = { label: runLabel(state.run), summary: state.run.summary, changed: state.run.changed };
    const column = (entry) => {
        const summary = entry.summary;
        return { label: entry.label, failing: summary.insolvent.map((row) => row.name), first: summary.firstFailure, total: summary.totalLoss };
    };
    const [left, right] = [column(pinned), column(now)];
    const same = left.label === right.label && JSON.stringify(pinned.changed) === JSON.stringify(now.changed) && left.total === right.total;
    const firstText = (entry) => (entry.first ? `${escapeHtml(entry.first.name)}, around day ${day(entry.first.scenarioFailure)}` : 'nobody');
    box.innerHTML = `<div class="pin"><h3>Compared with the pinned run</h3>${same ? '<p class="lede">This is the pinned run.</p>' : ''}
        <div class="card" style="padding: 6px 10px"><table><thead><tr><th></th><th>Pinned</th><th>This run</th></tr></thead><tbody>
        <tr><td>Run</td><td>${escapeHtml(left.label)}</td><td>${escapeHtml(right.label)}</td></tr>
        <tr><td>Institutions that fail</td><td>${left.failing.length}: ${escapeHtml(left.failing.join(', ') || 'none')}</td><td>${right.failing.length}: ${escapeHtml(right.failing.join(', ') || 'none')}</td></tr>
        <tr><td>First failure</td><td>${firstText(left)}</td><td>${firstText(right)}</td></tr>
        <tr><td>Total equity lost, millions</td><td>${number.format(left.total)}</td><td>${number.format(right.total)} <span class="empty">(${right.total >= left.total ? '+' : '−'}${number.format(Math.abs(right.total - left.total))})</span></td></tr>
        <tr><td>Changed from default</td><td>${escapeHtml(pinned.changed.join('; ') || 'nothing')}</td><td>${escapeHtml(now.changed.join('; ') || 'nothing')}</td></tr>
        </tbody></table></div></div>`;
}

// ---- exploring: many runs of the same scenario ------------------------------------------------------------

state.exploreResults = { rank: null, breaking: null, networks: null };
state.breaking = { control: 'haircut', criterion: 'chosen', low: 0, high: 1 };

function exploreContext() {
    const scenario = scenarioOf();
    return { scenario, request: buildRequest(scenario, state.controls, state.defaults, facilityIndex()), options: modelOptions() };
}
const sensitivityKey = () => { const { request, options } = exploreContext(); return JSON.stringify([state.scenarioId, state.entity, request.overrides, request.runTime, options]); };

// One run for a view that makes many: the model rebuilt if the options differ, the run summarized and released.
async function runOnce({ options, entity, overrides, runTime }) {
    await ensureModel(options);
    const data = await call(api.runScenario(state.scenarioId, { entity, signals: runSignals, runTime, overrides, retain: false }));
    return summarizeRun(data, state.imported.report.institutions);
}

function exploreFailed(error) {
    $('#exploreStatus').innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
}

// Runs a view, shows progress, and afterwards puts the host back as it was, so the results, the canvas and the export still work.
async function withExplore(work) {
    if (state.busy) return;
    const restore = state.run?.options ?? JSON.parse(state.appliedKey);
    state.busy = true;
    state.cancel = false;
    $('#cancelExplore').hidden = false;
    for (const button of $$('.explore-card button, #checkSensitivity, #runScenario')) button.disabled = true;
    try {
        await work((progress) => { $('#exploreStatus').innerHTML = `<div class="running"><div class="spinner"></div><span>${escapeHtml(progress)}</span></div>`; });
        $('#exploreStatus').replaceChildren();
    } catch (error) {
        exploreFailed(error);
    } finally {
        try {
            const key = JSON.stringify(restore);
            if (key !== state.appliedKey) {
                await ensureModel(restore);
                if (state.run) {
                    const { request, scenario } = state.run;
                    state.run.data = await call(api.runScenario(scenario.scenarioId, { entity: scenario.choose ? state.run.data.entity : null, signals: runSignals, runTime: request.runTime, overrides: request.overrides }));
                    state.run.summary = summarize(state.run.data);
                }
            }
        } catch (error) { exploreFailed(error); }
        state.busy = false;
        $('#cancelExplore').hidden = true;
        renderControls();
        if ($('#panel-explore').classList.contains('active')) renderExplore();
    }
}
$('#cancelExplore').addEventListener('click', () => { state.cancel = true; });

for (const tab of document.querySelectorAll('[data-explore]')) {
    tab.addEventListener('click', () => { state.exploreTab = tab.dataset.explore; renderExplore(); });
}

const pct = (value, digits = 1) => `${Number((100 * value).toFixed(digits))}%`;
const failedText = (row) => (row.failures === 0 ? 'nobody' : `${row.failures}: ${row.failed.map((name) => name.replace(/ Bank$/, '')).join(', ')}`);

function renderExplore() {
    if (!state.imported || !state.controls) return;
    const scenario = scenarioOf();
    const { request } = exploreContext();
    for (const tab of document.querySelectorAll('[data-explore]')) tab.setAttribute('aria-selected', String(tab.dataset.explore === state.exploreTab));
    for (const card of document.querySelectorAll('.explore-card')) card.classList.toggle('hidden', card.id !== `explore-${state.exploreTab}`);
    const context = `<p class="lede" style="margin: 0 0 6px"><b>${escapeHtml(scenario.name)}</b>${scenario.choose ? `, stress on <b>${escapeHtml(state.entity)}</b>` : ''}${request.changed.length || Object.keys(modelOptions()).length ? ` <span class="badge required">custom settings</span>` : ' <span class="badge">defaults</span>'}. Change the scenario or settings on the Scenario step.</p>`;
    const chosenRate = state.controls.stressed[state.entity] ?? Object.values(state.controls.stressed)[0] ?? Object.values(state.defaults.stressed)[0] ?? 0.015;

    // -- rank
    const rank = state.exploreResults.rank;
    $('#explore-rank').innerHTML = `<div class="title">Rank institutions</div>${context}
        <p class="lede" style="margin: 0">The same shock on each institution in turn, at ${pct(chosenRate, 3)} of deposits a day. This says how much damage a run on each one would do, if it happened. It does not say which institution is likely to be run on: the model has no idea.</p>
        ${scenario.choose ? '' : '<div class="notice warning"><div>This scenario stresses every institution at once, so there is nothing to rank. Choose a scenario that stresses one institution.</div></div>'}
        <div class="explore-row"><button class="button primary" type="button" id="runRank" ${scenario.choose && !state.problems?.length ? '' : 'disabled'}>Run on every institution</button></div>
        ${rank ? `<div class="card" style="padding: 6px 10px; margin-top: 12px"><table id="rankTable"><thead><tr><th>If this institution is run on</th><th>Total equity lost, millions</th><th>Institutions that fail</th><th>First failure, about day</th><th>Its own failure, about day</th></tr></thead><tbody>${rank.rows.map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${number.format(row.total)}</td><td>${escapeHtml(failedText(row))}</td><td>${row.firstFailureDay === null ? '—' : day(row.firstFailureDay)}</td><td>${row.ownFailureDay === null ? 'holds' : day(row.ownFailureDay)}</td></tr>`).join('')}</tbody></table></div>
            <p class="lede" style="margin: 8px 0 0">Ranked by total damage, worst first. ${rank.cancelled ? 'Cancelled: the rows that finished are shown.' : ''} Run with the settings that were current at ${escapeHtml(rank.at)}.</p>` : ''}`;

    // -- breaking point
    const bp = state.breaking;
    const bpResult = state.exploreResults.breaking;
    const withdrawalName = state.entity ?? Object.keys(state.controls.stressed)[0] ?? '';
    $('#explore-breaking').innerHTML = `<div class="title">Find the breaking point</div>${context}
        <p class="lede" style="margin: 0">Raise one control step by step and find where an institution first fails. It scans 12 points across the range you give, narrows the first change by halving, and confirms it by running just below and just above.</p>
        <div class="explore-row">
            <label class="field">Control<select id="bpControl"><option value="haircut" ${bp.control === 'haircut' ? 'selected' : ''}>Forced-sale discount</option><option value="withdrawal" ${bp.control === 'withdrawal' ? 'selected' : ''} ${scenario.choose ? '' : 'disabled'}>Withdrawal rate of ${escapeHtml(withdrawalName)}</option></select></label>
            <label class="field">Until<select id="bpCriterion"><option value="chosen" ${bp.criterion === 'chosen' ? 'selected' : ''}>${escapeHtml(withdrawalName || 'the stressed institution')} fails</option><option value="other" ${bp.criterion === 'other' ? 'selected' : ''}>a second institution fails (the cascade)</option></select></label>
            <label class="field">From, %<input type="number" id="bpLow" step="any" value="${Number((100 * bp.low).toPrecision(6))}"></label>
            <label class="field">To, %<input type="number" id="bpHigh" step="any" value="${Number((100 * bp.high).toPrecision(6))}"></label>
            <button class="button primary" type="button" id="runBreaking" ${state.problems?.length ? 'disabled' : ''}>Find it</button>
        </div>
        ${bpResult ? breakingHtml(bpResult) : ''}`;

    // -- sensitivity
    const sensitivity = state.sensitivity;
    $('#explore-sensitivity').innerHTML = `<div class="title">Which assumptions matter</div>${context}
        <p class="lede" style="margin: 0">Each assumption halved and raised by half, one at a time, around its current value. It ranks over ranges we chose, not which assumption is most uncertain, and it ignores interactions between them.</p>
        <div class="explore-row"><button class="button primary" type="button" id="runSensitivity" ${state.problems?.length ? 'disabled' : ''}>Check every assumption</button></div>
        ${sensitivity ? sensitivityHtml(sensitivity) : ''}`;

    // -- networks
    const networks = state.exploreResults.networks;
    $('#explore-networks').innerHTML = `<div class="title">Compare the networks</div>${context}
        <p class="lede" style="margin: 0">The same scenario with the interbank network treated four ways. Who lent to whom decides how a run spreads, and the two ways of having no network are different things.</p>
        <div class="explore-row"><button class="button primary" type="button" id="runNetworks" ${state.problems?.length ? 'disabled' : ''}>Run all four</button></div>
        ${networks ? `<div class="card" style="padding: 6px 10px; margin-top: 12px"><table id="networkTable"><thead><tr><th>Network</th><th>Total equity lost, millions</th><th>Institutions that fail</th><th>First failure, about day</th></tr></thead><tbody>${networks.rows.map((row) => `<tr><td>${escapeHtml(row.label)}</td><td>${row.error ? '—' : number.format(row.total)}</td><td>${row.error ? escapeHtml(row.error) : escapeHtml(failedText(row))}</td><td>${row.firstFailureDay === null || row.error ? '—' : day(row.firstFailureDay)}</td></tr>`).join('')}</tbody></table></div>
            <p class="lede" style="margin: 8px 0 0">${escapeHtml(networks.note)}</p>` : ''}`;
}

function breakingHtml(result) {
    const control = result.control === 'haircut' ? 'forced-sale discount' : `withdrawal rate of ${result.entity}`;
    const value = (v) => pct(v, 2);
    let headline;
    if (result.status === 'cancelled') headline = 'Cancelled.';
    else if (result.status === 'none') headline = `No change over ${value(result.low)} to ${value(result.high)}: ${result.criterionText} at no point in this range. Try a wider range.`;
    else if (result.status === 'alreadyTrue') headline = `${result.criterionText} already at ${value(result.value)}, the bottom of the range. Try a lower start.`;
    else headline = `${result.criterionText[0].toUpperCase()}${result.criterionText.slice(1)} from a ${control} of about <b>${value(result.above)}</b> (between ${value(result.below)} and ${value(result.above)}).`;
    const facts = result.status === 'found'
        ? `<p class="lede" style="margin: 6px 0 0">First change found, not proven to be the only one${result.notMonotonic ? '; <b>the outcome changes more than once across this range</b>, so read the table' : ''}. Found by scanning 12 points, then narrowing; ${result.confirmed ? 'confirmed by running again just below (it does not happen) and just above (it does)' : '<b>not confirmed</b> by the rerun, so treat it with care'}. Over ${result.runLength} simulated days.</p>` : '';
    const maxTotal = Math.max(1, ...result.scan.map((point) => point.total));
    return `<p style="margin: 14px 0 0; font-size: 16px" id="bpHeadline">${headline}</p>${facts}
        <div class="card" style="padding: 6px 10px; margin-top: 10px"><table><thead><tr><th>${escapeHtml(control)}</th><th>Institutions that fail</th><th>Total equity lost, millions</th></tr></thead><tbody>${result.scan.map((point) => `<tr><td>${value(point.value)}</td><td>${point.failures}${point.hit ? ' <span class="status bad">yes</span>' : ''}</td><td>${number.format(point.total)} <span class="bar-track" style="display:inline-block; width:120px; vertical-align:middle"><i style="left:0; width:${Math.max(1, 100 * point.total / maxTotal)}%; background:var(--accent)"></i></span></td></tr>`).join('')}</tbody></table></div>`;
}

function sensitivityHtml(result) {
    const rows = result.rows;
    const scale = Math.max(0.05, ...rows.map((row) => row.largest));
    const fresh = state.sensitivityKey === sensitivityKey();
    const bar = (change, colour) => {
        if (!change || change.skipped) return '<div class="bar-track"><span class="zero" style="left:50%"></span></div>';
        const c = change.damageChange ?? 0;
        return `<div class="bar-track"><span class="zero" style="left:50%"></span><i style="background:${colour}; left:${c < 0 ? 50 + (100 * c) / scale / 2 : 50}%; width:${Math.abs(100 * c) / scale / 2}%"></i></div>`;
    };
    return `${fresh ? '' : '<div class="notice warning"><div>The settings have changed since this was checked, so it is out of date. Check again.</div></div>'}
        <p class="lede" style="margin: 10px 0 0">Baseline for this check: ${result.baseline.failures.length === 0 ? 'nobody fails' : `${failedText({ failures: result.baseline.failures.length, failed: failingNames(result.baseline) })} fail`}, total equity lost ${number.format(result.baseline.total)} million. Bars show the change in total damage: upper bar when halved, lower when raised by half.</p>
        <div class="bars" id="sensitivityBars">${rows.map((row) => `<div><b>${escapeHtml(row.label)}</b><br><span class="empty">${escapeHtml(formatValue(assumptionControls.find((control) => control.key === row.key), row.value))}</span></div>
            <div>${bar(row.changes[0], 'var(--ok)')}${bar(row.changes[1], 'var(--danger)')}<div class="lede" style="margin: 2px 0 0; font-size: 12px">${row.fragile ? '<b style="color: var(--warn)">Fragile.</b> ' : ''}${escapeHtml(fragilityText(row, result.baseline).text || 'already at its limit')}</div></div>`).join('')}</div>`;
}

$('#panel-explore').addEventListener('change', (event) => {
    if (event.target.id === 'bpControl') state.breaking.control = event.target.value;
    else if (event.target.id === 'bpCriterion') state.breaking.criterion = event.target.value;
    else if (event.target.id === 'bpLow' || event.target.id === 'bpHigh') {
        const value = Number(event.target.value) / 100;
        if (Number.isFinite(value)) state.breaking[event.target.id === 'bpLow' ? 'low' : 'high'] = value;
    } else return;
    if (event.target.id === 'bpControl') { state.breaking.low = 0; state.breaking.high = event.target.value === 'haircut' ? 1 : 0.05; renderExplore(); }
});
$('#panel-explore').addEventListener('click', (event) => {
    const id = event.target.id;
    if (id === 'runRank') runRank().catch(exploreFailed);
    else if (id === 'runBreaking') runBreaking().catch(exploreFailed);
    else if (id === 'runSensitivity') runSensitivityCheck().catch(exploreFailed);
    else if (id === 'runNetworks') runNetworks().catch(exploreFailed);
});

// Ranking: the scenario stresses each institution in turn, at the rate of the one chosen, with every other setting as it is.
async function runRank() {
    const { scenario, options } = exploreContext();
    const names = entitiesBySize();
    const rate = state.controls.stressed[state.entity] ?? Object.values(state.controls.stressed)[0] ?? Object.values(state.defaults.stressed)[0] ?? 0.015;
    await withExplore(async (progress) => {
        await ensureModel(options);
        const rows = await rankInstitutions({
            names, concurrency: 2, cancelled: () => state.cancel, onProgress: ({ done, total }) => progress(`Running on institution ${done} of ${total}…`),
            run: async (name) => {
                const defaults = defaultControls(scenario, { entity: name, names, haircutDefault: state.model.haircutDefault });
                const controls = structuredClone(state.controls);
                controls.stressed = { [name]: rate };
                const request = buildRequest(scenario, controls, defaults, facilityIndex());
                return runOnce({ options, entity: name, overrides: request.overrides, runTime: request.runTime });
            }
        });
        state.exploreResults.rank = { rows, cancelled: state.cancel, at: new Date().toLocaleTimeString() };
    });
}

async function runBreaking() {
    const { scenario, options } = exploreContext();
    const setting = state.breaking;
    const entity = state.entity ?? Object.keys(state.controls.stressed)[0];
    const criterion = setting.criterion === 'chosen'
        ? { test: (summary) => failingNames(summary).includes(entity), text: `${entity} fails` }
        : { test: (summary) => failingNames(summary).some((name) => name !== entity), text: 'a second institution fails' };
    const low = Math.min(setting.low, setting.high);
    const high = Math.max(setting.low, setting.high);
    const control = setting.control === 'haircut' ? shockControls.haircut : shockControls.withdrawalRate;
    for (const value of [low, high]) { const check = checkValue(control, value); if (!check.ok) { exploreFailed(new Error(check.message)); return; } }
    if (!(high > low)) { exploreFailed(new Error('The range needs a lower start than end.')); return; }
    await withExplore(async (progress) => {
        await ensureModel(options);
        const run = async (value) => {
            const controls = structuredClone(state.controls);
            if (setting.control === 'haircut') controls.haircut = value; else controls.stressed[entity] = value;
            const request = buildRequest(scenario, controls, state.defaults, facilityIndex());
            return runOnce({ options, entity: scenario.choose ? state.entity : null, overrides: request.overrides, runTime: request.runTime });
        };
        const result = await findBreakingPoint({
            run, criterion: criterion.test, low, high, cancelled: () => state.cancel,
            onProgress: ({ stage, done, total }) => progress(stage === 'scan' ? `Scanning point ${done} of ${total}…` : `Narrowing, step ${done} of ${total}…`)
        });
        state.exploreResults.breaking = { ...result, control: setting.control, entity, criterionText: criterion.text, low, high, runLength: state.controls.runLength };
    });
}

async function runSensitivityCheck() {
    const { scenario, request, options } = exploreContext();
    if (state.problems?.length) return;
    const current = { ...assumptionDefaults, ...state.settings };
    await withExplore(async (progress) => {
        const result = await assumptionSensitivity({
            current, cancelled: () => state.cancel, onProgress: ({ done, total }) => progress(`Checking assumption change ${done} of ${total}…`),
            run: (change) => runOnce({ options: { ...options, assumptions: { ...(options.assumptions ?? {}), ...change } }, entity: scenario.choose ? state.entity : null, overrides: request.overrides, runTime: request.runTime })
        });
        if (!result.cancelled) { state.sensitivity = result; state.sensitivityKey = sensitivityKey(); }
    });
    if ($('#panel-explore').classList.contains('active')) state.exploreTab = 'sensitivity';
}

async function runNetworks() {
    const { scenario, request, options } = exploreContext();
    const rows = [];
    await withExplore(async (progress) => {
        for (const [index, option] of networkOptions.entries()) {
            if (state.cancel) break;
            progress(`Running with the network ${index + 1} of ${networkOptions.length}…`);
            const label = option.key === 'auto' ? (state.imported.report.summary.exposuresEstimated ? 'Exposures estimated (none were given)' : 'Exposures as given') : option.label.split(':')[0];
            try {
                const summary = await runOnce({ options: { ...options, network: option.key === 'auto' ? undefined : option.key }, entity: scenario.choose ? state.entity : null, overrides: request.overrides, runTime: request.runTime });
                rows.push({ label, total: summary.total, failures: summary.failures.length, failed: failingNames(summary), firstFailureDay: summary.failures[0]?.day ?? null });
            } catch (error) {
                rows.push({ label, error: error.message });
            }
        }
        state.exploreResults.networks = { rows, note: 'Interbank frozen keeps every claim and borrowing at book value but lets no cash move and passes no losses on. No interbank exposure removes the balances: each institution settles its net position in cash, so its equity is unchanged.' };
    });
}

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
}
