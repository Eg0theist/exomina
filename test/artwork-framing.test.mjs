import test from 'node:test';
import assert from 'node:assert/strict';
import {cyberpunkFrame} from '../src/artwork-framing.js';
import {THEMES} from '../desktop/themes.mjs';

test('selected Cyberpunk portraits stay beside reading surfaces at normal and ultrawide sizes',()=>{
  for(const theme of THEMES.filter(theme=>theme.artworkFrame?.kind==='character'))for(const [width,height,readingRight] of [[1180,948,946],[2666,771,1743]]){
    const g=cyberpunkFrame({width,height,readingRight,frame:theme.artworkFrame});
    const left=g.left+theme.artworkFrame.face[0]*g.imageWidth,right=g.left+theme.artworkFrame.face[2]*g.imageWidth;
    assert.ok(left>=readingRight+15.99,theme.id);assert.ok(right<=width-15.99,theme.id);assert.ok(Math.abs(g.imageWidth/g.imageHeight-16/9)<1e-9);
  }
});
test('full-width reading and a narrow browser split produce finite undistorted artwork',()=>{
  for(const theme of THEMES.filter(theme=>theme.id.startsWith('cyberpunk-')))for(const width of [320,740,1180]){
    const g=cyberpunkFrame({width,height:820,readingRight:width,frame:theme.artworkFrame});
    assert.ok(Object.values(g).every(Number.isFinite));assert.ok(g.imageWidth>0&&g.imageHeight>0);assert.ok(Math.abs(g.imageWidth/g.imageHeight-16/9)<1e-9);
  }
});
