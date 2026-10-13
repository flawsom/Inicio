import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { API_SCOPES } from '../src/platform/keys.js';

/**
 * The contract, held to the code rather than to a memory of the code.
 *
 * `specs/openapi.yaml` was documentation for a school API the server no longer
 * mounted: every path in it was dead, and nothing failed when that happened. This
 * test is the thing that fails instead. It reads the route registrations out of the
 * source — method and path, with the prefixes `app.ts` and `platform/index.ts`
 * actually mount — and compares them, both ways, with the operations in the
 * contract. A route added without its entry fails, and so does an entry kept after
 * its route is gone.
 *
 * It also pins the *machine* surface, which is the part a reader cannot check by
 * eye: `requireActor(req, { scope })` is deny-by-default, so a route is callable
 * with an API key only if it names a scope, and the contract must say the same. If
 * somebody wires another scope onto a route and forgets the contract (or marks a
 * route machine-callable that the code refuses), this is where it shows up.
 *
 * No database is involved: it is a text-and-YAML test, so it runs anywhere.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

/**
 * Where each route file is mounted. Kept explicit rather than derived, because
 * this list is the thing that must agree with `app.ts` and `platform/index.ts` —
 * it is small, and a mismatch is exactly what this test exists to catch.
 */
const SOURCES: Array<{ file: string; prefix: string }> = [
  { file: 'apps/api/src/routes/health.ts', prefix: '' },
  { file: 'apps/api/src/auth/routes.ts', prefix: '/auth' },
  { file: 'apps/api/src/platform/auth.ts', prefix: '/api/v1/auth' },
  { file: 'apps/api/src/platform/legal.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/terms.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/admin.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/orgs.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/forms.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/events.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/collect.ts', prefix: '/api/v1/collect' },
  { file: 'apps/api/src/platform/keys.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/webhooks/routes.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/flags.ts', prefix: '/api/v1' },
  { file: 'apps/api/src/platform/public.ts', prefix: '/api/v1' },
];

/**
 * The operations an API key may call, and the scope each one demands. This mirrors
 * the `requireActor(req, { scope })` calls in the source; the API suite proves the
 * behaviour, and this proves the contract describes it.
 */
const MACHINE_SURFACE: Array<{ operation: string; scope: string }> = [
  { operation: 'get /api/v1/forms', scope: 'forms:read' },
  { operation: 'get /api/v1/forms/{formId}', scope: 'forms:read' },
  { operation: 'get /api/v1/forms/{formId}/versions/{versionId}', scope: 'forms:read' },
  { operation: 'get /api/v1/forms/{formId}/xlsform', scope: 'forms:read' },
  { operation: 'get /api/v1/forms/{formId}/responses', scope: 'responses:read' },
  { operation: 'get /api/v1/forms/{formId}/analytics', scope: 'analytics:read' },
  { operation: 'get /api/v1/forms/{formId}/responses/export', scope: 'responses:export' },
  { operation: 'get /api/v1/orgs/{orgId}/flags', scope: 'flags:read' },
  { operation: 'patch /api/v1/orgs/{orgId}/flags/{flagId}', scope: 'flags:write' },
  { operation: 'post /api/v1/orgs/{orgId}/forms/{formId}/flags/scan', scope: 'flags:write' },
  { operation: 'post /api/v1/orgs/{orgId}/forms/{formId}/responses/{responseId}/flags', scope: 'flags:write' },
];

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

interface Operation {
  operation: string;
  /** The effective credential: what the operation declares, or the root default. */
  security: string[];
  summary: string | undefined;
  operationId: string | undefined;
  /** True when the operation declares `security: []`, which is how a route says "public". */
  declaredPublic: boolean;
  description: string;
}

/**
 * The unauthenticated surface, named rather than counted. A route that quietly became
 * public is the kind of change nobody notices in review, and it is the reason this
 * list exists: adding one here is a deliberate act with a line in a diff.
 */
