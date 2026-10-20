const status = document.querySelector('#status');
document.querySelector('#connect').addEventListener('submit', async event => {
  event.preventDefault(); status.textContent = 'Connecting…';
  try {
    const result = await chrome.runtime.sendMessage({ action: 'pair', code: document.querySelector('#code').value.trim() });
    if (result.error) throw Error(result.error);
    document.querySelector('#code').value = ''; status.textContent = 'Connected. Return to Exomina and choose “Use my browser”.';
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#disconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'disconnect' }); status.textContent = 'Disconnected from this browser.';
});
const saved = await chrome.storage.local.get('connection');
if (saved.connection) status.textContent = 'This browser is paired with Exomina. Keep Exomina open to use browser tools.';
await chrome.runtime.sendMessage({ action: 'wake' });
