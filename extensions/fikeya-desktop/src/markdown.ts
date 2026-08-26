/*---------------------------------------------------------------------------------------------
 *  SPDX-License-Identifier: AGPL-3.0-or-later
 *  Copyright (C) 2026 Fikeya contributors
 *--------------------------------------------------------------------------------------------*/

import { escapeHtml } from './messageValidation';

export interface MarkdownActionLabels {
	readonly copy: string;
	readonly reviewDiff: string;
}

/**
 * Renders the small Markdown subset needed by provider answers without accepting raw HTML.
 * Links become validated host actions, and code remains text inside escaped code elements.
 */
export function renderSafeMarkdown(source: string, labels: MarkdownActionLabels): string {
	const chunks: string[] = [];
	const fence = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g;
	let cursor = 0;
	for (let match = fence.exec(source); match; match = fence.exec(source)) {
		chunks.push(renderTextBlocks(source.slice(cursor, match.index)));
		const language = normalizeLanguage(match[1]);
		const code = match[2].replace(/\r\n/g, '\n').replace(/\n$/, '');
		const review = language === 'diff' || language === 'patch'
			? `<button class="quiet" data-review-diff type="button">${escapeHtml(labels.reviewDiff)}</button>`
			: '';
		chunks.push(`<figure class="message-code"><figcaption><span>${escapeHtml(language || 'text')}</span><span class="message-code-actions">${review}<button class="quiet" data-copy-code type="button">${escapeHtml(labels.copy)}</button></span></figcaption><pre tabindex="0"><code data-code-language="${escapeHtml(language)}">${escapeHtml(code)}</code></pre></figure>`);
		cursor = match.index + match[0].length;
	}
	chunks.push(renderTextBlocks(source.slice(cursor)));
	return chunks.filter(Boolean).join('');
}

function renderTextBlocks(source: string): string {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const output: string[] = [];
	let paragraph: string[] = [];
	let list: string[] = [];
	const flushParagraph = () => {
		if (paragraph.length > 0) {
			output.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
			paragraph = [];
		}
	};
	const flushList = () => {
		if (list.length > 0) {
			output.push(`<ul>${list.map(item => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
			list = [];
		}
	};
	for (const line of lines) {
		const heading = /^(#{1,4})\s+(.+)$/.exec(line);
		const item = /^\s*[-*]\s+(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			const level = Math.min(4, heading[1].length + 2);
			output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
		} else if (item) {
			flushParagraph();
			list.push(item[1]);
		} else if (!line.trim()) {
			flushParagraph();
			flushList();
		} else {
			flushList();
			paragraph.push(line.trim());
		}
	}
	flushParagraph();
	flushList();
	return output.join('');
}

function renderInline(source: string): string {
	const tokens: string[] = [];
	const token = (html: string): string => {
		const marker = `\u0000${tokens.length}\u0000`;
		tokens.push(html);
		return marker;
	};
	let encoded = source
		.replace(/`([^`\n]+)`/g, (_whole, code: string) => token(`<code>${escapeHtml(code)}</code>`))
		.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_whole, label: string, target: string) => token(renderLink(label, target)));
	encoded = escapeHtml(encoded)
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
		.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
	return encoded.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => tokens[Number(index)] ?? '');
}

function renderLink(label: string, rawTarget: string): string {
	const target = rawTarget.trim();
	if (/^https:\/\/[^\s]+$/i.test(target)) {
		return `<button class="message-link" data-open-external="${escapeHtml(target)}" type="button">${escapeHtml(label)}</button>`;
	}
	if (isProjectRelativePath(target)) {
		return `<button class="message-link" data-open-file="${escapeHtml(target)}" type="button">${escapeHtml(label)}</button>`;
	}
	return escapeHtml(label);
}

function isProjectRelativePath(value: string): boolean {
	if (!value || value.length > 4096 || value.includes('\\') || value.startsWith('/') || /[:?#\u0000-\u001f]/.test(value)) {
		return false;
	}
	return value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..');
}

function normalizeLanguage(value: string): string {
	const language = value.trim().toLowerCase();
	return /^[a-z0-9_+.-]{1,32}$/.test(language) ? language : '';
}
