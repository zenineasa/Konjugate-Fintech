/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Small SVG charts drawn by hand, with no library: a sparkline for the data preview and a line chart with a hover
// readout for results. Text inside an SVG is drawn in the page's own font, since the window is an ordinary page.

export const palette = ['#45c6b8', '#e6b04a', '#ee8a7e', '#8fb2ff', '#c39bf0', '#9bd66b', '#f29ac6', '#7fd0e8'];
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

// A level series scaled to its own range, with the chosen stretch of it shaded. `from` and `to` are indices.
export function sparkline(values, { width = 220, height = 48, from = 0, to = values.length - 1 } = {}) {
    const finite = values.filter(Number.isFinite);
    const low = Math.min(...finite);
    const high = Math.max(...finite);
    const span = high - low || 1;
    const x = (index) => (index / Math.max(1, values.length - 1)) * width;
    const y = (value) => height - 3 - ((value - low) / span) * (height - 6);
    const step = Math.max(1, Math.floor(values.length / 200));
    const points = values.map((value, index) => [index, value]).filter(([index]) => index % step === 0 || index === values.length - 1)
        .map(([index, value]) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-hidden="true">
        <rect x="${x(from).toFixed(1)}" y="0" width="${Math.max(1, x(to) - x(from)).toFixed(1)}" height="${height}" fill="rgba(69,198,184,.14)"/>
        <polyline points="${points}" fill="none" stroke="#8aa1af" stroke-width="1.4" vector-effect="non-scaling-stroke"/>
    </svg>`;
}

function niceStep(span) {
    const rough = span / 5;
    const magnitude = 10 ** Math.floor(Math.log10(rough));
    const scaled = rough / magnitude;
    return (scaled > 5 ? 10 : scaled > 2 ? 5 : scaled > 1 ? 2 : 1) * magnitude;
}

// Lines over a shared x axis. series: [{ name, color, dashed, width, points: [[x, y], ...] }]. `format(y)` writes a value,
// `markX` draws a dashed vertical line (where a shock starts). Wires a hover readout into `readout`.
export function drawChart(container, readout, { series, bands = [], maxX, markX = null, xLabel = 'bars', format = (value) => `${value}`, zeroLine = true }) {
    const width = 860;
    const height = 300;
    const margin = { left: 58, right: 16, top: 16, bottom: 30 };
    const values = [...series.flatMap((line) => line.points.map(([, y]) => y)), ...bands.flatMap((band) => band.points.flatMap(([, low, high]) => [low, high]))].filter(Number.isFinite);
    const rawLow = Math.min(...values, zeroLine ? 0 : Infinity);
    const rawHigh = Math.max(...values, zeroLine ? 0 : -Infinity);
    const tick = niceStep(Math.max(rawHigh - rawLow, 1e-9));
    const low = Math.floor(rawLow / tick) * tick;
    const high = Math.max(Math.ceil(rawHigh / tick) * tick, low + tick);
    const x = (value) => margin.left + (value / maxX) * (width - margin.left - margin.right);
    const y = (value) => margin.top + ((high - value) / (high - low)) * (height - margin.top - margin.bottom);
    const path = (points) => points.map(([px, py], index) => `${index ? 'L' : 'M'}${x(px).toFixed(1)},${y(py).toFixed(1)}`).join(' ');
    // A band is the area between a lower and an upper value at each x, drawn behind the lines.
    const bandPath = (points) => `${points.map(([px, low], index) => `${index ? 'L' : 'M'}${x(px).toFixed(1)},${y(low).toFixed(1)}`).join(' ')} ${[...points].reverse().map(([px, , high]) => `L${x(px).toFixed(1)},${y(high).toFixed(1)}`).join(' ')} Z`;
    const yTicks = [];
    for (let value = low; value <= high + tick / 1000; value += tick) yTicks.push(Number(value.toPrecision(10)));
    const xStep = maxX > 100 ? 20 : maxX > 40 ? 10 : maxX > 12 ? 5 : 1;
    const xTicks = [];
    for (let value = 0; value <= maxX; value += xStep) xTicks.push(value);
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img">
        ${yTicks.map((value) => `<line class="gridline" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}"${value === 0 ? ' stroke="#8aa1af" stroke-opacity=".6"' : ''}/><text x="${margin.left - 8}" y="${y(value) + 4}" text-anchor="end">${escapeHtml(format(value))}</text>`).join('')}
        ${xTicks.map((value) => `<text x="${x(value)}" y="${height - 8}" text-anchor="middle">${value}</text>`).join('')}
        <text x="${width - margin.right}" y="${height - 8}" text-anchor="end">${escapeHtml(xLabel)}</text>
        ${markX === null ? '' : `<line x1="${x(markX)}" x2="${x(markX)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#8aa1af" stroke-dasharray="3 4"/>`}
        ${bands.map((band) => `<path d="${bandPath(band.points)}" fill="${band.color}" fill-opacity="${band.opacity ?? 0.16}" stroke="none"/>`).join('')}
        ${series.map((line) => `<path d="${path(line.points)}" fill="none" stroke="${line.color}" stroke-width="${line.width ?? 2.4}"${line.dashed ? ' stroke-dasharray="6 4"' : ''}${line.faint ? ' opacity=".55"' : ''}/>`).join('')}
        <line class="cursor" x1="0" x2="0" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#d9e6ec" stroke-opacity=".5" visibility="hidden"/>
        <rect class="hit" x="${margin.left}" y="${margin.top}" width="${width - margin.left - margin.right}" height="${height - margin.top - margin.bottom}" fill="transparent"/>
    </svg>`;
    readout.textContent = 'Move over the chart to read values.';
    const svg = container.querySelector('svg');
    const hit = container.querySelector('.hit');
    const cursor = container.querySelector('.cursor');
    hit.addEventListener('mousemove', (event) => {
        const box = svg.getBoundingClientRect();
        const at = Math.min(maxX, Math.max(0, ((event.clientX - box.left) / box.width * width - margin.left) / (width - margin.left - margin.right) * maxX));
        cursor.setAttribute('x1', x(at));
        cursor.setAttribute('x2', x(at));
        cursor.setAttribute('visibility', 'visible');
        const nearest = (points) => points.reduce((best, point) => (Math.abs(point[0] - at) < Math.abs(best[0] - at) ? point : best))[1];
        readout.textContent = `${xLabel === 'bars' ? 'Bar' : xLabel} ${Math.round(at)}: ${series.map((line) => `${line.name}${line.dashed ? ' (actual)' : ''} ${format(nearest(line.points))}`).join(' · ')}`;
    });
    hit.addEventListener('mouseleave', () => cursor.setAttribute('visibility', 'hidden'));
}
