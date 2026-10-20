import { validateServerConfig } from './external-mcp.mjs';

// Extensions are small local programs that speak MCP. The assistant can write one into the workspace and register it
// here, but nothing is saved until the person has seen the exact command, and nothing starts until they approve the launch.
export const MAX_EXTENSIONS = 20;
export const EXTENSION_TOOLS = [
  { name: 'extension_add', description: 'Register a local MCP program as an Exomina extension so its tools become available from the next message. Use it after writing the program yourself (for example a small Node script in the workspace) when the user asks for a capability Exomina lacks. The user is shown the exact command, arguments and environment and must approve both saving and starting it. Prefer node with a script path in the workspace; never register a program you have not shown the user.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'name', 'command', 'purpose'], properties: {
      id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$', description: 'Short identifier, unique among extensions.' },
      name: { type: 'string', minLength: 1, maxLength: 60, description: 'Name shown to the user.' },
      command: { type: 'string', minLength: 1, maxLength: 4096, description: 'Executable such as node, or a full path. Batch files are not allowed.' },
      args: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 32000 } },
      env: { type: 'object', additionalProperties: { type: 'string', maxLength: 32000 }, description: 'Optional environment variables. Never put secrets here.' },
      purpose: { type: 'string', minLength: 1, maxLength: 500, description: 'One or two sentences telling the user what the extension does and why.' } } } },
];

/** Validates a proposed extension against what is already installed; returns the record to store. */
export function extensionRecord(args, existing = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Provide the extension as an object.');
  const { id, name, command, purpose } = args;
  if(id==='cua')throw new Error('The cua identifier belongs to the built-in computer driver. Choose another id.');
  if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('Give the extension a name of up to 60 characters.');
  if (typeof purpose !== 'string' || !purpose.trim() || purpose.length > 500) throw new Error('Explain in up to 500 characters what the extension does.');
  const record = { id, name: name.trim(), command, ...(args.args?.length ? { args: args.args } : {}), ...(args.env && Object.keys(args.env).length ? { env: args.env } : {}), enabled: true };
  validateServerConfig(record);
  if(extensionSummary(record,purpose).length>22000)throw new Error('The complete launch preview must fit within 22,000 characters. Put long configuration in a reviewed workspace file.');
  if (existing.some(server => server.id === id)) throw new Error(`An extension called "${id}" already exists. Remove it under Tools → Extensions first, or choose another id.`);
  if (existing.length >= MAX_EXTENSIONS) throw new Error(`Exomina keeps at most ${MAX_EXTENSIONS} extensions. Remove one under Tools → Extensions first.`);
  return record;
}

/** The text the person approves: everything that will run, in full. */
export function extensionSummary(record, purpose) {
  return [`${record.name} (${record.id})`, '', purpose.trim(), '', `Runs: ${record.command}`, `Arguments: ${JSON.stringify(record.args ?? [])}`,
    ...(record.env ? [`Environment: ${JSON.stringify(record.env)}`] : []), '', 'It runs on this computer with your Windows account’s permissions. Only approve a program you have seen.'].join('\n');
}
