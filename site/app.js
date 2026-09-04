const tabs = Array.from(document.querySelectorAll('[data-layout-tab]'));
const panels = Array.from(document.querySelectorAll('[data-layout-panel]'));

const selectLayout = selectedTab => {
	const layout = selectedTab.dataset.layoutTab;

	for (const tab of tabs) {
		const isSelected = tab === selectedTab;
		tab.setAttribute('aria-selected', String(isSelected));
		tab.tabIndex = isSelected ? 0 : -1;
	}

	for (const panel of panels) {
		panel.hidden = panel.dataset.layoutPanel !== layout;
	}
};

for (const tab of tabs) {
	tab.addEventListener('click', () => selectLayout(tab));
	tab.addEventListener('keydown', event => {
		const currentIndex = tabs.indexOf(tab);
		let nextIndex = currentIndex;

		if (event.key === 'ArrowRight') {
			nextIndex = (currentIndex + 1) % tabs.length;
		} else if (event.key === 'ArrowLeft') {
			nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
		} else if (event.key === 'Home') {
			nextIndex = 0;
		} else if (event.key === 'End') {
			nextIndex = tabs.length - 1;
		} else {
			return;
		}

		event.preventDefault();
		selectLayout(tabs[nextIndex]);
		tabs[nextIndex].focus();
	});
}

const providerItems = Array.from(document.querySelectorAll('.provider-item'));
const providerDetail = {
	model: document.querySelector('#provider-model'),
	storage: document.querySelector('#provider-storage'),
	usage: document.querySelector('#provider-usage'),
	fallback: document.querySelector('#provider-fallback')
};

for (const item of providerItems) {
	item.addEventListener('click', () => {
		for (const candidate of providerItems) {
			const isActive = candidate === item;
			candidate.classList.toggle('active', isActive);
			candidate.setAttribute('aria-pressed', String(isActive));
		}

		for (const [key, target] of Object.entries(providerDetail)) {
			if (target) {
				target.textContent = item.dataset[key] ?? '';
			}
		}
	});
}

const engineNames = {
	chromium: 'Chromium',
	firefox: 'Firefox',
	webkit: 'WebKit',
	obscura: 'Obscura',
	lightpanda: 'Lightpanda'
};

const fullEngineIds = new Set(['chromium', 'firefox', 'webkit']);

for (const picker of document.querySelectorAll('[data-engine-picker]')) {
	const choices = Array.from(picker.querySelectorAll('[data-engine-choice]'));
	const cards = Array.from(picker.querySelectorAll('[data-engine-detail]'));
	const count = picker.querySelector('[data-engine-selection-count]');
	const summary = picker.querySelector('[data-engine-selection-summary]');
	const selectFull = picker.querySelector('[data-engine-select-full]');
	const clear = picker.querySelector('[data-engine-clear]');

	const updateEngineSelection = () => {
		const selected = choices
			.filter(choice => choice.checked)
			.map(choice => choice.value);

		for (const choice of choices) {
			choice.closest('[data-engine-choice-card]')?.classList.toggle('is-selected', choice.checked);
		}

		for (const card of cards) {
			const isSelected = selected.includes(card.dataset.engineDetail);
			card.classList.toggle('is-selected', isSelected);
			card.classList.toggle('is-unselected', !isSelected);
		}

		if (count) {
			count.textContent = selected.length === 0
				? 'No engines selected'
				: `${selected.length} ${selected.length === 1 ? 'engine' : 'engines'} selected`;
		}

		if (!summary) {
			return;
		}

		if (selected.length === 0) {
			summary.textContent = 'Select one or more engine lanes to compare their declared capability boundaries.';
			return;
		}

		const selectedNames = selected.map(engine => engineNames[engine]).join(', ');
		const isFullEngineSelection = selected.every(engine => fullEngineIds.has(engine));

		if (selected.includes('lightpanda')) {
			summary.textContent = `${selectedNames}: Lightpanda is available for manifest and machine preflight only. Runtime launch stays disabled until its egress conformance gate passes.`;
			return;
		}

		if (selected.includes('obscura')) {
			summary.textContent = `${selectedNames}: Obscura is an explicit experimental lane. Its 28.25 MiB result is limited to the published constrained fixture, and each selected engine is preflighted separately.`;
			return;
		}

		if (isFullEngineSelection) {
			summary.textContent = `${selectedNames}: full rendering engines remain distinct execution lanes. Fikeya prepares a separate capability preflight for every selected engine with no substitution.`;
			return;
		}

		summary.textContent = `${selectedNames}: every selected engine is preflighted against its own declared capability boundary before an authenticated session can be requested.`;
	};

	for (const choice of choices) {
		choice.addEventListener('change', updateEngineSelection);
	}

	selectFull?.addEventListener('click', () => {
		for (const choice of choices) {
			choice.checked = fullEngineIds.has(choice.value);
		}
		updateEngineSelection();
	});

	clear?.addEventListener('click', () => {
		for (const choice of choices) {
			choice.checked = false;
		}
		updateEngineSelection();
	});

	updateEngineSelection();
}
