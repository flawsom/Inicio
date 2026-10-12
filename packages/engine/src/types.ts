/** Canonical form model. Adapters (XLSForm, CSV, SurveyJS) translate to this. */

export type LocalizedText = Record<string, string>;

export type QuestionType =
  | 'text' | 'textarea' | 'integer' | 'decimal' | 'percentage' | 'currency'
  | 'date' | 'datetime' | 'time' | 'yesno'
  | 'select_one' | 'select_multiple' | 'rank'
  | 'geopoint' | 'geotrace' | 'geoshape'
  | 'image' | 'audio' | 'video' | 'file' | 'barcode'
  | 'note' | 'calculate';

/** Types whose value is a list. */
export const MULTI_TYPES: ReadonlySet<QuestionType> = new Set(['select_multiple', 'rank']);
/** Types with no user input (never required, never blank-validated). */
export const DISPLAY_TYPES: ReadonlySet<QuestionType> = new Set(['note']);

export interface Choice {
  value: string;
  label: LocalizedText;
  /** Extra attribute columns from the XLSForm `choices` sheet, used by choiceFilter. */
  extra?: Record<string, string>;
}

/**
 * Adapter-specific source preserved verbatim through a round trip. The runtime never
 * interprets this — it exists so an XLSForm import that uses a type or column the
 * canonical model has no field for (ODK metadata types, `guidance_hint`, platform-only
 * appearances) is not silently lossy on the way back out.
 */
export interface PreservedSource {
  adapter: string;
  /** The original `type` cell, when it differs from the canonical type. */
  type?: string;
  /** Columns the canonical model does not model, re-emitted on export. */
  columns?: Record<string, string>;
}

export interface QuestionRules {
  /** Show/hide. Hidden => answer is nulled. */
  visibleIf?: string | null;
  /** Visible but read-only when false. */
  enableIf?: string | null;
  /** Derived value, recomputed when dependencies change. */
  calculate?: string | null;
  /** Dynamic option filtering (cascading selects). */
  choiceFilter?: string | null;
}

export interface Question {
  id: string;
  groupId?: string | null;
  /** Stable export column name. Unique within a form. */
  name: string;
  type: QuestionType;
  label: LocalizedText;
  hint?: LocalizedText;
  /** true, false, or an expression string for conditional requirement. */
  required?: boolean | string;
  requiredMessage?: LocalizedText;
  choices?: { listName?: string; inline?: Choice[] } | null;
  validation?: { constraint?: string | null; message?: LocalizedText } | null;
  rules?: QuestionRules;
  appearance?: string | null;
  defaultValue?: unknown;
  upload?: { accept?: string[]; maxFiles?: number; maxSizeMb?: number } | null;
  source?: PreservedSource | null;
}

export interface Group {
  id: string;
  name: string;
  label: LocalizedText;
  repeat?: boolean;
  repeatCount?: string | null;
  /** Group-level relevance: an invisible group hides every question inside it. */
  rules?: QuestionRules;
  /** XLSForm `appearance` (e.g. `field-list`) — a rendering hint, not logic. */
  appearance?: string | null;
  source?: PreservedSource | null;
}

export interface Variable { name: string; type: 'text' | 'number' | 'date'; label?: LocalizedText }

export interface Trigger {
  type: 'skip' | 'complete' | 'setvalue';
  when: string;
  target?: string;
  value?: string;
}

export interface FormDefinition {
  title: string;
  defaultLanguage: string;
  languages: string[];
  groups: Group[];
  questions: Question[];
  choiceLists: Record<string, Choice[]>;
  variables?: Variable[];
  triggers?: Trigger[];
  settings?: Record<string, unknown>;
}

export interface AnswerMap { [questionName: string]: unknown }
