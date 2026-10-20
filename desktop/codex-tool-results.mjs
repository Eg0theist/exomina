const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_WIRE_BYTES = 32 * 1024 * 1024;

/** Preserve MCP observations through Codex's text/image/audio-only response contract.
 * Resource metadata is source data: it is never fetched or executed here. */
export function codexToolResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.content)) throw Error('The tool returned an invalid MCP result.');
  const contentItems = [];
  let textBytes = 0, unsupported = false;
  const text = value => {
    if (typeof value !== 'string') throw Error('The tool returned invalid text content.');
    textBytes += Buffer.byteLength(value);
    if (textBytes > MAX_TEXT_BYTES) throw Error('The tool result exceeds the 8 MiB text limit. Request a smaller read or a bounded snapshot.');
    contentItems.push({ type: 'inputText', text: value });
  };
  const metadata = value => JSON.stringify(value);
  for (const block of result.content) {
    if (!block || typeof block !== 'object') throw Error('The tool returned an invalid content block.');
    if (block.type === 'text') text(block.text);
    else if (block.type === 'image' || block.type === 'audio') {
      if (typeof block.mimeType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(block.mimeType) || typeof block.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw Error('The tool returned invalid media content.');
      contentItems.push(block.type === 'image'
        ? { type: 'inputImage', imageUrl: `data:${block.mimeType};base64,${block.data}` }
        : { type: 'inputAudio', audioUrl: `data:${block.mimeType};base64,${block.data}` });
    } else if (block.type === 'resource_link') {
      const { name, title, uri, description, mimeType, size } = block;
      text(metadata({ type: 'resource_link', name, title, uri, description, mimeType, size }));
    } else if (block.type === 'resource') {
      const resource = block.resource;
      if (!resource || typeof resource !== 'object') throw Error('The tool returned an invalid embedded resource.');
      const { uri, mimeType } = resource;
      if (typeof resource.text === 'string') text(metadata({ type: 'resource', resource: { uri, mimeType, text: resource.text } }));
      else {
        unsupported = true;
        text(metadata({ type: 'resource', resource: { uri, mimeType }, limitation: 'Embedded binary resource was not delivered. Request supported text, image or audio content.' }));
      }
    } else {
      unsupported = true;
      text(`Unsupported MCP content type: ${String(block.type || 'unknown')}. This part of the result was not delivered.`);
    }
  }
  if (result.structuredContent !== undefined) {
    if (!result.structuredContent || typeof result.structuredContent !== 'object' || Array.isArray(result.structuredContent)) throw Error('The tool returned invalid MCP structured content.');
    const serialized = metadata(result.structuredContent);
    // MCP servers sometimes include the same JSON in both representations.
    if (!contentItems.some(item => item.type === 'inputText' && item.text === serialized)) text(`MCP structured content (source data):\n${serialized}`);
  }
  if (unsupported) text('The tool returned, but some output could not be delivered. Its effects may already be complete. Inspect the target before repeating any action.');
  const converted = { success: !result.isError && !unsupported, contentItems };
  if (Buffer.byteLength(JSON.stringify(converted)) > MAX_WIRE_BYTES) throw Error('The tool result exceeds the 32 MiB native response limit. Request fewer images or a smaller read.');
  return converted;
}
