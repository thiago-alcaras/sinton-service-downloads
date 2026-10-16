import { cp, mkdir, rm, writeFile, copyFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.argv[2] || './vendor/sinton-service');
const destination = resolve(project, 'build-resources', 'sinton-service');
const allowed = resolve(project, 'build-resources') + sep;
if (!destination.startsWith(allowed)) throw new Error('Invalid service staging path.');
if (!(await stat(join(source, 'server', 'local-service.js'))).isFile()) throw new Error('Bundled Sinton Service sources are missing.');
if (!(await stat(join(project, 'service-runtime', 'node_modules'))).isDirectory()) throw new Error('Run npm ci --prefix service-runtime before preparing the service.');

await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'server'), { recursive: true });
await mkdir(join(destination, 'src'), { recursive: true });
await cp(join(source, 'server'), join(destination, 'server'), { recursive: true });
await copyFile(join(source, 'src', 'languages.js'), join(destination, 'src', 'languages.js'));
const dependencies = join(project, 'service-runtime', 'node_modules');
const bundledModules = join(destination, 'node_modules');
await cp(dependencies, bundledModules, {
  recursive: true,
  dereference: true,
  filter: sourcePath => resolve(sourcePath).toLowerCase() !== resolve(dependencies, 'ip').toLowerCase(),
});
await cp(join(project, 'service-runtime', 'vendor', 'ip-address-codec'), join(bundledModules, 'ip'), { recursive: true });
await writeFile(join(destination, 'package.json'), JSON.stringify({ type: 'module', private: true }));

const runtime = join(destination, 'runtime');
await mkdir(runtime, { recursive: true });
if (process.platform === 'win32') {
  await copyFile(process.execPath, join(runtime, 'node.exe'));
  const runtimeLicense = join(dirname(process.execPath), 'LICENSE');
  try { await copyFile(runtimeLicense, join(runtime, 'LICENSE.txt')); } catch {}
} else if (process.platform === 'darwin') {
  const nodeRoot = resolve(dirname(process.execPath), '..');
  await cp(nodeRoot, runtime, { recursive: true, dereference: true });
  await stat(join(runtime, 'bin', 'node'));
} else {
  throw new Error(`Unsupported build platform: ${process.platform}`);
}
console.log(`Prepared local playback service for ${process.platform}/${process.arch}.`);
