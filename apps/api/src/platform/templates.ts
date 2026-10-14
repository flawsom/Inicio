import type { FormDefinition } from '@inicio/engine';

/**
 * Starter templates.
 *
 * The school ranking survey that this repository was originally specified around is
 * *here*, as one template among several — not as the application. That was the whole
 * point of the pivot: the survey is content, the platform is the product. Keeping it
 * also means the work already done on the questionnaire is not wasted.
 *
 * Templates are canonical definitions, not spreadsheets: they are type-checked at
 * build time and they go through the same publish-time analyser as anything an author
 * builds by hand.
 */
export interface Template {
  id: string;
  title: string;
  description: string;
  definition: FormDefinition;
}

const schoolRanking: FormDefinition = {
  title: 'School Ranking Survey 2026',
  defaultLanguage: 'en',
  languages: ['en', 'hi'],
  groups: [
    { id: 'g_admin', name: 'admin', label: { en: 'Administration', hi: 'प्रशासन' }, repeat: false, appearance: 'field-list' },
    { id: 'g_metrics', name: 'metrics', label: { en: 'Ranking metrics', hi: 'रैंकिंग मानदंड' }, repeat: false, appearance: 'field-list' },
    { id: 'g_contacts', name: 'contacts', label: { en: 'Contacts', hi: 'संपर्क' }, repeat: true, repeatCount: null },
  ],
  questions: [
    {
      id: 'q_school_name',
      groupId: 'g_admin',
      name: 'school_name',
      type: 'text',
      label: { en: 'School name (as printed on the board)', hi: 'विद्यालय का नाम' },
      hint: { en: 'Enter it exactly as it appears', hi: 'बिल्कुल वैसा ही लिखें' },
      required: true,
    },
    {
      id: 'q_school_type',
      groupId: 'g_admin',
      name: 'school_type',
      type: 'select_one',
      label: { en: 'School type', hi: 'विद्यालय प्रकार' },
      required: true,
      choices: { listName: 'school_types' },
      appearance: 'minimal',
    },
    {
      id: 'q_state',
      groupId: 'g_admin',
      name: 'state',
      type: 'select_one',
      label: { en: 'State', hi: 'राज्य' },
      required: true,
      choices: { listName: 'states' },
    },
    {
      id: 'q_district',
      groupId: 'g_admin',
      name: 'district',
      type: 'select_one',
      label: { en: 'District', hi: 'जिला' },
      required: true,
      choices: { listName: 'districts' },
      // Cascading select, written exactly as XLSForm writes it: the bare `state` is a
      // column on the choices sheet, `${state}` is the answered question.
      rules: { choiceFilter: 'state = ${state}' },
    },
    {
      id: 'q_enrolment',
      groupId: 'g_admin',
      name: 'enrolment',
      type: 'integer',
      label: { en: 'Total enrolment', hi: 'कुल नामांकन' },
      required: true,
      validation: { constraint: '. >= 0', message: { en: 'Enrolment cannot be negative' } },
    },
    {
      id: 'q_location',
      groupId: 'g_admin',
      name: 'location',
      type: 'geopoint',
      label: { en: 'School location', hi: 'विद्यालय का स्थान' },
      hint: { en: 'Capture on site, not from memory', hi: 'स्थल पर ही दर्ज करें' },
    },
    {
      id: 'q_teacher_quality',
      groupId: 'g_metrics',
      name: 'teacher_quality',
      type: 'integer',
      label: { en: 'Teacher quality (1-5)', hi: 'शिक्षक गुणवत्ता (1-5)' },
      required: true,
      appearance: 'rating',
      validation: { constraint: '. >= 1 and . <= 5', message: { en: 'Between 1 and 5' } },
    },
    {
      id: 'q_infrastructure',
      groupId: 'g_metrics',
      name: 'infrastructure',
      type: 'integer',
      label: { en: 'Infrastructure (1-5)', hi: 'अधोसंरचना (1-5)' },
      required: true,
      appearance: 'rating',
      validation: { constraint: '. >= 1 and . <= 5', message: { en: 'Between 1 and 5' } },
    },
    {
      id: 'q_facilities',
      groupId: 'g_metrics',
      name: 'facilities',
      type: 'select_multiple',
      label: { en: 'Facilities available', hi: 'उपलब्ध सुविधाएँ' },
      choices: { listName: 'facilities' },
    },
    {
      id: 'q_fee_annual',
      groupId: 'g_metrics',
      name: 'fee_annual',
      type: 'decimal',
      label: { en: 'Annual fee, if private', hi: 'वार्षिक शुल्क (निजी हो तो)' },
      rules: { visibleIf: "${school_type} = 'private'" },
      validation: { constraint: '. >= 0', message: { en: 'Fee cannot be negative' } },
    },
    {
      id: 'q_score',
      groupId: 'g_metrics',
      name: 'composite_score',
      type: 'calculate',
      label: { en: 'Composite score', hi: 'समग्र अंक' },
      rules: { calculate: '(${teacher_quality} + ${infrastructure}) * 10' },
    },
    {
      id: 'q_contact_name',
      groupId: 'g_contacts',
      name: 'contact_name',
      type: 'text',
      label: { en: 'Contact name', hi: 'संपर्क नाम' },
      required: true,
    },
    {
      id: 'q_contact_phone',
      groupId: 'g_contacts',
      name: 'contact_phone',
      type: 'text',
      label: { en: 'Contact phone', hi: 'संपर्क फ़ोन' },
      required: true,
      validation: { constraint: 'length(.) = 10', message: { en: 'Exactly 10 digits' } },
    },
  ],
  choiceLists: {
    school_types: [
      { value: 'govt', label: { en: 'Government', hi: 'सरकारी' } },
      { value: 'aided', label: { en: 'Aided', hi: 'अनुदानित' } },
      { value: 'private', label: { en: 'Private', hi: 'निजी' } },
    ],
    states: [
      { value: 'ka', label: { en: 'Karnataka', hi: 'कर्नाटक' } },
      { value: 'mh', label: { en: 'Maharashtra', hi: 'महाराष्ट्र' } },
      { value: 'tn', label: { en: 'Tamil Nadu', hi: 'तमिलनाडु' } },
    ],
    // The `state` attribute column is what the district question filters on.
    districts: [
      { value: 'ka_blr', label: { en: 'Bengaluru Urban', hi: 'बेंगलुरु शहरी' }, extra: { state: 'ka' } },
      { value: 'ka_mys', label: { en: 'Mysuru', hi: 'मैसूर' }, extra: { state: 'ka' } },
      { value: 'mh_pun', label: { en: 'Pune', hi: 'पुणे' }, extra: { state: 'mh' } },
      { value: 'mh_mum', label: { en: 'Mumbai Suburban', hi: 'मुंबई उपनगर' }, extra: { state: 'mh' } },
      { value: 'tn_che', label: { en: 'Chennai', hi: 'चेन्नई' }, extra: { state: 'tn' } },
    ],
    facilities: [
      { value: 'library', label: { en: 'Library', hi: 'पुस्तकालय' } },
      { value: 'lab', label: { en: 'Science laboratory', hi: 'विज्ञान प्रयोगशाला' } },
      { value: 'playground', label: { en: 'Playground', hi: 'खेल का मैदान' } },
      { value: 'computers', label: { en: 'Computer room', hi: 'कंप्यूटर कक्ष' } },
      { value: 'ramp', label: { en: 'Wheelchair access', hi: 'व्हीलचेयर पहुँच' } },
    ],
  },
  settings: { pagination: 'section', allowPartialSave: true },
};

