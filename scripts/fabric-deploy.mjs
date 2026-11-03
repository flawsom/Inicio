#!/usr/bin/env node
/**
 * Publish a real Power BI report to a Fabric workspace.
 *
 * This is deliberately a command rather than a button. A browser must never hold
 * the client secret that can write to an organisation's workspace, and a deploy
 * that a reader can trigger from a report screen is a deploy nobody reviewed.
 *
 * Two supported artifacts, because Microsoft supports two different operations:
 *
 *   --pbix  A model-bearing report saved by Power BI Desktop. The Power BI
 *           Imports API uploads the file and returns the semantic model and the
 *           report. This is the path that produces a working, modelled report.
 *   --pbir  A Power BI project report folder exported by Desktop, deployed as a
 *           Fabric report definition. The report must reference an existing
 *           semantic model, because the Fabric Create Report API does not import
 *           a model.
 *
 * This file does not create a PBIX. Microsoft does not support generating or
 * converting a model-bearing PBIX programmatically outside Power BI Desktop.
 * Pretending otherwise would produce a file that cannot open. See
 * docs/POWER-BI.md for the boundary and the prerequisites.
 *
 * Usage:
 *   pnpm fabric:deploy -- --pbix ./report.pbix --workspace <id> --dry-run
 *   pnpm fabric:deploy -- --pbix ./report.pbix --workspace <id>
 *   pnpm fabric:deploy -- --pbir ./MyReport.Report --semantic-model <id> --update
 *
 * Environment:
 *   FABRIC_TENANT_ID
 *   FABRIC_CLIENT_ID
 *   FABRIC_CLIENT_SECRET
 *   FABRIC_WORKSPACE_ID       fallback for --workspace
 *   FABRIC_SEMANTIC_MODEL_ID  fallback for --semantic-model
 *
 * Never put the client secret in a command line or a browser bundle. The shell
 * environment in this workspace is loaded from `.env.local` by the platform; in
 * a normal CI it comes from the secret store.
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = `Publish a Power BI report to a Fabric workspace.

Usage:
  pnpm fabric:deploy -- --pbix <file.pbix> [options]
  pnpm fabric:deploy -- --pbir <report.Report> [options]

Options:
  --workspace <id>         Fabric workspace id (or FABRIC_WORKSPACE_ID)
  --name <name>            item display name (defaults to the artifact name)
  --semantic-model <id>    semantic model id for a PBIR report
                           (or FABRIC_SEMANTIC_MODEL_ID)
  --update                 update the existing report with --name (PBIR only)
  --overwrite              overwrite a dataset with the same name (PBIX only)
  --dry-run                validate the artifact and configuration, no network
  --help                   print this text

Required environment:
  FABRIC_TENANT_ID
  FABRIC_CLIENT_ID
  FABRIC_CLIENT_SECRET

The command never prints the client secret or an access token.
`;

const FABRIC_HOST = 'https://api.fabric.microsoft.com';
const POWER_BI_HOST = 'https://api.powerbi.com';
const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
// The Power BI REST API is exposed by the analysis.windows.net resource, not by
// the api.powerbi.com hostname. Requesting the hostname as a scope fails token
// acquisition before the import is even attempted.
const POWER_BI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';
const OPERATION_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 2_000;
// Power BI Desktop 2.158 writes definition.pbir without $schema after a save.
// Fabric rejects that shell file even though the files inside definition/ keep
// theirs, so the deploy command restores the published schema before upload.
const PBIR_SCHEMA =
  'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json';

export class DeployError extends Error {
  constructor(message, code = 'fabric_deploy_failed') {
    super(message);
    this.name = 'DeployError';
    this.code = code;
  }
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new DeployError(`${flag} needs a value`, 'usage');
  return value;
}

/** Parse only the arguments this command owns; unknown flags are an error, not ignored. */
export function parseArgs(argv) {
  const options = {
    pbix: null,
    pbir: null,
    workspace: null,
    name: null,
    semanticModel: null,
    update: false,
    overwrite: false,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const [flag, inline] = raw.includes('=') ? raw.split(/=(.*)/s, 2) : [raw, undefined];
    const take = () => inline ?? valueAfter(argv, index++, flag);
    switch (flag) {
      case '--':
        // pnpm forwards a literal separator for `pnpm fabric:deploy -- ...`.
        break;
      case '--pbix':
        if (options.pbix) throw new DeployError('--pbix was given more than once', 'usage');
        options.pbix = take();
        break;
      case '--pbir':
        if (options.pbir) throw new DeployError('--pbir was given more than once', 'usage');
        options.pbir = take();
        break;
      case '--workspace':
        options.workspace = take();
        break;
      case '--name':
        options.name = take();
        break;
      case '--semantic-model':
        options.semanticModel = take();
        break;
      case '--update':
        options.update = true;
        break;
      case '--overwrite':
        options.overwrite = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new DeployError(`unknown option ${raw}. Run with --help.`, 'usage');
    }
  }
  if (options.help) return options;
  if (options.pbix && options.pbir) throw new DeployError('choose --pbix or --pbir, not both', 'usage');
  if (!options.pbix && !options.pbir) throw new DeployError('one of --pbix or --pbir is required', 'usage');
  if (options.pbix && options.update) throw new DeployError('--update is for --pbir; use --overwrite for a PBIX', 'usage');
  if (options.pbir && options.overwrite) throw new DeployError('--overwrite is for --pbix; use --update for a PBIR report', 'usage');
  return options;
}

