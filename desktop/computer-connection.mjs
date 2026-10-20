import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateServerConfig } from './external-mcp.mjs';

// Approval belongs to one driver command, arguments and environment. Editing an
// MCP connection cannot grant consent to a different executable or launch mode.
export function driverLaunchSignature(config) {
  validateServerConfig(config);
  const command = path.resolve(config.command);
  return createHash('sha256').update(JSON.stringify({
    id: config.id, command: process.platform === 'win32' ? command.toLowerCase() : command,
    args: config.args ?? [], env: Object.entries(config.env ?? {}).sort(([a], [b]) => a.localeCompare(b)),
  })).digest('hex');
}

export function approvedDriverLaunch(settings, config) {
  return config.id === 'cua' && config.enabled === true &&
    settings.cuaDriverApproval?.signature === driverLaunchSignature(config);
}

export function driverConfig(settings) {
  return settings.externalMcpServers?.find(server => server.id === 'cua');
}

// Bundled drivers follow the current install after updates. Custom driver paths
// stay where the user chose them. Only existing approval of a bundled command
// can follow the bundle; this never creates approval for a legacy connection.
export function followBundledDriver(settings, bundled) {
  const saved = settings.cuaDriverPath;
  const equal = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const custom = settings.cuaDriverBundled === false || settings.cuaDriverApproval?.bundled === false;
  const stale = saved && !custom && /[\\/]app\.asar\.unpacked[\\/]vendor[\\/]cua-driver[\\/]cua-driver\.exe$/i.test(saved) && !equal(saved, bundled);
  if (saved && !stale) return false;
  settings.cuaDriverPath = bundled;
  settings.cuaDriverBundled = true;
  const previous = driverConfig(settings);
  if (previous && saved && equal(previous.command, saved)) {
    const approved = settings.cuaDriverApproval?.bundled === true && approvedDriverLaunch(settings, previous);
    const next = { ...previous, command: bundled };
    settings.externalMcpServers = settings.externalMcpServers.map(server => server.id === 'cua' ? next : server);
    if (approved) settings.cuaDriverApproval = { signature: driverLaunchSignature(next), bundled: true };
  }
  return true;
}

export class ComputerConnection {
  constructor({ external, getSettings, changed = () => {}, reconnectDelay = 5000, maxDelay = 60000, setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { external, getSettings, changed, reconnectDelay, maxDelay, setTimer, clearTimer });
    this.stopped = true;
    this.timer = null;
    this.running = null;
    this.failures = 0;
  }

  start() {
    if (!this.stopped) return this.running ?? Promise.resolve();
    this.stopped = false;
    return this.check(true);
  }

  check(requestApproval = false) {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.clearTimer(this.timer);
    this.timer = null;
    this.running = (async () => {
      const settings = await this.getSettings(), config = driverConfig(settings);
      const entry = this.external.clients.get('cua');
      if (!config?.enabled) {
        if (entry) await this.external.refresh(undefined, { serverIds: ['cua'], requestApproval: false });
        this.failures = 0;
        return;
      }
      if (entry && !entry.client.dead && entry.signature === JSON.stringify(config) && this.external.status.some(server => server.id === 'cua' && server.connected)) { this.failures = 0; return; }
      // A legacy enabled connection may ask once on startup. A decline or a
      // changed command never causes a repeating popup in the retry loop.
      if (!requestApproval && !approvedDriverLaunch(settings, config)) return;
      const result = await this.external.refresh(undefined, { serverIds: ['cua'], requestApproval });
      this.failures = result.status.find(server => server.id === 'cua')?.connected ? 0 : this.failures + 1;
      await this.changed();
    })().catch(() => { this.failures++; }).finally(() => {
      this.running = null;
      if (!this.stopped) {
        const delay = Math.min(this.maxDelay, this.reconnectDelay * 2 ** Math.min(this.failures, 5));
        this.timer = this.setTimer(() => this.check(), delay);
        this.timer?.unref?.();
      }
    });
    return this.running;
  }

  close() {
    this.stopped = true;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}
