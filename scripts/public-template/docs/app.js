/* Progressive enhancement only. The page, downloads and trailer work without it.
   Nothing here listens to scrolling, runs on a timer or animates per frame. */
(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('js');
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];

  /* Menu */
  const burger = $('.burger'), nav = $('#nav');
  if (burger && nav) {
    const set = open => {
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? burger.dataset.close : burger.dataset.open);
      nav.classList.toggle('open', open);
    };
    burger.addEventListener('click', e => { e.stopPropagation(); set(burger.getAttribute('aria-expanded') !== 'true'); });
    nav.addEventListener('click', e => { if (e.target.closest('a')) set(false); });
    document.addEventListener('click', e => { if (!e.target.closest('#nav')) set(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && burger.getAttribute('aria-expanded') === 'true') { set(false); burger.focus(); } });
  }

  /* Trailer: nothing is fetched until someone presses play. Without script the links open the file. */
  const box = $('.trailer-box');
  if (box && box.showModal) {
    const video = $('video', box);
    let opener = null;
    $$('[data-trailer]').forEach(a => a.addEventListener('click', e => {
      e.preventDefault();
      opener = a;
      box.showModal();
      video.preload = 'auto';
      video.play().catch(() => {});
    }));
    $('.trailer-close', box).addEventListener('click', () => box.close());
    box.addEventListener('click', e => { if (e.target === box) box.close(); });
    box.addEventListener('close', () => { video.pause(); if (opener) opener.focus({ preventScroll: true }); });
  }

  const load = src => { const s = document.createElement('script'); s.src = src; document.head.append(s); };

  /* The hero demo arrives once the page has loaded. The two smaller demos follow when the browser is
     idle, so their setup can never land in the middle of someone's scroll. */
  const mount = $('.demo-mount');
  if (mount) {
    const go = () => {
      load(mount.dataset.src);
      (window.requestIdleCallback || setTimeout)(() => load(mount.dataset.src.replace('demo.js', 'widgets.js')), { timeout: 2000 });
    };
    if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
  }

  /* Operating-system hint. Never guesses a Mac or Linux processor architecture. */
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const ua = navigator.userAgent || '';
  if (!/Android|iPhone|iPad|iPod/i.test(ua) && /Win/i.test(platform)) {
    const card = $('[data-os="windows"]');
    if (card) { card.classList.add('is-you'); const tag = $('.you', card); if (tag) tag.hidden = false; }
  }
})();
