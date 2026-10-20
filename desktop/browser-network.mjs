// Use Chromium's TCP/TLS transport on networks that reject QUIC (HTTP/3).
// This must run before Electron is ready or creates a network service.
export function configureBrowserNetworking(app) {
  app.commandLine.appendSwitch('disable-quic');
}

export function browserLoadError(description) {
  const code = String(description || 'The page could not be loaded.');
  if (code.includes('ERR_QUIC_PROTOCOL_ERROR')) return 'The QUIC connection failed. If Exomina has a waiting browser update, reopen with it and reload the page. If this persists, check your network connection. (ERR_QUIC_PROTOCOL_ERROR)';
  if (code.includes('ERR_NETWORK_ACCESS_DENIED')) return 'Network access was denied. Check whether Windows, your security software or your network allows Exomina to connect. (ERR_NETWORK_ACCESS_DENIED)';
  if (code.includes('ERR_INTERNET_DISCONNECTED')) return 'The internet connection is offline. Reconnect, then reload this page. (ERR_INTERNET_DISCONNECTED)';
  return code;
}
