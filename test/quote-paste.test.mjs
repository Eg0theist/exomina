import test from 'node:test';
import assert from 'node:assert/strict';
import {quotePaste} from '../src/quote-paste.js';
test('multiline paste continues a quote across paragraphs and CRLF',()=>{
 const result=quotePaste('> ',2,2,'First\r\nSecond\r\n\r\nLast');assert.equal(result.value,'> First\n> Second\n> \n> Last');assert.equal(result.caret,result.value.length);
});
test('nested quote paste preserves its depth and does not double existing markers',()=>{
 assert.equal(quotePaste('>> ',3,3,'Alpha\nBeta').value,'>> Alpha\n>> Beta');
 assert.equal(quotePaste('> ',2,2,'> Alpha\n> Beta').value,'> Alpha\n> Beta');
});
test('quote paste replaces a selection and preserves surrounding content',()=>{
 const value='before\n> replace me\nafter',start=value.indexOf('replace');const result=quotePaste(value,start,start+10,'one\ntwo');assert.equal(result.value,'before\n> one\n> two\nafter');assert.equal(result.value.slice(result.caret),'\nafter');
});
test('ordinary paste, single lines and fenced examples keep native behavior',()=>{
 assert.equal(quotePaste('plain',5,5,'a\nb'),null);assert.equal(quotePaste('> ',2,2,'single'),null);
 assert.equal(quotePaste('```text\n> ',10,10,'a\nb'),null);assert.equal(quotePaste('~~~\n> ',6,6,'a\nb'),null);
});