const PUBLIC_SURFACE = [
  'get /health',
  'post /auth/otp/request',
  'post /auth/otp/verify',
  'post /auth/logout',
  'get /api/v1/legal/terms',
  'get /api/v1/legal/privacy',
  'get /api/v1/legal/acceptance',
  'post /api/v1/auth/otp/request',
  'post /api/v1/auth/otp/verify',
  'get /api/v1/auth/mail-status',
  'get /api/v1/auth/invite/{token}',
  'post /api/v1/auth/invite/redeem',
  'get /api/v1/collect/{token}',
  'post /api/v1/collect/{token}/responses',
  'get /api/v1/collect/{token}/responses/{responseId}',
  'patch /api/v1/collect/{token}/responses/{responseId}',
  'post /api/v1/collect/{token}/responses/{responseId}/submit',
  'get /api/v1/public/summary',
];

/** Every route the server actually registers, as `get /api/v1/forms/{formId}`. */
async function mountedOperations(): Promise<Set<string>> {
  const found = new Set<string>();
  for (const { file, prefix } of SOURCES) {
    const source = await readFile(join(repoRoot, file), 'utf8');
    // `app.get('/path', …)` and the multi-line form both match: \s covers newlines.
    for (const match of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) {
      const method = match[1] as string;
      const path = (match[2] as string).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      found.add(`${method} ${prefix}${path}`);
    }
  }
  return found;
}

interface Contract {
  document: { components?: { securitySchemes?: Record<string, unknown> } };
  /** The default credential from the root block, which an operation inherits. */
  globalSecurity: string[];
  operations: Map<string, Operation>;
}

/** Every operation the contract documents, in the same notation. */
async function readContract(): Promise<Contract> {
  const text = await readFile(join(repoRoot, 'specs/openapi.yaml'), 'utf8');
  const document = parse(text) as {
    security?: Array<Record<string, unknown>>;
    paths?: Record<string, Record<string, unknown>>;
    components?: { securitySchemes?: Record<string, unknown> };
  };
  const operations = new Map<string, Operation>();
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) {
      const raw = item[method] as
        | { security?: Array<Record<string, unknown>>; summary?: string; operationId?: string; description?: string }
        | undefined;
      if (!raw) continue;
      // `security: []` on an operation is how a public route says so explicitly; the
      // absence of the key means it inherits the root block, exactly as OpenAPI says.
      const declared = raw.security;
      operations.set(`${method} ${path}`, {
        operation: `${method} ${path}`,
        security: declared
          ? Object.keys(Object.assign({}, ...declared))
          : Object.keys(Object.assign({}, ...(document.security ?? []))),
        summary: raw.summary,
        operationId: raw.operationId,
        declaredPublic: declared !== undefined && declared.length === 0,
        description: raw.description ?? '',
      });
    }
  }
  return {
    document,
    globalSecurity: Object.keys(Object.assign({}, ...(document.security ?? []))),
    operations,
  };
}

