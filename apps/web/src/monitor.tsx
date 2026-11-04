import { useMemo, useState } from 'react';
import { ClientAnalysis } from './analysis';
import { api } from './api';
import { liveLabel, useLive } from './live';
import {
  buildMonitorModel,
  monitorCsv,
  powerBiPlanJson,
  powerBiPlanSummary,
  questionCsv,
  type MonitorModel,
  type MonitorQuestion,
} from './monitor-model';

/**
 * The live monitor for one form.
 *
 * It is not a screenshot of a dashboard. Every number and every bar below is
 * computed from `/forms/:id/analytics`, which reads the live tables on each request;
 * the form's SSE stream says when the analytics aggregate moved, so the screen
 * refetches without a timer while the stream is up. The fallback timer is the
 * screen's safety net, not its pulse.
 *
 * The Power BI plan is generated from the same questionnaire definition the
 * respondent answers. It is a specification, not a PBIX binary: Microsoft does not
 * support writing a model-bearing PBIX outside Desktop, so pretending otherwise
 * would be worse than saying where the boundary is.
 */

function downloadText(name: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Safari can cancel a download if its object URL is revoked in the same task.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function percent(value: number | null): string {
  return value === null ? 'No starts' : `${(value * 100).toFixed(1)}%`;
}

function number(value: number): string {
  return value.toLocaleString();
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function fileName(title: string, suffix: string): string {
  return `${slug(title) || 'inicio'}-${suffix}`;
}

function downloadCsv(name: string, content: string): void {
  // The byte order mark is for Excel. Without it, a non-ASCII label opens as
  // mojibake in the one program most readers will use.
  downloadText(name, `\uFEFF${content}`, 'text/csv;charset=utf-8');
}

function typeLabel(type: string): string {
  return type.replaceAll('_', ' ');
}

function baseSentence(question: MonitorQuestion): string {
  const answered = `${question.answered} answered`;
  const missing = question.missing > 0 ? ` · ${question.missing} missing` : '';
  return `${answered}${missing} · base ${number(question.total)} submitted`;
}

function BarChart({ question }: { question: MonitorQuestion }): JSX.Element {
  const visible = question.options.slice(0, 8);
  const max = Math.max(...visible.map((option) => option.count), 1);
  const summary = visible
    .slice(0, 4)
    .map((option) => `${option.label}: ${option.count}`)
    .join(', ');
  return (
    <div className="monitor-chart">
      <div
        className="monitor-bars"
        role="img"
        aria-label={`${question.label}. ${summary}${question.options.length > 4 ? ', and more in the data table' : ''}.`}
      >
        {visible.map((option) => (
          <div className="monitor-bar-row" key={option.value}>
            <span className="monitor-bar-label" title={option.label}>
              {option.label}
            </span>
            <span className="monitor-bar-track">
              <span
                className="monitor-bar-fill"
                style={{ width: `${Math.max(2, (option.count / max) * 100)}%` }}
              />
            </span>
            <span className="monitor-bar-value">
              {number(option.count)}
              <small>{option.percent.toFixed(1)}%</small>
            </span>
          </div>
        ))}
      </div>
      {question.options.length > visible.length && (
        <p className="monitor-chart-note">
          Showing the top {visible.length} of {question.options.length}. Open the data table for every value.
        </p>
      )}
      <details className="monitor-details">
        <summary>Data behind this chart</summary>
        <table>
          <thead>
            <tr>
              <th>Answer</th>
              <th className="right">Count</th>
              <th className="right">Share</th>
            </tr>
          </thead>
          <tbody>
            {question.options.map((option) => (
              <tr key={option.value}>
                <td>{option.label}</td>
                <td className="right">{number(option.count)}</td>
                <td className="right">{option.percent.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Histogram({ question }: { question: MonitorQuestion }): JSX.Element {
  const numeric = question.numeric!;
  const max = Math.max(...numeric.bins.map((bin) => bin.count), 1);
  return (
    <div className="monitor-chart">
      <div className="monitor-stats">
        <span>
          <strong>{numeric.mean.toFixed(2)}</strong> mean
        </span>
        <span>
          <strong>{numeric.median.toFixed(2)}</strong> median
        </span>
        <span>
          <strong>{numeric.min.toFixed(2)}</strong> min
        </span>
        <span>
          <strong>{numeric.max.toFixed(2)}</strong> max
        </span>
      </div>
      <div
        className="monitor-hist"
        role="img"
        aria-label={`${question.label}. ${numeric.n} answers, mean ${numeric.mean.toFixed(2)}, median ${numeric.median.toFixed(2)}, minimum ${numeric.min.toFixed(2)}, maximum ${numeric.max.toFixed(2)}.`}
      >
        {numeric.bins.map((bin, index) => (
          <div className="monitor-hist-col" key={`${bin.from}-${index}`}>
            <span className="monitor-hist-count">{bin.count}</span>
            <span
              className="monitor-hist-bar"
              style={{ height: `${Math.max(4, (bin.count / max) * 84)}px` }}
            />
            <span className="monitor-hist-label">
              {bin.from === bin.to ? bin.from.toFixed(1) : `${bin.from.toFixed(1)}–${bin.to.toFixed(1)}`}
            </span>
          </div>
        ))}
      </div>
      <details className="monitor-details">
        <summary>Data behind this chart</summary>
        <table>
          <thead>
            <tr>
              <th>Range</th>
              <th className="right">Answers</th>
            </tr>
          </thead>
          <tbody>
            {numeric.bins.map((bin, index) => (
              <tr key={`${bin.from}-${index}`}>
                <td>
                  {bin.from.toFixed(2)} to {bin.to.toFixed(2)}
                </td>
                <td className="right">{number(bin.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function LineChart({ question }: { question: MonitorQuestion }): JSX.Element {
  const allSeries = question.series;
  const series = allSeries.slice(-30);
  const width = 640;
  const height = 170;
  const padding = 26;
  const max = Math.max(...series.map((point) => point.count), 1);
  const step = series.length > 1 ? (width - padding * 2) / (series.length - 1) : 0;
  const points = series.map((point, index) => ({
    x: padding + index * step,
    y: height - padding - (point.count / max) * (height - padding * 2),
    ...point,
  }));
  const polyline = points.map((point) => `${point.x},${point.y}`).join(' ');
  const area = points.length
    ? `M ${points[0].x} ${height - padding} L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L ${points.at(-1)!.x} ${height - padding} Z`
    : '';
  return (
    <div className="monitor-chart">
      <div
        className="monitor-line-wrap"
        role="img"
        aria-label={`${question.label}. ${series.reduce((sum, point) => sum + point.count, 0)} answers across ${series.length} shown day${series.length === 1 ? '' : 's'}${allSeries.length > series.length ? ` of ${allSeries.length}` : ''}.`}
      >
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={padding}
              x2={width - padding}
              y1={padding + fraction * (height - padding * 2)}
              y2={padding + fraction * (height - padding * 2)}
              className="monitor-grid-line"
            />
          ))}
          {area && <path d={area} className="monitor-area" />}
          {polyline && <polyline points={polyline} className="monitor-line" fill="none" />}
          {points.map((point) => (
            <circle key={point.key} cx={point.x} cy={point.y} r="3.5" className="monitor-point">
              <title>
                {point.label}: {point.count}
              </title>
            </circle>
          ))}
        </svg>
        <div className="monitor-axis">
          <span>{series[0]?.label}</span>
          <span>{series.at(-1)?.label}</span>
        </div>
      </div>
      <details className="monitor-details">
        <summary>Every day in the data</summary>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th className="right">Answers</th>
            </tr>
          </thead>
          <tbody>
            {allSeries.map((point) => (
              <tr key={point.key}>
                <td>{point.key}</td>
                <td className="right">{number(point.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function GeoScatter({ question }: { question: MonitorQuestion }): JSX.Element {
  const points = question.points.slice(0, 500);
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latSpan = maxLat - minLat || 1;
  const lonSpan = maxLon - minLon || 1;
  const project = (lat: number, lon: number): { x: number; y: number } => ({
    x: 32 + ((lon - minLon) / lonSpan) * 576,
    y: 150 - ((lat - minLat) / latSpan) * 116,
  });
  return (
    <div className="monitor-chart">
      <div
        className="monitor-geo"
        role="img"
        aria-label={`${question.label}. ${question.points.length} unique coordinate${question.points.length === 1 ? '' : 's'} plotted from ${question.answered} answers.`}
      >
        <svg viewBox="0 0 640 180" aria-hidden="true" focusable="false">
          {[32, 176, 320, 464, 608].map((x) => (
            <line key={`x-${x}`} x1={x} x2={x} y1="18" y2="166" className="monitor-grid-line" />
          ))}
          {[34, 92, 150].map((y) => (
            <line key={`y-${y}`} x1="32" x2="608" y1={y} y2={y} className="monitor-grid-line" />
          ))}
          {points.map((point, index) => {
            const projected = project(point.lat, point.lon);
            return <circle key={`${point.lat}-${point.lon}-${index}`} cx={projected.x} cy={projected.y} r="4" className="monitor-point" />;
          })}
        </svg>
        <span className="monitor-geo-label">lat / lon only, no basemap</span>
      </div>
      {(question.points.length > points.length || question.points.length > 50) && (
        <p className="monitor-chart-note">
          {question.points.length > points.length
            ? `Showing ${points.length} of ${question.points.length} unique coordinates; the table shows the first 50.`
            : `The table shows the first 50 of ${question.points.length} unique coordinates.`}
        </p>
      )}
      <details className="monitor-details">
        <summary>Data behind this chart</summary>
        <table>
          <thead>
            <tr>
              <th>Latitude</th>
              <th>Longitude</th>
              <th className="right">Responses</th>
            </tr>
          </thead>
          <tbody>
            {question.points.slice(0, 50).map((point, index) => (
              <tr key={`${point.lat}-${point.lon}-${index}`}>
                <td>{point.lat.toFixed(5)}</td>
                <td>{point.lon.toFixed(5)}</td>
                <td className="right">{number(point.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function QuestionCard({
  question,
  index,
  onCsv,
}: {
  question: MonitorQuestion;
  index: number;
  onCsv: () => void;
}): JSX.Element {
  return (
    <article className="monitor-card">
      <header className="monitor-card-head">
        <span className="monitor-index">{String(index).padStart(2, '0')}</span>
        <div>
          <h3>{question.label}</h3>
          <p className="monitor-meta">
            <span className="mono">{question.name}</span>
            <span className="pill">{typeLabel(question.type)}</span>
          </p>
        </div>
        <button
          type="button"
          className="ghost monitor-card-csv"
          onClick={onCsv}
          aria-label={`Export ${question.label} as CSV`}
        >
          Export CSV
        </button>
      </header>
      <p className="monitor-base">{baseSentence(question)}</p>
      {question.answered === 0 ? (
        <p className="monitor-empty">
          No submitted answer yet. The first answer will appear here through the live stream.
        </p>
      ) : question.chart === 'histogram' && question.numeric ? (
        <Histogram question={question} />
      ) : question.chart === 'line' && question.series.length > 0 ? (
        <LineChart question={question} />
      ) : question.chart === 'points' && question.points.length > 0 ? (
        <GeoScatter question={question} />
      ) : question.chart === 'count' ? (
        <div className="monitor-count">
          <strong>{number(question.answered)}</strong>
          <span>responses with a file, image, audio or video</span>
        </div>
      ) : question.options.length > 0 ? (
        <BarChart question={question} />
      ) : (
        <p className="monitor-empty">Answers are present but could not be plotted as this question type.</p>
      )}
      {question.notes.length > 0 && (
        <ul className="monitor-notes">
          {question.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

function Kpi({ label, value, detail }: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div className="monitor-kpi">
      <span className="monitor-kpi-label">{label}</span>
      <strong>{value}</strong>
      <span className="monitor-kpi-detail">{detail}</span>
    </div>
  );
}

function Activity({ model }: { model: MonitorModel }): JSX.Element {
  const points = model.timeline.slice(-30);
  const width = 640;
  const height = 150;
  const padding = 20;
  const max = Math.max(...points.flatMap((point) => [point.started, point.submitted]), 1);
  const step = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;
  const line = (key: 'started' | 'submitted'): string =>
    points
      .map((point, index) => {
        const x = padding + index * step;
        const y = height - padding - (point[key] / max) * (height - padding * 2);
        return `${x},${y}`;
      })
      .join(' ');
  return (
    <div className="monitor-activity">
      <div className="monitor-section-head">
        <div>
          <span className="eyebrow">Field period</span>
          <h2>Responses over time</h2>
        </div>
        <span className="muted small">Started and submitted, by day</span>
      </div>
      <div
        className="monitor-line-wrap"
        role="img"
        aria-label={`Started and submitted responses by day. Latest day ${points.at(-1)?.day ?? 'has no data'}: ${points.at(-1)?.started ?? 0} started, ${points.at(-1)?.submitted ?? 0} submitted.`}
      >
        <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={padding}
              x2={width - padding}
              y1={padding + fraction * (height - padding * 2)}
              y2={padding + fraction * (height - padding * 2)}
              className="monitor-grid-line"
            />
          ))}
          <polyline points={line('started')} className="monitor-line monitor-line-muted" fill="none" />
          <polyline points={line('submitted')} className="monitor-line" fill="none" />
          {points.map((point, index) => {
            const x = padding + index * step;
            const startedY = height - padding - (point.started / max) * (height - padding * 2);
            const submittedY = height - padding - (point.submitted / max) * (height - padding * 2);
            return (
              <g key={point.day}>
                <circle cx={x} cy={startedY} r="2.5" className="monitor-point monitor-point-muted" />
                <circle cx={x} cy={submittedY} r="2.5" className="monitor-point" />
              </g>
            );
          })}
        </svg>
        <div className="monitor-axis">
          <span>{points[0]?.day}</span>
          <span>{points.at(-1)?.day}</span>
        </div>
      </div>
      <div className="monitor-legend">
        <span>
          <i className="monitor-swatch monitor-swatch-muted" /> started
        </span>
        <span>
          <i className="monitor-swatch" /> submitted
        </span>
      </div>
    </div>
  );
}

export function MonitorTab({
  formId,
  publishedVersion,
  client,
}: {
  formId: string;
  publishedVersion: number | null;
  /** The organisation the questionnaire was commissioned for, shown on the brief. */
  client?: string;
}): JSX.Element {
  const { data, error, reload, status, live } = useLive(() => api.analytics(formId), {
    formId,
    aggregate: 'analytics',
    fallbackMs: 30_000,
    deps: [formId],
  });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const model = useMemo(() => (data ? buildMonitorModel(data, formId) : null), [data, formId]);

  const downloadPlan = (): void => {
    if (!model) return;
    setDownloadError(null);
    try {
      downloadText(fileName(model.title, 'power-bi-plan.json'), powerBiPlanJson(model), 'application/json');
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'the report plan could not be downloaded');
    }
  };

  const downloadAllCsv = (): void => {
    if (!model) return;
    setDownloadError(null);
    try {
      downloadCsv(fileName(model.title, 'monitor-tables.csv'), monitorCsv(model));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'the monitor tables could not be downloaded');
    }
  };

  const downloadQuestionCsv = (question: MonitorQuestion, index: number): void => {
    if (!model) return;
    setDownloadError(null);
    try {
      downloadCsv(
        fileName(model.title, `q${String(index).padStart(2, '0')}-${slug(question.name) || 'question'}.csv`),
        questionCsv(question),
      );
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'the question table could not be downloaded');
    }
  };

  if (!publishedVersion) {
    return (
      <div className="stack">
        <div className="monitor-hero surface">
          <div>
            <span className="eyebrow">Live monitor</span>
            <h2>Nothing to monitor yet</h2>
            <p>Publish a version in the Builder tab and this screen will chart every submitted answer.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="stack monitor">
      <section className="monitor-hero surface">
        <div className="monitor-hero-copy">
          <span className="eyebrow">Live monitor</span>
          <h2>{model?.title ?? 'Reading the questionnaire…'}</h2>
          <p>
            Every question chart below is computed from submitted answers in the live database; the
            field-period line also shows started responses. Nothing is seeded, cached or copied into a
            separate reporting table.
          </p>
        </div>
        <div className="monitor-hero-side">
          <span className={live ? 'live-pill on' : 'live-pill'} role="status">
            <i aria-hidden="true" />
            {liveLabel(status, live, 30_000)}
          </span>
          {model && (
            <span className="monitor-stamp">
              data as of {new Date(model.generatedAt).toLocaleTimeString()} · published v{publishedVersion}
            </span>
          )}
          <button type="button" className="ghost" onClick={reload}>
            Refresh now
          </button>
        </div>
        {model && (
          <div className="monitor-kpis">
            <Kpi label="Submitted" value={number(model.submitted)} detail={`of ${number(model.total)} started`} />
            <Kpi label="Open" value={number(model.open)} detail="partial interviews" />
            <Kpi
              label="Completion rate"
              value={percent(model.completionRate)}
              detail={model.total ? `${number(model.submitted)} of ${number(model.total)} started` : 'no starts yet'}
            />
            <Kpi label="Sync conflicts" value={number(model.conflicts)} detail="server kept the value it held" />
          </div>
        )}
      </section>

      {error && <p className="error small">{error}</p>}
      {!model && !error && <p className="muted">Reading the live analytics table…</p>}

      {model && (
        <>
          <ClientAnalysis model={model} client={client} />

          <section className="card monitor-plan">
            <div className="monitor-plan-copy">
              <span className="eyebrow">Power BI handoff</span>
              <h2>Report plan for this questionnaire</h2>
              <p>
                {powerBiPlanSummary(model.powerBi)}. The plan maps every answerable field to a visual,
                a measure and an 8 px grid on a 1280×720 canvas.
              </p>
              <p className="small muted">
                This is a specification, not a .pbix. Microsoft does not support generating a
                model-bearing PBIX outside Power BI Desktop, and a report-only PBIX is not a live model.
                The monitor above is the live surface. The plan is ready for Desktop or Fabric.
              </p>
              {downloadError && <p className="error small">{downloadError}</p>}
            </div>
            <div className="monitor-plan-actions">
              <button type="button" onClick={downloadPlan}>
                Download report plan (.json)
              </button>
              <span className="muted small">
                {model.answerable} answerable field{model.answerable === 1 ? '' : 's'} ·{' '}
                {model.omitted} display or calculated field{model.omitted === 1 ? '' : 's'} omitted
              </span>
            </div>
          </section>

          {model.timeline.length > 0 && <Activity model={model} />}

          <section className="monitor-questions">
            <div className="monitor-section-head">
              <div>
                <span className="eyebrow">Question coverage</span>
                <h2>Every field, with its own chart</h2>
              </div>
              <div className="row wrap">
                <span className="muted small">
                  {model.answerable} answerable · {model.omitted} omitted
                </span>
                <button type="button" className="ghost" onClick={downloadAllCsv}>
                  Export every table (.csv)
                </button>
              </div>
            </div>
            {model.groups.length === 0 && (
              <p className="muted">The published version has no answerable questions yet.</p>
            )}
            {model.groups.map((group) => (
              <section className="monitor-group" key={group.id}>
                <h3 className="monitor-group-title">{group.label}</h3>
                <div className="monitor-grid">
                  {group.questions.map((question) => (
                    <QuestionCard
                      key={question.id}
                      question={question}
                      index={model.questions.findIndex((candidate) => candidate.id === question.id) + 1}
                      onCsv={() =>
                        downloadQuestionCsv(
                          question,
                          model.questions.findIndex((candidate) => candidate.id === question.id) + 1,
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>

          <p className="muted small">
            Question charts use submitted responses only; the field-period line counts every started
            response. A missing count is a submitted response with no value for that field. Multi-select
            bars show the share of respondents who selected each option, so they can add past 100%.
          </p>
        </>
      )}
    </div>
  );
}
