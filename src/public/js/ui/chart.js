import { h, svg } from '../dom.js';
import { formatNumber } from '../format.js';

const WIDTH = 840;
const HEIGHT = 230;
const PAD = { top: 12, right: 8, bottom: 26, left: 36 };

/** A tidy axis: four equal steps with round numbers, e.g. 0, 5, 10, 15, 20. */
const niceMax = (value) => {
  const rawStep = Math.max(value, 4) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10]
    .map((m) => m * magnitude)
    .find((candidate) => candidate >= rawStep);
  return Math.max(Math.ceil(step), 1) * 4;
};

let tooltip;

function showTip(event, lines) {
  tooltip ??= h('div', { class: 'chart-tooltip', role: 'presentation' });
  tooltip.replaceChildren(...lines.map((line) => h('div', null, line)));
  document.body.append(tooltip);
  tooltip.style.left = `${Math.min(event.clientX + 12, window.innerWidth - 180)}px`;
  tooltip.style.top = `${event.clientY + 14}px`;
}

const hideTip = () => tooltip?.remove();

/**
 * Daily bars: what the provider accepted (light), with delivered and bounced drawn over it.
 * A text summary is attached so the chart is usable without seeing it.
 */
export function dailyChart(points) {
  const max = niceMax(Math.max(...points.map((p) => p.accepted), 0));
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const slot = innerW / points.length;
  const barW = Math.max(Math.min(slot * 0.62, 28), 2);
  const y = (value) => PAD.top + innerH - (value / max) * innerH;

  const root = svg('svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img',
    'aria-label': summarise(points),
  });

  for (let i = 0; i <= 4; i++) {
    const value = (max / 4) * i;
    root.append(
      svg('line', {
        class: 'grid-line',
        x1: PAD.left,
        x2: WIDTH - PAD.right,
        y1: y(value),
        y2: y(value),
      }),
      svg(
        'text',
        { class: 'axis-label', x: PAD.left - 6, y: y(value) + 4, 'text-anchor': 'end' },
        formatNumber(Math.round(value)),
      ),
    );
  }

  const labelEvery = Math.ceil(points.length / 8);
  points.forEach((point, i) => {
    const x = PAD.left + slot * i + (slot - barW) / 2;
    const bar = (cls, value) =>
      value > 0 &&
      svg('rect', { class: cls, x, y: y(value), width: barW, height: y(0) - y(value), rx: 2 });
    root.append(
      bar('bar-accepted', point.accepted),
      bar('bar-delivered', point.delivered),
      bar('bar-bounced', point.bounced),
    );

    if (i % labelEvery === 0) {
      const date = new Date(`${point.date}T00:00:00Z`);
      root.append(
        svg(
          'text',
          { class: 'axis-label', x: x + barW / 2, y: HEIGHT - 6, 'text-anchor': 'middle' },
          date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }),
        ),
      );
    }

    const hit = svg('rect', {
      class: 'hit',
      x: PAD.left + slot * i,
      y: PAD.top,
      width: slot,
      height: innerH,
      tabindex: '-1',
    });
    const lines = [
      new Date(`${point.date}T00:00:00Z`).toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      }),
      `${formatNumber(point.accepted)} sent · ${formatNumber(point.delivered)} delivered · ${formatNumber(point.bounced)} bounced`,
    ];
    hit.addEventListener('mousemove', (event) => showTip(event, lines));
    hit.addEventListener('mouseleave', hideTip);
    root.append(hit);
  });

  return h(
    'figure',
    { class: 'chart' },
    root,
    h(
      'div',
      { class: 'legend' },
      h('span', null, h('i', { class: 'lg-accepted' }), 'Sent'),
      h('span', null, h('i', { class: 'lg-delivered' }), 'Delivered'),
      h('span', null, h('i', { class: 'lg-bounced' }), 'Bounced'),
    ),
  );
}

function summarise(points) {
  const total = points.reduce((sum, p) => sum + p.accepted, 0);
  if (total === 0) return 'Daily sending chart. Nothing was sent in this period.';
  const busiest = points.reduce((a, b) => (b.accepted > a.accepted ? b : a));
  return `Daily sending chart. ${formatNumber(total)} emails sent over ${points.length} days. The busiest day was ${busiest.date} with ${formatNumber(busiest.accepted)}.`;
}