describe('the API contract', () => {
  it('documents every route that is mounted, and nothing that is not', async () => {
    const mounted = await mountedOperations();
    const { operations: documented } = await readContract();

    const missing = [...mounted].filter((operation) => !documented.has(operation)).sort();
    const extra = [...documented.keys()].filter((operation) => !mounted.has(operation)).sort();

    // The message names the routes, because "the sets differ" is not actionable.
    expect(missing, `in the code but not in specs/openapi.yaml:\n${missing.join('\n')}`).toEqual([]);
    expect(extra, `in specs/openapi.yaml but not mounted:\n${extra.join('\n')}`).toEqual([]);
  });

  it('is machine-readable, and says which operations need no credential at all', async () => {
    const { operations, globalSecurity } = await readContract();

    // A generator needs something to name; a reader needs a sentence.
    const undocumented = [...operations.values()]
      .filter((operation) => !operation.summary || !operation.operationId)
      .map((operation) => operation.operation)
      .sort();
    expect(undocumented, `operations without a summary or an operationId:\n${undocumented.join('\n')}`).toEqual([]);

    // The root block is what makes every operation a session call by default. If it
    // were dropped, fifty operations would silently become public, so it is asserted
    // rather than assumed.
    expect(globalSecurity).toEqual(['cookieAuth']);

    // And the public surface is named, not counted: a route that becomes public is
    // exactly the change a reviewer would otherwise skim past.
    const publicOperations = [...operations.values()]
      .filter((operation) => operation.declaredPublic)
      .map((operation) => operation.operation)
      .sort();
    expect(publicOperations).toEqual([...PUBLIC_SURFACE].sort());
    const withoutCredential = [...operations.values()]
      .filter((operation) => operation.security.length === 0 && !operation.declaredPublic)
      .map((operation) => operation.operation);
    expect(withoutCredential).toEqual([]);
  });

  it('marks exactly the routes an API key may call, and names the scope each needs', async () => {
    const { operations: documented } = await readContract();
    const withKey = [...documented.values()]
      .filter((operation) => operation.security.includes('bearerApiKey'))
      .map((operation) => operation.operation)
      .sort();
    expect(withKey).toEqual(MACHINE_SURFACE.map((entry) => entry.operation).sort());

    for (const { operation, scope } of MACHINE_SURFACE) {
      const documentedOperation = documented.get(operation);
      expect(documentedOperation, `${operation} is missing from the contract`).toBeDefined();
      // A scope that is not stated is a scope an integrator has to read our source
      // to discover, which is the whole reason `insufficient_scope` names it.
      expect(documentedOperation?.description, `${operation} does not state ${scope}`).toContain(scope);
    }
  });

  it('uses one credential scheme per surface, and never invents a scope', async () => {
    const text = await readFile(join(repoRoot, 'specs/openapi.yaml'), 'utf8');
    const { document, operations } = await readContract();
    // Two schemes, because there are exactly two credentials a caller can present.
    // The distribution token is a **path parameter**, not a scheme: it is a bearer
    // token in the URL by design, and modelling `in: path` as a security scheme would
    // describe it as something a client can attach wherever it likes.
    expect(Object.keys(document.components?.securitySchemes ?? {}).sort()).toEqual(['bearerApiKey', 'cookieAuth']);

    // The token-scoped surface is `security: []`, so its authorisation has to be
    // visible in the parameters instead. A collect operation missing its `{token}`
    // parameter reads as an open endpoint, which is the one thing it is not.
    for (const operation of operations.keys()) {
      if (!operation.includes('/api/v1/collect/')) continue;
      const item = (parse(text) as { paths: Record<string, Record<string, { parameters?: unknown[] }>> }).paths[
        operation.split(' ')[1] as string
      ];
      const method = operation.split(' ')[0] as string;
      const parameters = JSON.stringify(item?.[method]?.parameters ?? []);
      expect(parameters, `${operation} does not document the {token} parameter`).toMatch(/Token|token/);
    }

    // The vocabulary in the contract is the vocabulary the API accepts, read from the
    // source rather than restated: a scope documented but not grantable would send an
    // integrator to `403 insufficient_scope` with no way to find out why, and a scope
    // in the code that the contract never mentions is a capability nobody can discover.
    for (const scope of API_SCOPES) expect(text, `the contract never mentions ${scope}`).toContain(scope);

    // Nothing scope-shaped that the API does not know about. Content types such as
    // `text/html` share the `word:word` shape, so this looks only at the namespaces
    // the scope vocabulary actually uses.
    const namespaces = ['forms', 'responses', 'analytics', 'flags', 'keys', 'webhooks'];
    const mentioned = new Set(
      (text.match(/[a-z]+:[a-z]+/g) ?? []).filter((token) => namespaces.includes(token.split(':')[0] as string)),
    );
    const unknown = [...mentioned].filter((token) => !(API_SCOPES as readonly string[]).includes(token)).sort();
    expect(unknown, `scope-shaped tokens the API does not define:\n${unknown.join('\n')}`).toEqual([]);
  });
});
