/* The hands-on demo: a scripted preview of how a project grows in Exomina.
   No AI runs here and nothing typed leaves the browser. The three projects really work.
   Anything that loops (the game, the beat) only runs after a press, and stops out of view. */
(() => {
  'use strict';
  const root = document.documentElement;
  const de = root.lang === 'de';
  const mount = document.querySelector('.demo-mount');
  if (!mount) return;
  const base = (root.dataset.base || './') + 'assets/';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const eur = n => '€' + Math.round(n).toLocaleString(de ? 'de-DE' : 'en-GB');

  /* Stops a looping toy when it leaves the screen or the tab is hidden. */
  const whileVisible = (el, onLeave) => {
    const io = new IntersectionObserver(([e]) => { if (!e.isIntersecting) onLeave(); }, { threshold: .2 });
    io.observe(el);
    const vis = () => { if (document.hidden) onLeave(); };
    document.addEventListener('visibilitychange', vis);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis); };
  };

  const T = de ? {
    steps: ['Beschreiben', 'Ändern', 'KI wechseln', 'Wiederkommen'], bar: 'Neuer Chat', restart: 'Neu starten',
    place0: 'Was willst du bauen?', place: 'Bitte um eine Änderung …', send: 'Senden',
    pickHint: 'Wähle rechts etwas aus oder beschreibe es hier.', changeHint: 'Probiere eine Änderung', moreHint: 'Noch eine Änderung?',
    switchHint: 'Wechsle die KI. Die Arbeit bleibt.', leave: 'Schließen und in vier Wochen wiederkommen', leaveHint: 'Oder lass es liegen',
    continueWith: m => `Weiter mit ${m}`, switched: (a, b) => `Von ${a} zu ${b} gewechselt. Gleicher Chat, gleiches Projekt.`,
    later: 'Vier Wochen später', back: 'Wo waren wir stehen geblieben?',
    recall: (x, n, a, b) => `Du wolltest: „${x}“ Das Projekt steht bei Version ${n}. Unterwegs sind wir von ${a} zu ${b} gewechselt.`,
    recallSame: (x, n) => `Du wolltest: „${x}“ Das Projekt steht bei Version ${n}.`,
    open: 'Originalnachricht öffnen', srcLabel: 'Deine Nachricht, vor vier Wochen', srcNote: 'Jede Zusammenfassung führt zur Quelle zurück.',
    endText: 'Beschreiben, ändern, und nichts geht verloren. Weiter unten siehst du, wie das funktioniert.', get: 'Exomina holen', another: 'Etwas anderes bauen',
    version: 'Version', viewing: n => `Zurück auf Version ${n}. Die anderen sind noch da.`, latest: 'Wieder auf dem neuesten Stand.',
    unknown0: 'In Exomina würde sich deine verbundene KI daran versuchen. Diese Demo ist geskriptet und kennt nur drei Projekte, wähle rechts eines aus.',
    unknown: 'In Exomina würde sich deine verbundene KI daran versuchen. Diese Demo ist geskriptet und kennt nur ein paar Änderungen. Die hier gehen:',
    nothingLeft: 'Mehr kennt diese geskriptete Demo für dieses Projekt nicht. Eine echte KI würde hier weitermachen.', edited: 'Bearbeitet', versions: 'Versionen',
  } : {
    steps: ['Describe', 'Change', 'Switch AI', 'Come back'], bar: 'New chat', restart: 'Start over',
    place0: 'What do you want to make?', place: 'Ask for a change…', send: 'Send',
    pickHint: 'Pick one on the right, or describe it here.', changeHint: 'Try a change', moreHint: 'Another change?',
    switchHint: 'Switch AI. The work stays.', leave: 'Close it and come back in four weeks', leaveHint: 'Or leave it for now',
    continueWith: m => `Continue with ${m}`, switched: (a, b) => `Switched from ${a} to ${b}. Same chat, same project.`,
    later: 'Four weeks later', back: 'Where did we leave this?',
    recall: (x, n, a, b) => `You asked for: “${x}” The project is at version ${n}. We moved from ${a} to ${b} along the way.`,
    recallSame: (x, n) => `You asked for: “${x}” The project is at version ${n}.`,
    open: 'Open the original message', srcLabel: 'Your message, four weeks ago', srcNote: 'Every summary leads back to its source.',
    endText: 'Describe it, change it, lose nothing. Further down the page you can see how.', get: 'Get Exomina', another: 'Build something else',
    version: 'Version', viewing: n => `Back on version ${n}. The others are still there.`, latest: 'Back on the latest version.',
    unknown0: 'In Exomina, your connected AI would have a go at that. This demo is scripted and only knows three projects, so pick one on the right.',
    unknown: 'In Exomina, your connected AI would have a go at that. This demo is scripted and only knows a few changes. These work:',
    nothingLeft: 'That is everything this scripted demo knows for this project. A real AI would keep going from here.', edited: 'Edited', versions: 'Versions',
  };

  const MODELS = [['ChatGPT', '#ff8538', /chat\s?gpt|openai/i], ['Claude', '#6194ff', /claude/i], ['Gemini', '#7aeb8c', /gemini/i], [de ? 'Lokales Modell' : 'Local model', '#c487ff', /lokal|local/i]];

  const PROJECTS = {
    game: { re: /game|spiel|jump|spring|insel|island/i, file: 'game.js', make: createGame,
      art: '<svg viewBox="0 0 120 60" aria-hidden="true"><circle cx="30" cy="22" r="6" fill="#fff"/><path d="M4 44h44l-9 9-13 6-9-7zM62 34h52l-11 11-14 8-14-9z" fill="#3d2c29"/><path d="M4 43h44v3H4zM62 33h52v3H62z" fill="#7d9a71"/></svg>',
      tile: de ? 'Ein Spiel' : 'A game', sub: de ? 'Du kannst es sofort spielen.' : 'You can play it straight away.',
      ask: de ? 'Ein Spiel, in dem ich zwischen schwebenden Inseln springe.' : 'A game about hopping between floating islands.',
      first: de ? 'Hier ist die erste Version. Starte sie und spring mit Leertaste oder Tippen.' : 'Here is a first version. Start it, then jump with space or a tap.',
      changes: [
        { id: 'flip', re: /grav|flip|schwerkraft|umkehr|ceiling|decke/i, text: de ? 'Jeder Druck soll die Schwerkraft umkehren.' : 'Make each press flip gravity.', reply: de ? 'Erledigt. Du läufst jetzt auch an den Unterseiten der Inseln entlang.' : 'Done. You can now run along the undersides of islands too.', diff: ['- if (ground) vy = -JUMP;', '+ if (opt.flip) { g = -g; vy = 0; }', '+ else if (ground || coyote > 0) vy = -JUMP;'] },
        { id: 'night', re: /night|dark|nacht|dunkel/i, text: de ? 'Mach es Nacht.' : 'Make it night.', reply: de ? 'Es ist Nacht. Die Regeln bleiben gleich.' : 'It is night now. The rules stay the same.', diff: ["- const sky = ['#d8cdda', '#f6c9a6'];", "+ const sky = opt.night ? ['#0b0d1e', '#2d2350'] : ['#d8cdda', '#f6c9a6'];"] },
        { id: 'shards', re: /collect|shard|coin|score|sammel|scherb|münz|punkt/i, text: de ? 'Gib mir etwas zum Sammeln.' : 'Give me something to collect.', reply: de ? 'Über den Lücken schweben jetzt Scherben. Der Zähler läuft oben links.' : 'Shards now float over the gaps. The counter is top left.', diff: ['+ shards.push({ x: gapMiddle, y: top - 110 });', '+ if (touching(shard)) { shard.got = true; score++; }'] },
        { id: 'comet', re: /trail|comet|tail|spur|komet|schweif|prettier|schöner/i, text: de ? 'Gib der Kugel einen Kometenschweif.' : 'Give the orb a comet trail.', reply: de ? 'Die Kugel zieht jetzt einen Schweif hinter sich her.' : 'The orb now pulls a trail behind it.', diff: ['+ trail.unshift({ x: scroll + PX, y });', '+ trail.length = Math.min(trail.length, 16);'] },
      ] },
    money: { re: /abo|subscri|budget|money|geld|tool|werkzeug|tracker|kosten|cost/i, file: 'subscriptions.js', make: createMoney,
      art: '<svg viewBox="0 0 120 60" aria-hidden="true"><g fill="#afc5ad"><rect x="8" y="10" width="72" height="8" rx="2"/><rect x="8" y="26" width="46" height="8" rx="2"/><rect x="8" y="42" width="24" height="8" rx="2" fill="#d7a46d"/></g><text x="88" y="38" font-size="20" fill="#f4ecdd" font-family="system-ui">€</text></svg>',
      tile: de ? 'Ein Abo-Werkzeug' : 'A subscription tool', sub: de ? 'Es rechnet wirklich. Ändere die Preise.' : 'It really adds up. Change the prices.',
      ask: de ? 'Zeig mir, was meine Abos mich kosten.' : 'Show me what my subscriptions cost.',
      first: de ? 'Hier ist deine Liste mit Beispieldaten. Schalte Abos um oder ändere Preise, die Summe rechnet mit.' : 'Here is your list, with sample data. Switch things off or change a price, and the total follows.',
      changes: [
        { id: 'year', re: /year|annual|jahr/i, text: de ? 'Zeig mir die Summe pro Jahr.' : 'Show me the yearly total.', reply: de ? 'Die Jahressumme steht jetzt oben.' : 'The yearly total is at the top now.', diff: ['+ const yearly = monthly * 12;', '+ header.append(big(eur(yearly)));'] },
        { id: 'usage', re: /use|usage|nutz|barely|kaum|selten/i, text: de ? 'Welche nutze ich kaum?' : 'Which ones do I barely use?', reply: de ? 'Jede Zeile zeigt jetzt die Nutzung im letzten Monat. Die kaum genutzten sind markiert.' : 'Each row now shows last month’s use. The barely used ones are marked.', diff: ['+ row.append(bar(sub.uses / 30));', '+ row.classList.toggle("low", sub.uses < 3);'] },
        { id: 'cancel', needs: 'usage', re: /cancel|kündig|save|spar|what if|was wäre/i, text: de ? 'Was spare ich, wenn ich die kündige?' : 'What do I save if I cancel those?', reply: de ? 'Ich habe sie probeweise abgeschaltet. Die Ersparnis steht oben, gekündigt wurde nichts.' : 'I switched them off as a what-if. The saving is at the top, and nothing was actually cancelled.', diff: ['+ for (const s of subs) if (s.uses < 3) s.on = false;', '+ header.append(saved(before - monthly));'] },
      ] },
    beat: { re: /beat|music|musik|drum|song|sound|ton|loop/i, file: 'beats.js', make: createBeat,
      art: '<svg viewBox="0 0 120 60" aria-hidden="true"><g fill="#cba3f4">' + [[8,8],[40,8],[72,8],[104,8],[24,26],[88,26],[8,44],[24,44],[56,44],[88,44]].map(([x, y]) => `<rect x="${x}" y="${y}" width="10" height="10" rx="2"/>`).join('') + '</g></svg>',
      tile: de ? 'Eine Beatmaschine' : 'A beat machine', sub: de ? 'Mach Musik, Ton an.' : 'Make noise, sound on.',
      ask: de ? 'Eine kleine Beatmaschine zum Herumspielen.' : 'A little beat machine to mess about with.',
      first: de ? 'Hier ist sie. Drück auf Abspielen und klick Felder an oder aus, auch während sie läuft.' : 'Here it is. Press play and click steps on or off, even while it runs.',
      changes: [
        { id: 'bass', re: /bass/i, text: de ? 'Füg eine Basslinie hinzu.' : 'Add a bassline.', reply: de ? 'Die Basslinie ist da, als eigene Spur.' : 'There is a bassline now, on its own track.', diff: ['+ tracks.push({ name: "Bass", steps: BASS, play: bassNote });'] },
        { id: 'dark', re: /dark|slow|dunkel|langsam|düster|moody/i, text: de ? 'Langsamer und düsterer.' : 'Slower and darker.', reply: de ? 'Weniger Tempo, weniger Höhen. Der Regler zeigt es.' : 'Less tempo, less top end. The slider shows it.', diff: ['- let bpm = 118;', '+ let bpm = 88;', '+ master.frequency.value = 900;'] },
        { id: 'swing', re: /swing|groove|shuffle/i, text: de ? 'Gib dem Ganzen Swing.' : 'Give it some swing.', reply: de ? 'Jeder zweite Schritt kommt jetzt etwas später.' : 'Every second step now lands a little late.', diff: ['+ const late = step % 2 ? stepTime * .22 : 0;', '+ schedule(when + late);'] },
      ] },
  };

  /* ---------- Game ---------- */
  function createGame(stage) {
    const L = de ? { start: 'Spiel starten', again: 'Weiterspielen', jump: 'Leertaste oder Tippen zum Springen', flip: 'Leertaste oder Tippen kehrt die Schwerkraft um', shards: 'Scherben', dist: 'Strecke', aria: 'Kleines Inselspiel. Leertaste oder Tippen zum Springen.' }
      : { start: 'Start the game', again: 'Keep playing', jump: 'Space or tap to jump', flip: 'Space or tap flips gravity', shards: 'Shards', dist: 'Distance', aria: 'Small island game. Press space or tap to jump.' };
    const W = 960, H = 540, PX = 210, R = 15, G = 1500, JUMP = 640, COYOTE = .09, BUFFER = .12;
    const wrap = h('div', 'g-wrap');
    const c = h('canvas'); c.width = W; c.height = H; c.tabIndex = 0; c.setAttribute('role', 'application'); c.setAttribute('aria-label', L.aria);
    const hud = h('div', 'g-hud glass', `<div><small>${L.dist}</small><b data-d>0</b></div><div data-s hidden><small>${L.shards}</small><b data-n>00</b></div>`);
    const startBtn = h('button', 'g-start', L.start); startBtn.type = 'button';
    const help = h('div', 'g-help', L.jump);
    wrap.append(c, hud, startBtn, help); stage.append(wrap);
    const x = c.getContext('2d', { alpha: false });
    let opt = new Set();
    const has = k => opt.has(k);
    const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
    const far = document.createElement('canvas'); far.width = W; far.height = H;
    const orb = document.createElement('canvas'); orb.width = orb.height = 96;
    {
      const o = orb.getContext('2d');
      const g = o.createRadialGradient(48, 48, 6, 48, 48, 48);
      g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(.32, 'rgba(255,250,235,.5)'); g.addColorStop(1, 'rgba(255,245,220,0)');
      o.fillStyle = g; o.fillRect(0, 0, 96, 96);
      o.fillStyle = '#fff'; o.beginPath(); o.arc(48, 48, R, 0, 7); o.fill();
    }
    /* Sky and distant clouds are painted once, so a frame is mostly two image copies. */
    const paintBg = () => {
      const b = bg.getContext('2d'), n = has('night');
      const g = b.createLinearGradient(0, 0, 0, H);
      if (n) { g.addColorStop(0, '#0b0d1e'); g.addColorStop(.7, '#1d1a3a'); g.addColorStop(1, '#2d2350'); }
      else { g.addColorStop(0, '#c9c0dc'); g.addColorStop(.55, '#f1d9c4'); g.addColorStop(1, '#f6c9a6'); }
      b.fillStyle = g; b.fillRect(0, 0, W, H);
      let s = 11; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
      if (n) { b.fillStyle = '#fff'; for (let i = 0; i < 130; i++) { b.globalAlpha = .25 + r() * .7; b.fillRect(r() * W, r() * 400, 1.6, 1.6); } b.globalAlpha = 1; }
      b.fillStyle = n ? '#e8e3ff' : '#fff6e4'; b.beginPath(); b.arc(760, 96, n ? 34 : 46, 0, 7); b.fill();
      const f = far.getContext('2d'); f.clearRect(0, 0, W, H);
      f.fillStyle = n ? 'rgba(90,76,150,.5)' : 'rgba(255,238,222,.85)';
      for (let i = 0; i < 26; i++) { const ex = r() * W, ey = H - r() * 46, rx = 50 + r() * 70, ry = 14 + r() * 18; for (const off of [0, W, -W]) { f.beginPath(); f.ellipse(ex + off, ey, rx, ry, 0, 0, 7); f.fill(); } }
    };
    let seed, scroll, lower, upper, shards, sparks, trail, cursor, y, vy, g, ground, coyote, buffered, score, running = false, raf = 0, last = 0, misses = 0, shownD = -1;
    const nodeD = hud.querySelector('[data-d]'), nodeN = hud.querySelector('[data-n]'), nodeS = hud.querySelector('[data-s]');
    const rnd = (a, b) => { seed = (seed * 16807) % 2147483647; return a + (seed / 2147483647) * (b - a); };
    const spawn = () => {
      while (cursor < scroll + W + 400) {
        const w = rnd(250, 390), gap = rnd(100, 160), top = rnd(350, 400);
        lower.push({ x: cursor, w, y: top });
        upper.push({ x: cursor + w - 120, w: gap + 240, y: rnd(130, 170) });
        shards.push({ x: cursor + w + gap / 2, y: top - rnd(90, 125), upY: rnd(220, 270), got: false });
        cursor += w + gap;
      }
      while (lower.length && lower[0].x + lower[0].w < scroll - 60) { lower.shift(); upper.shift(); shards.shift(); }
    };
    const reset = () => {
      seed = 4242; scroll = 0; lower = []; upper = []; shards = []; sparks = []; trail = []; cursor = 40; score = 0; misses = 0; spawn();
      y = lower[0].y - R; vy = 0; g = 1; ground = true; coyote = 0; buffered = 0; nodeN.textContent = '00';
    };
    const island = (is, up) => {
      const sx = is.x - scroll, d = up ? -1 : 1;
      x.fillStyle = has('night') ? '#141026' : '#3d2c29';
      x.beginPath(); x.moveTo(sx, is.y); x.lineTo(sx + is.w, is.y);
      x.lineTo(sx + is.w * .8, is.y + 46 * d); x.lineTo(sx + is.w * .56, is.y + 102 * d); x.lineTo(sx + is.w * .32, is.y + 56 * d); x.closePath(); x.fill();
      x.fillStyle = has('night') ? '#5b4b9a' : '#7d9a71';
      x.fillRect(sx, up ? is.y - 7 : is.y, is.w, 7);
    };
    const draw = () => {
      x.drawImage(bg, 0, 0);
      const fx = -(scroll * .25) % W; x.drawImage(far, fx, 0); x.drawImage(far, fx + W, 0);
      for (const i of lower) if (i.x - scroll < W && i.x + i.w - scroll > 0) island(i, false);
      if (has('flip')) for (const i of upper) if (i.x - scroll < W && i.x + i.w - scroll > 0) island(i, true);
      if (has('shards')) {
        x.fillStyle = '#9264bf';
        for (const s of shards) if (!s.got) {
          const sx = s.x - scroll, sy = has('flip') ? s.upY : s.y;
          if (sx < -20 || sx > W + 20) continue;
          x.beginPath(); x.moveTo(sx, sy - 16); x.lineTo(sx + 10, sy); x.lineTo(sx, sy + 16); x.lineTo(sx - 10, sy); x.closePath(); x.fill();
        }
      }
      if (has('comet')) {
        x.fillStyle = has('night') ? '#cba3f4' : '#fff';
        trail.forEach((p, i) => { x.globalAlpha = (1 - i / trail.length) * .45; x.beginPath(); x.arc(p.x - scroll, p.y, R * (1 - i / trail.length * .7), 0, 7); x.fill(); });
        x.globalAlpha = 1;
      }
      if (sparks.length) {
        x.fillStyle = '#cba3f4';
        for (const s of sparks) { x.globalAlpha = Math.max(0, s.life * 2.5); x.fillRect(s.x - scroll, s.y, 4, 4); }
        x.globalAlpha = 1;
      }
      x.drawImage(orb, PX - 48, y - 48);
    };
    const doPress = () => {
      if (has('flip')) { g = -g; vy = 0; ground = false; coyote = 0; return true; }
      if (ground || coyote > 0) { vy = -JUMP; ground = false; coyote = 0; return true; }
      return false;
    };
    const step = dt => {
      const speed = 270 + Math.min(80, scroll / 90);
      scroll += speed * dt; spawn();
      const wasGround = ground;
      const py = y; vy += G * g * dt; y += vy * dt; ground = false;
      const px = scroll + PX;
      if (g > 0) { for (const i of lower) if (px > i.x - 6 && px < i.x + i.w + 6 && py + R <= i.y + 2 && y + R >= i.y) { y = i.y - R; vy = 0; ground = true; } }
      else if (has('flip')) { for (const i of upper) if (px > i.x - 6 && px < i.x + i.w + 6 && py - R >= i.y - 2 && y - R <= i.y) { y = i.y + R; vy = 0; ground = true; } }
      coyote = ground ? COYOTE : wasGround ? COYOTE : Math.max(0, coyote - dt);
      if (buffered > 0) { buffered -= dt; if (doPress()) buffered = 0; }
      if (has('comet')) { trail.unshift({ x: px, y }); if (trail.length > 16) trail.length = 16; }
      if (has('shards')) for (const s of shards) if (!s.got && Math.abs(s.x - px) < 32 && Math.abs((has('flip') ? s.upY : s.y) - y) < 46) {
        s.got = true; score++; nodeN.textContent = String(score).padStart(2, '0');
        for (let i = 0; i < 8; i++) sparks.push({ x: px + (i - 4) * 5, y: y + (i % 3 - 1) * 12, vy: (i - 4) * 28, life: .4 });
      }
      if (sparks.length) { for (const s of sparks) { s.life -= dt; s.y += s.vy * dt; } sparks = sparks.filter(s => s.life > 0); }
      const d = Math.floor(scroll / 50); if (d !== shownD) { shownD = d; nodeD.textContent = d; }
      if (y > H + 50 || y < -50) {
        const next = lower.find(i => i.x > px - 40) || lower[0];
        scroll = next.x - PX + 30; y = next.y - R; vy = 0; g = 1; ground = true; trail = [];
        if (++misses >= 4) stop(L.again);
      }
    };
    const frame = t => {
      raf = 0; if (!running) return;
      step(Math.min((t - last) / 1000, .05)); last = t; draw();
      raf = requestAnimationFrame(frame);
    };
    function stop(label) { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; if (label) { startBtn.textContent = label; startBtn.hidden = false; } }
    const run = () => { if (running) return; running = true; misses = 0; startBtn.hidden = true; last = performance.now(); raf = requestAnimationFrame(frame); };
    const press = () => {
      if (!running) { run(); c.focus({ preventScroll: true }); return; }
      misses = 0;
      if (!doPress()) buffered = BUFFER;
    };
    c.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
    c.addEventListener('keydown', e => { if (e.code === 'Space' || e.key === 'ArrowUp') { e.preventDefault(); press(); } });
    startBtn.addEventListener('click', press);
    const off = whileVisible(wrap, () => { if (running) stop(L.again); });
    paintBg(); reset(); draw();
    return {
      set(next) {
        const wasNight = has('night'); opt = next;
        if (wasNight !== has('night')) { paintBg(); wrap.classList.toggle('g-night', has('night')); }
        nodeS.hidden = !has('shards');
        help.textContent = has('flip') ? L.flip : L.jump;
        if (!has('flip')) { if (g < 0) { g = 1; vy = 0; } }
        if (!has('comet')) trail = [];
        if (!running) draw();
        c.focus({ preventScroll: true });
      },
      destroy() { stop(); off(); wrap.remove(); },
    };
  }

  /* ---------- Subscription tool: it really calculates ---------- */
  function createMoney(stage) {
    const L = de ? { month: 'Pro Monat', year: 'Pro Jahr', saved: 'Du würdest sparen', perYear: 'pro Jahr', uses: n => `${n}× im Monat`, sample: 'Beispieldaten', price: n => `Preis für ${n}`, on: n => `${n} an oder aus`, names: ['Musik', 'Filme & Serien', 'Cloud-Speicher', 'Fitnessstudio', 'Zeitung', 'Sprachen-App', 'Foto-Editor'] }
      : { month: 'Per month', year: 'Per year', saved: 'You would save', perYear: 'a year', uses: n => `${n}× a month`, sample: 'Sample data', price: n => `Price of ${n}`, on: n => `${n} on or off`, names: ['Music', 'Films & shows', 'Cloud storage', 'Gym', 'Newspaper', 'Language app', 'Photo editor'] };
    const data = [[11, 26], [14, 12], [3, 30], [35, 2], [19, 1], [8, 0], [13, 2]].map(([p, u], i) => ({ n: L.names[i], p, u, on: true }));
    const wrap = h('div', 'y-wrap');
    const head = h('div', 'y-head', `<div><small>${L.month}</small><b data-m></b></div><div data-y hidden><small>${L.year}</small><b data-yr></b></div><div data-sv hidden class="y-save"><small>${L.saved}</small><b data-s></b></div>`);
    const list = h('ul', 'y-list');
    data.forEach((d, i) => {
      const li = h('li', '', `<label class="y-on"><input type="checkbox" checked aria-label="${esc(L.on(d.n))}"><span>${esc(d.n)}</span></label><span class="y-use" hidden><i style="width:${Math.round(d.u / 30 * 100)}%"></i><em>${L.uses(d.u)}</em></span><label class="y-price">€<input type="number" min="0" max="999" step="1" value="${d.p}" aria-label="${esc(L.price(d.n))}"></label>`);
      li.querySelector('[type=checkbox]').addEventListener('change', e => { d.on = e.target.checked; li.classList.toggle('off', !d.on); total(); });
      li.querySelector('[type=number]').addEventListener('input', e => { d.p = Math.max(0, Math.min(999, +e.target.value || 0)); total(); });
      d.li = li; list.append(li);
    });
    wrap.append(head, list, h('p', 'y-note', L.sample)); stage.append(wrap);
    let opt = new Set(), baseline = 0;
    const q = s => head.querySelector(s);
    function total() {
      const m = data.reduce((a, d) => a + (d.on ? d.p : 0), 0);
      q('[data-m]').textContent = eur(m);
      q('[data-yr]').textContent = eur(m * 12);
      q('[data-s]').textContent = `${eur((baseline - m) * 12)} ${L.perYear}`;
    }
    total();
    return {
      set(next) {
        const had = opt.has('cancel'); opt = next;
        q('[data-y]').hidden = !opt.has('year');
        list.classList.toggle('y-usage', opt.has('usage'));
        data.forEach(d => { d.li.querySelector('.y-use').hidden = !opt.has('usage'); d.li.classList.toggle('low', opt.has('usage') && d.u < 3); });
        if (opt.has('cancel') !== had) {
          if (opt.has('cancel')) baseline = data.reduce((a, d) => a + (d.on ? d.p : 0), 0);
          data.forEach(d => { if (d.u < 3) { d.on = !opt.has('cancel'); d.li.querySelector('[type=checkbox]').checked = d.on; d.li.classList.toggle('off', !d.on); } });
        }
        q('[data-sv]').hidden = !opt.has('cancel');
        total();
      },
      destroy() { wrap.remove(); },
    };
  }

  /* ---------- Beat machine: every sound is synthesised live, no audio files ---------- */
  function createBeat(stage) {
    const L = de ? { play: 'Abspielen', stop: 'Stopp', tempo: 'Tempo', names: { kick: 'Kick', snare: 'Snare', hat: 'Hi-Hat', bass: 'Bass' }, cell: (n, i) => `${n}, Schritt ${i}` }
      : { play: 'Play', stop: 'Stop', tempo: 'Tempo', names: { kick: 'Kick', snare: 'Snare', hat: 'Hat', bass: 'Bass' }, cell: (n, i) => `${n}, step ${i}` };
    const N = 16;
    const pat = s => [...s].map(c => c === 'x');
    const tracks = [
      { id: 'kick', steps: pat('x...x...x..x....') },
      { id: 'snare', steps: pat('....x.......x..x') },
      { id: 'hat', steps: pat('x.x.x.xxx.x.x.xx') },
      { id: 'bass', steps: pat('x..x..x...x..x..'), extra: true },
    ];
    const NOTES = [55, 55, 55, 65.41, 65.41, 65.41, 49, 49, 49, 49, 41.2, 41.2, 41.2, 49, 49, 49];
    const wrap = h('div', 'b-wrap');
    const grid = h('div', 'b-grid'); const cols = Array.from({ length: N }, () => []);
    tracks.forEach(t => {
      const row = h('div', 'b-row', `<span>${L.names[t.id]}</span>`); if (t.extra) row.hidden = true; t.row = row;
      t.steps.forEach((on, i) => {
        const b = h('button', i % 4 === 0 ? 'b-cell b-q' : 'b-cell'); b.type = 'button';
        b.setAttribute('aria-pressed', on); b.setAttribute('aria-label', L.cell(L.names[t.id], i + 1));
        b.addEventListener('click', () => { t.steps[i] = !t.steps[i]; b.setAttribute('aria-pressed', t.steps[i]); });
        row.append(b); cols[i].push(b);
      });
      grid.append(row);
    });
    const tools = h('div', 'b-tools');
    const playBtn = h('button', 'c-play', `▶ ${L.play}`); playBtn.type = 'button';
    const tempo = h('label', 'b-tempo', `<span>${L.tempo}</span><input type="range" min="70" max="150" value="118"><output>118</output>`);
    tools.append(playBtn, tempo);
    wrap.append(grid, tools); stage.append(wrap);
    const slider = tempo.querySelector('input'), out = tempo.querySelector('output');
    let bpm = 118, ctx = null, master = null, noise = null, playing = false, timer = 0, stepNo = 0, nextT = 0, lit = -1, opt = new Set(), litTimers = [];
    slider.addEventListener('input', () => { bpm = +slider.value; out.textContent = bpm; });
    const audio = () => {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor(); comp.connect(ctx.destination);
      master = ctx.createBiquadFilter(); master.type = 'lowpass'; master.frequency.value = opt.has('dark') ? 900 : 16000; master.connect(comp);
      noise = ctx.createBuffer(1, ctx.sampleRate * .3, ctx.sampleRate); const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    };
    const env = (when, peak, len) => { const g = ctx.createGain(); g.gain.setValueAtTime(peak, when); g.gain.exponentialRampToValueAtTime(.001, when + len); g.connect(master); return g; };
    const hit = {
      kick(t) { const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + .12); o.connect(env(t, .9, .26)); o.start(t); o.stop(t + .27); },
      snare(t) { const s = ctx.createBufferSource(); s.buffer = noise; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; s.connect(f); f.connect(env(t, .5, .16)); s.start(t); s.stop(t + .17); },
      hat(t) { const s = ctx.createBufferSource(); s.buffer = noise; const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000; s.connect(f); f.connect(env(t, .18, .05)); s.start(t); s.stop(t + .06); },
      bass(t, i) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = NOTES[i]; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 480; o.connect(f); f.connect(env(t, .42, .3)); o.start(t); o.stop(t + .31); },
    };
    const light = i => { if (lit >= 0) cols[lit].forEach(b => b.classList.remove('now')); lit = i; if (i >= 0) cols[i].forEach(b => b.classList.add('now')); };
    const schedule = () => {
      /* A coarse timer looks a little ahead, and the audio clock does the precise timing. */
      while (nextT < ctx.currentTime + .12) {
        const stepLen = 60 / bpm / 4, i = stepNo;
        const when = nextT + (opt.has('swing') && i % 2 ? stepLen * .22 : 0);
        tracks.forEach(t => { if (t.steps[i] && (!t.extra || opt.has('bass'))) hit[t.id](when, i); });
        if (!calm) litTimers.push(setTimeout(() => { if (playing) light(i); }, Math.max(0, (when - ctx.currentTime) * 1000)));
        if (litTimers.length > 32) litTimers = litTimers.slice(-16);
        nextT += stepLen; stepNo = (stepNo + 1) % N;
      }
      timer = setTimeout(schedule, 40);
    };
    function stop() {
      if (!playing) return;
      playing = false; clearTimeout(timer); litTimers.forEach(clearTimeout); litTimers = []; light(-1);
      if (ctx) ctx.suspend();
      playBtn.textContent = `▶ ${L.play}`;
    }
    playBtn.addEventListener('click', () => {
      if (playing) return stop();
      audio(); ctx.resume();
      playing = true; stepNo = 0; nextT = ctx.currentTime + .05;
      playBtn.textContent = `■ ${L.stop}`;
      schedule();
    });
    const off = whileVisible(wrap, stop);
    return {
      set(next) {
        const wasDark = opt.has('dark'); opt = next;
        tracks[3].row.hidden = !opt.has('bass');
        if (wasDark !== opt.has('dark')) { bpm = opt.has('dark') ? 88 : 118; slider.value = bpm; out.textContent = bpm; }
        wrap.classList.toggle('b-dark', opt.has('dark'));
        wrap.classList.toggle('b-swing', opt.has('swing'));
        if (master) master.frequency.value = opt.has('dark') ? 900 : 16000;
      },
      destroy() { stop(); off(); if (ctx) ctx.close(); wrap.remove(); },
    };
  }

  /* ---------- Conversation ---------- */
  const demo = h('div', 'demo');
  const steps = h('ol', 'd-steps', T.steps.map((s, i) => `<li><i>${i + 1}</i>${s}</li>`).join(''));
  const chat = h('div', 'd-chat');
  const bar = h('div', 'd-bar', `<img src="${base}exomina.svg" alt="" width="20" height="20"><span>${T.bar}</span><span class="dot" style="--c:#ff8538"></span><span data-model>ChatGPT</span><button type="button" class="d-reset">${T.restart}</button>`);
  const log = h('div', 'd-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');
  const next = h('div', 'd-next');
  const form = h('form', 'd-compose', `<input type="text" maxlength="200" autocomplete="off" aria-label="${esc(T.place0)}"><button type="submit" aria-label="${esc(T.send)}">↑</button>`);
  const input = form.querySelector('input');
  chat.append(bar, log, next, form);
  const stageEl = h('div', 'd-stage');
  const verBar = h('div', 'd-vers'); verBar.setAttribute('role', 'group'); verBar.setAttribute('aria-label', T.versions);
  const toyEl = h('div', 'd-toy');
  stageEl.append(verBar, toyEl);
  demo.append(steps, chat, stageEl);
  mount.append(demo);

  let S;
  const toEnd = () => { log.scrollTop = log.scrollHeight; };
  const setStep = n => [...steps.children].forEach((li, i) => { li.className = i < n ? 'done' : i === n ? 'now' : ''; if (i === n) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
  const say = (kind, html) => { const m = h('div', 'm m-' + kind, html); log.append(m); toEnd(); return m; };
  const ai = (text, after) => {
    next.replaceChildren();
    const wait = say('ai', '<div class="typing"><i></i><i></i><i></i></div>');
    const run = S.run;
    const [name, color] = MODELS[S.model];
    setTimeout(() => {
      if (run !== S.run || !wait.isConnected) return;
      wait.innerHTML = `<small><span class="dot" style="--c:${color}"></span>${esc(name)}</small>${text}`;
      toEnd();
      after && after(wait);
    }, calm ? 60 : 600);
  };
  const hint = t => next.append(h('div', 'd-hint', t));
  const chip = (text, fn, parent = next) => { const b = h('button', 'chip', text); b.type = 'button'; b.addEventListener('click', fn); parent.append(b); return b; };
  const available = () => PROJECTS[S.project].changes.filter(c => !S.done.includes(c) && (!c.needs || S.done.some(d => d.id === c.needs)));

  function renderNext() {
    next.replaceChildren();
    if (!S.project || S.ended) return;
    const left = available();
    if (left.length) {
      hint(S.done.length ? T.moreHint : T.changeHint);
      left.slice(0, S.done.length ? 2 : 3).forEach(c => chip(esc(c.text), () => change(c)));
    }
    if (S.done.length && !S.switched) {
      hint(T.switchHint);
      const row = h('div', 'chip-row'); next.append(row);
      MODELS.forEach((m, i) => { if (i === S.model) return; const b = chip(`<span class="dot" style="--c:${m[1]}"></span>${esc(m[0])}`, () => switchTo(i), row); b.setAttribute('aria-label', T.continueWith(m[0])); });
    } else if (S.switched) {
      hint(T.leaveHint);
      chip(`${esc(T.leave)} →`, leave);
    }
  }
  function renderVersions() {
    verBar.replaceChildren();
    if (!S.project) { verBar.hidden = true; return; }
    verBar.hidden = false;
    verBar.append(h('span', '', T.version));
    for (let v = 1; v <= S.done.length + 1; v++) {
      const b = h('button', 'd-v', String(v)); b.type = 'button';
      b.setAttribute('aria-pressed', v === S.viewing);
      b.addEventListener('click', () => view(v));
      verBar.append(b);
    }
  }
  const applied = v => new Set(S.done.slice(0, v - 1).map(c => c.id));
  function view(v) {
    if (v === S.viewing) return;
    S.viewing = v; S.toy.set(applied(v)); renderVersions();
    say('sys', esc(v === S.done.length + 1 ? T.latest : T.viewing(v)));
  }
  function change(c, words) {
    say('user', esc(words || c.text));
    S.done.push(c); S.viewing = S.done.length + 1;
    if (!S.first) S.first = words || c.text;
    setStep(S.switched ? 3 : 1);
    S.toy.set(applied(S.viewing)); renderVersions();
    const p = PROJECTS[S.project];
    const adds = c.diff.filter(l => l[0] === '+').length, dels = c.diff.filter(l => l[0] === '-').length;
    const code = c.diff.map(l => `<span class="${l[0] === '+' ? 'add' : 'del'}">${esc(l)}</span>`).join('\n');
    ai(`${esc(c.reply)}<details class="m-tool"><summary>${esc(T.edited)} ${esc(p.file)} <b>+${adds}</b>${dels ? ` <i>−${dels}</i>` : ''}</summary><pre>${code}</pre></details>`, renderNext);
  }
  function switchTo(i, words) {
    if (words) say('user', esc(words));
    const from = MODELS[S.model][0]; S.from = from; S.model = i; S.switched = true;
    bar.querySelector('[data-model]').textContent = MODELS[i][0];
    bar.querySelector('.dot').style.setProperty('--c', MODELS[i][1]);
    say('sys', esc(T.switched(from, MODELS[i][0])));
    setStep(2);
    renderNext();
  }
  function leave() {
    next.replaceChildren();
    S.ended = true;
    say('time', esc(T.later));
    say('user', esc(T.back));
    setStep(3);
    const said = S.first || PROJECTS[S.project].ask;
    const line = S.from ? T.recall(said, S.done.length + 1, S.from, MODELS[S.model][0]) : T.recallSame(said, S.done.length + 1);
    ai(`${esc(line)} <button type="button" class="text-link" data-src>${esc(T.open)}</button>`, m => {
      m.querySelector('[data-src]').addEventListener('click', e => {
        e.target.replaceWith(h('span', 'm-src', `<small>${esc(T.srcLabel)}</small>“${esc(said)}”<small style="margin-top:6px">${esc(T.srcNote)}</small>`));
        toEnd();
      });
      steps.lastElementChild.className = 'done';
      const end = h('div', 'd-end', `<p>${esc(T.endText)}</p><div><a class="btn btn-solid btn-sm" href="#download">${esc(T.get)}</a><button type="button" class="btn btn-sm" data-again>${esc(T.another)}</button></div>`);
      next.replaceChildren(end);
      end.querySelector('[data-again]').addEventListener('click', start);
    });
  }
  function pick(id, words) {
    const p = PROJECTS[id];
    S.project = id; S.viewing = 1;
    toyEl.replaceChildren();
    S.toy = p.make(toyEl);
    renderVersions();
    say('user', esc(words || p.ask));
    if (words) S.first = words;
    input.setAttribute('placeholder', T.place);
    setStep(1);
    ai(esc(p.first), renderNext);
  }
  /* Free typing: a small keyword match, and an honest answer when it does not know. */
  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (S.ended) { start(); }
    if (!S.project) {
      const id = Object.keys(PROJECTS).find(k => PROJECTS[k].re.test(text));
      if (id) return pick(id, text);
      say('user', esc(text));
      ai(esc(T.unknown0), () => { next.replaceChildren(); hint(T.pickHint); });
      return;
    }
    const m = MODELS.findIndex((x, i) => i !== S.model && x[2].test(text));
    if (m >= 0) return switchTo(m, text);
    const c = available().find(x => x.re.test(text));
    if (c) return change(c, text);
    say('user', esc(text));
    ai(esc(available().length ? T.unknown : T.nothingLeft), renderNext);
  });
  function start() {
    if (S && S.toy) S.toy.destroy();
    S = { run: (S ? S.run : 0) + 1, model: 0, done: [], switched: false, first: null, from: null, viewing: 1, toy: null, project: null, ended: false };
    log.replaceChildren(); next.replaceChildren();
    bar.querySelector('[data-model]').textContent = MODELS[0][0];
    bar.querySelector('.dot').style.setProperty('--c', MODELS[0][1]);
    input.setAttribute('placeholder', T.place0);
    setStep(0);
    hint(T.pickHint);
    renderVersions();
    const tiles = h('div', 'd-tiles');
    Object.entries(PROJECTS).forEach(([id, p]) => {
      const b = h('button', `d-tile d-tile-${id}`, `<span class="d-art">${p.art}</span><span class="d-tx">${esc(p.tile)}<small>${esc(p.sub)}</small></span>`);
      b.type = 'button'; b.addEventListener('click', () => pick(id)); tiles.append(b);
    });
    toyEl.replaceChildren(tiles);
  }
  bar.querySelector('.d-reset').addEventListener('click', start);
  start();
})();
