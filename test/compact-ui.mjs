import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {_electron as electron} from 'playwright-core';
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),evidence=path.join(root,'evidence','compact-ui');
await mkdir(evidence,{recursive:true});
const env={...process.env,TRACE_ATLAS_TEST_PROFILE:'hud-'+Date.now()};delete env.ELECTRON_RUN_AS_NODE;delete env.ORIVO_START_MODE;
let app;
const checks=[],errors=[];
try{
 app=await electron.launch({executablePath:require('electron'),args:[root],env,timeout:30000});
 const shell=await app.firstWindow();shell.setDefaultTimeout(20000);shell.on('pageerror',e=>errors.push(e.message));
 await shell.locator('#coverage-badge').filter({hasText:'Element to column captured'}).waitFor();
 await shell.emulateMedia({reducedMotion:'reduce'});
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];if(w.isMaximized())w.unmaximize();w.setSize(1720,1050);});
 assert.ok(await shell.locator('#session-setup').isVisible(),'Tracing setup must be directly visible');
 await shell.locator('#session-setup').click();await shell.locator('#tracing-setup-dialog[open]').waitFor();
 await shell.keyboard.press('Escape');checks.push('Direct tracing setup works');
 const state=await shell.evaluate(()=>window.traceAtlas.getState());
 const id=await app.evaluate(({webContents},url)=>webContents.getAllWebContents().find(w=>w.getURL().startsWith(url)).id,state.url);
 await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`(()=>{const node=document.querySelector('[data-trace-id="price-orbit"]');function ProductCard(){};Object.defineProperty(node,'__reactFiber$hud',{value:{type:'strong',tag:5,_debugOwner:{tag:0,type:ProductCard,_debugSource:{fileName:location.origin+'/app.mjs',lineNumber:4,columnNumber:1}},_debugSource:{fileName:location.origin+'/app.mjs',lineNumber:4,columnNumber:3}},configurable:true});})()`),id);
 await shell.evaluate(()=>window.traceAtlas.capture('[data-trace-id="price-orbit"]'));
 await shell.locator('[data-inspector=components]').click();
 const component=shell.locator('.component-source').filter({hasText:'ProductCard'});
 await component.waitFor();assert.ok((await component.boundingBox()).height>=32);
 await component.click();assert.equal(await shell.locator('#detail-name').textContent(),'ProductCard');
 assert.equal(await component.getAttribute('aria-current'),'true');checks.push('Full component row opens verified source');
 async function screenshot(name){await shell.waitForTimeout(350);const image=await app.evaluate(async({BrowserWindow,desktopCapturer})=>{const w=BrowserWindow.getAllWindows()[0],b=w.getBounds(),sources=await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:b.width,height:b.height}}),s=sources.find(s=>s.id===w.getMediaSourceId());return(s&&!s.thumbnail.isEmpty()?s.thumbnail:await w.capturePage()).toPNG().toString('base64');});await writeFile(path.join(evidence,name),Buffer.from(image,'base64'));}
 for(const theme of ['dark','light']){
  await shell.locator('[data-appearance='+theme+']').click();
  await shell.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);
  assert.equal(await shell.locator('[data-appearance='+theme+']').getAttribute('aria-pressed'),'true');
  for(const selector of ['#session-setup','#trace-tools-button','#inspect-button'])assert.ok((await shell.locator(selector).boundingBox()).height>=28,selector+' must retain a compact usable hit area');
  assert.equal(await shell.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await screenshot('desktop-'+theme+'.png');
  if(theme==='dark'){await shell.locator('[data-inspector=components]').click();await screenshot('components-dark.png');await shell.locator('[data-inspector=source]').click();}
 }
 checks.push('Both themes preserve control hit areas and desktop layout');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(1100,700));await shell.waitForTimeout(400);
 assert.equal(await shell.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 for(const selector of ['#session-setup','#tab-map','#preview-surface','#refresh-trace','#play-trace'])assert.ok(await shell.locator(selector).isVisible(),selector+' must remain reachable');
 const vertical=await shell.evaluate(()=>({main:document.querySelector('.main-content').getBoundingClientRect().bottom,inspector:document.querySelector('.detail-panel').getBoundingClientRect().bottom}));
 assert.ok(vertical.inspector<=vertical.main+1,'Source inspector must fit vertically: '+JSON.stringify(vertical));
 const actions=await shell.evaluate(()=>{const parent=document.querySelector('.trace-toolbar').getBoundingClientRect();return ['refresh-trace','play-trace'].map(id=>{const box=document.getElementById(id).getBoundingClientRect();return {id,right:box.right,parentRight:parent.right};});});
 for(const action of actions)assert.ok(action.right<=action.parentRight+1,action.id+' must not be clipped');
 await shell.locator('[data-inspector=components]').click();assert.ok(await component.isVisible(),'Components remain reachable at minimum size');
 await screenshot('minimum-light.png');checks.push('Minimum desktop size retains navigation and native preview');
 assert.deepEqual(errors,[]);
 await writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:true,checks,errors},null,2));console.log(JSON.stringify({passed:true,checks,evidence}));
}catch(error){if(app){const page=await app.firstWindow();await page.screenshot({path:path.join(evidence,'failure.png')});console.log(await page.evaluate(()=>Object.fromEntries(['.workbench','.app-sidebar','.main-content','#session-setup','#sidebar-sash'].map(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return[selector,{x:r.x,y:r.y,width:r.width,height:r.height,display:getComputedStyle(e).display,grid:getComputedStyle(e).gridColumn}];}))));}await writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:false,error:error.stack,checks},null,2));throw error;}
finally{if(app)await app.close();}
