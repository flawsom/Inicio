import { useMemo, useState } from 'react';
import {
  ANALYSIS_METHODS,
  analysisBriefMarkdown,
  buildAnalysisBrief,
  certaintyLabel,
  quadrantLabel,
  type AnalysisFinding,
} from './analysis-model';
import type { MonitorModel } from './monitor-model';

/**
 * The client-facing reading of the live monitor.
 *
 * The monitor answers "what is in the table". This section answers the harder
 * question a client actually asks: "what does this mean, how sure are we, and
 * what should we do next?" It is built from the same live counts, and it says
 * plainly where those counts stop being able to answer.
 *
 * It is deliberately not a wall of statistics. Every finding has a one-sentence
 * reading, a decision consequence and a next move; the arithmetic sits behind
 * "Show the working" for the analyst who has to defend the sentence.
 */

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

function downloadBrief(name: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function clampPercent(value: number): number {
  return Math.min(92, Math.max(8, value));
}

function positionFor(finding: AnalysisFinding): { left: string; bottom: string } {
  return {
    left: `${clampPercent(finding.certaintyScore)}%`,
    bottom: `${clampPercent(finding.signalScore)}%`,
  };
}

function Meter({ score, label }: { score: number; label: string }): JSX.Element {
  return (
    <div
      className="analysis-meter"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score}
    >
      <span style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
    </div>
  );
}

function DecisionMap({ findings }: { findings: AnalysisFinding[] }): JSX.Element {
  return (
    <div className="analysis-map-wrap">
      <div className="analysis-section-head">
        <div>
          <span className="eyebrow">Decision grid</span>
          <h3>What is strong, and what is certain</h3>
        </div>
        <span className="muted small">right = more certain · up = stronger pattern</span>
      </div>
      <div className="analysis-map" aria-hidden="true">
        <span className="analysis-map-label analysis-map-label-tl">Big, but uncertain</span>
        <span className="analysis-map-label analysis-map-label-tr">Act on it</span>
        <span className="analysis-map-label analysis-map-label-bl">Too early</span>
        <span className="analysis-map-label analysis-map-label-br">Solid, but small</span>
        <span className="analysis-map-axis analysis-map-axis-x">certainty →</span>
        <span className="analysis-map-axis analysis-map-axis-y">signal ↑</span>
        {findings.map((finding, index) => (
          <span
            key={finding.id}
            className={`analysis-dot analysis-dot-${finding.quadrant}`}
            style={positionFor(finding)}
            title={`${index + 1}. ${finding.title} — ${certaintyLabel(finding.certainty)}`}
          >
            {index + 1}
          </span>
        ))}
      </div>
      <p className="analysis-map-caption">
        Position is a reading aid, not a significance test. The numbers match the findings below.
      </p>
    </div>
  );
}

