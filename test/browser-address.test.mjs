import test from 'node:test';
import assert from 'node:assert/strict';
import {browserAddressUrl} from '../desktop/browser-address.mjs';
test('address bar sends keywords and Unicode searches to Google',()=>{
 for(const term of ['ghidra mcp','Ghidra','C++ examples & symbols','Example City Weißer Hirsch','example.com help']) assert.equal(browserAddressUrl('  '+term+'  '),'https://www.google.com/search?q='+encodeURIComponent(term));
});
test('address bar recognises bare websites, paths, local ports and explicit URLs',()=>{
 const examples={'example.com':'https://example.com/','example.com/docs?q=hello#part':'https://example.com/docs?q=hello#part','localhost:3000/test':'http://localhost:3000/test','127.0.0.1:5678':'http://127.0.0.1:5678/','[::1]:8000':'http://[::1]:8000/','https://example.com/test':'https://example.com/test','HTTP://EXAMPLE.COM':'http://example.com/','bücher.de':'https://xn--bcher-kva.de/'};
 for(const [input,expected] of Object.entries(examples))assert.equal(browserAddressUrl(input),expected);
});
test('address bar refuses unsupported schemes and embedded credentials',()=>{
 for(const input of ['',null,'javascript:alert(1)','file:///C:/secret','data:text/html,hello','https://user:pass@example.com','https://'])assert.throws(()=>browserAddressUrl(input));
});
