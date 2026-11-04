import { describe, expect, it } from 'vitest';
import { compileDocxDocument } from '../src/compiler/docx-compiler.js';
import type { DocxDocument, DocxParagraph } from '../src/compiler/docx.js';
import { evaluateForm } from '../src/evaluate.js';

function paragraph(text: string): DocxParagraph {
  return { text, runs: [], bold: false, italic: false, numbered: false };
}

function document(blocks: string[]): DocxDocument {
  return {
    title: 'Bounce rider survey',
    partNames: [],
    blocks: blocks.map((text) => ({ kind: 'paragraph', paragraph: paragraph(text) })),
  };
}

/**
 * A compact Bounce-shaped instrument. It is deliberately paragraph-based, because
 * that is the layout that produced the giant field-list, the section choices and
 * the lost screener relevance in the real client workbook.
 */
const BOUNCE_LIKE = document([
  'INTERVIEWER TO READ: GOOD MORNING. I am from the research agency.',
  'Screener',
  'S1. Which city do you currently deliver in? SA',
  'Bengaluru',
  'Delhi NCR',
  'Other: ______ TERMINATE',
  'S2. Do you currently use a Bounce scooter for deliveries? SA',
  'Yes, I use one now CONTINUE AS CURRENT USER',
  'I used one but stopped CONTINUE AS CHURNED',
  'No, never TERMINATE',
  'S3. How long have you used or did you use a Bounce scooter? SA',
  'Under 1 month',
  '1 to 3 months',
  '2. Module A. Rider profile',
  'A2. Do you work for one platform or several at the same time? SA',
  'One only',
  'Two',
  'Three or more',
  'B1. How much do you pay Bounce per day for the scooter? INR/day: ________ PROGRAMMER TO ALLOW NUMBERS ONLY, MINIMUM 2 DIGITS.',
  'Under Rs. 240',
  'Rs. 240 to Rs. 270',
  'Over Rs. 270',
  'B7. A) Compared with your situation before Bounce, do you feel you save more money each month now? SA',
  'Much more',
  'Much less',
  'B1) PROGRAMMER TO ASK IF CODED 1. How much more do you save? ________ PROGRAMMER TO ALLOW NUMBERS ONLY, MINIMUM 2 DIGITS.',
  'B2) PROGRAMMER TO ASK IF CODED 2. How much less do you save? ________ PROGRAMMER TO ALLOW NUMBERS ONLY, MINIMUM 2 DIGITS.',
  'C2. On a working day, how many hours and km do you usually ride? Hours: ______, Km: _____ PROGRAMMER TO ALLOW NUMBERS ONLY.',
  'C7. A How likely are you to recommend Bounce to another rider? 0 = not at all, 10 = extremely',
  '9. Churned-rider branch only for riders who stopped using Bounce.',
  'X1. When did you stop using the Bounce scooter? SA',
  'Under 1 month',
  '1 to 3 months',
  'X6. At your busiest, how many days a week did you ride, and what did you earn per day? Days: ____ INR/day: ______ PROGRAMMER TO ALLOW NUMBERS ONLY.',
]);

const compiled = compileDocxDocument(BOUNCE_LIKE, {
  title: 'Bounce rider survey',
  projectNumber: 1608,
  now: new Date('2026-11-02T03:59:00Z'),
});

function question(name: string) {
  const found = compiled.definition.questions.find((entry) => entry.name === name);
  if (!found) throw new Error(`question ${name} was not compiled`);
  return found;
}

describe('docx compiler: Bounce regression', () => {
  it('does not put a field-list around the screener', () => {
    const screener = compiled.definition.groups.find((group) => group.name === 'screener');
    expect(screener).toBeDefined();
    expect(screener?.appearance ?? '').not.toContain('field-list');
  });

  it('chains screener relevance and gates the main questionnaire from the answer variables', () => {
    expect(question('s2').rules?.visibleIf).toContain("selected(${s1}, '1')");
    expect(question('s2').rules?.visibleIf).not.toContain('s1_oth');
    expect(question('s3').rules?.visibleIf).toContain("selected(${s1}, '1')");
    expect(question('glob_term').rules?.calculate).toContain("selected(${s1}, '1')");
    expect(question('glob_term').rules?.calculate).not.toContain('s1_oth');
  });

  it('routes a terminate option to note_term instead of the main questionnaire', () => {
    const live = evaluateForm(compiled.definition, { s1: '1', s2: '1', s3: '1' });
    expect(live.states['glob_term']?.value).toBe('1');
    expect(live.states['a2']?.visible).toBe(true);
    expect(live.states['note_term']?.visible).toBe(false);

    const terminated = evaluateForm(compiled.definition, { s1: '3' });
    expect(terminated.states['s2']?.visible).toBe(false);
    expect(terminated.states['a2']?.visible).toBe(false);
    expect(terminated.states['glob_term']?.value).toBe('');
    expect(terminated.states['note_term']?.visible).toBe(true);
  });

  it('creates a segment router from the CONTINUE AS CURRENT/CHURNED instructions', () => {
    expect(question('z0').rules?.calculate).toContain("selected(${s2}, '1')");
    expect(question('z0').rules?.calculate).toContain("selected(${s2}, '2')");
    expect(question('n_z0').label.english).toContain('${z0_dis}');
    expect(question('x1')?.rules?.visibleIf ?? '').toContain("selected(${z0}, '2')");
  });

  it('does not leak section headers into the choices sheet', () => {
    for (const choices of Object.values(compiled.definition.choiceLists)) {
      for (const choice of choices) {
        expect(choice.label.english ?? '').not.toMatch(/Module\s+[A-Z]|ZO\.\s*USER/i);
      }
    }
  });

  it('compiles numeric brackets, numeric follow-ups and the 0–10 scale', () => {
    expect(question('b1').type).toBe('integer');
    expect(question('b1_po').type).toBe('calculate');
    expect(question('b7a').type).toBe('select_one');
    expect(question('b7a').choices?.listName).toBe('b7a');
    expect(compiled.definition.choiceLists['b7a']).toHaveLength(2);
    expect(question('b7b1').type).toBe('integer');
    expect(question('b7b2').type).toBe('integer');
    expect(question('b7b1').rules?.visibleIf).toContain("selected(${b7a}, '1')");
    expect(question('c7a').choices?.listName).toBe('c7a');
    expect(compiled.definition.choiceLists['c7a']).toHaveLength(11);
  });

  it('groups only the two-input numeric pairs onto one page', () => {
    const fieldLists = compiled.definition.groups.filter((group) => /\bfield-list\b/i.test(group.appearance ?? ''));
    expect(fieldLists.map((group) => group.name).sort()).toEqual(['bg_c2', 'bg_x6']);
    expect(question('c2_h').groupId).toBe('g_bg_c2');
    expect(question('c2_k').groupId).toBe('g_bg_c2');
  });
});
