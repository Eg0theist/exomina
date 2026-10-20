import { chatFileTarget, chatFileAction } from './chat-link-open.mjs';

/** A window-owned native menu; cancellation performs no file action. */
export async function showChatFileMenu(input, { Menu, window, x, y, ...options }) {
  const target = await chatFileTarget(input, options, { allowMissing: true });
  if (window.isDestroyed()) throw new Error('The app window has closed.');
  return new Promise((resolve, reject) => {
    let selected = false, settled = false, menu;
    const finish = (result, error) => {
      if (settled) return;
      settled = true; window.removeListener('closed', closed);
      if (error) reject(error); else resolve(result);
    };
    const closed = () => { try { menu?.closePopup(window); } catch {} finish({ cancelled: true }); };
    const choose = async action => {
      if (selected || settled) return;
      selected = true;
      try { finish(await chatFileAction(input, options, action)); } catch (error) { finish(null, error); }
    };
    window.once('closed', closed);
    try {
      menu = Menu.buildFromTemplate([
        { label: 'Show in Explorer', enabled: !target.missing, click: () => choose('show') },
        { label: 'Open with default app', enabled: !target.missing, click: () => choose('open') },
        { label: 'Copy path', click: () => choose('copy') },
      ]);
      const bounds = window.getContentBounds();
      const position = {};
      if (Number.isFinite(x) && Number.isFinite(y)) {
        position.x = Math.max(0, Math.min(Math.round(x), bounds.width - 1));
        position.y = Math.max(0, Math.min(Math.round(y), bounds.height - 1));
      }
      menu.popup({ window, ...position, callback: () => { if (!selected) finish({ cancelled: true }); } });
    } catch (error) { finish(null, error); }
  });
}