function required(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new DeployError(`${key} is not set`, 'configuration');
  return value;
}

/** Resolve the command into a complete, checkable plan without making a request. */
export function resolveConfig(options, env = process.env) {
  const workspace = options.workspace?.trim() || env.FABRIC_WORKSPACE_ID?.trim() || '';
  if (!workspace) throw new DeployError('--workspace or FABRIC_WORKSPACE_ID is required', 'configuration');
  const semanticModel = options.semanticModel?.trim() || env.FABRIC_SEMANTIC_MODEL_ID?.trim() || '';
  return {
    mode: options.pbix ? 'pbix' : 'pbir',
    artifact: resolve(options.pbix ?? options.pbir),
    workspace,
    name: options.name?.trim() || '',
    semanticModel,
    update: options.update,
    overwrite: options.overwrite,
    dryRun: options.dryRun,
    tenantId: required(env, 'FABRIC_TENANT_ID'),
    clientId: required(env, 'FABRIC_CLIENT_ID'),
    clientSecret: required(env, 'FABRIC_CLIENT_SECRET'),
  };
}

function defaultName(config) {
  if (config.name) return config.name;
  const base = basename(config.artifact);
  return config.mode === 'pbix' ? base.replace(/\.pbix$/i, '') : base.replace(/\.Report$/i, '');
}

function relativePart(root, path) {
  return relative(root, path).split(sep).join('/');
}

/** Only the parts a report definition is allowed to carry are uploaded. */
function isReportPart(path) {
  return (
    path === 'definition.pbir' ||
    path === '.platform' ||
    path === 'report.json' ||
    path === 'semanticModelDiagramLayout.json' ||
    path.startsWith('definition/') ||
    path.startsWith('StaticResources/')
  );
}

