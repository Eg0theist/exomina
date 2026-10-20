import { randomUUID } from 'node:crypto';

export const CLAUDE_USAGE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--tools', '', '--no-session-persistence'];

/** The broad traffic switch also disables /usage. Permit this read while disabling telemetry/update traffic explicitly. */
export function claudeUsageEnvironment(sanitized) {
  const env = { ...sanitized, DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' };
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return env;
}

/** A metadata-only native control exchange. The runtime owns authentication. */
export function readClaudeUsage(child, timeout = 25_000) {
  return new Promise((resolve, reject) => {
    const initId = randomUUID(), usageId = randomUUID();
    let settled = false, buffer = '';
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    const timer = setTimeout(() => finish(new Error('Claude usage refresh timed out.')), timeout);
    child.stderr.resume();
    child.stdout.setEncoding('utf8');
    child.on('error', () => finish(new Error('Claude usage runtime could not start.')));
    child.on('close', () => finish(new Error('Claude closed before returning usage.')));
    child.stdin.on('error', () => finish(new Error('Claude usage runtime connection closed.')));
    child.stdout.on('data', chunk => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { finish(new Error('Claude returned oversized usage data.')); return; }
      let index;
      while (!settled && (index = buffer.indexOf('\n')) >= 0) {
        let message;
        try { message = JSON.parse(buffer.slice(0, index)); } catch { finish(new Error('Claude returned invalid usage data.')); return; }
        buffer = buffer.slice(index + 1);
        if (message.type === 'control_request') {
          send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Actions are unavailable during usage refresh.' } });
          continue;
        }
        if (message.type !== 'control_response') continue;
        const response = message.response;
        if (![initId, usageId].includes(response?.request_id)) continue;
        if (response.subtype === 'error') { finish(new Error('Claude could not complete its native usage request.')); return; }
        if (response.request_id === initId) {
          send({ type: 'control_request', request_id: usageId, request: { subtype: 'get_usage', skip_behaviors: true } });
          continue;
        }
        const result = response.response;
        if (!result?.rate_limits) {
          const error = new Error('Claude could not fetch subscription limits. Check its connection and try Refresh.');
          error.usageDiagnostic = { fields: Object.keys(result || {}), available: result?.rate_limits_available, subscriptionType: result?.subscription_type };
          finish(error); return;
        }
        finish(null, result);
      }
    });
    send({ type: 'control_request', request_id: initId, request: { subtype: 'initialize', hooks: null } });
  });
}
