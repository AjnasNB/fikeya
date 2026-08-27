/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import path from 'path';
import fs from 'fs';
import es from 'event-stream';
import pickle from 'chromium-pickle-js';
import Filesystem from 'asar/lib/filesystem.js';
import VinylFile from 'vinyl';
import minimatch from 'minimatch';

export function createAsar(folderPath: string, unpackGlobs: string[], skipGlobs: string[], duplicateGlobs: string[], destFilename: string): NodeJS.ReadWriteStream {
	const archiveRoot = fs.realpathSync(folderPath);

	const getArchiveRelativePath = (file: VinylFile): string => {
		const normalized = file.relative.replace(/\\/g, '/');
		const nodeModulesMarker = 'node_modules/';
		const markerIndex = normalized.indexOf(nodeModulesMarker);
		const relative = markerIndex >= 0 ? normalized.substring(markerIndex + nodeModulesMarker.length) : normalized;
		const platformRelative = relative.split('/').join(path.sep);
		const resolved = path.resolve(archiveRoot, platformRelative);
		const rootRelative = path.relative(archiveRoot, resolved);
		if (!rootRelative || rootRelative === '..' || rootRelative.startsWith(`..${path.sep}`) || path.isAbsolute(rootRelative)) {
			throw new Error(`ASAR entry must stay within the archive root: ${file.relative}`);
		}
		return rootRelative;
	};

	const getMatchPath = (file: VinylFile): string => `node_modules/${getArchiveRelativePath(file).replace(/\\/g, '/')}`;

	const shouldUnpackFile = (file: VinylFile): boolean => {
		const matchPath = getMatchPath(file);
		for (let i = 0; i < unpackGlobs.length; i++) {
			if (minimatch(matchPath, unpackGlobs[i])) {
				return true;
			}
		}
		return false;
	};

	const shouldSkipFile = (file: VinylFile): boolean => {
		const matchPath = getMatchPath(file);
		for (const skipGlob of skipGlobs) {
			if (minimatch(matchPath, skipGlob)) {
				return true;
			}
		}
		return false;
	};

	// Files that should be duplicated between
	// node_modules.asar and node_modules
	const shouldDuplicateFile = (file: VinylFile): boolean => {
		const matchPath = getMatchPath(file);
		for (const duplicateGlob of duplicateGlobs) {
			if (minimatch(matchPath, duplicateGlob)) {
				return true;
			}
		}
		return false;
	};

	const filesystem = new Filesystem(archiveRoot);
	const out: Buffer[] = [];

	// Keep track of pending inserts
	let pendingInserts = 0;
	let onFileInserted = () => { pendingInserts--; };

	// Do not insert twice the same directory
	const seenDir: { [key: string]: boolean } = {};
	const insertDirectoryRecursive = (dir: string) => {
		if (path.resolve(dir) === archiveRoot) {
			return;
		}
		if (seenDir[dir]) {
			return;
		}

		insertDirectoryRecursive(path.dirname(dir));
		seenDir[dir] = true;
		filesystem.insertDirectory(dir);
	};

	const insertDirectoryForFile = (file: string) => {
		insertDirectoryRecursive(path.dirname(file));
	};

	const insertFile = (relativePath: string, stat: { size: number; mode: number }, shouldUnpack: boolean) => {
		insertDirectoryForFile(relativePath);
		pendingInserts++;
		// Do not pass `onFileInserted` directly because it gets overwritten below.
		// Create a closure capturing `onFileInserted`.
		filesystem.insertFile(relativePath, shouldUnpack, { stat: stat }, {}).then(() => onFileInserted(), () => onFileInserted());
	};

	return es.through(function (file) {
		if (file.stat.isDirectory()) {
			return;
		}
		if (!file.stat.isFile()) {
			throw new Error(`unknown item in stream!`);
		}
		if (shouldSkipFile(file)) {
			this.queue(new VinylFile({
				base: '.',
				path: file.path,
				stat: file.stat,
				contents: file.contents
			}));
			return;
		}
		if (shouldDuplicateFile(file)) {
			this.queue(new VinylFile({
				base: '.',
				path: file.path,
				stat: file.stat,
				contents: file.contents
			}));
		}
		const archiveRelativePath = getArchiveRelativePath(file);
		const archivePath = path.join(archiveRoot, archiveRelativePath);
		const shouldUnpack = shouldUnpackFile(file);
		insertFile(archivePath, { size: file.contents.length, mode: file.stat.mode }, shouldUnpack);

		if (shouldUnpack) {
			// The file goes outside of xx.asar, in a folder xx.asar.unpacked
			this.queue(new VinylFile({
				base: '.',
				path: path.join(destFilename + '.unpacked', archiveRelativePath),
				stat: file.stat,
				contents: file.contents
			}));
		} else {
			// The file goes inside of xx.asar
			out.push(file.contents);
		}
	}, function () {

		const finish = () => {
			{
				const headerPickle = pickle.createEmpty();
				headerPickle.writeString(JSON.stringify(filesystem.header));
				const headerBuf = headerPickle.toBuffer();

				const sizePickle = pickle.createEmpty();
				sizePickle.writeUInt32(headerBuf.length);
				const sizeBuf = sizePickle.toBuffer();

				out.unshift(headerBuf);
				out.unshift(sizeBuf);
			}

			const contents = Buffer.concat(out);
			out.length = 0;

			this.queue(new VinylFile({
				base: '.',
				path: destFilename,
				contents: contents
			}));
			this.queue(null);
		};

		// Call finish() only when all file inserts have finished...
		if (pendingInserts === 0) {
			finish();
		} else {
			onFileInserted = () => {
				pendingInserts--;
				if (pendingInserts === 0) {
					finish();
				}
			};
		}
	});
}
