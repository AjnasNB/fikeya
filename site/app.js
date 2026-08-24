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
