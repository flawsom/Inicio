import { describe, expect, it } from 'vitest';
import { diffDefinitions } from '../src/diff.js';
import type { FormDefinition, Group, Question } from '../src/types.js';

/**
 * The fixture is the shape a real instrument takes: two languages, a field-list
 * group, a group that repeats, a cascading select over a shared choice list, a
 * mandatory question and a relevance rule. Every test changes exactly one thing
 * about it, because a diff is only trustworthy if each sentence can be traced to
 * the one change that produced it.
 */
const base: FormDefinition = {
  title: 'School ranking',
  defaultLanguage: 'en',
  languages: ['en', 'hi'],
  groups: [
    { id: 'g_admin', name: 'admin', label: { en: 'Administration', hi: 'प्रशासन' } },
    { id: 'g_contacts', name: 'contacts', label: { en: 'Contacts' }, repeat: true },
    { id: 'g_geo', name: 'geo', label: { en: 'Location' } },
  ],
  questions: [
    {
      id: 'q_school',
      name: 'school',
      type: 'text',
      groupId: 'g_admin',
      label: { en: 'School', hi: 'स्कूल' },
      required: true,
    },
    { id: 'q_contact', name: 'contact_name', type: 'text', groupId: 'g_contacts', label: { en: 'Contact name' } },
    {
      id: 'q_type',
      name: 'school_type',
      type: 'select_one',
      groupId: 'g_admin',
      label: { en: 'School type' },
      choices: { listName: 'school_types' },
    },
    {
      id: 'q_consent',
      name: 'consent',
      type: 'yesno',
      groupId: 'g_geo',
      label: { en: 'Consent' },
      rules: { visibleIf: '${school_type} = "private"' },
    },
  ],
  choiceLists: {
    school_types: [
      { value: 'govt', label: { en: 'Government', hi: 'सरकारी' } },
      { value: 'private', label: { en: 'Private', hi: 'निजी' } },
    ],
  },
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** A copy of the fixture with one thing changed, so the rest of the diff is silent. */
function edited(from: FormDefinition, edit: (draft: FormDefinition) => void): FormDefinition {
  const draft = clone(from);
  edit(draft);
  return draft;
}

function question(def: FormDefinition, name: string): Question {
  const found = def.questions.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`the fixture has no question called ${name}`);
  return found;
}

function group(def: FormDefinition, id: string): Group {
  const found = def.groups.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`the fixture has no group called ${id}`);
  return found;
}

