/* Copyright © 2026 Zenin Easa Panthakkalakath */

import { initStartController } from './startController.mjs';
import { initMarketsController } from './marketsController.mjs';

const api = window.konjugateLauncher;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

// ---- Synchronisation & Decoupling State ----------------------------------------------------------------

const syncState = {
    mode: 'coupled', // 'coupled' | 'decoupled'
    activeTool: null, // 'start' | 'markets' | null
    latestScenarioId: {
        start: null,
        markets: null
    }
};

function getActiveScenarioId() {
    if (syncState.activeTool && syncState.latestScenarioId[syncState.activeTool]) {
        return syncState.latestScenarioId[syncState.activeTool];
    }
    return syncState.latestScenarioId.start || syncState.latestScenarioId.markets || null;
}

async function syncToCanvas({ focus = false, silent = true } = {}) {
    if (!api) return;
    try {
        const scenarioId = getActiveScenarioId();
        await api.openInCanvas(scenarioId, { focus, silent });
        if (!focus) {
            flashSyncStatus('Synced to Konjugate');
        }
    } catch (error) {
        // When no data has been imported yet, silent auto-sync safely ignores the error
        if (focus) {
            alert(`Could not focus canvas: ${error.message}`);
        }
    }
}

function flashSyncStatus(message) {
    const label = $('#syncStatusLabel');
    if (!label) return;
    const original = syncState.mode === 'coupled' ? 'Canvas Live Sync' : 'Decoupled (Manual edit mode)';
    label.textContent = message;
    label.style.color = 'var(--accent)';
    setTimeout(() => {
        label.textContent = syncState.mode === 'coupled' ? 'Canvas Live Sync' : 'Decoupled (Manual edit mode)';
        label.style.color = '';
    }, 2200);
}

function updateSyncUi() {
    const dot = $('#syncDot');
    const label = $('#syncStatusLabel');
    const toggleBtn = $('#toggleSyncLabel');
    const banner = $('#welcomeSyncBanner');

    if (syncState.mode === 'coupled') {
        if (dot) dot.className = 'sync-dot coupled';
        if (label) label.textContent = 'Canvas Live Sync';
        if (toggleBtn) toggleBtn.textContent = 'Decouple';
        if (banner) {
            banner.classList.remove('decoupled');
            banner.querySelector('strong').textContent = 'Real-time Canvas Synchronization';
            banner.querySelector('p').textContent = 'All balance sheets, market graphs, and stress runs build the underlying Konjugate graph model in the background. Use the Decouple control in the header whenever you wish to perform custom, manual edits to equations, nodes, or parameters directly in Konjugate.';
        }
    } else {
        if (dot) dot.className = 'sync-dot decoupled';
        if (label) label.textContent = 'Decoupled (Manual edit mode)';
        if (toggleBtn) toggleBtn.textContent = 'Re-couple & Sync';
        if (banner) {
            banner.classList.add('decoupled');
            banner.querySelector('strong').textContent = 'Toolbox Decoupled from Canvas';
            banner.querySelector('p').textContent = 'Live synchronization is currently paused. You can freely edit equations, parameters, and nodes directly in the Konjugate canvas without the toolbox overwriting your work. Click "Re-couple & Sync" to push your toolbox model back to the canvas.';
        }
    }
}

// Global Sync & Decouple buttons
$('#toggleSyncBtn')?.addEventListener('click', async () => {
    if (syncState.mode === 'coupled') {
        syncState.mode = 'decoupled';
        updateSyncUi();
    } else {
        syncState.mode = 'coupled';
        updateSyncUi();
        await syncToCanvas({ focus: false, silent: true });
    }
});

$('#focusCanvasBtn')?.addEventListener('click', async () => {
    await syncToCanvas({ focus: true, silent: false });
});

// Hooks for sub-controllers
function onModelUpdated(tool) {
    syncState.activeTool = tool;
    if (syncState.mode === 'coupled') {
        syncToCanvas({ focus: false, silent: true });
    }
}

function onScenarioRun(tool, scenarioId) {
    syncState.activeTool = tool;
    syncState.latestScenarioId[tool] = scenarioId;
    if (syncState.mode === 'coupled') {
        syncToCanvas({ focus: false, silent: true });
    }
}

// ---- Navigation Router --------------------------------------------------------------------------------

const TOOL_TITLES = {
    welcome: 'Fintech Toolbox',
    start: 'Interbank Stress Testing',
    markets: 'Market Dynamics'
};

function switchView(viewName) {
    if (!['welcome', 'start', 'markets'].includes(viewName)) return;

    // Update active view container
    $$('.view-container').forEach((view) => {
        view.classList.toggle('active', view.id === `view-${viewName}`);
    });

    // Update header switch buttons
    $$('.tool-switch-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Update identity & breadcrumb
    const divider = $('#navDivider');
    const badge = $('#currentToolBadge');

    if (viewName === 'welcome') {
        if (divider) divider.hidden = true;
        if (badge) badge.hidden = true;
        document.title = 'Fintech Toolbox';
    } else {
        if (divider) divider.hidden = false;
        if (badge) {
            badge.hidden = false;
            badge.textContent = TOOL_TITLES[viewName];
        }
        document.title = `${TOOL_TITLES[viewName]} · Fintech Toolbox`;
        syncState.activeTool = viewName;
    }
}

// Header brand button returns to welcome
$('#navHubBtn')?.addEventListener('click', () => switchView('welcome'));

// Tool switcher tabs
$$('.tool-switch-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Welcome hub launch cards
$$('[data-launch]').forEach((elem) => {
    elem.addEventListener('click', (event) => {
        const launchTarget = elem.dataset.launch;
        if (launchTarget) {
            event.stopPropagation();
            switchView(launchTarget);
        }
    });
});

// Global page handler for help guides
document.addEventListener('click', (event) => {
    const page = event.target.closest('[data-page]')?.dataset.page;
    if (page && api?.openPage) {
        api.openPage(page).catch((error) => console.error(error));
    }
});

// ---- Initialize Sub-Controllers -----------------------------------------------------------------------

try {
    initStartController({ api, onModelUpdated, onScenarioRun });
} catch (error) {
    console.error('Error initializing Start controller:', error);
}

try {
    initMarketsController({ api, onModelUpdated, onScenarioRun });
} catch (error) {
    console.error('Error initializing Markets controller:', error);
}

// Initial state
updateSyncUi();
switchView('welcome');
