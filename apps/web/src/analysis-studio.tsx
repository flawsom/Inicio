import { useMemo } from 'react';
import {
  buildAnalysisBrief,
  certaintyLabel,
  quadrantLabel,
} from './analysis-model';
import {
  buildMonitorInsights,
  insightNumber,
  insightPercent,
  type InsightConfidenceBand,
  type InsightTimelinePoint,
} from './monitor-insights';
import type { MonitorModel } from './monitor-model';

/**
 * The live analytical studio.
 *
 * The monitor below this section is a catalogue of every answer. This section is
 * the executive read: how much evidence there is, where the answer bases are
 * thin, how the field is moving, and which single-choice answers have a lead
 * worth trusting. It is deliberately built from the same monitor model and the
 * same client brief as the rest of the screen, so no second source of truth can
 * drift from the live counts.
 */

function Meter({ score, label, tone }: { score: number; label: string; tone?: 'ok' | 'warn' }): JSX.Element {
  return (
    <span
      className={`studio-meter${tone ? ` studio-meter-${tone}` : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(score)}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
    </span>
  );
}

function ConfidenceBands({ bands }: { bands: InsightConfidenceBand[] }): JSX.Element {
  const summary = bands
    .slice(0, 4)
    .map((band) => `${band.label}: ${band.topLabel} at ${band.share.toFixed(1)}%, range ${band.interval.low.toFixed(1)} to ${band.interval.high.toFixed(1)} percent`)
    .join('; ');
  return (
    <section className="studio-panel studio-bands-panel">
      <header className="studio-panel-head">
        <div>
          <span className="eyebrow">Evidence, not decoration</span>
          <h3>Confidence bands</h3>
        </div>
        <span className="studio-panel-note">95% Wilson · single choice</span>
      </header>
      {bands.length === 0 ? (
        <p className="studio-empty">
          No single-choice answer has a submitted base yet. The first answers will appear here as bands, not as a fake percentage.
        </p>
      ) : (
        <>
          <div className="studio-bands" role="img" aria-label={`Confidence bands for the top answers. ${summary}.`}>
            {bands.map((band) => (
              <div className="studio-band-row" key={band.name}>
                <div className="studio-band-copy">
                  <span className="studio-band-label" title={band.label}>{band.label}</span>
                  <span className="studio-band-sub">
                    {band.topLabel} · n={insightNumber(band.base)} · {band.effectiveOptions.toFixed(1)} effective options
                    {band.thinBase ? ' · thin base' : ''}
                  </span>
                </div>
                <div className="studio-band-track" aria-hidden="true">
                  <span
                    className="studio-band-range"
                    style={{ left: `${band.interval.low}%`, width: `${Math.max(1.5, band.interval.high - band.interval.low)}%` }}
                  />
                  <span className="studio-band-dot" style={{ left: `${band.share}%` }} />
                </div>
                <span className="studio-band-value" title={`Top-answer share ${band.share.toFixed(1)}%; 95% range ${band.interval.low.toFixed(1)}% to ${band.interval.high.toFixed(1)}%`}>
                  {band.share.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
          <div className="studio-band-scale" aria-hidden="true">
            <span>0%</span>
            <span>50%</span>
            <span>100%</span>
          </div>
          <p className="studio-panel-foot">
            The dot is the observed top-answer share. The band is the uncertainty around it at this base; overlapping bands are not a significance test.
          </p>
        </>
      )}
    </section>
  );
}

function FieldworkChart({ points }: { points: InsightTimelinePoint[] }): JSX.Element {
  if (points.length === 0) {
    return (
      <p className="studio-empty">
        The field-period chart will appear once the first response starts. Nothing is projected or back-filled.
      </p>
    );
  }
  const width = 560;
  const height = 190;
  const paddingX = 28;
  const paddingTop = 18;
  const paddingBottom = 28;
  const max = Math.max(...points.flatMap((point) => [point.cumulativeStarted, point.cumulativeSubmitted]), 1);
  const step = points.length > 1 ? (width - paddingX * 2) / (points.length - 1) : 0;
  const x = (index: number): number => paddingX + index * step;
  const y = (value: number): number => height - paddingBottom - (value / max) * (height - paddingTop - paddingBottom);
  const started = points.map((point, index) => `${x(index)},${y(point.cumulativeStarted)}`).join(' ');
  const submitted = points.map((point, index) => `${x(index)},${y(point.cumulativeSubmitted)}`).join(' ');
  const area = points.length
    ? `M ${x(0)} ${height - paddingBottom} L ${points.map((point, index) => `${x(index)} ${y(point.cumulativeSubmitted)}`).join(' L ')} L ${x(points.length - 1)} ${height - paddingBottom} Z`
    : '';
  return (
    <div
      className="studio-field-chart"
      role="img"
      aria-label={`Cumulative responses by day. ${points.at(-1)?.day ?? 'Latest day'}: ${points.at(-1)?.cumulativeStarted ?? 0} started and ${points.at(-1)?.cumulativeSubmitted ?? 0} submitted.`}
    >
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true" focusable="false">
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={paddingX}
            x2={width - paddingX}
            y1={paddingTop + fraction * (height - paddingTop - paddingBottom)}
            y2={paddingTop + fraction * (height - paddingTop - paddingBottom)}
            className="studio-grid-line"
          />
        ))}
        <line x1={paddingX} x2={paddingX} y1={paddingTop} y2={height - paddingBottom} className="studio-axis-line" />
        <line x1={paddingX} x2={width - paddingX} y1={height - paddingBottom} y2={height - paddingBottom} className="studio-axis-line" />
        {area && <path d={area} className="studio-area" />}
        <polyline points={started} className="studio-line studio-line-started" fill="none" />
        <polyline points={submitted} className="studio-line" fill="none" />
        {points.map((point, index) => (
          <g key={point.day}>
            <circle cx={x(index)} cy={y(point.cumulativeStarted)} r="2.4" className="studio-point-muted">
              <title>{point.day}: {point.cumulativeStarted} started</title>
            </circle>
            <circle cx={x(index)} cy={y(point.cumulativeSubmitted)} r="3" className="studio-point">
              <title>{point.day}: {point.cumulativeSubmitted} submitted</title>
            </circle>
          </g>
        ))}
      </svg>
      <div className="studio-chart-axis">
        <span>{points[0]?.day}</span>
        <span>{points.at(-1)?.day}</span>
      </div>
    </div>
  );
}

function FieldworkPulse({
  points,
  velocity,
  peakDay,
  activeDays,
  completionRate,
}: {
  points: InsightTimelinePoint[];
  velocity: number | null;
  peakDay: InsightTimelinePoint | null;
  activeDays: number;
  completionRate: number | null;
}): JSX.Element {
  return (
    <section className="studio-panel studio-field-panel">
      <header className="studio-panel-head">
        <div>
          <span className="eyebrow">Fieldwork telemetry</span>
          <h3>How the field is moving</h3>
        </div>
        <span className="studio-panel-note">cumulative · started vs submitted</span>
      </header>
      <FieldworkChart points={points} />
      <div className="studio-field-stats">
        <div>
          <span className="studio-stat-label">7-day velocity</span>
          <strong>{velocity === null ? '—' : `${velocity.toFixed(1)}/day`}</strong>
          <small>submitted in the latest observed days</small>
        </div>
        <div>
          <span className="studio-stat-label">Peak day</span>
          <strong>{peakDay ? insightNumber(peakDay.submitted) : '—'}</strong>
          <small>{peakDay ? peakDay.day : 'no submissions yet'}</small>
        </div>
        <div>
          <span className="studio-stat-label">Active days</span>
          <strong>{insightNumber(activeDays)}</strong>
          <small>{completionRate === null ? 'no starts yet' : `${insightPercent(completionRate)} started→submitted`}</small>
        </div>
      </div>
      <p className="studio-panel-foot">
        Counts are observed, not extrapolated. A rising cumulative line is not a forecast; it is the field period to date.
      </p>
    </section>
  );
}

function CoverageMap({ groups }: { groups: ReturnType<typeof buildMonitorInsights>['coverageGroups'] }): JSX.Element {
  const ordered = groups
    .filter((group) => group.possible > 0)
    .sort((a, b) => a.coverage - b.coverage || a.label.localeCompare(b.label));
  return (
    <section className="studio-panel studio-coverage-panel">
      <header className="studio-panel-head">
        <div>
          <span className="eyebrow">Questionnaire coverage</span>
          <h3>Where the answer base thins</h3>
        </div>
        <span className="studio-panel-note">weakest section first</span>
      </header>
      {ordered.length === 0 ? (
        <p className="studio-empty">No answerable sections are available yet.</p>
      ) : (
        <div className="studio-coverage-list">
          {ordered.map((group) => (
            <div className="studio-coverage-row" key={group.id}>
              <div className="studio-coverage-copy">
                <span>{group.label}</span>
                <small>
                  {group.questionCount} question{group.questionCount === 1 ? '' : 's'}
                  {group.thinQuestions > 0 ? ` · ${group.thinQuestions} thin` : ''}
                </small>
              </div>
              <span className="studio-coverage-track" aria-hidden="true">
                <span style={{ width: `${Math.max(1, group.coverage * 100)}%` }} />
              </span>
              <span className="studio-coverage-value">
                {insightPercent(group.coverage)}
                <small>{group.answered}/{group.possible}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="studio-panel-foot">
        Coverage is answered fields divided by possible submitted fields across the section. Skip logic can lower it by design.
      </p>
    </section>
  );
}

function TypeMix({ slices, omitted }: { slices: ReturnType<typeof buildMonitorInsights>['typeMix']; omitted: number }): JSX.Element {
  return (
    <section className="studio-panel studio-mix-panel">
      <header className="studio-panel-head">
        <div>
          <span className="eyebrow">Instrument architecture</span>
          <h3>What this questionnaire measures</h3>
        </div>
        <span className="studio-panel-note">{omitted} calculated / display fields omitted</span>
      </header>
      {slices.length === 0 ? (
        <p className="studio-empty">No answerable field types yet.</p>
      ) : (
        <>
          <div className="studio-mix-bar" aria-hidden="true">
            {slices.map((slice) => (
              <span
                key={slice.type}
                className={`studio-mix-segment studio-mix-${slice.type.replaceAll('_', '-')}`}
                style={{ width: `${slice.share * 100}%` }}
              />
            ))}
          </div>
          <dl className="studio-mix-legend">
            {slices.map((slice) => (
              <div key={slice.type}>
                <dt>
                  <i className={`studio-mix-dot studio-mix-${slice.type.replaceAll('_', '-')}`} />
                  {slice.label}
                </dt>
                <dd>
                  {slice.count} <span>{Math.round(slice.share * 100)}%</span>
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="studio-panel-foot">
        Type counts come from the published questionnaire, not from the data. They show what the instrument can support.
      </p>
    </section>
  );
}

function SignalCards({
  findings,
}: {
  findings: ReturnType<typeof buildAnalysisBrief>['findings'];
}): JSX.Element | null {
  if (findings.length === 0) return null;
  return (
    <div className="studio-signals" aria-label="Strongest current signals">
      {findings.slice(0, 3).map((finding, index) => (
        <article className={`studio-signal studio-signal-${finding.quadrant}`} key={finding.id}>
          <header className="studio-signal-head">
            <span className="studio-signal-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="studio-signal-tag">{certaintyLabel(finding.certainty)} · {quadrantLabel(finding.quadrant)}</span>
          </header>
          <h3>{finding.title}</h3>
          <p>{finding.action}</p>
          <div className="studio-signal-bars">
            <span>
              <small>signal</small>
              <Meter score={finding.signalScore} label={`Signal strength ${finding.signalScore} out of 100`} />
            </span>
            <span>
              <small>certainty</small>
              <Meter score={finding.certaintyScore} label={`Certainty ${finding.certaintyScore} out of 100`} tone="ok" />
            </span>
          </div>
        </article>
      ))}
    </div>
  );
}

export function AnalysisStudio({
  model,
  client,
  live,
}: {
  model: MonitorModel;
  client?: string;
  live: boolean;
}): JSX.Element {
  const insights = useMemo(() => buildMonitorInsights(model), [model]);
  const brief = useMemo(() => buildAnalysisBrief(model, { client }), [client, model]);
  const readiness = brief.readiness;

  return (
    <section className="analysis-studio surface" aria-labelledby="analysis-studio-title">
      <header className="analysis-studio-head">
        <div className="analysis-studio-heading">
          <span className="eyebrow">Analytical studio</span>
          <h2 id="analysis-studio-title">The signal room</h2>
          <p>
            A live reading of <strong>{model.title}</strong>. Every band, bar and count is derived from
            the same submitted responses as the monitor below; there is no seeded example and no
            external benchmark.
          </p>
        </div>
        <div className="analysis-studio-status">
          <span className={live ? 'studio-live on' : 'studio-live'}>
            <i aria-hidden="true" />
            {live ? 'live analysis' : 'snapshot analysis'}
          </span>
          <span>data as of {new Date(insights.generatedAt).toLocaleString()}</span>
          <span className="studio-method-note">marginals only · unweighted</span>
        </div>
      </header>

      <div className="analysis-studio-scoreboard">
        <div className="studio-readiness">
          <div
            className="studio-ring"
            style={{ background: `conic-gradient(var(--accent) ${Math.max(0, Math.min(100, readiness.score))}%, var(--panel-2) 0)` }}
            role="progressbar"
            aria-label={`Analysis readiness: ${readiness.label}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={readiness.score}
          >
            <div>
              <strong>{readiness.score}</strong>
              <span>/100</span>
            </div>
          </div>
          <div className="studio-readiness-copy">
            <span className="eyebrow">Analysis readiness</span>
            <h3>{readiness.label}</h3>
            <p>{readiness.summary}</p>
          </div>
        </div>
        <div className="studio-metrics">
          <div>
            <span className="studio-stat-label">Answer coverage</span>
            <strong>{insightPercent(insights.coverageRate)}</strong>
            <small>answered fields / possible fields</small>
          </div>
          <div>
            <span className="studio-stat-label">Conflict-free</span>
            <strong>{insightPercent(insights.integrityRate)}</strong>
            <small>{insightNumber(insights.conflicts)} sync disagreement{insights.conflicts === 1 ? '' : 's'}</small>
          </div>
          <div>
            <span className="studio-stat-label">No answer yet</span>
            <strong>{insightNumber(insights.noAnswers)}</strong>
            <small>{insightNumber(insights.thinQuestions)} answered bases under 30</small>
          </div>
          <div>
            <span className="studio-stat-label">Field days</span>
            <strong>{insightNumber(insights.activeDays)}</strong>
            <small>days with a submission</small>
          </div>
        </div>
      </div>

      <SignalCards findings={brief.findings} />

      <div className="analysis-studio-grid">
        <ConfidenceBands bands={insights.confidenceBands} />
        <FieldworkPulse
          points={insights.recentTimeline}
          velocity={insights.velocity}
          peakDay={insights.peakDay}
          activeDays={insights.activeDays}
          completionRate={insights.completionRate}
        />
      </div>

      <div className="analysis-studio-grid analysis-studio-grid-lower">
        <CoverageMap groups={insights.coverageGroups} />
        <TypeMix slices={insights.typeMix} omitted={model.omitted} />
      </div>

      <footer className="analysis-studio-foot">
        <span className="eyebrow">The boundary</span>
        <p>
          This is a live read of marginal counts. It does not cross-tabulate respondents, weight the
          sample, forecast the field period or infer causes; those need response-level data and a
          sampling design. The detailed client brief below carries the method, limits and next
          questions for every finding.
        </p>
      </footer>
    </section>
  );
}