async function walk(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/**
 * A PBIR report tells Fabric which semantic model to bind to. The byPath form
 * that Desktop writes beside a sibling `.SemanticModel` cannot be resolved in a
 * workspace, so it is rewritten to the documented byConnection form. If the
 * caller supplied a semantic model id, it wins: that is the explicit target.
 */
export function bindSemanticModel(pbir, semanticModel) {
  if (!pbir || typeof pbir !== 'object' || Array.isArray(pbir)) {
    throw new DeployError('definition.pbir must contain a JSON object', 'artifact');
  }
  const normalized = pbir.$schema ? pbir : { ...pbir, $schema: PBIR_SCHEMA };
  if (semanticModel) {
    return {
      ...normalized,
      datasetReference: {
        byConnection: { connectionString: `semanticmodelid=${semanticModel}` },
      },
    };
  }
  const connection = pbir?.datasetReference?.byConnection?.connectionString;
  if (typeof connection !== 'string' || !/semanticmodelid=/i.test(connection)) {
    throw new DeployError(
      'the PBIR definition.pbir has no byConnection semantic model reference. Pass --semantic-model or set FABRIC_SEMANTIC_MODEL_ID.',
      'semantic_model_missing',
    );
  }
  return normalized;
}

/** Read a PBIR folder into the base64 parts the Fabric definition API accepts. */
export async function collectPbirParts(config) {
  const info = await stat(config.artifact).catch(() => null);
  if (!info?.isDirectory()) throw new DeployError(`PBIR folder not found: ${config.artifact}`, 'artifact');

  const files = await walk(config.artifact);
  const pbirFile = files.find((file) => relativePart(config.artifact, file) === 'definition.pbir');
  if (!pbirFile) {
    throw new DeployError('the PBIR folder has no definition.pbir at its root', 'artifact');
  }
  let pbir;
  try {
    pbir = JSON.parse(await readFile(pbirFile, 'utf8'));
  } catch {
    throw new DeployError('definition.pbir is not valid JSON', 'artifact');
  }
  const partPaths = files.map((file) => relativePart(config.artifact, file));
  const hasDefinition = partPaths.some((path) => path.startsWith('definition/'));
  const hasLegacy = partPaths.includes('report.json');
  if (!hasDefinition && !hasLegacy) {
    throw new DeployError('the report has neither a definition/ folder nor a report.json', 'artifact');
  }
  if (hasDefinition && hasLegacy) {
    throw new DeployError('the report has both PBIR and PBIR-Legacy definitions; remove one before deploying', 'artifact');
  }

  const bound = bindSemanticModel(pbir, config.semanticModel);
  const name = defaultName(config);
  const parts = [];
  let platformPart = null;
  for (const file of files) {
    const path = relativePart(config.artifact, file);
    if (!isReportPart(path) || path === 'definition.pbir') continue;
    let payload;
    if (path === '.platform') {
      let platform;
      try {
        platform = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        throw new DeployError('.platform is not valid JSON', 'artifact');
      }
      if (!platform || typeof platform !== 'object' || Array.isArray(platform)) {
        throw new DeployError('.platform must contain a JSON object', 'artifact');
      }
      const metadata = platform.metadata && typeof platform.metadata === 'object' ? platform.metadata : {};
      if (metadata.type && metadata.type !== 'Report') {
        throw new DeployError(`.platform describes a ${metadata.type}, not a Report`, 'artifact');
      }
      platform.metadata = { ...metadata, type: 'Report', displayName: name };
      payload = Buffer.from(JSON.stringify(platform, null, 2));
      platformPart = path;
    } else {
      payload = await readFile(file);
    }
    parts.push({ path, payloadType: 'InlineBase64', payload: payload.toString('base64') });
  }
  parts.push({
    path: 'definition.pbir',
    payloadType: 'InlineBase64',
    payload: Buffer.from(JSON.stringify(bound, null, 2)).toString('base64'),
  });
  if (!platformPart) {
    const platform = {
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
      metadata: { type: 'Report', displayName: name },
      config: { version: '2.0', logicalId: randomUUID() },
    };
    parts.push({
      path: '.platform',
      payloadType: 'InlineBase64',
      payload: Buffer.from(JSON.stringify(platform, null, 2)).toString('base64'),
    });
  }
  return parts;
}

export async function validateArtifact(config) {
  const info = await stat(config.artifact).catch(() => null);
  if (!info) throw new DeployError(`artifact not found: ${config.artifact}`, 'artifact');
  if (config.mode === 'pbix') {
    if (!info.isFile()) throw new DeployError('--pbix must name a file', 'artifact');
    if (extname(config.artifact).toLowerCase() !== '.pbix') {
      throw new DeployError('--pbix must name a .pbix file', 'artifact');
    }
    return { mode: 'pbix', files: 1, parts: 0, bytes: info.size, name: defaultName(config) };
  }
  if (!info.isDirectory()) throw new DeployError('--pbir must name a report folder', 'artifact');
  const parts = await collectPbirParts(config);
  return { mode: 'pbir', files: parts.length, parts: parts.length, bytes: parts.reduce((sum, part) => sum + Buffer.byteLength(part.payload, 'base64'), 0), name: defaultName(config) };
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function serviceMessage(body) {
  if (!body) return '';
  const detail =
    body.error_description ??
    body.error?.message ??
    body.error?.code ??
    body.message ??
    body.errorCode ??
    (typeof body.error === 'string' ? body.error : '');
  return detail ? `: ${detail}` : '';
}

async function tokenFor(config, scope) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope,
  });
  const response = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(30_000),
    },
  );
  const parsed = await readBody(response);
  if (!response.ok || !parsed?.access_token) {
    throw new DeployError(`Entra refused the service principal${serviceMessage(parsed)}`, 'auth');
  }
  return parsed.access_token;
}

