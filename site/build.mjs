import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(root, 'dist');
if (!output.startsWith(`${path.resolve(root)}${path.sep}`)) {
	throw new Error('Refusing to build outside the site directory.');
}

const publicFiles = [
	'_headers',
	'app.js',
	'favicon.svg',
	'fikeya-live-editor.png',
	'fikeya-live-editor-graph.png',
	'index.html',
	'robots.txt',
	'sitemap.xml',
	'site.webmanifest',
	'styles.css'
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all(publicFiles.map(file => copyFile(path.join(root, file), path.join(output, file))));
process.stdout.write(`Built ${publicFiles.length} public files in ${output}.\n`);
