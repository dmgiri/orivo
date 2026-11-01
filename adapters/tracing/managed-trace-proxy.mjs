import http from 'node:http';

// The browser receives only a random lookup key. The backend readiness token
// stays in the owned frontend process and is never included in page metadata.
export function managedTraceProxy({backendUrl, backendTraceToken}={}) {
  let target;
  try { target=new URL(backendUrl); } catch {}
  const enabled=target?.protocol==='http:'&&['127.0.0.1','[::1]'].includes(target.hostname)&&/^[A-Za-z0-9_-]{16,100}$/.test(backendTraceToken||'');
  return function handleTrace(request,response,next=()=>{}) {
    if(!String(request.url||'').startsWith('/__orivo_trace/')){next();return false;}
    const match=/^\/__orivo_trace\/([a-f0-9]{32})$/.exec(request.url);
    if(!enabled||request.method!=='GET'||!match){response.writeHead(404,{'Cache-Control':'no-store'});response.end();return true;}
    const endpoint=new URL('/__orivo_trace/'+backendTraceToken+'/'+match[1],target);
    const upstream=http.get(endpoint,{headers:{Accept:'application/json'},timeout:15000},reply=>{
      let length=0;const chunks=[];
      reply.on('data',chunk=>{length+=chunk.length;if(length>2*1024*1024){reply.destroy();return;}chunks.push(chunk);});
      reply.on('end',()=>{if(response.destroyed)return;response.writeHead(reply.statusCode===200?200:404,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(reply.statusCode===200?Buffer.concat(chunks):'{}');});
      reply.on('error',()=>{if(!response.destroyed&&!response.headersSent){response.writeHead(502,{'Cache-Control':'no-store'});response.end();}});
    });
    upstream.on('timeout',()=>upstream.destroy());
    upstream.on('error',()=>{if(!response.destroyed&&!response.headersSent){response.writeHead(502,{'Cache-Control':'no-store'});response.end();}});
    response.once('close',()=>upstream.destroy());
    return true;
  };
}
