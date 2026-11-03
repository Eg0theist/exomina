// MCP text content must be a string. Some Electron APIs reject with values that are not
// Error objects (or with empty messages), which would otherwise yield `text: undefined`
// and a result that fails the client's schema validation.
export function toolErrorText(error) {
  const text = typeof error === 'string' ? error : error?.message;
  return typeof text === 'string' && text.trim() ? text : 'The tool failed without an error message.';
}

export const toolErrorResult = error => ({ isError: true, content: [{ type: 'text', text: toolErrorText(error) }] });