describe('diffDefinitions', () => {
  it('reports one instrument copied as another as identical, with nothing to say', () => {
    const diff = diffDefinitions(base, clone(base));

    expect(diff.identical).toBe(true);
    expect(diff.changes).toEqual([]);
    expect(diff.questions).toEqual([]);
    expect(diff.notes).toEqual([]);
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('names a new question and its type', () => {
    const to = edited(base, (draft) => {
      draft.questions.push({ id: 'q_new', name: 'enrolment', type: 'integer', label: { en: 'Enrolment' } });
    });
    const diff = diffDefinitions(base, to);

    expect(diff.identical).toBe(false);
    expect(diff.changes).toEqual(['Added question "enrolment" (integer).']);
    expect(diff.questions).toEqual([{ name: 'enrolment', kind: 'added', details: ['Added question "enrolment" (integer).'] }]);
    expect(diff.counts).toEqual({ added: 1, removed: 0, changed: 0 });
  });

  it('names a question that is no longer collected', () => {
    const to = edited(base, (draft) => {
      draft.questions = draft.questions.filter((candidate) => candidate.name !== 'contact_name');
    });
    const diff = diffDefinitions(base, to);

    expect(diff.changes).toEqual(['Removed question "contact_name".']);
    expect(diff.counts).toEqual({ added: 0, removed: 1, changed: 0 });
    expect(diff.questions[0]).toEqual({
      name: 'contact_name',
      kind: 'removed',
      details: ['Removed question "contact_name".'],
    });
  });

  it('reports a prompt change in the language that changed, with both texts', () => {
    const to = edited(base, (draft) => {
      question(draft, 'school').label = { en: 'School', hi: 'विद्यालय' };
    });

    expect(diffDefinitions(base, to).changes).toEqual(['"school" label in hi changed from "स्कूल" to "विद्यालय".']);
  });

  it('reports a language a question gained and one it lost', () => {
    const to = edited(base, (draft) => {
      question(draft, 'contact_name').label = { en: 'Contact name', ta: 'தொடர்பு பெயர்' };
    });
    const diff = diffDefinitions(base, to);

    expect(diff.changes).toContain('"contact_name" gained a ta label: "தொடர்பு பெயர்".');
  });

  it('reports options added to and dropped from a shared list, and their labels', () => {
    const to = edited(base, (draft) => {
      draft.choiceLists['school_types'] = [
        { value: 'private', label: { en: 'Private', hi: 'निजी स्कूल' } },
        { value: 'trust', label: { en: 'Trust' } },
      ];
    });
    const diff = diffDefinitions(base, to);

    expect(diff.changes).toEqual([
      '"school_type" choices: added "trust"; removed "govt".',
      '"school_type" choice "private" label in hi changed from "निजी" to "निजी स्कूल".',
    ]);
  });

  it('says when options moved between a shared list and the question itself', () => {
    const to = edited(base, (draft) => {
      question(draft, 'school_type').choices = {
        inline: [
          { value: 'govt', label: { en: 'Government', hi: 'सरकारी' } },
          { value: 'private', label: { en: 'Private', hi: 'निजी' } },
        ],
      };
    });

    expect(diffDefinitions(base, to).changes).toEqual([
      '"school_type" now writes its options into the question instead of taking them from the list "school_types".',
    ]);
  });

  it('says when a question points at a list this version does not declare', () => {
    const to = edited(base, (draft) => {
      question(draft, 'school_type').choices = { listName: 'districts' };
    });
    const diff = diffDefinitions(base, to);

    expect(diff.changes).toEqual([
      '"school_type" now takes its options from the list "districts" instead of "school_types".',
    ]);
    expect(diff.notes).toEqual(['This version does not declare the option list "districts" used by "school_type".']);
  });

  it('reports a question that stopped being mandatory, and one that became conditional', () => {
    const relaxed = edited(base, (draft) => {
      question(draft, 'school').required = false;
    });
    expect(diffDefinitions(base, relaxed).changes).toEqual(['"school" is no longer mandatory.']);

    const conditional = edited(base, (draft) => {
      question(draft, 'school').required = '${enrolment} > 50';
    });
    expect(diffDefinitions(base, conditional).changes).toEqual([
      '"school" is now mandatory only when "${enrolment} > 50".',
    ]);
  });

  it('reports a relevance change in the words the original instrument used', () => {
    const from = edited(base, (draft) => {
      question(draft, 'consent').rules = { visibleIf: '${age} > 17' };
    });
    const to = edited(from, (draft) => {
      question(draft, 'consent').rules = { visibleIf: '${age} >= 18' };
    });

    expect(diffDefinitions(from, to).changes).toEqual([
      '"consent" relevance changed from "${age} > 17" to "${age} >= 18".',
    ]);
  });

  it('quotes an expression that contains a quote so the sentence stays readable', () => {
    const to = edited(base, (draft) => {
      question(draft, 'school_type').rules = { choiceFilter: '${state} = "ka"' };
    });

    expect(diffDefinitions(base, to).changes).toEqual([
      `"school_type" options are now filtered by '\${state} = "ka"'.`,
    ]);
  });

  it('reports a hint, a constraint and its message as separate facts', () => {
    const to = edited(base, (draft) => {
      const school = question(draft, 'school');
      school.hint = { en: 'As printed on the board' };
      school.validation = { constraint: 'length(.) > 2', message: { en: 'Too short' } };
    });

    expect(diffDefinitions(base, to).changes).toEqual([
      '"school" gained a en hint: "As printed on the board".',
      '"school" must now satisfy "length(.) > 2".',
      '"school" gained a en validation message: "Too short".',
    ]);
  });

  it('reports a calculation a question took on', () => {
    const to = edited(base, (draft) => {
      question(draft, 'contact_name').rules = { calculate: 'concat(${a}, ${b})' };
    });

    expect(diffDefinitions(base, to).changes).toEqual(['"contact_name" is now calculated as "concat(${a}, ${b})".']);
  });

  it('reports a question moved between groups, by group name', () => {
    const to = edited(base, (draft) => {
      question(draft, 'contact_name').groupId = 'g_admin';
    });
    const diff = diffDefinitions(base, to);

    expect(diff.changes).toEqual(['"contact_name" moved from the group "contacts" to "admin".']);
  });

  it('reports a question taken out of a group altogether', () => {
    const to = edited(base, (draft) => {
      question(draft, 'consent').groupId = null;
    });

    expect(diffDefinitions(base, to).changes).toEqual(['"consent" is no longer inside a group (it was in "geo").']);
  });

  it('reports a group added, removed, renamed and no longer repeating', () => {
    const to = edited(base, (draft) => {
      group(draft, 'g_admin').name = 'administration';
      group(draft, 'g_contacts').repeat = false;
      group(draft, 'g_contacts').label = { en: 'People to contact' };
      draft.groups = draft.groups.filter((candidate) => candidate.id !== 'g_geo');
      draft.groups.push({ id: 'g_visits', name: 'visits', label: { en: 'Visits' }, repeat: true });
    });
    const diff = diffDefinitions(base, to);

    expect(diff.changes).toEqual([
      'Removed the group "geo".',
      'Added the group "visits", which repeats once per response.',
      'The group "admin" is now called "administration".',
      'The group "contacts" label in en changed from "Contacts" to "People to contact".',
      'The group "contacts" no longer repeats.',
    ]);
  });

  it('reports the instrument-level changes before the questions', () => {
    const to = edited(base, (draft) => {
      draft.title = 'School ranking 2026';
      draft.defaultLanguage = 'hi';
      draft.languages = ['hi', 'ta'];
    });

    expect(diffDefinitions(base, to).changes).toEqual([
      'The title changed from "School ranking" to "School ranking 2026".',
      'The default language changed from en to hi.',
      'The language en is no longer in the instrument.',
      'The language ta was added to the instrument.',
    ]);
  });

  it('reports a reordering as one fact rather than as every question moving', () => {
    const to = edited(base, (draft) => {
      const [first, second, third, fourth] = draft.questions;
      if (!first || !second || !third || !fourth) throw new Error('the fixture lost a question');
      draft.questions = [third, first, second, fourth];
    });

    expect(diffDefinitions(base, to).changes).toEqual(['The questions were reordered.']);
  });

  it('says a question changed in a way it cannot phrase, and refuses to call the versions identical', () => {
    const to = edited(base, (draft) => {
      question(draft, 'school').appearance = 'minimal';
    });
    const diff = diffDefinitions(base, to);

    expect(diff.identical).toBe(false);
    expect(diff.changes).toEqual(['"school" also changed in a way this diff does not describe in words (appearance).']);
    expect(diff.notes).toEqual([
      'Some differences are real but are not described in words: appearance. The two versions are not identical.',
    ]);
  });

  it('says plainly when one version has no questions at all', () => {
    const empty = edited(base, (draft) => {
      draft.groups = [];
      draft.questions = [];
      draft.choiceLists = {};
    });
    const diff = diffDefinitions(empty, base);

    expect(diff.changes).toEqual([
      'Added the group "admin".',
      'Added the group "contacts", which repeats once per response.',
      'Added the group "geo".',
      'Added question "school" (text).',
      'Added question "contact_name" (text).',
      'Added question "school_type" (select_one).',
      'Added question "consent" (yesno).',
    ]);
    expect(diff.notes).toEqual(['The earlier version had no questions, so every question is new.']);
    expect(diff.counts.added).toBe(4);
  });

  it('compares only the first of two questions sharing a name, and says so', () => {
    const duplicated = edited(base, (draft) => {
      draft.questions.push({ id: 'q_dup', name: 'school', type: 'text', label: { en: 'School again' } });
    });
    const diff = diffDefinitions(duplicated, base);

    expect(diff.notes).toContain('Two questions are called "school" in the earlier version; only the first of them is compared.');
    expect(diff.changes).toEqual([]);
  });

  it('leaves a question that carries none of the optional fields alone', () => {
    const from = edited(base, (draft) => {
      draft.questions.push({ id: 'q_bare', name: 'bare', type: 'text', label: { en: 'Bare' } });
    });
    const to = edited(from, (draft) => {
      question(draft, 'bare').label = { en: 'Bare', hi: 'खाली' };
      question(draft, 'bare').hint = undefined;
      question(draft, 'bare').choices = null;
      question(draft, 'bare').rules = undefined;
      question(draft, 'bare').validation = null;
    });
    const diff = diffDefinitions(from, to);

    expect(diff.changes).toEqual(['"bare" gained a hi label: "खाली".']);
    expect(diff.notes).toEqual([]);
  });

  it('is deterministic: the same pair of definitions gives the same answer twice', () => {
    const to = edited(base, (draft) => {
      draft.title = 'School ranking 2026';
      question(draft, 'school').required = false;
      draft.questions.push({ id: 'q_new', name: 'enrolment', type: 'integer', label: { en: 'Enrolment' } });
    });

    expect(diffDefinitions(base, to)).toEqual(diffDefinitions(base, to));
  });
});
