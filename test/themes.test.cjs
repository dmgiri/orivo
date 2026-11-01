const test=require('node:test'),assert=require('node:assert/strict');
const pack=require('../renderer/themes.js');
test('legacy reference palettes and original Archify presets produce readable light and dark theme tokens',()=>{
 assert.equal(pack.palettes.length,9);assert.equal(new Set(pack.palettes.map(p=>p.id)).size,9);
 assert.deepEqual(pack.globalPalettes.map(p=>p.id),['classic','signal-flow','blueprint','editorial']);
 for(const palette of [...pack.palettes,...pack.globalPalettes])for(const mode of ['light','dark']){
  const t=pack.tokens(palette.id,mode);for(const [key,color]of Object.entries(t))assert.match(color,/^#[a-f\d]{6}$/i,palette.id+' '+key);
  for(const key of ['ink','muted','subtle','accent'])assert.ok(pack.contrast(t[key],t.panel)>=4.5,palette.id+' '+mode+' '+key);
  assert.ok(pack.contrast(t['on-accent'],t.accent)>=4.5,palette.id+' button contrast');
  for(const key of ['keyword','string','number','comment'])assert.ok(pack.contrast(t[key],t.code)>=4.5,palette.id+' code '+key);
 }
});
test('invalid palette selection safely falls back to the forest theme',()=>{assert.deepEqual(pack.tokens('unknown'),pack.tokens('forest'));});
