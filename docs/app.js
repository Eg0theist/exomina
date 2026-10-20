const root = document.documentElement;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionAllowed = () => !document.hidden && !reducedMotion.matches && !root.classList.contains('motion-paused');
const syncVisibility = () => root.classList.toggle('page-hidden', document.hidden);
syncVisibility();
document.addEventListener('visibilitychange', syncVisibility);
const onVisible = (element, callback, options = {threshold: 0.25}) => {
  if (!element) return;
  if (!('IntersectionObserver' in window)) { callback(true); return; }
  new IntersectionObserver(entries => entries.forEach(entry => callback(entry.isIntersecting, entry)), options).observe(element);
};

// Header and menu
const header = document.querySelector('.site-header');
const updateHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 12);
updateHeader();
window.addEventListener('scroll', updateHeader, {passive: true});
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
    if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { setMenu(false); menu.focus(); }
  });
  document.addEventListener('click', event => { if (!event.target.closest('.site-header')) setMenu(false); });
  window.matchMedia('(min-width:861px)').addEventListener('change', event => { if (event.matches) setMenu(false); });
}

// Global motion toggle (pauses decorative and automatic animation)
const motionToggle = document.querySelector('[data-motion-toggle]');
const motionListeners = [];
const notifyMotion = () => motionListeners.forEach(listener => listener());
if (motionToggle) {
  motionToggle.hidden = false;
  motionToggle.addEventListener('click', () => {
    const paused = root.classList.toggle('motion-paused');
    motionToggle.textContent = paused ? motionToggle.dataset.play : motionToggle.dataset.pause;
    motionToggle.setAttribute('aria-pressed', String(paused));
    notifyMotion();
  });
  motionToggle.setAttribute('aria-pressed', 'false');
}
reducedMotion.addEventListener('change', notifyMotion);

// Reveal on scroll
const revealed = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (entry.isIntersecting) { entry.target.classList.add('is-visible'); observer.unobserve(entry.target); }
  }), {threshold: 0.12, rootMargin: '0px 0px -40px 0px'});
  revealed.forEach(element => observer.observe(element));
} else revealed.forEach(element => element.classList.add('is-visible'));

// Decorative details pause outside the viewport and do not restart on re-entry.
document.querySelectorAll('.mini-plan, .final-orb').forEach(element => onVisible(element, visible => element.classList.toggle('in-view', visible), {threshold: 0}));

// Starfield: drawn once and again after resizing, never animated per frame
const canvas = document.querySelector('.starfield');
if (canvas && canvas.getContext) {
  const context = canvas.getContext('2d');
  let stars = [], width = 0, height = 0;
  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1);
    width = canvas.clientWidth; height = canvas.clientHeight;
    canvas.width = width * ratio; canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(90, width * height / 16000));
    stars = Array.from({length: count}, () => ({x: Math.random() * width, y: Math.random() * height, r: Math.random() * 1.3 + .3, a: Math.random() * .6 + .2}));
    draw();
  };
  const draw = () => {
    context.clearRect(0, 0, width, height);
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const t = stars[j], dx = s.x - t.x, dy = s.y - t.y, d = dx * dx + dy * dy;
        if (d < 12000) { context.strokeStyle = `rgba(190,160,255,${.11 * (1 - d / 12000)})`; context.lineWidth = .6; context.beginPath(); context.moveTo(s.x, s.y); context.lineTo(t.x, t.y); context.stroke(); }
      }
      context.fillStyle = `rgba(230,220,255,${s.a})`;
      context.beginPath(); context.arc(s.x, s.y, s.r, 0, Math.PI * 2); context.fill();
    }
  };
  resize();
  let resizeTimer, lastWidth = innerWidth;
  // Mobile browsers fire resize while scrolling as toolbars collapse; only redraw when the width changes.
  window.addEventListener('resize', () => { if (innerWidth === lastWidth && stars.length) return; lastWidth = innerWidth; clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); });
}

