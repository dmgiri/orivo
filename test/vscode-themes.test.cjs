'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
test('VS Code 2026 workbench maps official surface and editor colors',()=>{
 const themes=require('../renderer/themes.js'),official=require('../renderer/vscode-theme-data.js');
 assert.deepEqual(themes.workbenchPalettes.map(p=>p.id),['vscode-2026']);
 for(const mode of ['dark','light']){const colors=official[mode].colors,tokens=themes.tokens('vscode-2026',mode);if(mode==='dark'){assert.equal(tokens.page.toLowerCase(),colors['editor.background'].toLowerCase());assert.equal(tokens.panel.toLowerCase(),colors['sideBar.background'].toLowerCase());assert.equal(tokens.code.toLowerCase(),colors['editor.background'].toLowerCase());}assert.equal(tokens.button.toLowerCase(),colors['button.background'].toLowerCase());assert.ok(themes.contrast(tokens.ink,tokens.panel)>=4.5);assert.ok(themes.contrast(tokens['on-button'],tokens.button)>=4.5);}
});
test('azure light separates the canvas, cards and menus with readable text',()=>{
 const themes=require('../renderer/themes.js'),t=themes.tokens('vscode-2026','light');
 assert.equal(t.canvas,'#e7f1fa');assert.equal(t.panel,'#e3eff9');assert.equal(t.card,'#f8fbff');assert.notEqual(t.card,t.canvas);assert.notEqual(t.line,'#F0F1F2');
 for(const background of [t.panel,t.canvas,t.card,t.code])for(const foreground of [t.ink,t.muted,t.subtle])assert.ok(themes.contrast(foreground,background)>=4.5,foreground+' against '+background);
});