async function api(token, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = await readBody(response);
  if (response.status === 401) throw new DeployError('The service rejected the token. Check the tenant and the service principal permissions.', 'unauthorized');
  if (response.status === 403) {
    throw new DeployError(
      `The service refused the service principal${serviceMessage(parsed)}. Add it to the workspace as Contributor or Member, grant the permission for this step (including Workspace.Read for an --update lookup), and enable the tenant settings in docs/POWER-BI.md.`,
      'forbidden',
    );
  }
  if (!response.ok && response.status !== 202) {
    throw new DeployError(`The service answered ${response.status}${serviceMessage(parsed)}`, 'http');
  }
  return { response, body: parsed };
}

function retryDelay(response) {
  const raw = response.headers.get('retry-after');
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, seconds * 1000) : POLL_MS;
}

async function waitForFabricOperation(token, operationId, initialResponse) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let response = initialResponse;
  let body = null;
  for (;;) {
    const result = await api(token, 'GET', `${FABRIC_HOST}/v1/operations/${encodeURIComponent(operationId)}`);
    response = result.response;
    body = result.body;
    if (response.status === 200) {
      if (body?.status === 'Succeeded') return body;
      if (body?.status === 'Failed') {
        throw new DeployError(`Fabric operation failed${serviceMessage(body)}`, 'operation');
      }
    }
    if (Date.now() >= deadline) throw new DeployError('Fabric operation did not finish within 10 minutes', 'timeout');
    await new Promise((resolveSleep) => setTimeout(resolveSleep, retryDelay(response)));
  }
}

async function findReport(token, workspace, name) {
  let continuationToken = '';
  do {
    const query = new URLSearchParams({ type: 'Report', recursive: 'true' });
    if (continuationToken) query.set('continuationToken', continuationToken);
    const { body } = await api(
      token,
      'GET',
      `${FABRIC_HOST}/v1/workspaces/${encodeURIComponent(workspace)}/items?${query.toString()}`,
    );
    const found = (body?.value ?? []).find((item) => item.type === 'Report' && item.displayName === name);
    if (found) return found;
    continuationToken = body?.continuationToken ?? '';
  } while (continuationToken);
  return null;
}

async function deployPbir(config, token) {
  const parts = await collectPbirParts(config);
  const name = defaultName(config);
  const existing = config.update ? await findReport(token, config.workspace, name) : null;
  if (config.update && !existing) {
    throw new DeployError(`no report named "${name}" exists in workspace ${config.workspace}`, 'not_found');
  }
  const url = existing
    ? `${FABRIC_HOST}/v1/workspaces/${encodeURIComponent(config.workspace)}/items/${encodeURIComponent(existing.id)}/updateDefinition?updateMetadata=true`
    : `${FABRIC_HOST}/v1/workspaces/${encodeURIComponent(config.workspace)}/reports`;
  const payload = existing ? { definition: { parts } } : { displayName: name, definition: { parts } };
  const { response, body } = await api(token, 'POST', url, payload);
  let completed = null;
  if (response.status === 202) {
    const operationId = response.headers.get('x-ms-operation-id');
    if (!operationId) throw new DeployError('Fabric accepted the deployment but returned no operation id', 'operation');
    await waitForFabricOperation(token, operationId, response);
    // The accepted response names the operation, not the item. The result
    // endpoint is where a create operation hands back the new report id.
    try {
      completed = (
        await api(token, 'GET', `${FABRIC_HOST}/v1/operations/${encodeURIComponent(operationId)}/result`)
      ).body;
    } catch {
      // An update can legitimately return no result body. The existing item is
      // still the report that was updated, so the id is not lost.
    }
  }
  const report = existing ?? completed ?? body;
  const id = report?.id ?? existing?.id;
  console.log(`published ${name} to workspace ${config.workspace}`);
  if (id) console.log(`report id: ${id}`);
  if (id) console.log(`open: https://app.fabric.microsoft.com/groups/${encodeURIComponent(config.workspace)}/reports/${encodeURIComponent(id)}`);
  return id;
}

