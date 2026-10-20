import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StdioMcpClient } from '../desktop/external-mcp.mjs';

const driverPath = fileURLToPath(new URL('../vendor/cua-driver/cua-driver.exe', import.meta.url));

function clientForFixture() {
  return new StdioMcpClient({
    id: 'cua-qa', command: driverPath, args: ['mcp'],
    env: { DO_NOT_TRACK: '1', CUA_TELEMETRY: '0', CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' },
  });
}

export async function inspectCuaSchemas() {
  const client = clientForFixture();
  try {
    const server = await client.connect();
    const tools = await client.listTools();
    return { server: server.serverInfo, protocol: server.protocolVersion, toolCount: tools.length, tools: tools.filter(({ name }) => ['get_window_state', 'click', 'type_text', 'verify_state'].includes(name)).map(({ name, inputSchema }) => ({ name, inputSchema })) };
  } finally { await client.close(); }
}

/**
 * ONLY call with PID/HWND read directly from the synthetic Electron fixture created
 * for QA. This does not enumerate apps/windows, select an inferred target, or call
 * any desktop-wide tool. Supply labels matching the synthetic fixture's own DOM.
 * A separate DOM assertion in the owning Electron test should verify the outcome.
 */
export async function runScopedCuaQa({ pid, windowId, expectedTitle, fieldLabel = 'CUA test field', buttonLabel = 'Apply CUA test', expectedText = 'Exomina CUA verified', expectedStatus = `Confirmed: ${expectedText}`, allowForeground = false }) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Supply the synthetic fixture process PID.');
  assert.ok(Number.isSafeInteger(windowId) && windowId > 0, 'Supply the synthetic fixture native HWND.');
  assert.ok(typeof expectedTitle === 'string' && /QA|fixture/i.test(expectedTitle), 'Supply the exact synthetic QA window title.');
  const client = clientForFixture();
  const target = { pid, window_id: windowId };
  const steps = [];
  const call = async (name, args) => {
    // Every action remains independently bound to the single verified window.
    const result = await client.request('tools/call', { name, arguments: { ...target, ...args } });
    if (result.isError) throw new Error(`${name}: ${result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n')}`);
    return result;
  };
  const snapshot = async (screenshot = false) => {
    const result = await call('get_window_state', { include_screenshot: screenshot, include_accessibility_tree: true, max_elements: 250, max_depth: 20, timeout_ms: 5000 });
    const state = result.structuredContent;
    assert.ok(state, 'CUA must return structured window state.');
    assert.equal(state.pid, pid, 'Returned process must be the synthetic fixture.');
    assert.equal(state.window_id, windowId, 'Returned window must be the synthetic fixture.');
    assert.equal(state.window_title, expectedTitle, 'Stop if the exact synthetic window title changed.');
    return { result, state };
  };
  const exactElement = (state, label, kind) => {
    const named = state.elements?.filter((element) => element.label === label && element.element_token) ?? [];
    const matching = named.filter((element) => kind === 'field' ? /edit|input|textbox|text.?field/i.test(element.role) : /button/i.test(element.role));
    assert.equal(matching.length, 1, `Expected exactly one current ${kind} labelled "${label}". Candidates: ${JSON.stringify(named.map(({role,actions,value})=>({role,actions,value})))}`);
    return matching[0];
  };
  try {
    await client.connect();
    await snapshot(false); // Check the exact synthetic title before capturing pixels.
    const before = await snapshot(true);
    const images = before.result.content.filter((item) => item.type === 'image');
    assert.ok(images.length > 0, 'The exact synthetic window must produce an image.');
    steps.push({ step: 'capture', imageCount: images.length, elementCount: before.state.elements.length });
    const field = exactElement(before.state, fieldLabel, 'field');
    let typed;
    try { typed = await call('type_text', { element_token: field.element_token, text: expectedText, delivery_mode: 'background' }); }
    catch (error) {
      steps.push({ step: 'type-background-refusal', error: error.message });
      if (!allowForeground || !error.message.includes('Background delivery is not available')) throw error;
      const retryState = await snapshot(false);
      const retryField = exactElement(retryState.state, fieldLabel, 'field');
      typed = await call('type_text', { element_token: retryField.element_token, text: expectedText, delivery_mode: 'foreground' });
    }
    steps.push({ step: 'type', result: typed.structuredContent });
    const afterType = await snapshot(false);
    const typedField = exactElement(afterType.state, fieldLabel, 'field');
    assert.equal(typedField.value, expectedText, 'Fresh UIA readback must contain the exact typed text.');
    const button = exactElement(afterType.state, buttonLabel, 'button');
    let clicked;
    try { clicked = await call('click', { element_token: button.element_token, delivery_mode: 'background' }); }
    catch (error) {
      steps.push({ step: 'click-background-refusal', error: error.message });
      if (!allowForeground || !error.message.includes('Background delivery is not available')) throw error;
      const retryState = await snapshot(false);
      const retryButton = exactElement(retryState.state, buttonLabel, 'button');
      clicked = await call('click', { element_token: retryButton.element_token, delivery_mode: 'foreground' });
    }
    steps.push({ step: 'click', result: clicked.structuredContent });
    const afterClick = await snapshot(false);
    assert.ok(afterClick.state.elements.some((element) => element.label === expectedStatus || element.value === expectedStatus), 'The button must update the synthetic confirmation text.');
    return { passed: true, target: { pid, windowId, expectedTitle }, steps, expectedText, expectedStatus };
  } catch (error) { error.cuaSteps = steps; throw error; }
  finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // Default invocation is metadata only. It never captures any app or screen.
  console.log(JSON.stringify(await inspectCuaSchemas(), null, 2));
}
