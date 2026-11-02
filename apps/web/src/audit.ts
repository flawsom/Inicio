/**
 * The device half of the audit instruments.
 *
 * Two things are measured while an interview happens:
 *
 * - how long each field was on screen and when it was answered, which becomes the
 *   text audit rows and the input to the speed check;
 * - a sampled audio clip, if the instrument asks for one.
 *
 * Both are deliberately quiet. An audit field is invisible to a respondent, so a
 * browser that refuses the microphone, a page that never gains focus, or a device
 * with no MediaRecorder must all degrade to "no clip" rather than interrupt the
 * interview. The one thing this file never does is invent a timing for a field it
 * did not see.
 */
import {
  auditSeed,
  audioWindow,
  evaluateSpeed,
  isAudited,
  parseAuditSpec,
  parseSpeedSpec,
  type FieldTiming,
  type FormDefinition,
  type SpeedOptions,
  type SpeedReport,
} from '@inicio/engine';
import type { Paradata, ParadataTiming } from './offline/types';

/** A recorded segment, held until the response exists and it can be uploaded. */
export interface AudioClip {
  /** The audit field this clip belongs to. */
  field: string;
  blob: Blob;
  mime: string;
  /** Wall clock, ISO, when recording began. This is the clip's `started_at`. */
  startedAt: string;
  startSeconds: number;
  durationSeconds: number;
}

interface ScheduledCapture {
  field: string;
  timer: ReturnType<typeof setTimeout>;
}

export class AuditRecorder {
  private readonly startedAt: number;
  private readonly shown = new Map<string, number>();
  private readonly answered = new Map<string, number>();
  private readonly visits = new Map<string, number>();
  private readonly clips: AudioClip[] = [];
  private readonly captures: ScheduledCapture[] = [];
  private readonly recorders = new Set<MediaRecorder>();
  private stream: MediaStream | null = null;
  private audioStarted = false;
  private disposed = false;

  constructor(
    private readonly definition: FormDefinition,
    private readonly seed: string,
    private readonly answerOf: () => Record<string, unknown>,
    private readonly now: () => number = () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  ) {
    this.startedAt = this.now();
  }

  /** When a field first became visible. Repeated calls keep the first instant. */
  noteVisible(name: string): void {
    if (this.disposed || this.shown.has(name)) return;
    this.shown.set(name, this.now());
  }

  /** When an answer was committed. The last commit is the one timed. */
  noteAnswer(name: string, value: unknown): void {
    if (this.disposed) return;
    const question = this.definition.questions.find((candidate) => candidate.name === name);
    if (!question || question.type === 'note' || question.type === 'calculate') return;
    const at = this.now();
    if (!this.shown.has(name)) this.shown.set(name, at);
    this.answered.set(name, at);
    this.visits.set(name, (this.visits.get(name) ?? 0) + 1);
    void value;
  }

  /** The offline payload. Only answered fields produce a row: a blank is not a timing. */
  paradata(): Paradata {
    const timings: ParadataTiming[] = [];
    for (const [question, answeredAt] of this.answered) {
      const shownAt = this.shown.get(question) ?? answeredAt;
      timings.push({
        question,
        shownAt: Math.max(0, Math.round(shownAt - this.startedAt)),
        answeredAt: Math.max(0, Math.round(answeredAt - this.startedAt)),
        visits: this.visits.get(question) ?? 1,
      });
    }
    return { timings };
  }

  /** The device's own copy of the speed verdict, recomputed from the timings. */
  speed(): SpeedReport {
    const options: SpeedOptions = { thresholds: {} };
    for (const question of this.definition.questions) {
      if (question.audit?.kind !== 'speed_violations' || !question.audit.spec) continue;
      const parsed = parseSpeedSpec(question.audit.spec);
      if ('error' in parsed) continue;
      Object.assign(options.thresholds ?? {}, parsed.thresholds);
      if (parsed.minimumFormSeconds !== undefined) options.minimumFormSeconds = parsed.minimumFormSeconds;
    }

    const answers = this.answerOf();
    const timings: FieldTiming[] = [];
    for (const [question, answeredAt] of this.answered) {
      const definition = this.definition.questions.find((candidate) => candidate.name === question);
      if (!definition) continue;
      const value = answers[question];
      timings.push({
        question,
        type: definition.type,
        shownAt: this.shown.get(question) ?? answeredAt,
        answeredAt,
        answer: value === undefined || value === null ? '' : String(value),
      });
    }
    return evaluateSpeed(timings, options);
  }

