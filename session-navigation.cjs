'use strict';
// This policy only preserves a known, owned tracing origin. It does not grant
// navigation permission: callers must still validate URLs with host-security.
function sessionNavigation(value, session) {
 const target=new URL(value);
 if(!session?.active||session.status!=='running'||!session.url)return {url:target.href,redirected:false};
 const managed=new URL(session.url);
 if(target.origin===managed.origin)return {url:target.href,redirected:false};
 if(session.urlMode==='separate'&&session.requestedUrl&&target.origin===new URL(session.requestedUrl).origin){
  return {url:managed.origin+target.pathname+target.search+target.hash,redirected:true};
 }
 throw Error('Stop the current tracing session before opening a different application. The preview must stay on the traced address.');
}
module.exports={sessionNavigation};