// Show each example once, then leave the page at rest. Whole phrases avoid
// repeatedly laying out text as individual characters are inserted/deleted.
const promptBar = document.querySelector('[data-prompts]');
if (promptBar) {
  const output = promptBar.querySelector('[data-prompt-text]');
  const prompts = [...promptBar.querySelectorAll('[data-prompt-list] li')].map(item => item.textContent);
  let index = 0, timer = 0, inView = false;
  const sync = () => {
    clearTimeout(timer);
    timer = 0;
    if (!motionAllowed() || document.hidden || !inView || index >= prompts.length - 1) return;
    timer = setTimeout(() => {
      timer = 0;
      if (!motionAllowed() || document.hidden || !inView) return;
      output.textContent = prompts[++index];
      output.classList.add('is-changing');
      sync();
    }, 4000);
  };
  output.addEventListener('animationend', () => output.classList.remove('is-changing'));
  onVisible(promptBar, visible => { inView = visible; sync(); }, {threshold: 0});
  document.addEventListener('visibilitychange', sync);
  motionListeners.push(sync);
}

// Hero walkthrough
const story = document.querySelector('[data-story]');
if (story) {
  const stepButtons = [...document.querySelectorAll('[data-story-step]')];
  const play = document.querySelector('[data-story-play]');
  const model = story.querySelector('[data-story-model]');
  const timed = [...story.querySelectorAll('[data-at]')];
  const skeleton = story.querySelector('[data-until]');
  const last = stepButtons.length - 1;
  let current = last, playing = false, timer, started = false;
  const show = (index, animate = true) => {
    current = index;
    story.dataset.step = String(index);
    timed.forEach(element => {
      const future = Number(element.dataset.at) > index;
      const wasFuture = element.classList.contains('is-future');
      element.classList.toggle('is-future', future);
      element.classList.remove('is-entering');
      if (!future && wasFuture && animate && motionAllowed()) { void element.offsetWidth; element.classList.add('is-entering'); }
    });
    if (skeleton) skeleton.classList.toggle('is-shown', index < Number(skeleton.dataset.until));
    model.textContent = index >= 2 ? 'ChatGPT' : 'Claude';
    model.classList.toggle('is-gpt', index >= 2);
    stepButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  };
  const setPlayLabel = () => {
    play.textContent = playing ? 'Ⅱ ' + play.dataset.pause : '▷ ' + (current === last ? play.dataset.replay : play.dataset.play);
    play.setAttribute('aria-pressed', String(playing));
  };
  const pause = () => { clearTimeout(timer); playing = false; story.dataset.playing = 'false'; setPlayLabel(); };
  const schedule = () => {
    timer = setTimeout(() => {
      if (!playing || document.hidden || !motionAllowed()) { pause(); return; }
      show(current + 1);
      if (current >= last) pause(); else schedule();
    }, current === 0 ? 2200 : 3000);
  };
  const start = () => {
    if (current >= last) show(0);
    playing = true; story.dataset.playing = 'true'; setPlayLabel(); schedule();
  };
  stepButtons.forEach((button, index) => button.addEventListener('click', () => { pause(); show(index); setPlayLabel(); }));
  play.addEventListener('click', () => {
    if (playing) { pause(); return; }
    if (!motionAllowed()) { show(current >= last ? 0 : current + 1, false); setPlayLabel(); return; }
    start();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  motionListeners.push(() => { if (!motionAllowed()) pause(); });
  onVisible(story, visible => {
    if (visible && !started && motionAllowed()) { started = true; show(0, false); start(); }
    else if (!visible && playing) pause();
  }, {threshold: 0.35});
  show(last, false);
  setPlayLabel();
}

// Comparison slider
const compare = document.querySelector('[data-compare]');
if (compare) {
  const range = compare.querySelector('.compare-range');
  range.hidden = false;
  const set = value => compare.style.setProperty('--split', `${value}%`);
  range.addEventListener('input', () => set(range.value));
}

// One short memory illustration per visit. Scrolling back never restarts it.
document.querySelectorAll('[data-memory]').forEach(visual => onVisible(visual, visible => {
  visual.classList.toggle('in-view', visible);
  if (visible) visual.classList.add('is-live');
}, {threshold: 0.3}));

// Tabs
const tabs = [...document.querySelectorAll('[data-tab]')];
const selectTab = (tab, focus = false) => {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
};
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectTab(tab, true));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next], true); }
  });
});

