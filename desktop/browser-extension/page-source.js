export function snapshotOptions(input = {}) {
  const { offset = 0, limit = 24000, include_screenshot = true } = input;
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Snapshot offset must be a non-negative integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24000) throw Error('Snapshot limit must be between 1 and 24000 characters.');
  if (typeof include_screenshot !== 'boolean') throw Error('Snapshot include_screenshot must be true or false.');
  return { offset, limit, include_screenshot };
}

export function snapshotSource(id, input = {}) {
  const {offset, limit} = snapshotOptions(input);
  return `(() => {
    for (const e of document.querySelectorAll('[data-exomina-node]')) e.removeAttribute('data-exomina-node');
    const main = document.querySelector('main,article,[role="main"],#mw-content-text');
    const mainText = main?.innerText || '';
    const fullText = mainText || document.body?.innerText || '';
    const offset = Math.min(${offset}, fullText.length);
    const end = Math.min(offset + ${limit}, fullText.length);
    return { url: location.href, title: document.title, readyState: document.readyState,
      text: fullText.slice(offset, end), textScope: mainText ? 'main content' : 'page',
      textOffset: offset, totalTextLength: fullText.length, nextOffset: end < fullText.length ? end : null,
      textTruncated: end < fullText.length,
      elements: Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]')).filter(e => e.getClientRects().length).slice(0,150).map((e,i) => {
        const token = ${JSON.stringify(id)} + '-' + i; e.setAttribute('data-exomina-node',token);
        return {index:i,tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||e.getAttribute('placeholder')||'').slice(0,120),selector:'[data-exomina-node="'+token+'"]',href:e.href||undefined};
      }) };
  })()`;
}

export function actionSource(command) {
  const { action, input, expiresAt } = command;
  if (!/^\[data-exomina-node="[\w-]+"\]$/.test(input.selector || '')) throw Error('Read a fresh browser snapshot and use one of its selectors.');
  return `(() => {
    if(Date.now()>${expiresAt})throw Error('This browser action expired.');
    const e=document.querySelector(${JSON.stringify(input.selector)});if(!e)throw Error('The page changed. Read a new snapshot first.');
    e.scrollIntoView({block:'center'});e.focus();
    ${action === 'type' ? `if(!('value' in e)&&!e.isContentEditable)throw Error('Target is not editable');if(e.isContentEditable)e.textContent=${JSON.stringify(input.text)};else{const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const d=Object.getOwnPropertyDescriptor(p,'value');if(d?.set)d.set.call(e,${JSON.stringify(input.text)});else e.value=${JSON.stringify(input.text)};}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true;` : `const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};`}
  })()`;
}
