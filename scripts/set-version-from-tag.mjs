import { readFile, writeFile } from 'node:fs/promises';

const tag = process.env.GITHUB_REF_NAME || '';
const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
if (!match) throw new Error(`Expected a release tag like v1.2.3, received: ${tag || '(empty)'}`);

for (const file of ['package.json', 'package-lock.json']) {
  const document = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  document.version = match[1];
  if (file === 'package-lock.json' && document.packages?.['']) document.packages[''].version = match[1];
  await writeFile(new URL(`../${file}`, import.meta.url), `${JSON.stringify(document, null, 2)}\n`);
}