  /**
   * Ask for the microphone and schedule the sampled clips.
   *
   * A refusal is not an error state. The respondent said no, or the browser asked
   * before the page had a gesture, and the interview continues without audio.
   */
  async startAudio(): Promise<void> {
    if (this.audioStarted || this.disposed) return;
    const fields = this.definition.questions.filter((question) => question.audit?.kind === 'audio_audit');
    if (fields.length === 0) return;
    this.audioStarted = true;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    if (typeof MediaRecorder === 'undefined') return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return;
    }
    if (this.disposed) {
      this.stopTracks();
      return;
    }

    for (const question of fields) {
      const parsed = parseAuditSpec('audio_audit', question.audit?.spec ?? '');
      if ('error' in parsed) continue;
      const seed = auditSeed(this.seed, question.name);
      if (!isAudited(parsed, seed)) continue;
      const window = audioWindow(parsed, seed, (name) => this.answerOf()[name]);
      if ('error' in window) continue;
      const delay = Math.min(Math.max(0, window.startSeconds), 3600) * 1000;
      const timer = setTimeout(() => {
        this.capture(question.name, window.durationSeconds, window.stopField);
      }, delay);
      this.captures.push({ field: question.name, timer });
    }
  }

  /** Hand over the clips that have not been uploaded, and forget them. */
  takeClips(): AudioClip[] {
    return this.clips.splice(0, this.clips.length);
  }

  dispose(): void {
    this.disposed = true;
    for (const capture of this.captures) clearTimeout(capture.timer);
    this.captures.length = 0;
    for (const recorder of this.recorders) {
      try {
        if (recorder.state !== 'inactive') recorder.stop();
      } catch {
        // A recorder already stopped by the browser has nothing to stop.
      }
    }
    this.recorders.clear();
    this.stopTracks();
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private capture(field: string, durationSeconds: number | undefined, stopField: string | undefined): void {
    if (this.disposed || !this.stream) return;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(this.stream, mimeChoice());
    } catch {
      return;
    }

    const chunks: Blob[] = [];
    const startedAt = new Date();
    const started = this.now();
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      this.recorders.delete(recorder);
      if (this.disposed || chunks.length === 0) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      this.clips.push({
        field,
        blob,
        mime: blob.type || 'audio/webm',
        startedAt: startedAt.toISOString(),
        startSeconds: Math.max(0, (started - this.startedAt) / 1000),
        durationSeconds: Math.max(0, (this.now() - started) / 1000),
      });
    };

    try {
      recorder.start(1000);
    } catch {
      return;
    }
    this.recorders.add(recorder);

    if (durationSeconds !== undefined) {
      this.after(Math.max(0.5, Math.min(durationSeconds, 3600)) * 1000, () => this.stopRecorder(recorder));
      return;
    }

    // A stop field ends the recording when it gets an answer. The cap is a safety
    // net, not a duration: an interview that never reaches the stop field still
    // releases the microphone and produces a clip rather than running all day.
    const limit = Date.now() + 3_600_000;
    const poll = (): void => {
      if (recorder.state === 'inactive') return;
      const stopValue = stopField ? this.answerOf()[stopField] : undefined;
      const answered = stopValue !== undefined && stopValue !== null && String(stopValue).trim() !== '';
      if (answered || Date.now() >= limit) {
        this.stopRecorder(recorder);
        return;
      }
      this.after(1000, poll);
    };
    this.after(1000, poll);
  }

  private stopRecorder(recorder: MediaRecorder): void {
    try {
      if (recorder.state !== 'inactive') recorder.stop();
    } catch {
      // Already stopped.
    }
  }

  private after(delayMs: number, fn: () => void): void {
    const timer = setTimeout(() => {
      if (!this.disposed) fn();
    }, delayMs);
    this.captures.push({ field: '', timer });
  }
}

function mimeChoice(): MediaRecorderOptions {
  for (const mimeType of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(mimeType)) return { mimeType };
  }
  return {};
}
