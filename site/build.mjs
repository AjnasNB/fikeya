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
	'fikeya-desktop-beta-agent.jpg',
	'fikeya-desktop-beta-editor.jpg',
	'fikeya-desktop-beta-graph.jpg',
	'fikeya-desktop-beta-review.jpg',
	'fikeya-desktop-beta-terminal.jpg',
	'fikeya-desktop-editor.png',
	'fikeya-desktop-memory.png',
	'fikeya-live-editor-graph.png',
	'fikeya-live-editor.png',
	'fikeya-live-graph.png',
	'fikeya-live-site.png',
	'index.html',
	'qarinah-standalone-graph.png',
	'robots.txt',
	'sitemap.xml',
	'site.webmanifest',
	'styles.css'
];

const fontFiles = [
	['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2', 'ibm-plex-sans-400.woff2'],
	['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-500-normal.woff2', 'ibm-plex-sans-500.woff2'],
	['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-600-normal.woff2', 'ibm-plex-sans-600.woff2'],
	['@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-700-normal.woff2', 'ibm-plex-sans-700.woff2'],
	['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'ibm-plex-mono-400.woff2'],
	['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', 'ibm-plex-mono-500.woff2'],
	['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2', 'ibm-plex-mono-600.woff2']
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await mkdir(path.join(output, 'fonts'), { recursive: true });
await Promise.all([
	...publicFiles.map(file => copyFile(path.join(root, file), path.join(output, file))),
	...fontFiles.map(([source, destination]) => copyFile(
		path.join(root, 'node_modules', source),
		path.join(output, 'fonts', destination)
	))
]);
process.stdout.write(`Built ${publicFiles.length} public files and ${fontFiles.length} fonts in ${output}.\n`);
