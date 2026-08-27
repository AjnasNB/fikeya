/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

export interface FikeyaImageInput {
	readonly name: string;
	readonly mimeType: FikeyaImageMimeType;
	readonly base64Data: string;
	readonly sizeBytes: number;
}

export type FikeyaImageMimeType = 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';

export const maximumImageCount = 4;
export const maximumImageBytes = 393_216;
export const maximumTotalImageBytes = 524_288;

const imageNamePattern = /^[^\\/\u0000-\u001f\u007f]{1,160}$/u;
const dataUrlPattern = /^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

/** Normalizes untrusted webview image data without retaining browser-owned data URLs. */
export function parseImageInputs(value: unknown): readonly FikeyaImageInput[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || value.length > maximumImageCount) {
		return undefined;
	}
	const images: FikeyaImageInput[] = [];
	let totalBytes = 0;
	for (const candidate of value) {
		if (!isRecord(candidate)
			|| Object.keys(candidate).some(key => !['dataUrl', 'name', 'sizeBytes'].includes(key))
			|| typeof candidate.name !== 'string'
			|| !imageNamePattern.test(candidate.name)
			|| typeof candidate.dataUrl !== 'string'
			|| candidate.dataUrl.length > (maximumImageBytes * 4 / 3) + 128
			|| typeof candidate.sizeBytes !== 'number'
			|| !Number.isSafeInteger(candidate.sizeBytes)
			|| candidate.sizeBytes < 1
			|| candidate.sizeBytes > maximumImageBytes) {
			return undefined;
		}
		const match = dataUrlPattern.exec(candidate.dataUrl);
		if (!match) {
			return undefined;
		}
		let decoded: Buffer;
		try {
			decoded = Buffer.from(match[2], 'base64');
		} catch {
			return undefined;
		}
		if (decoded.byteLength !== candidate.sizeBytes
			|| decoded.byteLength > maximumImageBytes
			|| decoded.toString('base64') !== match[2]) {
			return undefined;
		}
		totalBytes += decoded.byteLength;
		if (totalBytes > maximumTotalImageBytes) {
			return undefined;
		}
		images.push({
			name: candidate.name,
			mimeType: match[1] as FikeyaImageMimeType,
			base64Data: match[2],
			sizeBytes: decoded.byteLength
		});
	}
	return images;
}

export function isImageInputs(value: unknown): value is readonly FikeyaImageInput[] {
	if (!Array.isArray(value)) {
		return false;
	}
	return parseImageInputs(value.map(image => ({
		dataUrl: isRecord(image) ? `data:${String(image.mimeType)};base64,${String(image.base64Data)}` : '',
		name: isRecord(image) ? image.name : undefined,
		sizeBytes: isRecord(image) ? image.sizeBytes : undefined
	}))) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
