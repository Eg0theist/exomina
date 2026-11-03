/* The two smaller demos: following a memory down to its source, and the access levels.
   Example content only. They do nothing until pressed, and run no timers afterwards. */
(() => {
  'use strict';
  const de = document.documentElement.lang === 'de';
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const h = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- Memory tree ---------- */
  const memMount = document.querySelector('[data-widget="memory"]');
  if (memMount) {
    const M = de ? {
      ask: 'Frag dein Projekt', deeper: 'Eine Ebene tiefer', again: 'Noch einmal von oben', fix: 'Das stimmt nicht mehr', fixed: 'Von dir korrigiert. Das Original bleibt erhalten.', answer: 'Antwort', covers: n => `Zusammenfassung von ${n} Nachrichten`, orig: 'Originalnachricht', treeAlt: 'Erinnerungsbaum: Der markierte Pfad führt von der Gesamtzusammenfassung zu einer einzelnen Nachricht.',
      qs: [
        { q: 'Was haben wir zu Exporten entschieden?', a: 'Zuerst CSV, JSON später für die Integration.', fix: 'Korrigiert: JSON zuerst, die Integration startet früher als geplant.', leaf: 2, path: ['Projektverlauf: Datenformate festgelegt, Oberfläche überarbeitet, erste Tests.', 'Oktober: Export-Entscheidung, Tabellenansicht für Kunden.', 'Export: CSV zuerst wegen Tabellenkalkulation, JSON folgt.'], from: 'Du, 14. Oktober', via: 'mit Claude', msg: '„Beginne mit CSV, damit ich die Dateien in einer Tabelle öffnen kann. JSON ergänzen wir, wenn wir die Integration bauen.“' },
        { q: 'Warum gibt es keine Anmeldeseite mehr?', a: 'Die App läuft nur lokal, eine Anmeldung brachte nichts.', fix: 'Korrigiert: Die Anmeldung kommt zurück, sobald es einen Handy-Zugang gibt.', leaf: 5, path: ['Projektverlauf: Datenformate festgelegt, Oberfläche überarbeitet, erste Tests.', 'September: Anmeldung gestrichen, Start beschleunigt.', 'Anmeldung entfernt, weil die App nur lokal läuft.'], from: 'Du, 3. September', via: 'mit ChatGPT', msg: '„Die App läuft doch nur auf meinem Rechner. Wozu dann ein Passwort? Nimm die Anmeldeseite raus.“' },
      ],
    } : {
      ask: 'Ask your project', deeper: 'Go one level deeper', again: 'Start again from the top', fix: 'That is out of date', fixed: 'Corrected by you. The original stays on record.', answer: 'Answer', covers: n => `Summary of ${n} messages`, orig: 'Original message', treeAlt: 'Memory tree: the highlighted path runs from the overall summary to one single message.',
      qs: [
        { q: 'What did we decide about exports?', a: 'CSV first, JSON later for the integration.', fix: 'Corrected: JSON first, because the integration is starting sooner than planned.', leaf: 2, path: ['Project so far: data formats settled, interface reworked, first tests.', 'October: export decision, client table view.', 'Exports: CSV first for spreadsheets, JSON to follow.'], from: 'You, 14 October', via: 'with Claude', msg: '“Start with CSV so I can open the files in a spreadsheet. We can add JSON when we build the integration.”' },
        { q: 'Why is there no login page any more?', a: 'The app only runs locally, so a login added nothing.', fix: 'Corrected: login comes back once there is phone access.', leaf: 5, path: ['Project so far: data formats settled, interface reworked, first tests.', 'September: login dropped, faster startup.', 'Login removed because the app only runs locally.'], from: 'You, 3 September', via: 'with ChatGPT', msg: '“It only runs on my computer anyway. What is the password for? Take the login page out.”' },
      ],
    };
    const COUNTS = [1248, 312, 39];
    /* Fifteen nodes: one overall summary, then two children each, down to eight messages. */
    const nodes = []; const pos = (lvl, i) => [(i + .5) * 440 / 2 ** lvl, 26 + lvl * 72];
    for (let l = 0; l < 4; l++) for (let i = 0; i < 2 ** l; i++) nodes.push({ l, i });
    let lines = '';
    for (const n of nodes) if (n.l < 3) for (const c of [0, 1]) { const [a, b] = pos(n.l, n.i), [x, y] = pos(n.l + 1, n.i * 2 + c); lines += `<line data-e="${n.l + 1}-${n.i * 2 + c}" x1="${a}" y1="${b}" x2="${x}" y2="${y}"/>`; }
    const svg = `<svg class="mt-tree" viewBox="0 0 440 268" role="img" aria-label="${esc(M.treeAlt)}">${lines}${nodes.map(n => { const [x, y] = pos(n.l, n.i); return `<circle data-n="${n.l}-${n.i}" cx="${x}" cy="${y}" r="${n.l === 3 ? 8 : 11}"/>`; }).join('')}</svg>`;
    const box = h('div', 'mt');
    const left = h('div', 'mt-left', `<p class="d-hint">${esc(M.ask)}</p>`);
    const chips = h('div', 'mt-qs'); left.append(chips);
    const ans = h('div', 'mt-answer'); left.append(ans);
    const right = h('div', 'mt-right', svg);
    const card = h('div', 'mt-card'); const act = h('div', 'mt-act');
    right.append(card, act);
    box.append(left, right);
    memMount.replaceChildren(box);
    let qi = 0, depth = 0; const fixed = new Set();
    const paint = () => {
      const q = M.qs[qi];
      [...chips.children].forEach((b, i) => b.setAttribute('aria-pressed', i === qi));
      ans.innerHTML = `<small>${esc(M.answer)}</small>${esc(fixed.has(qi) ? q.fix : q.a)}${fixed.has(qi) ? `<span class="mt-fixed">${esc(M.fixed)}</span>` : ''}`;
      right.querySelectorAll('.on').forEach(e => e.classList.remove('on'));
      for (let l = 0; l <= depth; l++) {
        const i = q.leaf >> (3 - l);
        right.querySelector(`[data-n="${l}-${i}"]`).classList.add('on');
        if (l) right.querySelector(`[data-e="${l}-${i}"]`).classList.add('on');
      }
      card.innerHTML = depth < 3
        ? `<small>${esc(M.covers(COUNTS[depth]))}</small>${esc(q.path[depth])}`
        : `<small>${esc(M.orig)} · ${esc(q.from)} · ${esc(q.via)}</small>${esc(q.msg)}`;
      act.replaceChildren();
      const btn = (cls, text, fn) => { const b = h('button', cls, esc(text)); b.type = 'button'; b.addEventListener('click', fn); act.append(b); };
      if (depth < 3) btn('btn btn-sm btn-solid', M.deeper, () => { depth++; paint(); });
      else {
        btn('btn btn-sm', M.again, () => { depth = 0; paint(); });
        if (!fixed.has(qi)) btn('btn btn-sm', M.fix, () => { fixed.add(qi); paint(); });
      }
    };
    M.qs.forEach((q, i) => { const b = h('button', 'chip', esc(q.q)); b.type = 'button'; b.addEventListener('click', () => { qi = i; depth = 0; paint(); }); chips.append(b); });
    paint();
  }

  /* ---------- Access levels ---------- */
  const ctlMount = document.querySelector('[data-widget="control"]');
  if (ctlMount) {
    const C = de ? {
      task: 'Aufgabe', taskText: 'Füge den CSV-Export hinzu, teste ihn und räume den alten Ordner auf.', run: 'Aufgabe starten', again: 'Noch einmal', stop: 'Stoppen', allow: 'Erlauben', deny: 'Nein, lieber nicht', wants: 'Die KI möchte',
      blocked: 'Blockiert', skipped: 'Von dir abgelehnt', asked: 'Von dir erlaubt', auto: 'Ohne Nachfrage', stopped: 'Von dir gestoppt', sum: 'Was passiert ist', legend: 'Zugriff für diesen Chat',
      levels: [['read-only', 'Nur lesen', 'Lesen und recherchieren. Alles andere wird blockiert.'], ['ask', 'Vorher fragen', 'Lesen läuft. Jede Änderung, jeder Befehl fragt zuerst.'], ['auto-edit', 'Änderungen annehmen', 'Dateiänderungen laufen. Befehle fragen weiterhin.'], ['full', 'Voller Zugriff', 'Alles läuft mit deinen Kontorechten, ohne Routinefragen.']],
      steps: [['read', 'src/export.js lesen', 'cat src/export.js', 'gelesen, 86 Zeilen'], ['edit', 'src/export.js ändern', 'edit src/export.js', '+18 −4'], ['cmd', 'Die Tests ausführen', 'npm test', '42 bestanden, 0 fehlgeschlagen'], ['cmd', 'Den alten Ordner löschen', 'rm -r old-exports/', 'old-exports/ gelöscht']],
      note: { 'read-only': 'Nichts wurde geändert. Gut für Fragen und Recherche.', ask: 'Du hast jeden Schritt gesehen, bevor er passiert ist.', 'auto-edit': 'Schneller beim Bearbeiten, und der Löschbefehl hat trotzdem gefragt.', full: 'Am schnellsten, und der Ordner war weg, ohne dass jemand gefragt hat. Wähle diese Stufe mit Bedacht.' },
    } : {
      task: 'Task', taskText: 'Add the CSV export, test it and clear out the old folder.', run: 'Run the task', again: 'Run it again', stop: 'Stop', allow: 'Allow', deny: 'No, leave that', wants: 'The AI wants to',
      blocked: 'Blocked', skipped: 'Declined by you', asked: 'Allowed by you', auto: 'No prompt', stopped: 'Stopped by you', sum: 'What happened', legend: 'Access for this chat',
      levels: [['read-only', 'Read only', 'Reads and researches. Everything else is blocked.'], ['ask', 'Ask before acting', 'Reads run freely. Every edit and command asks first.'], ['auto-edit', 'Auto-accept edits', 'File edits just happen. Commands still ask.'], ['full', 'Full access', 'Everything runs with your account’s permissions, without routine prompts.']],
      steps: [['read', 'read src/export.js', 'cat src/export.js', 'read, 86 lines'], ['edit', 'change src/export.js', 'edit src/export.js', '+18 −4'], ['cmd', 'run the tests', 'npm test', '42 passed, 0 failed'], ['cmd', 'delete the old folder', 'rm -r old-exports/', 'old-exports/ deleted']],
      note: { 'read-only': 'Nothing changed. Good for questions and research.', ask: 'You saw every step before it happened.', 'auto-edit': 'Faster while editing, and the delete command still asked.', full: 'The fastest, and the folder was gone without anyone asking. Choose this one with care.' },
    };
    /* Same rules as the app's four access levels. */
    const policy = (level, kind) => {
      if (kind === 'read') return 'auto';
      if (level === 'read-only') return 'block';
      if (level === 'full') return 'auto';
      if (level === 'auto-edit' && kind === 'edit') return 'auto';
      return 'ask';
    };
    const name = 'ctl-' + Math.random().toString(36).slice(2, 7);
    const box = h('div', 'ac');
    const form = h('fieldset', 'ac-levels', `<legend>${esc(C.legend)}</legend>` + C.levels.map(([id, l, d], i) => `<label><input type="radio" name="${name}" value="${id}"${i === 1 ? ' checked' : ''}><span><b>${esc(l)}</b>${esc(d)}</span></label>`).join(''));
    const main = h('div', 'ac-main');
    const taskEl = h('div', 'ac-task', `<div><small>${esc(C.task)}</small>${esc(C.taskText)}</div>`);
    const runBtn = h('button', 'btn btn-sm btn-solid', esc(C.run)); runBtn.type = 'button'; taskEl.append(runBtn);
    const term = h('div', 'ac-term'); term.setAttribute('role', 'log');
    const prompt = h('div', 'ac-prompt'); prompt.hidden = true;
    const sum = h('div', 'ac-sum'); sum.hidden = true;
    main.append(taskEl, term, prompt, sum);
    box.append(form, main);
    ctlMount.replaceChildren(box);
    term.append(h('div', 'ac-idle', '$ _'));
    let run = 0, timer = 0, active = false, results = [];
    const wait = ms => new Promise(r => { timer = setTimeout(r, calm ? 0 : ms); });
    const line = (cls, text) => { const d = h('div', cls, esc(text)); term.append(d); term.scrollTop = term.scrollHeight; };
    const ask = text => new Promise(res => {
      prompt.hidden = false;
      prompt.innerHTML = `<p><small>${esc(C.wants)}</small>${esc(text)}</p>`;
      const row = h('div', 'ac-btns');
      const y = h('button', 'btn btn-sm btn-solid', esc(C.allow)); y.type = 'button'; y.addEventListener('click', () => res(true));
      const n = h('button', 'btn btn-sm', esc(C.deny)); n.type = 'button'; n.addEventListener('click', () => res(false));
      row.append(y, n); prompt.append(row); y.focus({ preventScroll: true });
    });
    const finish = level => {
      active = false; prompt.hidden = true; runBtn.textContent = C.again;
      form.disabled = false;
      sum.hidden = false;
      sum.innerHTML = `<small>${esc(C.sum)}</small><ul>${results.map(([t, s, c]) => `<li class="${c}"><span>${esc(t)}</span><b>${esc(s)}</b></li>`).join('')}</ul>${level ? `<p>${esc(C.note[level])}</p>` : ''}`;
    };
    const go = async () => {
      const me = ++run, level = form.querySelector('input:checked').value;
      active = true; results = []; term.replaceChildren(); sum.hidden = true; form.disabled = true; runBtn.textContent = C.stop;
      for (const [kind, label, cmd, output] of C.steps) {
        await wait(420); if (me !== run) return;
        const p = policy(level, kind);
        let verdict = p === 'auto' ? 'auto' : p === 'block' ? 'blocked' : null;
        if (p === 'ask') { const ok = await ask(label); if (me !== run) return; prompt.hidden = true; verdict = ok ? 'asked' : 'skipped'; }
        if (verdict === 'blocked' || verdict === 'skipped') {
          line('t-skip', `$ ${cmd}`); line('t-note', verdict === 'blocked' ? C.blocked : C.skipped);
          results.push([label, C[verdict], 'no']);
          continue;
        }
        line('t-cmd', `$ ${cmd}`);
        await wait(380); if (me !== run) return;
        line('t-out', output);
        results.push([label, C[verdict], cmd.startsWith('rm') ? 'warn' : 'yes']);
      }
      finish(level);
    };
    runBtn.addEventListener('click', () => {
      if (!active) return go();
      run++; clearTimeout(timer);
      results.push([C.stopped, '', 'no']);
      finish(null);
    });
  }
})();