const serviceFeedback: FormDefinition = {
  title: 'Service feedback',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_rating', name: 'rating', type: 'select_one', label: { en: 'Overall rating' }, required: true, choices: { listName: 'ratings' } },
    { id: 'q_nps', name: 'nps', type: 'integer', label: { en: 'How likely are you to recommend us? (0-10)' }, required: true, validation: { constraint: '. >= 0 and . <= 10', message: { en: 'Between 0 and 10' } } },
    { id: 'q_comment', name: 'comment', type: 'textarea', label: { en: 'What should we improve?' }, rules: { visibleIf: '${rating} != \'excellent\'' } },
  ],
  choiceLists: {
    ratings: [
      { value: 'excellent', label: { en: 'Excellent' } },
      { value: 'good', label: { en: 'Good' } },
      { value: 'poor', label: { en: 'Poor' } },
    ],
  },
};

const fieldInspection: FormDefinition = {
  title: 'Field inspection (offline-ready)',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [{ id: 'g_site', name: 'site', label: { en: 'Site' }, repeat: false, appearance: 'field-list' }],
  questions: [
    { id: 'q_site_name', groupId: 'g_site', name: 'site_name', type: 'text', label: { en: 'Site name' }, required: true },
    { id: 'q_site_photo', groupId: 'g_site', name: 'site_photo', type: 'image', label: { en: 'Photograph' }, required: true },
    { id: 'q_gps', groupId: 'g_site', name: 'gps', type: 'geopoint', label: { en: 'GPS at the site' }, required: true },
    { id: 'q_condition', name: 'condition', type: 'select_one', label: { en: 'Condition' }, required: true, choices: { listName: 'conditions' } },
    { id: 'q_damage', name: 'damage_notes', type: 'textarea', label: { en: 'Describe the damage' }, rules: { visibleIf: "${condition} = 'damaged'" } },
  ],
  choiceLists: {
    conditions: [
      { value: 'good', label: { en: 'Good' } },
      { value: 'damaged', label: { en: 'Damaged' } },
      { value: 'unusable', label: { en: 'Unusable' } },
    ],
  },
};

export const TEMPLATES: Template[] = [
  {
    id: 'school-ranking-2026',
    title: schoolRanking.title,
    description:
      'The original 2026 school ranking instrument: cascading district selection, a repeat group for contacts, an on-site geopoint and a computed composite score. Kept as a template so the existing questionnaire is content, not the product.',
    definition: schoolRanking,
  },
  {
    id: 'service-feedback',
    title: serviceFeedback.title,
    description: 'Short NPS-style form: a rating, a 0-10 recommendation score and a conditional comment box.',
    definition: serviceFeedback,
  },
  {
    id: 'field-inspection',
    title: fieldInspection.title,
    description: 'Photo, GPS and a conditional damage narrative: the shape of an offline field inspection.',
    definition: fieldInspection,
  },
];

export function findTemplate(id: string): FormDefinition | null {
  return TEMPLATES.find((t) => t.id === id)?.definition ?? null;
}