function FindingCard({ finding, index }: { finding: AnalysisFinding; index: number }): JSX.Element {
  return (
    <article className={`analysis-finding analysis-finding-${finding.quadrant}`}>
      <header className="analysis-finding-head">
        <span className="analysis-finding-number">{String(index).padStart(2, '0')}</span>
        <div>
          <h4>{finding.title}</h4>
          <p className="analysis-tags">
            <span className={`analysis-tag analysis-tag-${finding.certainty}`}>
              {certaintyLabel(finding.certainty)}
            </span>
            <span className="analysis-tag">{quadrantLabel(finding.quadrant)}</span>
            {finding.questionName && <span className="analysis-tag mono">{finding.questionName}</span>}
          </p>
        </div>
      </header>
      <p className="analysis-plain">{finding.plain}</p>
      <div className="analysis-consequence">
        <div>
          <span className="analysis-label">Why it matters</span>
          <p>{finding.why}</p>
        </div>
        <div>
          <span className="analysis-label">What to do</span>
          <p>{finding.action}</p>
        </div>
      </div>
      <details className="analysis-working">
        <summary>Show the working</summary>
        <p className="small">
          <strong>Method.</strong> {finding.method}
        </p>
        <ul>
          {finding.evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export function ClientAnalysis({ model, client }: { model: MonitorModel; client?: string }): JSX.Element {
  const brief = useMemo(() => buildAnalysisBrief(model, { client }), [client, model]);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const usedLenses = brief.lenses.filter((lens) => lens.used);
  const unusedLenses = brief.lenses.filter((lens) => !lens.used);

  const download = (): void => {
    setDownloadError(null);
    try {
      downloadBrief(
        `${slug(brief.instrument) || 'inicio'}-${slug(brief.client) || 'client'}-analysis-brief.md`,
        analysisBriefMarkdown(brief),
      );
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : 'the brief could not be downloaded');
    }
  };

  return (
    <section className="card analysis" aria-labelledby="analysis-title">
      <header className="analysis-head">
        <div>
          <span className="eyebrow">Client analysis brief</span>
          <h2 id="analysis-title">{brief.instrument}</h2>
          <p className="analysis-prepared">
            Prepared for <strong>{brief.client}</strong>
            <span aria-hidden="true"> · </span>
            {brief.focus}
          </p>
          <p className="small muted">{brief.focusWhy}</p>
        </div>
        <div className="analysis-actions">
          <span className="muted small">
            Data as of {new Date(brief.generatedAt).toLocaleString()}
          </span>
          <button type="button" className="ghost" onClick={download}>
            Download client brief (.md)
          </button>
          {downloadError && <span className="error small">{downloadError}</span>}
        </div>
      </header>

      <div className="analysis-answer">
        <span className="eyebrow">The one-page answer</span>
        <p>{brief.bottomLine}</p>
      </div>

      <div className="analysis-readiness">
        <div className="analysis-readiness-score">
          <span className="analysis-score-number">{brief.readiness.score}</span>
          <span className="analysis-score-label">{brief.readiness.label}</span>
          <Meter score={brief.readiness.score} label={`Analysis readiness: ${brief.readiness.label}`} />
          <p className="small muted">out of 100</p>
        </div>
        <div className="analysis-readiness-copy">
          <p>{brief.readiness.summary}</p>
          <dl className="analysis-facts">
            {brief.readiness.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
                <span>{fact.note}</span>
              </div>
            ))}
          </dl>
          <details className="analysis-improvements">
            <summary>What would make this stronger</summary>
            <ul>
              {brief.readiness.improvements.map((improvement) => (
                <li key={improvement}>{improvement}</li>
              ))}
            </ul>
          </details>
        </div>
      </div>

      {brief.findings.length > 0 ? (
        <>
          <DecisionMap findings={brief.findings} />
          <div className="analysis-findings">
            {brief.findings.map((finding, index) => (
              <FindingCard key={finding.id} finding={finding} index={index + 1} />
            ))}
          </div>
        </>
      ) : (
        <div className="analysis-empty">
          <strong>No finding yet.</strong>
          <p>
            The brief does not invent a pattern before the data can support one. Submit an answer or
            review the question design, and this section will fill from the live counts.
          </p>
        </div>
      )}

      <div className="analysis-lenses">
        <div className="analysis-section-head">
          <div>
            <span className="eyebrow">Why this focus</span>
            <h3>Read through this questionnaire, not a template</h3>
          </div>
          <span className="muted small">
            {usedLenses.length} of {brief.lenses.length} lenses present
          </span>
        </div>
        <ul className="analysis-lens-list">
          {usedLenses.map((lens) => (
            <li key={lens.id}>
              <strong>{lens.label}</strong>
              <span>{lens.why}</span>
            </li>
          ))}
        </ul>
        {unusedLenses.length > 0 && (
          <details className="analysis-unused">
            <summary>What this instrument does not measure</summary>
            <p className="small muted">
              These lenses were checked and not found. They are named so the absence is visible, not
              silently treated as a zero.
            </p>
            <ul>
              {unusedLenses.map((lens) => (
                <li key={lens.id}>{lens.label}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="analysis-two-col">
        <section className="analysis-panel">
          <span className="eyebrow">Read with care</span>
          <h3>What this brief cannot tell you</h3>
          <ul>
            {brief.limits.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>
        <section className="analysis-panel">
          <span className="eyebrow">Next decision</span>
          <h3>Questions to ask next</h3>
          <ol>
            {brief.nextQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ol>
        </section>
      </div>

      <details className="analysis-glossary">
        <summary>Plain-language glossary</summary>
        <dl>
          {brief.glossary.map((entry) => (
            <div key={entry.term}>
              <dt>{entry.term}</dt>
              <dd>{entry.plain}</dd>
            </div>
          ))}
        </dl>
      </details>

      <details className="analysis-glossary">
        <summary>Methods used</summary>
        <ul>
          {ANALYSIS_METHODS.map((method) => (
            <li key={method.name}>
              <strong>{method.name}.</strong> {method.plain} <em>{method.source}.</em>
            </li>
          ))}
        </ul>
      </details>

      <p className="analysis-footnote">
        This is a reading aid built from unweighted marginal counts. It is not a substitute for
        reviewing the instrument, the sampling frame and the fieldwork log.
      </p>
    </section>
  );
}
