'use strict';
const {model}=require('./renderer/trace-view.js');
function traceToDiagram(graph){
 if(!graph||!Array.isArray(graph.nodes)||!graph.nodes.length)throw Error('Capture an element before opening its diagram.');
 if(graph.nodes.length>80)throw Error('Focus a trace branch with at most 80 nodes before creating its presentation diagram.');
 const view=model(graph,{scope:'request',showGaps:true,maxColumns:3,nodeWidth:300,nodeHeight:110});
 const positions=view.positions.map(row=>({...row,x:Math.round(row.x*1.4),y:Math.round(row.y*1.3)}));
 const byId=new Map(positions.map(row=>[row.node.id,row]));
 const kind={element:'external',source:'frontend',api:'backend',backend:'backend',query:'database',model:'backend',database:'database',gap:'external',execution:'database'};
 const shorten=(value,size)=>String(value||'').slice(0,size);
 return {schema_version:1,diagram_type:'architecture',meta:{title:shorten('Captured trace — '+(graph.title||'Selected element'),90),subtitle:'Presentation of Orivo evidence · '+(graph.coverage||'unavailable')+' coverage',output:'diagram.html',quality_profile:'standard'},
  components:positions.map(({node,x,y,w,h})=>({id:node.id,type:kind[node.kind]||'external',label:shorten(node.label,32),sublabel:shorten(node.kind.toUpperCase(),24),pos:[x,y],size:[w,h]})),
  connections:view.edges.map((edge,index)=>{
   const from=byId.get(edge.from),to=byId.get(edge.to),dx=to.x-from.x,dy=to.y-from.y,vertical=Math.abs(dy)>Math.abs(dx);
   const sides=vertical?(dy>0?{fromSide:'bottom',toSide:'top'}:{fromSide:'top',toSide:'bottom'}):(dx>=0?{fromSide:'right',toSide:'left'}:{fromSide:'left',toSide:'right'});
   const labelAt=vertical?[Math.round((from.x+from.w/2+to.x+to.w/2)/2),Math.round(dy>0?(from.y+from.h+to.y)/2:(to.y+to.h+from.y)/2)]:[Math.round(dx>=0?(from.x+from.w+to.x)/2:(to.x+to.w+from.x)/2),Math.round((from.y+from.h/2+to.y+to.h/2)/2-12)];
   return {id:'captured-edge-'+index,from:edge.from,to:edge.to,...sides,...(edge.label?{label:shorten(edge.label,26),labelAt}:{}),...(edge.status==='missing'?{variant:'dashed'}:{})};
  }),
  cards:[{dot:'cyan',title:'Captured evidence',items:['Capture: '+shorten(graph.id,100),'Captured at: '+shorten(graph.capturedAt,100),'Coverage: '+shorten(graph.coverage,100),'This diagram projects captured relationships. It adds no runtime evidence or tracing coverage.']},
   ...graph.nodes.map(node=>({dot:node.kind==='gap'?'rose':'emerald',title:shorten(node.label,80),items:[shorten(node.detail||node.subtitle||node.kind,400),...(node.file?[shorten(node.file+':'+(node.line||1),200)]:[])]})),
   ...(graph.gaps?.length?[{dot:'rose',title:'Unproven connections',items:graph.gaps.slice(0,12).map(value=>shorten(value,400))}]:[])]};
}
module.exports={traceToDiagram};
