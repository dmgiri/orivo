'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {sessionNavigation}=require('../session-navigation.cjs');
const {runtimeProbe}=require('../page-runtime.cjs');
const vm=require('node:vm');
const managed={active:true,status:'running',url:'http://127.0.0.1:62000/#dashboard',requestedUrl:'http://localhost:5173/',urlMode:'separate'};
test('original development origin routes to managed instrumentation retaining the requested route',()=>{
 assert.deepEqual(sessionNavigation('http://localhost:5173/guests?q=ada#details',managed),{url:'http://127.0.0.1:62000/guests?q=ada#details',redirected:true});
});
test('managed navigation stays on its origin and does not reuse an old route',()=>{
 assert.deepEqual(sessionNavigation('http://127.0.0.1:62000/rooms',managed),{url:'http://127.0.0.1:62000/rooms',redirected:false});
});
test('unrelated origin cannot silently abandon a running managed session',()=>{
 for(const url of ['http://localhost:5174/','http://localhost.evil.test:5173/','http://127.0.0.1:5173/'])assert.throws(()=>sessionNavigation(url,managed),/Stop the current tracing session/);
});
test('inactive sessions allow another app and invalid URLs remain invalid',()=>{
 for(const session of [null,{...managed,active:false},{...managed,status:'failed'}])assert.equal(sessionNavigation('http://localhost:5174/',session).url,'http://localhost:5174/');
 assert.throws(()=>sessionNavigation('invalid',managed));
});
test('runtime probe checks the real WeakMap contract without invoking getters',()=>{
 assert.equal(vm.runInNewContext(runtimeProbe,{}),false);
 assert.equal(vm.runInNewContext(runtimeProbe,{__studioElementFlowV1:{}}),false);
 assert.equal(vm.runInNewContext(runtimeProbe,{__studioElementFlowV1:new WeakMap()}),true);
 const sandbox={};Object.defineProperty(sandbox,'__studioElementFlowV1',{get(){throw Error('must not execute');}});
 assert.equal(vm.runInNewContext(runtimeProbe,sandbox),false);
});
