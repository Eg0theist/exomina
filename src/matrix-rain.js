// Decorative rain runs independently of React and never captures pointer input.
const GLYPHS = [...'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜ012345789:<>'];

export function startMatrixRain(canvas, { motion, green, bright, subscribeVisibility }) {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return () => {};
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0, height = 0, columns = [], request = 0, timer = 0, last = 0, elapsed = 0, disposed = false, windowVisible = true;
  const still = () => motion === 'reduced' || reduced.matches;
  const drawable = () => windowVisible && !document.hidden && width > 0 && height > 0;
  const animated = () => drawable();
  const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
  function cacheColumn(column,ratio) {
    const image=column.image ||= document.createElement('canvas');
    image.width=Math.ceil(column.size*2*ratio);image.height=Math.ceil((column.length+1)*column.size*ratio);
    const ink=image.getContext('2d');ink.setTransform(ratio,0,0,ratio,0,0);
    ink.textAlign='center';ink.font=`${column.size}px 'Cascadia Mono', Consolas, monospace`;
    for(let j=0;j<column.length;j++){
      ink.globalAlpha=column.alpha*Math.pow(1-j/column.length,1.35);ink.fillStyle=j===0?bright:green;
      ink.fillText(column.glyphs[j],column.size,(column.length-j)*column.size);
    }
    column.ratio=ratio;
  }
  function populate() {
    const bounds = canvas.getBoundingClientRect();
    width = Math.round(bounds.width); height = Math.round(bounds.height);
    // Cap backing resolution on high-DPI ultrawide displays.
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(4000000 / Math.max(1, width * height)));
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    columns = Array.from({ length: Math.min(180, Math.ceil(width / 23)) }, (_, i) => {
      const size = i % 3 === 0 ? 18 : 14, length = 10 + Math.floor(Math.random() * 16);
      return { x: i * 23 + 8, y: Math.random() * (height + 400), size, length,
        speed: 28 + Math.random() * 46, alpha: i % 3 === 0 ? .55 : .25,
        glyphs: Array.from({ length }, randomGlyph) };
    });
    for(const column of columns)cacheColumn(column,ratio);
  }
  function draw(seconds) {
    context.clearRect(0, 0, width, height);
    for (const column of columns) {
      column.y += column.speed * seconds;
      if (column.y - column.length * column.size > height) column.y = -column.size;
      context.drawImage(column.image,column.x-column.size,column.y-column.length*column.size,column.size*2,(column.length+1)*column.size);
    }
    context.globalAlpha = 1;
  }
  function tick(now) {
    request = 0;
    if (disposed || still() || !animated()) return;
    if (!last) last = now-1000/24;
    const delta = Math.min((now - last) / 1000, .15);
    if (delta >= 1 / 24) {
      draw(delta); last = now; elapsed += delta;
      if (elapsed > .16) {
        elapsed = 0;
        for (const column of columns) if (Math.random() < .22) {column.glyphs[Math.floor(Math.random() * column.length)] = randomGlyph();cacheColumn(column,column.ratio);}
      }
    }
    timer=setTimeout(()=>{timer=0;request=requestAnimationFrame(tick);},1000/24);
  }
  function sync() {
    cancelAnimationFrame(request);clearTimeout(timer); request = 0;timer=0; last = 0;
    const paused = still() || !animated();
    canvas.dataset.state = still() ? 'static' : paused ? 'paused' : 'running';
    if (drawable()) draw(0);
    if (!paused && !disposed) request = requestAnimationFrame(tick);
  }
  const observer = new ResizeObserver(() => { populate(); sync(); });
  observer.observe(canvas);
  const onVisibility = () => sync();
  reduced.addEventListener('change', sync);
  document.addEventListener('visibilitychange', onVisibility);
  populate(); sync();
  // Native hide/minimize events also stop drawing when a debugging or capture
  // session keeps Chromium's document visibility pinned to visible.
  const unsubscribeVisibility = subscribeVisibility?.(visible => { windowVisible = visible; sync(); });
  return () => {
    disposed = true; cancelAnimationFrame(request);clearTimeout(timer); observer.disconnect();
    unsubscribeVisibility?.();
    reduced.removeEventListener('change', sync);
    document.removeEventListener('visibilitychange', onVisibility);
    for(const column of columns){column.image.width=0;column.image.height=0;}
  };
}
