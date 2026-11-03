import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  bindSemanticModel,
  collectPbirParts,
  DeployError,
  parseArgs,
  resolveConfig,
  validateArtifact,
} from './fabric-deploy.mjs';

const roots = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'inicio-fabric-'));
  roots.push(root);
  await mkdir(join(root, 'definition', 'pages'), { recursive: true });
  await writeFile(join(root, 'definition.pbir'), JSON.stringify({
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/1.0.0/schema.json',
    version: '1.0',
    datasetReference: { byPath: { path: '../Report.SemanticModel' } },
  }));
  await writeFile(join(root, 'definition', 'version.json'), '{"version":"1.0"}\n');
  await writeFile(join(root, 'definition', 'report.json'), '{"name":"report"}\n');
  await writeFile(join(root, 'definition', 'pages', 'pages.json'), '{"pageOrder":["page"]}\n');
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('the Fabric deployment command', () => {
  it('requires exactly one artifact and rejects mismatched update flags', () => {
    assert.throws(() => parseArgs([]), DeployError);
    assert.throws(() => parseArgs(['--pbix', 'a.pbix', '--pbir', 'a.Report']), DeployError);
    assert.throws(() => parseArgs(['--pbix', 'a.pbix', '--update']), DeployError);
    assert.throws(() => parseArgs(['--pbir', 'a.Report', '--overwrite']), DeployError);
    const parsed = parseArgs(['--pbir', 'a.Report', '--semantic-model', 'model-1', '--update', '--dry-run']);
    assert.equal(parsed.pbir, 'a.Report');
    assert.equal(parsed.semanticModel, 'model-1');
    assert.equal(parsed.update, true);
    assert.equal(parsed.dryRun, true);
  });

  it('does not require a secret until the command has an artifact and workspace', () => {
    const options = parseArgs(['--pbir', 'a.Report', '--workspace', 'workspace-1']);
    const config = resolveConfig(options, {
      FABRIC_TENANT_ID: 'tenant-1',
      FABRIC_CLIENT_ID: 'client-1',
      FABRIC_CLIENT_SECRET: 'secret-1',
    });
    assert.equal(config.workspace, 'workspace-1');
    assert.equal(config.mode, 'pbir');
    assert.equal(config.tenantId, 'tenant-1');
    assert.equal(config.clientSecret, 'secret-1');
    assert.throws(
      () => resolveConfig(options, { FABRIC_TENANT_ID: 'tenant-1', FABRIC_CLIENT_ID: 'client-1' }),
      /FABRIC_CLIENT_SECRET/,
    );
  });

  it('rewrites a Desktop byPath reference to the Fabric byConnection form', async () => {
    const root = await fixture();
    const config = {
      mode: 'pbir',
      artifact: root,
      workspace: 'workspace-1',
      name: 'Monitor',
      semanticModel: 'model-1',
      tenantId: 'tenant',
      clientId: 'client',
      clientSecret: 'secret',
    };
    const parts = await collectPbirParts(config);
    const pbirPart = parts.find((part) => part.path === 'definition.pbir');
    assert.ok(pbirPart);
    const parsed = JSON.parse(Buffer.from(pbirPart.payload, 'base64').toString('utf8'));
    assert.equal(parsed.datasetReference.byConnection.connectionString, 'semanticmodelid=model-1');
    assert.ok(parts.some((part) => part.path === '.platform'), 'a definition needs its platform metadata');
    assert.ok(parts.some((part) => part.path === 'definition/pages/pages.json'));
    const platform = JSON.parse(Buffer.from(parts.find((part) => part.path === '.platform').payload, 'base64').toString('utf8'));
    assert.equal(platform.metadata.displayName, 'Monitor');
  });

  it('ignores local Desktop cache and unrelated files when packaging a report', async () => {
    const root = await fixture();
    await mkdir(join(root, '.pbi'), { recursive: true });
    await writeFile(join(root, '.pbi', 'cache.abf'), 'local cache');
    await writeFile(join(root, 'README.md'), 'not a report part');
    await writeFile(join(root, '.platform'), JSON.stringify({
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
      metadata: { type: 'Report', displayName: 'Old name' },
      config: { version: '2.0', logicalId: '00000000-0000-4000-8000-000000000000' },
    }));
    const parts = await collectPbirParts({
      mode: 'pbir',
      artifact: root,
      workspace: 'workspace-1',
      name: 'Monitor',
      semanticModel: 'model-1',
    });
    const paths = parts.map((part) => part.path);
    assert.ok(!paths.includes('.pbi/cache.abf'));
    assert.ok(!paths.includes('README.md'));
    const platform = JSON.parse(Buffer.from(parts.find((part) => part.path === '.platform').payload, 'base64').toString('utf8'));
    assert.equal(platform.metadata.displayName, 'Monitor');
    assert.equal(platform.config.logicalId, '00000000-0000-4000-8000-000000000000');
  });

  it('packages the legacy report.json form and refuses a mixed-format folder', async () => {
    const root = await fixture();
    await rm(join(root, 'definition'), { recursive: true, force: true });
    await writeFile(join(root, 'report.json'), '{"name":"legacy"}\n');
    const config = {
      mode: 'pbir',
      artifact: root,
      workspace: 'workspace-1',
      name: 'Monitor',
      semanticModel: 'model-1',
    };
    const legacy = await collectPbirParts(config);
    assert.ok(legacy.some((part) => part.path === 'report.json'));
    assert.ok(!legacy.some((part) => part.path.startsWith('definition/')));

    await mkdir(join(root, 'definition'), { recursive: true });
    await writeFile(join(root, 'definition', 'report.json'), '{"name":"enhanced"}\n');
    await assert.rejects(() => collectPbirParts(config), /both PBIR and PBIR-Legacy/);
  });

  it('refuses a definition that has no semantic model to bind to', () => {
    assert.throws(() => bindSemanticModel({ datasetReference: { byPath: { path: '../model' } } }, ''), /semantic-model/);
    const bound = bindSemanticModel({ datasetReference: { byConnection: { connectionString: 'semanticmodelid=model-1' } } }, '');
    assert.equal(bound.datasetReference.byConnection.connectionString, 'semanticmodelid=model-1');
  });

  it('restores the published definition.pbir schema that Desktop 2.158 omits on save', () => {
    const bound = bindSemanticModel(
      {
        version: '4.0',
        datasetReference: { byConnection: { connectionString: 'semanticmodelid=model-1' } },
      },
      '',
    );
    assert.equal(
      bound.$schema,
      'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
    );
    assert.equal(bound.version, '4.0');

    const kept = bindSemanticModel(
      {
        $schema: 'https://example.test/older.json',
        datasetReference: { byConnection: { connectionString: 'semanticmodelid=model-1' } },
      },
      '',
    );
    assert.equal(kept.$schema, 'https://example.test/older.json');
  });

  it('validates a PBIX without opening a network connection', async () => {
    const root = await fixture();
    const pbix = join(root, 'report.pbix');
    await writeFile(pbix, 'not-a-real-pbix');
    const config = {
      mode: 'pbix',
      artifact: pbix,
      workspace: 'workspace-1',
      name: '',
      semanticModel: '',
      tenantId: 'tenant',
      clientId: 'client',
      clientSecret: 'secret',
    };
    const report = await validateArtifact(config);
    assert.equal(report.mode, 'pbix');
    assert.equal(report.name, 'report');
    assert.equal(report.files, 1);
  });
});
