import { createHash } from 'node:crypto';

/**
 * The legal documents, held as data so that the version, the text and the hash
 * can never drift apart.
 *
 * Why the hash matters: terms acceptance is only worth anything as evidence if
 * it names the exact text that was on screen. The hash here is computed from
 * the same constant that the API serves and the browser renders, so a stored
 * acceptance can be checked against a retrievable document rather than trusting
 * a version string.
 *
 * These drafts follow the structure a data-collection platform is expected to
 * have, and include the disclaimers and role allocation that research on the
 * DPDP Act and GDPR indicates: the organisation running a survey is the data
 * fiduciary (controller) for its responses, this platform is its processor.
 * Counsel review is still required before relying on them commercially.
 */

export interface LegalSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface LegalDocument {
  id: 'terms' | 'privacy';
  title: string;
  version: string;
  effectiveDate: string;
  summary: string;
  sections: LegalSection[];
  /** SHA-256 of the canonical body; stored with every acceptance. */
  hash: string;
}

const VERSION = '2026-10-01';
const EFFECTIVE = '2026-10-01';
const OPERATOR = 'Inicio Survey (unifies.codes)';
const CONTACT = 'privacy@unifies.codes';

function hashOf(doc: Omit<LegalDocument, 'hash'>): string {
  const canonical = JSON.stringify({
    id: doc.id,
    version: doc.version,
    title: doc.title,
    summary: doc.summary,
    sections: doc.sections,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const termsBody: Omit<LegalDocument, 'hash'> = {
  id: 'terms',
  title: 'Terms of Service',
  version: VERSION,
  effectiveDate: EFFECTIVE,
  summary:
    'These terms govern your use of the survey and data-collection platform operated by ' +
    OPERATOR +
    '. By creating an account or using the service you agree to them.',
  sections: [
    {
      heading: '1. Who we are and what this agreement covers',
      paragraphs: [
        `The service is operated by ${OPERATOR} ("we", "us"). These terms are a contract between us and the organisation or individual that registers an account ("you", "customer").`,
        'The service lets you author surveys, distribute them, collect responses and export the results. Where you invite other people into your organisation, you are responsible for their use of the service under your account.',
      ],
    },
    {
      heading: '2. Accounts, invitations and access control',
      paragraphs: [
        'Accounts are created by invitation. An owner or administrator of an organisation invites an address, and the invitation link that we generate is single use and time limited.',
        'You must keep invitation links confidential. Anyone who obtains an invitation link before it is used can join the organisation with the role it carries, so treat it as a credential. We can revoke an invitation at the request of an organisation owner.',
        'Roles are owner, administrator, member and viewer. An owner can do everything, including managing the roster. An administrator can manage members and invitations. A member uses the product but cannot manage the roster or issue invitations. A viewer has read access only.',
        'You are responsible for the accuracy of the address you invite, for the roles you grant, and for removing access promptly when someone should no longer have it.',
      ],
    },
    {
      heading: '3. Your responsibilities for the data you collect',
      paragraphs: [
        'You decide what to ask, whom to ask, why you are asking and how long you keep the answers. That makes you the data fiduciary under the Digital Personal Data Protection Act, 2023 (India) and the controller under the General Data Protection Regulation where it applies. We process responses on your instructions as your processor.',
        'You are responsible for providing respondents with a clear notice before or at the point of collection, for identifying yourself as the party collecting the data, for choosing a lawful basis for the processing, and for obtaining and being able to evidence any consent that you rely on.',
        'If your survey collects data from anyone under 18, you are responsible for obtaining verifiable consent from a parent or lawful guardian where the law requires it, and for making sure the questions and any tracking are appropriate for that audience. Do not use the service to collect data from children without that process in place.',
        'If your survey touches special categories of data, such as health, ethnicity, religion, political opinion or sexual orientation, you are responsible for the additional legal conditions that apply and for telling us if you need specific safeguards.',
        'You must not put unlawful, deceptive or harmful content in a survey, must not use the service to send unsolicited bulk mail, must not attempt to breach the service or another tenant, and must not collect data you have no lawful reason to collect.',
      ],
    },
    {
      heading: '4. Our responsibilities',
      paragraphs: [
        'We provide the service with reasonable skill and care, apply technical and organisational measures appropriate to the risk, restrict our own access to your response data to what is needed to run and support the service, and process it only on your documented instructions unless the law requires otherwise.',
        'We will tell you without undue delay if we become aware of a personal data breach affecting your data, and we will give you the information you need to meet your own notification duties.',
        'Our privacy policy explains what we do with account, billing, security and product data for our own purposes, which is separate from the responses you collect.',
      ],
    },
    {
      heading: '5. Service availability and changes',
      paragraphs: [
        'We may change, add or remove features. Anything that materially reduces how the service works, or any change to these terms that materially affects your rights, will be notified to you and, where required, will require you to accept the updated terms before you continue.',
        'We may suspend an account where continued use would break the law, put other customers or respondents at risk, or where a security incident requires it. Where there is time to do so, we will tell you first and give you a chance to fix the problem.',
      ],
    },
    {
      heading: '6. Intellectual property',
      paragraphs: [
        'You keep all rights in your survey content, your questions, your data and your branding. You give us a limited licence to host, transmit, process and back up that content for the purpose of providing the service to you.',
        'We keep all rights in the platform, its software, its templates and its documentation. Nothing in these terms transfers ownership of personal data as if it were ordinary property.',
      ],
    },
    {
      heading: '7. Disclaimers',
      paragraphs: [
        'THIS SERVICE IS PROVIDED ON AN "AS IS" AND "AS AVAILABLE" BASIS. TO THE FULLEST EXTENT PERMITTED BY LAW WE DISCLAIM ALL IMPLIED WARRANTIES, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON INFRINGEMENT.',
        'We do not warrant that the service will be uninterrupted or error free, that email delivery will always succeed, that a survey will reach any particular number of respondents, or that the results of a survey are accurate, representative or fit for any decision you take. Survey results depend on how you design and distribute the instrument.',
        'Nothing in these terms excludes or limits any liability that cannot lawfully be excluded, including your statutory privacy rights and any mandatory consumer remedies.',
      ],
    },
    {
      heading: '8. Limitation of liability',
      paragraphs: [
        'To the fullest extent permitted by law, neither party is liable for indirect, incidental, special or consequential loss, loss of profit, loss of revenue, loss of goodwill or loss of anticipated savings, however arising.',
        'Our total liability arising out of or relating to these terms is limited to the greater of the fees you paid us in the twelve months before the claim arose, or INR 10,000.',
        'Claims relating to privacy or information security are subject to the same cap except where the law forbids a cap, in which case the cap applies to the maximum extent permitted.',
      ],
    },
    {
      heading: '9. Indemnities',
      paragraphs: [
        'You will indemnify us against third party claims arising from the content of your surveys, your collection or use of respondent data, the notices and consents you were required to give or obtain, or your breach of these terms.',
        'We will indemnify you against third party claims that the unmodified platform infringes their intellectual property. This indemnity does not cover claims arising from your content or from modifications you made.',
        'Where an indemnity applies, the party receiving it must give prompt notice, allow the other to control the defence, and cooperate reasonably.',
      ],
    },
    {
      heading: '10. Term, termination and data after termination',
      paragraphs: [
        'These terms continue while you have an account. Either party may terminate for material breach that is not fixed within 30 days of written notice, and we may terminate immediately for unlawful use or non payment.',
        'For 30 days after termination you may export your data in the formats the service offers. After that period we delete your response data and account data from live systems, and remove it from backups on the ordinary backup cycle, unless a law requires us to keep something for longer. We will tell you what we are keeping and why.',
        'Deleting an account does not affect data another organisation lawfully holds, or copies you already exported.',
      ],
    },
    {
      heading: '11. Governing law and disputes',
      paragraphs: [
        'These terms are governed by the laws of India. Subject to the paragraph below, the courts at Bengaluru, India have exclusive jurisdiction.',
        'Before starting proceedings, the parties will try in good faith to resolve a dispute by written notice and 30 days of discussion. Commercial disputes may be referred to arbitration by a sole arbitrator seated at Bengaluru, in English, under the Arbitration and Conciliation Act, 1996.',
        'Nothing in this clause takes away a right you have to bring a claim before a consumer commission or any other forum that cannot lawfully be excluded. If you are a consumer, your statutory remedies remain available.',
      ],
    },
    {
      heading: '12. Contact and notices',
      paragraphs: [
        `Questions about these terms, requests relating to personal data, and complaints go to ${CONTACT}. We publish the same address in our privacy policy.`,
        'We may give notice through the service interface or by email to the address on your account. You are responsible for keeping that address current.',
      ],
    },
  ],
};

const privacyBody: Omit<LegalDocument, 'hash'> = {
  id: 'privacy',
  title: 'Privacy Policy',
  version: VERSION,
  effectiveDate: EFFECTIVE,
  summary:
    'This policy explains what ' +
    OPERATOR +
    ' does with personal data in its own right, and how it handles survey responses for customers.',
  sections: [
    {
      heading: '1. Two roles, stated plainly',
      paragraphs: [
        'When an organisation uses the platform to run a survey, that organisation decides the purpose, the questions, the audience and the retention period. It is the data fiduciary under the Digital Personal Data Protection Act, 2023 and the controller under the GDPR. We act as the processor for those responses and process them on the organisation instructions.',
        'For account data, billing data, security telemetry and product administration, we decide the purpose and are a fiduciary and controller in our own right. This policy covers that processing.',
        'We do not use the responses a customer collects for our own marketing, for advertising, or to train models, and we do not sell personal data.',
      ],
    },
    {
      heading: '2. What we collect for our own purposes',
      paragraphs: [
        'Account and contact data, such as name and email address, used to authenticate you and to contact you about the service.',
        'Authentication and security data, such as one time codes (stored only as a salted hash), session identifiers (stored only as a hash), sign in times, IP address and user agent, used to sign you in, to prevent abuse and to keep an audit trail.',
        'Terms acceptance records, described in section 6 of this policy.',
        'Operational data such as service logs and error reports, used to keep the service working.',
      ],
    },
    {
      heading: '3. Legal bases',
      paragraphs: [
        'We rely on performance of a contract to create and manage your account and to provide the service, on our legitimate interests to secure the service and prevent abuse, and on your consent where we ask for it. Where you give consent, you can withdraw it at any time.',
        'Service messages about your account, security and the operation of the service are not marketing. We do not need marketing consent to send them, and you cannot opt out of the security ones while you hold an account.',
      ],
    },
    {
      heading: '4. Sharing and subprocessors',
      paragraphs: [
        'We share personal data only with service providers that help us run the platform, and only to the extent they need it. That currently includes a hosting provider for the application and database, and an email provider for authentication codes and service notifications. A current list of subprocessors is available on request.',
        'Each subprocessor is bound to confidentiality and security obligations at least as strict as ours, and takes no independent purpose in the data.',
        'We may disclose data where the law requires it, and we will tell you unless we are legally barred from doing so.',
      ],
    },
    {
      heading: '5. International transfers, retention and deletion',
      paragraphs: [
        'The service may store and process data on servers outside your country, including in the European Union and the United States. Where data moves from the European Economic Area or the United Kingdom, we put a lawful transfer mechanism in place, such as the standard contractual clauses.',
        'We keep account data while the account is open and for the period needed to meet legal, tax and audit obligations afterwards. We keep security logs for a limited period and then delete them. We do not keep personal data merely because it might be useful later.',
        'When you ask us to delete account data, or when an organisation ends its use of the service, we delete or return the data as the contract with that organisation requires, and remove it from backups on the ordinary cycle. Where the law requires retention, we say so.',
      ],
    },
    {
      heading: '6. Records of your agreement to these terms',
      paragraphs: [
        'When you tick the box to accept the Terms of Service and this policy, we record the user account it belongs to, the date and time, the version and the cryptographic hash of the exact documents you were shown, the wording of the checkbox, and your IP address and browser user agent.',
        'We keep those records as long as we need them to demonstrate that the agreement was properly formed, which may be longer than the account itself. This record is append only: an acceptance is never rewritten, and accepting a later version creates a new record rather than replacing the earlier one.',
      ],
    },
    {
      heading: '7. Your rights and how to use them',
      paragraphs: [
        `You can ask for a copy of your personal data, ask us to correct it, ask us to delete it, ask us to restrict how we use it, object to processing based on legitimate interests, and ask for a portable export. Write to ${CONTACT} and we will respond within the time the applicable law allows, generally within 30 days.`,
        'If you are a respondent in a survey, the organisation that collected your answers is the party that decides how they are used, and rights requests about those answers should go to that organisation first. We will assist it as its processor.',
        'If you are not satisfied with our response, you can complain to the Data Protection Board of India or, where the GDPR applies, to your local supervisory authority.',
      ],
    },
    {
      heading: '8. Security, children and contact',
      paragraphs: [
        'We protect personal data with measures appropriate to the risk, including access control, row level isolation between organisations, hashed credentials, single-use time limited invitation links and audit logging of administrative actions.',
        'The platform is not intended for use by children to create accounts. Where a survey gathers data from anyone under 18, the organisation running it must have the required consent from a parent or lawful guardian, and must configure the survey so that no tracking or behavioural monitoring of a child takes place.',
        `For any privacy question, request or complaint, contact ${CONTACT}.`,
      ],
    },
  ],
};

export const TERMS: LegalDocument = { ...termsBody, hash: hashOf(termsBody) };
export const PRIVACY: LegalDocument = { ...privacyBody, hash: hashOf(privacyBody) };

/** The wording shown beside the acceptance checkbox. Stored with each event. */
export const ACCEPTANCE_CHECKBOX_TEXT =
  'I have read and agree to the Terms of Service, and I acknowledge the Privacy Policy.';