async function waitForPowerBiImport(token, workspace, importId) {
  const deadline = Date.now() + OPERATION_TIMEOUT_MS;
  let response;
  for (;;) {
    const result = await api(
      token,
      'GET',
      `${POWER_BI_HOST}/v1.0/myorg/groups/${encodeURIComponent(workspace)}/imports/${encodeURIComponent(importId)}`,
    );
    response = result.response;
    const state = result.body?.importState ?? result.body?.state;
    if (state && !['Publishing', 'InProgress', 'Accepted'].includes(state)) {
      if (state !== 'Succeeded') {
        throw new DeployError(`Power BI import ended ${state}${serviceMessage(result.body)}`, 'import');
      }
      return result.body;
    }
    if (Date.now() >= deadline) throw new DeployError('Power BI import did not finish within 10 minutes', 'timeout');
    await new Promise((resolveSleep) => setTimeout(resolveSleep, retryDelay(response)));
  }
}

async function deployPbix(config, token) {
  const name = defaultName(config);
  const query = new URLSearchParams({
    datasetDisplayName: name,
    nameConflict: config.overwrite ? 'Overwrite' : 'Abort',
  });
  const form = new FormData();
  form.append('file', new Blob([await readFile(config.artifact)], { type: 'application/octet-stream' }), basename(config.artifact));
  const response = await fetch(
    `${POWER_BI_HOST}/v1.0/myorg/groups/${encodeURIComponent(config.workspace)}/imports?${query.toString()}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    },
  );
  const created = await readBody(response);
  if (!response.ok) {
    throw new DeployError(`Power BI answered ${response.status}${serviceMessage(created)}`, 'import');
  }
  if (!created?.id) throw new DeployError('Power BI accepted the file but returned no import id', 'import');
  const result = await waitForPowerBiImport(token, config.workspace, created.id);
  const reports = result?.reports ?? [];
  console.log(`imported ${basename(config.artifact)} into workspace ${config.workspace}`);
  for (const report of reports) {
    console.log(`report: ${report.name}${report.id ? ` (${report.id})` : ''}`);
    if (report.webUrl) console.log(`open: ${report.webUrl}`);
  }
  if (reports.length === 0) {
    console.log('the import succeeded but returned no report. A PBIT or a model-only file does not create one.');
  }
}

export async function deploy(config) {
  const report = await validateArtifact(config);
  if (config.dryRun) {
    console.log('dry run: no request was made');
    console.log(`mode: ${report.mode}`);
    console.log(`artifact: ${config.artifact}`);
    console.log(`name: ${report.name}`);
    console.log(`workspace: ${config.workspace}`);
    console.log(`files: ${report.files}`);
    console.log(`definition parts: ${report.parts}`);
    console.log(`semantic model: ${config.semanticModel || '(from definition.pbir)'}`);
    console.log(`action: ${config.update ? 'update existing report' : config.overwrite ? 'import and overwrite' : 'create'}`);
    return;
  }
  const token = await tokenFor(config, config.mode === 'pbix' ? POWER_BI_SCOPE : FABRIC_SCOPE);
  if (config.mode === 'pbix') await deployPbix(config, token);
  else await deployPbir(config, token);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const config = resolveConfig(options, env);
  await deploy(config);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`fabric-deploy: ${message}`);
    if (error instanceof DeployError && error.code === 'usage') console.error('run `pnpm fabric:deploy -- --help`');
    process.exitCode = 1;
  });
}
