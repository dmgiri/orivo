import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {_electron} from 'playwright-core';
const require=createRequire(import.meta.url),project=path.resolve(import.meta.dirname,'..');
const root=process.env.ORIVO_TEST_ROOT||project;
const product='Orivo';
const evidence=path.join(project,'evidence','theme-wave');await mkdir(evidence,{recursive:true});
const env={...process.env,TRACE_ATLAS_TEST_PROFILE:'wave-'+Date.now()};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:require('electron'),args:[root],env,timeout:30000});
const errors=[];
try{
 const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await page.locator('[data-appearance=light]').waitFor();
 for(const mode of ['light','dark']){
  await page.locator('[data-appearance='+mode+']').click();
  await page.waitForFunction(()=>document.getAnimations().some(a=>a.animationName==='theme-wave-reveal'));
  const pace=await page.evaluate(()=>{const root=document.documentElement,wave=document.getAnimations().find(a=>a.animationName==='theme-wave-reveal');wave.pause();const duration=wave.effect.getTiming().duration,radius=parseFloat(getComputedStyle(root).getPropertyValue('--theme-wave-radius'));const progress=()=>parseFloat(getComputedStyle(root,'::view-transition-new(root)').clipPath.match(/circle\(([\d.]+)/)[1])/radius;wave.currentTime=duration*.25;const early=progress();wave.currentTime=duration*.75;return {early,late:progress(),easing:wave.effect.getKeyframes()[0].easing,crest:document.getAnimations().find(a=>a.animationName==='theme-water-front').effect.getKeyframes()[0].easing};});
  assert.ok(pace.early<.2);assert.ok(pace.late-pace.early>pace.early*2);assert.equal(pace.easing,pace.crest);
  const phases=await page.evaluate(()=>{const root=document.documentElement,wave=document.getAnimations().find(a=>a.animationName==='theme-wave-reveal'),duration=wave.effect.getTiming().duration,radius=parseFloat(getComputedStyle(root).getPropertyValue('--theme-wave-radius'));return [.2,.6,.9].map(time=>{wave.currentTime=duration*time;return parseFloat(getComputedStyle(root,'::view-transition-new(root)').clipPath.match(/circle\(([\d.]+)/)[1])/radius;});});
  for(const [i,expected] of [.06,.42,.855].entries())assert.ok(Math.abs(phases[i]-expected)<.005,'Wave must follow slow / medium / fast timing');
  const frames=await page.evaluate(()=>{for(const a of document.getAnimations().filter(a=>a.animationName?.startsWith('theme-water-')||a.animationName==='theme-wave-reveal')){a.pause();a.currentTime=170;}return document.getAnimations().find(a=>a.animationName==='theme-wave-reveal').effect.getKeyframes().map(k=>k.clipPath);});
  assert.match(frames[0],/circle\(0px at 100% 0(?:px|%)\)/);assert.match(frames.at(-1),/at 100% 0(?:px|%)/);
  const water=await page.evaluate(()=>{const s=getComputedStyle(document.documentElement,'::view-transition-new(theme-water)');return {background:s.backgroundImage,radius:parseFloat(s.getPropertyValue('--water-front')),opacity:parseFloat(s.opacity)};});
  assert.match(water.background,/radial-gradient/);assert.ok(water.radius>0);assert.ok(water.opacity>0);
  assert.equal(await page.locator('#theme-water-surface').getAttribute('aria-hidden'),'true');
  assert.equal(await page.locator('#theme-water-surface').evaluate(n=>getComputedStyle(n).pointerEvents),'none');
  await page.screenshot({path:path.join(evidence,product.toLowerCase()+'-'+mode+'-wave.png')});
  await page.evaluate(()=>document.getAnimations().filter(a=>a.animationName?.startsWith('theme-water-')||a.animationName==='theme-wave-reveal').forEach(a=>a.finish()));
  await page.waitForFunction(()=>!document.documentElement.dataset.themeTransition);
  assert.equal(await page.locator('html').getAttribute('data-theme'),mode);
 }
 await page.evaluate(()=>{for(const mode of ['light','dark','light','dark','light'])document.querySelector('[data-appearance='+mode+']').click();});
 await page.waitForFunction(()=>!document.documentElement.dataset.themeTransition&&document.documentElement.dataset.theme==='light');
 assert.equal(await page.evaluate(()=>localStorage.getItem('trace-atlas-theme')),'light');
 assert.equal(await page.locator('[data-appearance=light]').getAttribute('aria-pressed'),'true');
 await page.emulateMedia({reducedMotion:'reduce'});await page.locator('[data-appearance=dark]').click();
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await page.evaluate(()=>document.getAnimations().some(a=>a.animationName==='theme-wave-reveal')),false);
 assert.equal(await page.locator('html').getAttribute('data-theme-transition'),null);
 await page.emulateMedia({reducedMotion:'no-preference'});await page.locator('[data-appearance=light]').focus();await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='light'&&!document.documentElement.dataset.themeTransition);
 assert.deepEqual(errors,[]);
 const result={passed:true,product,checks:['top-right circular reveal with shaded water crest and trailing ripples','noninteractive hidden-from-accessibility overlay','latest rapid click wins','preference and button state match','reduced motion immediate','keyboard activation'],rendererErrors:errors};
 await writeFile(path.join(evidence,product.toLowerCase()+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await app.close();}
