/* Progressive enhancement only. Every workflow and FAQ remains available without JS. */
(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const menu = document.querySelector('.menu-toggle');
  const nav = document.querySelector('#main-nav');
  if (menu && nav) {
    menu.hidden = false;
    const setMenu = open => {
      menu.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-label', open ? menu.dataset.closeLabel : menu.dataset.openLabel);
      nav.classList.toggle('is-open', open);
    };
    menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
    nav.addEventListener('click', event => { if (event.target.closest('a')) setMenu(false); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        setMenu(false); menu.focus();
      }
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.site-header')) setMenu(false);
    });
    matchMedia('(min-width: 701px)').addEventListener('change', () => setMenu(false));
  }

  const tablist = document.querySelector('[data-workflow-tabs]');
  const tabs = [...document.querySelectorAll('[data-workflow-tab]')];
  const panels = [...document.querySelectorAll('[data-workflow-panel]')];
  if (tablist && tabs.length && tabs.length === panels.length) {
    tablist.hidden = false;
    tablist.setAttribute('role', 'tablist');
    tabs.forEach(tab => {
      tab.setAttribute('role','tab');
      tab.setAttribute('aria-controls','panel-' + tab.dataset.workflowTab);
    });
    panels.forEach(panel => {
      panel.setAttribute('role','tabpanel');
      panel.setAttribute('aria-labelledby','tab-' + panel.dataset.workflowPanel);
      panel.tabIndex = 0;
    });
    const selectTab = (index, focus = false, animate = true) => {
      tabs.forEach((tab, i) => {
        tab.setAttribute('aria-selected', String(i === index));
        tab.tabIndex = i === index ? 0 : -1;
        panels[i].hidden = i !== index;
        panels[i].classList.remove('is-entering');
      });
      if (animate) {
        // Read layout once so a new selection receives a fresh short transition.
        void panels[index].offsetWidth;
        panels[index].classList.add('is-entering');
      }
      if (focus) {
        tabs[index].focus({ preventScroll: true });
        tabs[index].scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    };
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(index));
      tab.addEventListener('keydown', event => {
        let target;
        if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
        if (event.key === 'Home') target = 0;
        if (event.key === 'End') target = tabs.length - 1;
        if (target !== undefined) { event.preventDefault(); selectTab(target, true); }
      });
    });
    selectTab(0, false, false);
  }

  panels.forEach(panel => {
    const followup = panel.querySelector('[data-followup-button]');
    const reset = panel.querySelector('[data-reset-button]');
    const initial = panel.querySelector('[data-preview-initial]');
    const updated = panel.querySelector('[data-preview-updated]');
    const reply = panel.querySelector('[data-followup-reply]');
    const label = panel.querySelector('[data-demo-state-label]');
    const result = panel.querySelector('[data-demo-result]');
    if (!followup || !reset || !initial || !updated || !reply || !label || !result) return;
    followup.hidden = false;
    const setUpdated = changed => {
      panel.dataset.demoState = changed ? 'updated' : 'initial';
      initial.hidden = changed;
      updated.hidden = !changed;
      reply.hidden = !changed;
      reset.hidden = !changed;
      followup.setAttribute('aria-pressed', String(changed));
      followup.querySelector('[data-followup-label]').textContent = changed ? followup.dataset.appliedLabel : followup.dataset.initialLabel;
      label.textContent = changed ? label.dataset.updatedLabel : label.dataset.initialLabel;
      result.textContent = changed ? result.dataset.updatedText : result.dataset.initialText;
    };
    followup.addEventListener('click', () => {
      setUpdated(true);
      if (matchMedia('(max-width: 700px)').matches) {
        panel.querySelector('.workspace-preview').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    });
    reset.addEventListener('click', () => { setUpdated(false); followup.focus({ preventScroll: true }); });
  });

  document.querySelectorAll('[data-demo-jump]').forEach(button => {
    button.addEventListener('click', () => {
      const game = button.closest('.tinygame-mini');
      const scene = game.querySelector('[data-moon-scene]');
      const feedback = game.querySelector('[data-jump-feedback]');
      const german = document.documentElement.lang === 'de';
      scene.classList.remove('is-jumping');
      void scene.offsetWidth;
      scene.classList.add('is-jumping');
      feedback.textContent = scene.classList.contains('low-gravity') ? (german ? 'Ein weiter Sprung mit weniger Schwerkraft.' : 'A longer leap in lower gravity.') : (german ? 'Ein kleiner Sprung auf einem kleinen Mond.' : 'A little jump on a little moon.');
      setTimeout(() => scene.classList.remove('is-jumping'), 1300);
    });
  });

  // Operating-system hints never guess a Mac/Linux processor architecture.
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const userAgent = navigator.userAgent || '';
  const desktop = !/Android|iPhone|iPad|iPod/i.test(userAgent) && !(/Mac/i.test(platform) && navigator.maxTouchPoints > 1);
  if (desktop && /Win/i.test(platform)) {
    const card = document.querySelector('[data-platform="0"]');
    if (card) {
      card.classList.add('is-recommended');
      const badge = card.querySelector('.platform-recommended');
      if (badge) badge.hidden = false;
    }
  }
})();
