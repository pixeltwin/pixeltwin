// Server-rendered SVG charts (Insights): no chart library, and no JavaScript needed to read them.
// x is in percent of the chart's width and y in pixels, so a chart fills any width with crisp
// text and round dots; a line is drawn in a nested SVG stretched to the plot (its stroke does
// not scale). Columns are strokes whose width follows the viewport (CSS `bars-<n>`). Each band
// has a hit area with a <title> (the native tooltip without JavaScript) and a crosshair shown on
// hover; the `charts` island turns them into one styled tooltip and adds the arrow keys. Every
// chart has a title, a description, a legend for two series or more and its numbers as a table.

/** The categorical slots of tokens.css (validated for both themes), or the de-emphasis grey. */
export type Slot = 1 | 2 | 3 | 4 | 5 | 'muted';

export interface Series {
  label: string;
  slot: Slot;
}

export interface Bucket {
  /** Under the axis: `Oct 3`. */
  label: string;
  /** In the tooltip and the table: `Fri, Oct 3` or `Oct 3 – Oct 9`. */
  title: string;
  /** One per series; null is no data (a gap in a line). */
  values: Array<number | null>;
}

export interface ChartProps {
  id: string;
  title: string;
  /** One sentence: what the chart shows (the SVG's description and the caption). */
  description: string;
  kind: 'line' | 'stack';
  series: Series[];
  buckets: Bucket[];
  format: (value: number) => string;
  /** The top of the scale (1 for rates); otherwise a whole number of steps above the data. */
  max?: number;
  /** Round steps between gridlines, smallest first (durations: 1 min, 5 min, 1 h…); default 1, 2, 5 × 10ⁿ. */
  steps?: readonly number[];
  /** A line chart's first series gets a wash under it. */
  area?: boolean;
}

const HEIGHT = 200;
const TOP = 14;
const BASE = 172;
const PLOT = BASE - TOP;
const LEFT = 1;
const RIGHT = 99;

/** 1, 2, 5, 10, 20, 50, … */
const COUNT_STEPS = Array.from({ length: 30 }, (_, i) => ([1, 2, 5][i % 3] as number) * 10 ** Math.floor(i / 3));

/**
 * The gridlines for data up to `top`: the smallest round step that needs at most four of them, and
 * the top of the scale a whole number of steps up (at least one).
 */
export function scaleOf(top: number, steps: readonly number[] = COUNT_STEPS): { max: number; ticks: number[] } {
  const step =
    steps.find((s) => top / s <= 4) ?? (steps.at(-1) as number) * Math.ceil(top / 4 / (steps.at(-1) as number));
  const count = Math.max(1, Math.ceil(top / step));
  return { max: step * count, ticks: Array.from({ length: count + 1 }, (_, i) => i * step) };
}

const pct = (n: number) => `${Math.round(n * 1000) / 1000}%`;
const slotClass = (slot: Slot) => `viz-${slot}`;

