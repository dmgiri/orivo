/* A projection of captured evidence. This module never fills in missing links. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OrivoTraceView = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const STAGES = Object.freeze({element:'UI ELEMENT',frontend:'FRONTEND',api:'API REQUEST',backend:'BACKEND',query:'SQL QUERY',mapping:'RESPONSE MAPPING',model:'ORM MODEL',database:'DATA ORIGIN',gap:'COVERAGE GAP',execution:'CAPTURED EXECUTIONS'});
  const copy = value => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item]) => [key,copy(item)])) : value;
  const setOf = value => value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);
  const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const countExecutions = node => node.kind === 'query' ? Math.max(1,Number.isFinite(Number(node.meta?.executionCount))?Math.floor(Number(node.meta.executionCount)):node.meta?.queryIds?.length||1) : 0;
  const missing = node => node.kind === 'gap' || node.status === 'missing';
  const failed = node => node.meta?.failed === true || ['error','failed'].includes(node.status);
  function stage(node) {
    if (node.viewType === 'execution') return 'execution';
    if (node.kind === 'source') return ['response-mapping','response-collection'].includes(node.meta?.sourceRole) ? 'mapping' : node.meta?.sourceRole === 'backend-call'||node.file?.endsWith('.py') ? 'backend' : 'frontend';
    return Object.hasOwn(STAGES,node.kind) ? node.kind : 'backend';
  }
  function adjacency(nodes,edges) {
    const forward=new Map(nodes.map(node=>[node.id,[]])),reverse=new Map(nodes.map(node=>[node.id,[]]));
    for (const edge of edges) if (forward.has(edge.from)&&forward.has(edge.to)) {forward.get(edge.from).push(edge.to);reverse.get(edge.to).push(edge.from);}
    return {forward,reverse};
  }
  function visit(ids,adj,blocked=new Set()) {
    const seen=new Set(ids),pending=[...seen];
    for (let i=0;i<pending.length;i++) {
      const id=pending[i];if(blocked.has(id))continue;
      for(const next of adj.get(id)||[])if(!seen.has(next)){seen.add(next);pending.push(next);}
    }
    return seen;
  }
  function rootsFor(nodes,reverse) {
    const elements=nodes.filter(node=>node.kind==='element').map(node=>node.id);
    return elements.length ? elements : nodes.filter(node=>!(reverse.get(node.id)||[]).length).map(node=>node.id);
  }
  function focusProjection(nodes,edges,scope) {
    const safeNodes=nodes.filter(node=>!missing(node)),safeIds=new Set(safeNodes.map(node=>node.id)),safeEdges=edges.filter(edge=>safeIds.has(edge.from)&&safeIds.has(edge.to));
    const safe=adjacency(safeNodes,safeEdges),all=adjacency(nodes,edges),roots=rootsFor(safeNodes,safe.reverse),reachable=visit(roots,safe.forward);
    const origins=safeNodes.filter(node=>node.kind==='database'&&reachable.has(node.id)).map(node=>node.id),available=origins.length>0;
    if(scope!=='field'||!available)return {ids:new Set(nodes.map(node=>node.id)),available,applied:false,originIds:origins};
    const keep=visit(origins,safe.reverse),proven=new Set(keep);
    for(const id of visit(safeNodes.filter(node=>node.meta?.localValue===true).map(node=>node.id),safe.reverse))keep.add(id);
    for(const id of roots)keep.add(id);
    // Failures and unresolved branches remain visible even when another field has a verified origin.
    const problems=nodes.filter(node=>missing(node)||failed(node)).map(node=>node.id);
    for(const id of visit(problems,all.reverse))keep.add(id);
    for(const api of nodes.filter(node=>node.kind==='api'&&!proven.has(node.id))) {
      for(const id of visit([api.id],all.forward))keep.add(id);
      for(const id of visit([api.id],all.reverse))keep.add(id);
    }
    return {ids:keep,available,applied:keep.size<nodes.length,originIds:origins};
  }
  function executionItems(node) {
    const records=new Map(),ids=[];
    for(const entry of Array.isArray(node.meta?.executions)?node.meta.executions:[])if(entry&&typeof entry.id==='string'&&entry.id&&!records.has(entry.id)){records.set(entry.id,entry);ids.push(entry.id);}
    for(const id of Array.isArray(node.meta?.queryIds)?node.meta.queryIds:[])if(typeof id==='string'&&id&&!records.has(id)){records.set(id,{id});ids.push(id);}
    if(!ids.length&&typeof node.meta?.queryId==='string'){records.set(node.meta.queryId,{id:node.meta.queryId});ids.push(node.meta.queryId);}
    return ids.map(id=>records.get(id));
  }
  function expandQueries(nodes,edges,expanded) {
    const output=[...nodes],relations=[...edges],used=new Set(nodes.map(node=>node.id));
    for(const group of nodes) {
      if(group.kind!=='query'||!expanded.has(group.sourceNodeId))continue;
      const items=executionItems(group);if(items.length<2&&countExecutions(group)<2)continue;
      group.view={...group.view,expanded:true,availableExecutions:items.length};
      for(const [i,record] of items.entries()) {
        let id=`view-execution:${group.id}:${i}`;while(used.has(id))id+=':';used.add(id);
        const meta=copy(group.meta||{});
        for(const key of ['executions','durationMs','totalDurationMs','minDurationMs','maxDurationMs','measuredCount','startOffsetMs'])delete meta[key];
        Object.assign(meta,{queryId:record.id,queryIds:[record.id],executionId:record.id,executionCount:1});
        if(measured(record.durationMs))meta.durationMs=record.durationMs;
        if(measured(record.startOffsetMs))meta.startOffsetMs=record.startOffsetMs;
        const item={...copy(group),id,sourceNodeId:group.sourceNodeId,viewType:'execution',groupId:group.id,label:'Captured execution',subtitle:record.id,detail:'One captured execution belonging to this SQL group. Membership does not imply an execution order.',meta,view:{execution:true,executionRecord:copy(record)}};
        output.push(item);relations.push({id:`view-membership:${id}`,from:group.id,to:id,label:'captured execution',relation:'execution-member',sourceNodeId:group.sourceNodeId});
      }
    }
    return {nodes:output,edges:relations};
  }
  // Strongly connected components keep malformed/cyclic evidence finite without dropping its edges.
  function ranksFor(nodes,edges) {
    const {forward,reverse}=adjacency(nodes,edges),seen=new Set(),finished=[];
    for(const node of nodes) {
      if(seen.has(node.id))continue;seen.add(node.id);const stack=[[node.id,0]];
      while(stack.length){const frame=stack.at(-1),children=forward.get(frame[0]);if(frame[1]<children.length){const id=children[frame[1]++];if(!seen.has(id)){seen.add(id);stack.push([id,0]);}}else{finished.push(frame[0]);stack.pop();}}
    }
    const component=new Map(),groups=[];
    for(let i=finished.length-1;i>=0;i--){const id=finished[i];if(component.has(id))continue;const index=groups.length,members=[],pending=[id];component.set(id,index);for(let j=0;j<pending.length;j++){const next=pending[j];members.push(next);for(const parent of reverse.get(next))if(!component.has(parent)){component.set(parent,index);pending.push(parent);}}groups.push(members);}
    const children=groups.map(()=>new Set()),indegree=groups.map(()=>0),ranks=groups.map(()=>0);
    for(const edge of edges){const a=component.get(edge.from),b=component.get(edge.to);if(a!==b&&!children[a].has(b)){children[a].add(b);indegree[b]++;}}
    const pending=indegree.flatMap((n,i)=>n===0?[i]:[]);
    for(let i=0;i<pending.length;i++){const a=pending[i];for(const b of children[a]){ranks[b]=Math.max(ranks[b],ranks[a]+1);if(--indegree[b]===0)pending.push(b);}}
    return new Map(nodes.map(node=>[node.id,ranks[component.get(node.id)]]));
  }
  function path(points) {
    const clean=[];
    for(const point of points){const last=clean.at(-1);if(last&&last.x===point.x&&last.y===point.y)continue;const prior=clean.at(-2);if(prior&&((prior.x===last.x&&last.x===point.x)||(prior.y===last.y&&last.y===point.y)))clean.pop();clean.push(point);}
    return {points:clean,d:clean.map((p,i)=>`${i?'L':'M'}${p.x} ${p.y}`).join(' ')};
  }
  function crosses(points,positions,a,b) {
    for(let i=1;i<points.length;i++)for(const p of positions){if(p===a||p===b)continue;const u=points[i-1],v=points[i];if(u.x===v.x&&u.x>p.x&&u.x<p.x+p.w&&Math.max(u.y,v.y)>p.y&&Math.min(u.y,v.y)<p.y+p.h)return true;if(u.y===v.y&&u.y>p.y&&u.y<p.y+p.h&&Math.max(u.x,v.x)>p.x&&Math.min(u.x,v.x)<p.x+p.w)return true;}
    return false;
  }
  function route(edge,a,b,positions,bands,gapX) {
    let points;
    if(a===b)points=[{x:a.x+a.w,y:a.y+a.h/2-14},{x:a.x+a.w+gapX/2,y:a.y+a.h/2-14},{x:a.x+a.w+gapX/2,y:a.y+a.h/2+14},{x:a.x+a.w,y:a.y+a.h/2+14}];
    if(!points&&a.y===b.y){const right=b.x>a.x;points=[{x:right?a.x+a.w:a.x,y:a.y+a.h/2},{x:right?b.x:b.x+b.w,y:b.y+b.h/2}];if(crosses(points,positions,a,b))points=null;}
    if(!points&&a.x===b.x&&a.y!==b.y){const down=b.y>a.y;const candidate=[{x:a.x+a.w/2,y:down?a.y+a.h:a.y},{x:b.x+b.w/2,y:down?b.y:b.y+b.h}];if(!crosses(candidate,positions,a,b))points=candidate;}
    if(!points){
      const right=b.x>=a.x,sideA=right?a.x+a.w:a.x,sideB=a.x===b.x?b.x+b.w:right?b.x:b.x+b.w;
      const ca=sideA+(right?1:-1)*gapX/2,cb=sideB+(a.x===b.x||!right?1:-1)*gapX/2;
      const start={x:sideA,y:a.y+a.h/2},end={x:sideB,y:b.y+b.h/2};
      if(a.band===b.band&&Math.abs(a.col-b.col)===1){const mid=(sideA+sideB)/2;points=[start,{x:mid,y:start.y},{x:mid,y:end.y},end];}
      else{const rail=bands[a.band].bottom+18;points=[start,{x:ca,y:start.y},{x:ca,y:rail},{x:cb,y:rail},{x:cb,y:end.y},end];}
    }
    const routed=path(points);let longest=-1,labelX=0,labelY=0;
    for(let i=1;i<routed.points.length;i++){const a=routed.points[i-1],b=routed.points[i],length=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);if(length>longest){longest=length;labelX=(a.x+b.x)/2;labelY=(a.y+b.y)/2+(a.y===b.y?-9:0);if(a.x===b.x)labelX+=32;}}
    return {edge,...routed,labelX,labelY,lx:labelX,ly:labelY};
  }
  function layout(nodes,edges,options) {
    const w=Math.max(140,Number(options.nodeWidth)||244),h=Math.max(80,Number(options.nodeHeight)||119),gapX=84,gapY=30,columns=Math.max(1,Math.min(6,Math.floor(Number(options.maxColumns)||3))),left=48,top=10,bandGap=46,caption=25;
    if(!nodes.length)return {positions:[],routes:[],lanes:[],width:Math.max(360,left*2+w),height:180};
    const ranks=ranksFor(nodes,edges),maxRank=Math.max(...ranks.values()),rankNodes=Array.from({length:maxRank+1},()=>[]),{reverse}=adjacency(nodes,edges),indices=new Map(nodes.map((node,i)=>[node.id,i]));
    for(const node of nodes)rankNodes[ranks.get(node.id)].push(node);
    const rowOf=new Map();
    for(const list of rankNodes){list.sort((a,b)=>{const parents=id=>(reverse.get(id)||[]).map(id=>rowOf.get(id)).filter(Number.isFinite),average=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;return average(parents(a.id))-average(parents(b.id))||indices.get(a.id)-indices.get(b.id);});list.forEach((node,i)=>rowOf.set(node.id,i));}
    const usedColumns=Math.min(columns,maxRank+1),bands=[];let cursor=top;
    for(let band=0;band<=Math.floor(maxRank/columns);band++){const lists=rankNodes.slice(band*columns,(band+1)*columns),rows=Math.max(1,...lists.map(list=>list.length)),height=caption+rows*h+(rows-1)*gapY;bands.push({top:cursor,bottom:cursor+height,height});cursor+=height+bandGap;}
    const positions=[],lanes=[];
    for(const [rank,list] of rankNodes.entries()){
      const band=Math.floor(rank/columns),col=band%2?usedColumns-1-rank%columns:rank%columns,x=left+col*(w+gapX),y=bands[band].top;
      const stageIds=[...new Set(list.map(stage))];
      lanes.push({id:`rank-${rank}`,rank,label:stageIds.map(id=>STAGES[id]).join(' / '),stageIds,x,y:y+12,width:w,height:bands[band].height});
      list.forEach((node,row)=>positions.push({node,x,y:y+caption+row*(h+gapY),w,h,i:indices.get(node.id),rank,band,col,row}));
    }
    positions.sort((a,b)=>a.i-b.i);
    const byId=new Map(positions.map(position=>[position.node.id,position]));
    return {positions,routes:edges.map(edge=>route(edge,byId.get(edge.from),byId.get(edge.to),positions,bands,gapX)),lanes,width:left*2+usedColumns*w+(usedColumns-1)*gapX,height:Math.max(180,bands.at(-1).bottom+38)};
  }
  function model(graph={},options={}) {
    const seen=new Set(),rawNodes=(Array.isArray(graph.nodes)?graph.nodes:[]).filter(node=>node&&typeof node.id==='string'&&!seen.has(node.id)&&seen.add(node.id)),rawIds=new Set(rawNodes.map(node=>node.id)),rawEdges=(Array.isArray(graph.edges)?graph.edges:[]).filter(edge=>edge&&rawIds.has(edge.from)&&rawIds.has(edge.to));
    const scope=options.scope==='request'?'request':'field',focused=focusProjection(rawNodes,rawEdges,scope),collapsed=setOf(options.collapsed),expanded=setOf(options.expanded);
    let nodes=rawNodes.filter(node=>focused.ids.has(node.id)).map(node=>({...copy(node),sourceNodeId:node.id})),ids=new Set(nodes.map(node=>node.id)),edges=rawEdges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to)).map((edge,i)=>({...copy(edge),id:edge.id||`view-edge:${i}`}));
    const adj=adjacency(nodes,edges),roots=rootsFor(nodes,adj.reverse),afterCollapse=visit(roots,adj.forward,collapsed),candidates=new Set();
    for(const id of collapsed)for(const child of visit(adj.forward.get(id)||[],adj.forward))if(!collapsed.has(child))candidates.add(child);
    const branches=nodes.map(node=>{const descendants=visit(adj.forward.get(node.id)||[],adj.forward);descendants.delete(node.id);return {id:node.id,sourceNodeId:node.id,descendants:descendants.size,collapsed:collapsed.has(node.id),hidden:[...descendants].filter(id=>candidates.has(id)&&!afterCollapse.has(id)).length};}).filter(branch=>branch.descendants>0);
    nodes=nodes.filter(node=>!candidates.has(node.id)||afterCollapse.has(node.id));ids=new Set(nodes.map(node=>node.id));edges=edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to)&&!collapsed.has(edge.from));
    for(const node of nodes){const branch=branches.find(branch=>branch.id===node.id);if(branch)node.view={...node.view,collapsible:true,collapsed:branch.collapsed,hiddenDescendants:branch.hidden,descendantCount:branch.descendants};}
    const hiddenNodes=rawNodes.filter(node=>!ids.has(node.id)),hiddenIds=new Set(hiddenNodes.map(node=>node.id)),hidden={nodes:hiddenNodes.length,queries:hiddenNodes.filter(node=>node.kind==='query').length,executions:hiddenNodes.reduce((n,node)=>n+countExecutions(node),0),branches:rawEdges.filter(edge=>!hiddenIds.has(edge.from)&&hiddenIds.has(edge.to)).length};
    const hiddenGapNodes=options.showGaps===false?nodes.filter(missing).length:0;
    if(options.showGaps===false){nodes=nodes.filter(node=>!missing(node));ids=new Set(nodes.map(node=>node.id));edges=edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to));}
    const projection=expandQueries(nodes,edges,new Set([...expanded].filter(id=>!collapsed.has(id))));
    return {...projection,...layout(projection.nodes,projection.edges,options),scope,focus:{available:focused.available,applied:focused.applied,originIds:[...focused.originIds]},hidden,branches,coverage:graph.coverage||'unavailable',gaps:copy(Array.isArray(graph.gaps)?graph.gaps:[]),summary:{rawNodes:rawNodes.length,visibleEvidenceNodes:nodes.length,expandedExecutionNodes:projection.nodes.length-nodes.length,hiddenGapNodes}};
  }
  return Object.freeze({model,stage,countExecutions});
});
