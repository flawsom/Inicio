// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Definition } from '../src/api';
import { RespondentForm } from '../src/respondent';
import { DefinitionStudio } from '../src/studio';

/**
 * The studio: one definition, three live views of it.
 *
 * What is worth holding down here is not that three boxes appear. It is that the
 * three boxes are *the same definition*, read three ways, at the same moment:
 *
 *   - the JSON panel is what the server sent, and editing it repaints the other two
 *     without a request, because a preview that lags the thing it previews is a
 *     preview of the wrong thing;
 *   - the XLSForm panel is the workbook `Download .xlsx` writes, sheet by sheet —
 *     the rows come from `xlsFormSheets`, the function `exportXlsForm` zips;
 *   - the preview is the *respondent's own* renderer, evaluated live, so a question
 *     that a relevance rule hides is hidden here for the same reason it is hidden on
 *     the phone.
 *
 * Two more assertions are about not doing harm. Typing in the preview must not send
 * or store anything — a preview is not a response — and half-typed JSON must leave
 * the screen standing with a sentence explaining what it is, rather than a React
 * error boundary or a stale picture of the definition it used to be.
 */

const FORM = 'form-1';
const VERSION = 'ver-1';

const DEFINITION: Definition = {
  title: 'Household visit 2026',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [{ id: 'g1', name: 'admin', label: { en: 'Administration' } }],
  questions: [
    {
      id: 'q1',
      name: 'consent',
      type: 'select_one',
      groupId: 'g1',
      label: { en: 'Consent given?' },
      required: true,
      choices: {
        inline: [
          { value: 'yes', label: { en: 'Yes' } },
          { value: 'no', label: { en: 'No' } },
        ],
      },
    },
    {
      id: 'q2',
      name: 'school_name',
      type: 'text',
      groupId: 'g1',
      label: { en: 'School name' },
      hint: { en: 'As printed on the board' },
      rules: { visibleIf: "${consent} = 'yes'" },
    },
  ],
  choiceLists: {},
};