function Legend({ series, kind }: { series: Series[]; kind: ChartProps['kind'] }) {
  if (series.length < 2) return null;
  return (
    <ul class="chart-legend">
      {series.map((s) => (
        <li>
          <span
            class={`chart-key ${kind === 'line' ? 'key-line' : 'key-bar'} ${slotClass(s.slot)}`}
            aria-hidden="true"
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable(props: ChartProps) {
  return (
    <details class="chart-data">
      <summary>Show the numbers</summary>
      <table>
        <thead>
          <tr>
            <th scope="col">{props.buckets.length > 0 && props.buckets[0]?.title.includes('–') ? 'Week' : 'Day'}</th>
            {props.series.map((s) => (
              <th scope="col">{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.buckets.map((b) => (
            <tr>
              <th scope="row">{b.title}</th>
              {b.values.map((v) => (
                <td class="num">{v === null ? '—' : props.format(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** The text of a band's tooltip: its title, then each series' value. */
function tipOf(props: ChartProps, bucket: Bucket): string {
  return [
    bucket.title,
    ...props.series.map((s, i) => {
      const v = bucket.values[i];
      return `${s.label}: ${v === null || v === undefined ? 'no builds' : props.format(v)}`;
    }),
  ].join('\n');
}

function linePath(points: Array<{ x: number; y: number } | null>): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`;
    pen = true;
  }
  return d;
}

export function Chart(props: ChartProps) {
  const { buckets, series, kind } = props;
  const n = Math.max(1, buckets.length);
  const band = (RIGHT - LEFT) / n;
  const center = (i: number) => LEFT + band * (i + 0.5);
  const top =
    kind === 'stack'
      ? Math.max(0, ...buckets.map((b) => b.values.reduce<number>((a, v) => a + (v ?? 0), 0)))
      : Math.max(0, ...buckets.flatMap((b) => b.values.map((v) => v ?? 0)));
  const scale = props.max
    ? { max: props.max, ticks: [0, 0.25, 0.5, 0.75, 1].map((f) => f * (props.max as number)) }
    : scaleOf(top, props.steps);
  const { max, ticks } = scale;
  const y = (v: number) => BASE - (Math.min(v, max) / max) * PLOT;
  const labelStep = Math.ceil(n / 6);
  const titleId = `${props.id}-title`;
  const descId = `${props.id}-desc`;
  // In the nested plot: x 0–1000 across the whole width, y in pixels from the plot's top.
  const lineX = (i: number) => center(i) * 10;
  const lineY = (v: number) => y(v) - TOP;

  return (
    <figure class={`chart chart-kind-${kind}`} id={props.id}>
      <figcaption>
        <h3 class="chart-title">{props.title}</h3>
        <p class="muted chart-desc">{props.description}</p>
      </figcaption>
      <Legend series={series} kind={kind} />
      <div
        class="chart-plot"
        tabindex={0}
        data-chart=""
        data-slots={series.map((s) => s.slot).join(' ')}
        aria-describedby={descId}
      >
        <svg
          class={`chart-svg bars-${n}`}
          width="100%"
          height={HEIGHT}
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
        >
          <title id={titleId}>{props.title}</title>
          <desc id={descId}>{props.description}</desc>
          {ticks.map((v) => (
            <line class={v === 0 ? 'chart-base' : 'chart-grid'} x1="0" x2="100%" y1={y(v)} y2={y(v)} />
          ))}
          {kind === 'stack' &&
            buckets.map((b, i) => {
              let sum = 0;
              const nonZero = b.values.map((v, k) => ({ v: v ?? 0, k })).filter((s) => s.v > 0);
              return nonZero.map(({ v, k }, j) => {
                const low = y(sum);
                sum += v;
                const high = y(sum);
                // A 2 px surface gap between stacked segments; the baseline end stays on the baseline.
                const y2 = j === 0 ? low : low - 1;
                const y1 = j === nonZero.length - 1 ? high : high + 1;
                if (y2 - y1 < 0.5) return null;
                return (
                  <line
                    class={`chart-bar ${slotClass(series[k]?.slot ?? 1)}`}
                    x1={pct(center(i))}
                    x2={pct(center(i))}
                    y1={y1}
                    y2={y2}
                  />
                );
              });
            })}
          {kind === 'line' && (
            // biome-ignore lint/a11y/noSvgWithoutTitle: the plot inside the chart's own svg, which has the title
            <svg
              class="chart-lines"
              x="0"
              y={TOP}
              width="100%"
              height={PLOT}
              viewBox={`0 0 1000 ${PLOT}`}
              preserveAspectRatio="none"
              overflow="visible"
            >
              {series.map((s, k) => {
                const points = buckets.map((b, i) => {
                  const v = b.values[k];
                  return v === null || v === undefined ? null : { x: lineX(i), y: lineY(v) };
                });
                const d = linePath(points);
                const wash =
                  props.area && k === 0
                    ? points
                        .reduce<Array<Array<{ x: number; y: number }>>>(
                          (runs, p) => {
                            if (!p) runs.push([]);
                            else (runs.at(-1) as Array<{ x: number; y: number }>).push(p);
                            return runs;
                          },
                          [[]],
                        )
                        .filter((run) => run.length > 1)
                        .map(
                          (run) =>
                            `${linePath(run)}L${(run.at(-1) as { x: number }).x} ${PLOT}L${(run[0] as { x: number }).x} ${PLOT}Z`,
                        )
                        .join('')
                    : '';
                return (
                  <>
                    {wash && <path class={`chart-area ${slotClass(s.slot)}`} d={wash} />}
                    {d && <path class={`chart-line ${slotClass(s.slot)}`} d={d} vector-effect="non-scaling-stroke" />}
                  </>
                );
              })}
            </svg>
          )}
          {kind === 'line' &&
            series.map((s, k) =>
              buckets.map((b, i) => {
                const v = b.values[k];
                if (v === null || v === undefined) return null;
                const before = buckets[i - 1]?.values[k];
                const after = buckets[i + 1]?.values[k];
                const last = buckets.slice(i + 1).every((x) => x.values[k] === null || x.values[k] === undefined);
                const alone = (before === null || before === undefined) && (after === null || after === undefined);
                // The end of each line, and points with no neighbour (a line needs two).
                if (!last && !alone) return null;
                return <circle class={`chart-dot ${slotClass(s.slot)}`} cx={pct(center(i))} cy={y(v)} r={4} />;
              }),
            )}
          {ticks.slice(1).map((v) => (
            <text class="chart-tick" x="0" y={y(v) - 4}>
              {props.format(v)}
            </text>
          ))}
          {buckets.map((b, i) => {
            const last = i === n - 1;
            if (i % labelStep !== 0 && !last) return null;
            // The last label is always shown; one too close before it is left out.
            if (!last && n - 1 - i < labelStep && n > 1) return null;
            const anchor = i === 0 ? 'start' : last ? 'end' : 'middle';
            const x = i === 0 ? LEFT : last ? RIGHT : center(i);
            // Every other label in between gives way on a phone.
            const alt = !last && i !== 0 && (i / labelStep) % 2 === 1;
            return (
              <text
                class={alt ? 'chart-tick chart-tick-alt' : 'chart-tick'}
                x={pct(x)}
                y={HEIGHT - 8}
                text-anchor={anchor}
              >
                {b.label}
              </text>
            );
          })}
          {buckets.map((b, i) => (
            <g class="chart-band" data-tip={tipOf(props, b)}>
              <line class="chart-cross" x1={pct(center(i))} x2={pct(center(i))} y1={TOP} y2={BASE} />
              <rect class="chart-hit" x={pct(LEFT + band * i)} y="0" width={pct(band)} height={BASE}>
                <title>{tipOf(props, b)}</title>
              </rect>
            </g>
          ))}
        </svg>
      </div>
      <DataTable {...props} />
    </figure>
  );
}
