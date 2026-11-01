'use strict';
// Read the established adapter contract without invoking application getters.
const runtimeProbe=`(()=>{try{const map=Object.getOwnPropertyDescriptor(globalThis,'__studioElementFlowV1')?.value;WeakMap.prototype.has.call(map,{});return true;}catch{return false;}})()`;
module.exports={runtimeProbe};
