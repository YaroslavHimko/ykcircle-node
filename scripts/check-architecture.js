import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = (await readdir(path.join(root, 'src'), { recursive: true }))
  .filter((file) => file.endsWith('.js'))
  .map((file) => `src/${file.replaceAll('\\', '/')}`);
const known = new Set(files);
const graph = new Map();
const errors = [];

if ((await readdir(root)).includes('server')) {
  errors.push(
    'Remove the legacy server directory; source belongs in src/ and legal content in resources/legal-documents/.',
  );
}

// Outer layers may coordinate inner layers; inner layers never import startup or HTTP code.
const allowedLayers = {
  application: ['application', 'api', 'configuration', 'database', 'services', 'domain', 'utils'],
  api: ['api', 'database', 'services', 'domain', 'utils'],
  configuration: ['configuration', 'utils'],
  database: ['database', 'domain', 'utils'],
  services: ['services', 'database', 'domain', 'utils'],
  domain: ['domain', 'utils'],
  utils: ['utils'],
};
const adapterLayers = {
  express: 'api',
  cors: 'api',
  multer: 'api',
  mysql2: 'database',
  nodemailer: 'services',
  'basic-ftp': 'services',
  stripe: 'services',
};

function inspect(node, imports) {
  if (!node || typeof node !== 'object') return;
  if (
    [
      'ImportDeclaration',
      'ExportNamedDeclaration',
      'ExportAllDeclaration',
      'ImportExpression',
    ].includes(node.type) &&
    typeof node.source?.value === 'string'
  )
    imports.push(node.source.value);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach((value) => inspect(value, imports));
    else if (child?.type) inspect(child, imports);
  }
}

for (const file of files) {
  const layer = file.split('/')[1];
  if (!Object.hasOwn(allowedLayers, layer)) errors.push(`${file}: unknown source layer ${layer}`);
  if (file.endsWith('.routes.js') && !file.startsWith('src/api/routes/'))
    errors.push(`${file}: route modules belong in src/api/routes`);
  if (file.endsWith('.repository.js') && !file.startsWith('src/database/repositories/'))
    errors.push(`${file}: repositories belong in src/database/repositories`);
  const source = await readFile(path.join(root, file), 'utf8');
  const imports = [];
  inspect(parse(source, { sourceType: 'module', ecmaVersion: 'latest' }), imports);
  const dependencies = [];
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) {
      const packageName = specifier.split('/')[0];
      const expectedLayer = adapterLayers[packageName];
      if (expectedLayer && layer !== expectedLayer)
        errors.push(`${file}: ${packageName} belongs in the ${expectedLayer} layer`);
      continue;
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    if (target === 'src/application/main.js')
      errors.push(
        `${file}: do not import the executable entry point; use application modules directly`,
      );
    if (!known.has(target)) errors.push(`${file}: unresolved source import ${specifier}`);
    else dependencies.push(target);
    const targetLayer = target.split('/')[1];
    if (!allowedLayers[layer]?.includes(targetLayer))
      errors.push(`${file}: ${layer} must not import ${targetLayer} (${specifier})`);
    if (
      layer === 'api' &&
      targetLayer === 'database' &&
      !target.startsWith('src/database/repositories/')
    )
      errors.push(
        `${file}: inject database connections; API code may import repository functions only`,
      );
  }
  graph.set(file, dependencies);
}

const visited = new Set();
const visiting = new Set();
function visit(file, stack = []) {
  if (visiting.has(file)) {
    errors.push(`Circular import: ${[...stack, file].join(' -> ')}`);
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  for (const target of graph.get(file) || []) visit(target, [...stack, file]);
  visiting.delete(file);
  visited.add(file);
}
files.forEach((file) => visit(file));
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed for ${files.length} source modules.`);
}
