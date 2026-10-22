export const TITLEBAR_HEIGHT = 40;

/** Native controls retain Windows snapping while the app draws the surrounding header. */
export function windowChromeOptions({ borderless = true, ground, ink, platform = process.platform }) {
  if (!borderless) return {};
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset' };
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: ground, symbolColor: ink, height: TITLEBAR_HEIGHT } };
}

export function windowChromeState(win, { borderless, platform = process.platform }) {
  return { borderless, nativeControls: true, platform, maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() };
}

const CLEAR = '#00000000';

/** Hide HUD clears the caption strip entirely; 'peek' shows only the buttons while the pointer is near the top edge. */
export function applyWindowChromeTheme(win, { borderless, ground, ink, hud = null, platform = process.platform }) {
  if (!borderless || platform === 'darwin' || win.isDestroyed()) return;
  const color = hud === 'hidden' || hud === 'peek' ? CLEAR : ground, symbolColor = hud === 'hidden' ? CLEAR : ink;
  win.setTitleBarOverlay({ color, symbolColor, height: TITLEBAR_HEIGHT });
}

export const windowHudMode = value => value === 'hidden' || value === 'peek' ? value : null;

export function windowChromeCommand(win, action) {
  if (win.isDestroyed()) throw Error('The app window is closed.');
  if (action === 'minimize') win.minimize();
  else if (action === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close();
  else throw Error('Unknown window action.');
}