// Playgrounds
document.querySelectorAll('[data-tracker]').forEach(tracker => {
  const tasks = [...tracker.querySelectorAll('[data-task]')];
  const status = tracker.querySelector('[data-tracker-done]');
  tasks.forEach(task => task.addEventListener('click', () => {
    task.setAttribute('aria-pressed', String(task.getAttribute('aria-pressed') !== 'true'));
    const completed = tasks.filter(item => item.getAttribute('aria-pressed') === 'true').length;
    tracker.querySelector('[data-task-count]').textContent = `${completed} / ${tasks.length}`;
    tracker.querySelector('progress').value = completed;
    status.textContent = completed === tasks.length ? status.dataset.done : '';
  }));
});
document.querySelectorAll('[data-pipeline]').forEach(pipeline => {
  const lanes = [...pipeline.querySelectorAll('.pipeline-lane')];
  const card = pipeline.querySelector('.pipeline-card');
  const next = pipeline.querySelector('[data-pipeline-next]');
  let stage = 0;
  next.addEventListener('click', () => {
    stage = (stage + 1) % lanes.length;
    lanes[stage].querySelector('.lane-cards').append(card);
    card.style.animation = 'none'; void card.offsetWidth; card.style.animation = '';
    lanes.forEach((lane, i) => { lane.querySelector('[data-lane-count]').textContent = i === stage ? '1' : '0'; });
    pipeline.querySelector('[data-pipeline-status]').textContent = `${card.querySelector('strong').textContent} → ${lanes[stage].querySelector('.lane-title strong').textContent}`;
    next.textContent = `${stage === lanes.length - 1 ? next.dataset.reset : next.dataset.action} →`;
  });
});
document.querySelectorAll('[data-research]').forEach(research => {
  const action = research.querySelector('[data-research-action]');
  const status = research.querySelector('[data-research-status]');
  action.addEventListener('click', () => {
    const done = research.classList.toggle('is-done');
    status.textContent = done ? action.dataset.verdict : '';
    action.setAttribute('aria-pressed', String(done));
  });
  action.setAttribute('aria-pressed', 'false');
});
document.querySelectorAll('[data-jump-preview]').forEach(preview => {
  const modes = [...preview.querySelectorAll('[data-jump-mode]')];
  const scene = preview.querySelector('.jump-scene');
  let reset;
  modes.forEach(button => button.addEventListener('click', () => {
    preview.dataset.mode = button.dataset.jumpMode;
    modes.forEach(mode => mode.setAttribute('aria-pressed', String(mode === button)));
    scene.classList.remove('is-jumping');
    clearTimeout(reset);
  }));
  const action = preview.querySelector('[data-jump-action]');
  action.addEventListener('click', () => {
    preview.querySelector('[data-jump-status]').textContent = preview.dataset.mode === 'double' ? action.dataset.doubleResult : action.dataset.normalResult;
    scene.classList.remove('is-jumping');
    clearTimeout(reset);
    if (motionAllowed()) {
      void scene.offsetWidth;
      scene.classList.add('is-jumping');
      reset = setTimeout(() => scene.classList.remove('is-jumping'), 1700);
    }
  });
});

// Recommend the installer for this computer
const platformText = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '').toLowerCase();
const userAgent = navigator.userAgent.toLowerCase();
let platform = null;
if (platformText.includes('win')) platform = {cards: [0], name: 'Windows', direct: true};
else if (platformText.includes('mac') && !/iphone|ipad/.test(userAgent)) platform = {cards: [1, 2], name: 'macOS', direct: false};
else if (platformText.includes('linux') && !userAgent.includes('android')) platform = {cards: [/aarch64|arm64/.test(userAgent) ? 4 : 3], name: 'Linux', direct: true};
if (platform) {
  const cards = document.querySelectorAll('[data-platform]');
  platform.cards.forEach(index => cards[index] && cards[index].classList.add('is-recommended'));
  const heroButton = document.querySelector('[data-hero-download]');
  if (heroButton) {
    heroButton.querySelector('span').textContent = `${heroButton.dataset.label} ${platform.name}`;
    if (platform.direct && cards[platform.cards[0]]) heroButton.href = cards[platform.cards[0]].href;
  }
}