const VERSION_SUMMARY = {
  id: VERSION,
  version: 1,
  status: 'draft' as const,
  title: DEFINITION.title,
  published_at: null,
  created_at: '2026-10-13T09:00:00.000Z',
  question_count: 2,
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
/** What the next save answers. */
let saveAnswer: { status: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  saveAnswer = { status: 200, body: { errors: [], warnings: [], version: { definition: DEFINITION } } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'GET' && url.includes(`/forms/${FORM}/versions/${VERSION}`)) {
      return json({ version: { id: VERSION, version: 1, status: 'draft', definition: DEFINITION } });
    }
    if (method === 'PUT') return json(saveAnswer.body, saveAnswer.status);
    return json({});
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ helpers */

function panel(label: string): HTMLElement {
  const found = container.querySelector(`section[aria-label="${label}"]`);
  if (!found) throw new Error(`no "${label}" panel on screen`);
  return found as HTMLElement;
}

function buttonIn(scope: HTMLElement, label: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

function sheetTab(name: string): HTMLButtonElement {
  const found = [...panel('XLSForm').querySelectorAll('button[role="tab"]')].find((el) =>
    el.textContent?.trim().startsWith(name),
  );
  if (!found) throw new Error(`no "${name}" sheet tab`);
  return found as HTMLButtonElement;
}

function textarea(): HTMLTextAreaElement {
  const found = panel('Definition').querySelector('textarea');
  if (!found) throw new Error('no definition textarea');
  return found as HTMLTextAreaElement;
}

function previewField(labelText: string): HTMLElement | null {
  const fields = [...panel('Preview').querySelectorAll('.field')];
  return (fields.find((el) => el.querySelector('label')?.textContent?.includes(labelText)) as HTMLElement) ?? null;
}

const noop = (): void => undefined;

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

/** React reads `value` from its own event, so the native setter has to be used. */
async function edit(el: HTMLTextAreaElement | HTMLInputElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<DefinitionStudio formId={FORM} version={VERSION_SUMMARY} revision={0} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The definition as text, with `patch` applied — what a person typing would produce. */
function edited(patch: Partial<Definition>): string {
  return JSON.stringify({ ...DEFINITION, ...patch }, null, 2);
}

/* -------------------------------------------------------------------- tests */

describe('the definition studio', () => {
  it('opens on the version the server holds, as three panels over one definition', async () => {
    await mount();

    // The source panel is the server's own definition, not a copy with fields missing.
    expect(textarea().value).toBe(JSON.stringify(DEFINITION, null, 2));
    expect(panel('Definition').textContent).toContain('2 question(s) · valid JSON');

    // And the other two panels exist beside it rather than behind a tab.
    expect(panel('XLSForm')).toBeDefined();
    expect(panel('Preview')).toBeDefined();
  });

  it('shows the workbook the download writes, sheet by sheet', async () => {
    await mount();

    // The survey sheet is the real thing: the export's own column headings, the
    // question's name, the `select_one <list>` type an ODK tool needs, and the
    // relevance expression that came from the definition rather than from a mock.
    const survey = panel('XLSForm').textContent ?? '';
    expect(survey).toContain('type');
    expect(survey).toContain('select_one consent_choices');
    expect(survey).toContain('consent');
    expect(survey).toContain("${consent} = 'yes'");
    // The count is the sheet's own rows, which is four for two questions: a group is
    // a `begin_group`/`end_group` pair in XLSForm, and the panel says the shape it has.
    expect(sheetTab('survey').textContent?.trim()).toBe('survey 4 rows');

    // The choices sheet holds the list the inline choices were written to, which is
    // also what the adapter reported as a normalisation.
    await click(sheetTab('choices'));
    const choices = panel('XLSForm').textContent ?? '';
    expect(choices).toContain('consent_choices');
    expect(choices).toContain('Yes');
    expect(choices).toContain('normalised');

    // The settings sheet carries the form's own title.
    await click(sheetTab('settings'));
    expect(panel('XLSForm').textContent).toContain('form_title');
    expect(panel('XLSForm').textContent).toContain('Household visit 2026');
  });

  it('previews the respondent’s form, evaluated live', async () => {
    await mount();

    const preview = panel('Preview');
    expect(preview.querySelector('h1')?.textContent).toBe('Household visit 2026');
    expect(preview.textContent).toContain('Consent given?');
    // Required, so the marker the respondent sees is there too.
    expect(preview.querySelector('.req')?.textContent).toBe(' *');
    // `school_name` is only relevant when consent is `yes`: the rule is evaluated by
    // the engine, on the answers in the preview, not painted from the definition.
    expect(previewField('School name')).toBeNull();

    const consent = preview.querySelector('select') as HTMLSelectElement;
    expect([...consent.options].map((o) => o.textContent)).toEqual(['- choose -', 'Yes', 'No']);

    await choose(consent, 'yes');
    const shown = previewField('School name');
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain('As printed on the board');

    await choose(consent, '');
    expect(previewField('School name')).toBeNull();
  });

  it('never sends or stores anything typed into the preview', async () => {
    await mount();
    const before = calls.length;

    const preview = panel('Preview');
    await choose(preview.querySelector('select') as HTMLSelectElement, 'yes');
    await edit(preview.querySelector('input[type="text"]') as HTMLInputElement, 'Govt High School');

    // The only requests this screen makes are the read that opened it.
    expect(calls.slice(before).every((call) => call.method === 'GET')).toBe(true);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    // And the way a response would be written is present and off.
    const submit = buttonIn(preview, 'Submit');
    expect(submit.disabled).toBe(true);
    expect(preview.textContent).toContain('Nothing typed here is sent or stored');
  });

  it('repaints the workbook and the preview while the JSON is being edited', async () => {
    await mount();

    const added = {
      id: 'q3',
      name: 'visits',
      type: 'integer' as const,
      groupId: 'g1',
      label: { en: 'Visits this week' },
    };
    await edit(textarea(), edited({ questions: [...DEFINITION.questions, added] }));

    // No request was needed and none was made: all three panels read one object.
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(panel('Definition').textContent).toContain('3 question(s) · valid JSON');
    expect(sheetTab('survey').textContent?.trim()).toBe('survey 5 rows');
    expect(panel('XLSForm').textContent).toContain('visits');
    expect(previewField('Visits this week')).not.toBeNull();

    // Renaming a label moves the preview, which is the thing a preview is for. The
    // consent answer is given first so `school_name` is on screen to be renamed.
    await choose(panel('Preview').querySelector('select') as HTMLSelectElement, 'yes');
    await edit(
      textarea(),
      edited({
        questions: DEFINITION.questions.map((q) => (q.id === 'q2' ? { ...q, label: { en: 'School name — official' } } : q)),
      }),
    );
    expect(panel('Preview').textContent).toContain('School name — official');
    expect(panel('XLSForm').textContent).toContain('School name — official');
  });

  it('reports an analyser finding while typing, before anything is saved', async () => {
    await mount();

    const duplicate = { ...DEFINITION.questions[1], id: 'q9', name: 'consent' };
    await edit(textarea(), edited({ questions: [DEFINITION.questions[0], duplicate] }));

    expect(panel('Definition').textContent).toContain('Duplicate question name "consent"');
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('says what half-typed JSON is, instead of taking the screen down', async () => {
    await mount();

    await edit(textarea(), '{ "title": "Half');

    expect(panel('Definition').textContent).toContain('not valid JSON');
    expect(panel('XLSForm').textContent).toContain('Nothing to export until the JSON above is a form definition');
    expect(panel('Preview').textContent).toContain('The preview appears once the JSON above is a form definition');
    // Still three panels, still usable: the analyser and the save button are intact.
    expect(buttonIn(panel('Definition'), 'Save draft').disabled).toBe(false);

    // Something that parses but is not a form gets its own sentence, not a crash.
    await edit(textarea(), '{ "title": "Half a form" }');
    expect(panel('Definition').textContent).toContain('`questions` is not an array');
  });

  it('saves what is on screen, and shows what the server stored', async () => {
    await mount();

    const renamed = { ...DEFINITION, title: 'Household visit 2026 (round 2)' };
    saveAnswer = { status: 200, body: { errors: [], warnings: [], version: { definition: renamed } } };
    await edit(textarea(), JSON.stringify(renamed, null, 2));
    await click(buttonIn(panel('Definition'), 'Save draft'));

    const saved = calls.find((call) => call.method === 'PUT');
    expect(saved).toBeDefined();
    expect(saved?.url).toContain(`/forms/${FORM}/versions/${VERSION}`);
    expect(saved?.body).toEqual({ definition: renamed });
    // The panel keeps the server's answer rather than the textarea's, so what is on
    // screen is a fact about the database.
    expect(panel('Definition').textContent).toContain('Saved. The server kept 2 question(s)');
    expect(panel('Preview').textContent).toContain('Household visit 2026 (round 2)');
  });

  it('renders the preview with the respondent’s own field markup, not a lookalike', async () => {
    await mount();
    const preview = panel('Preview');
    await choose(preview.querySelector('select') as HTMLSelectElement, 'yes');

    const inPreview = [...preview.querySelectorAll('.field')].map((el) => el.outerHTML);
    expect(inPreview.length).toBe(2);

    // The same component, mounted the way the collection page mounts it, over the
    // same definition and the same answers. If a field ever renders differently in
    // the preview, the author is checking the wrong thing — which is the failure this
    // whole screen exists to prevent.
    const other = document.createElement('div');
    document.body.appendChild(other);
    const otherRoot = createRoot(other);
    await act(async () => {
      otherRoot.render(<RespondentForm definition={DEFINITION} answers={{ consent: 'yes' }} onChange={noop} />);
      await Promise.resolve();
    });
    const asRespondent = [...other.querySelectorAll('.field')].map((el) => el.outerHTML);
    expect(asRespondent).toEqual(inPreview);

    act(() => otherRoot.unmount());
    other.remove();
  });
});
