export function withUIPass(Base, science) {
 return class UIPass extends Base {
  renderVals(){
   const v=super.renderVals();v.appCls+=' ui-pass'+(this.state.view==='drive'?' ui-drive':'');
   v.hud={...v.hud,rate:v.hud.rate.replace('charging ','· ').replace('draining ','· '),sun:v.hud.sun.replace('In sunlight','Sunlit'),earth:v.hud.earth==='Earth link'?'Earth in view':v.hud.earth,skipLabel:v.hud.skipLabel.replace('Skip to Earthrise (','Earthrise in ').replace(')',' →')};
   for(const c of v.chartRows||[])for(const q of c.panels){q.thrLabelX=Number(q.x1)+6;for(let k=0;k<3;k++)q['e'+k].label='';}
   if(v.sct){for(let k=0;k<6;k++)v.sct['p'+k].t='';}
   const ser=this.series(),met=this.metrics(ser);const explain={Sunlight:'Share of time the Sun is visible.', 'Earth in view':'Earth above the terrain skyline; not a guaranteed radio link.', 'Longest night':'Longest continuous darkness without solar charging.', 'Longest Earth gap':'Longest continuous time with no view of Earth.'};
   for(const col of v.cmpCols||[]){col.moreRows=col.rows.filter((_,i)=>i===2||i===5);col.rows=col.rows.filter((_,i)=>i!==2&&i!==5).map(row=>({...row,name:row.name.replace('Earth contact','Earth in view').replace('Longest darkness','Longest night').replace('Longest without Earth','Longest Earth gap')}));for(const row of col.rows)row.help=explain[row.name]||'';col.why=col.rows.slice(0,2).map(x=>x.name+' '+x.value).join(' · ');}
   if(v.sc){const r=met.res[this.state.sel];if(r)v.sc.rows=[['Sunlight',this.pct(r.sun)],['Earth in view',this.pct(r.ear)],['Longest night',this.dur(r.dark)],['Longest Earth gap',this.dur(r.nocomm)]].map(([name,value])=>({name,value,reason:explain[name],pct:0,color:'#98989F',tgt:-10}));}
   v.driveZoom=Math.log(this.eng?.getDriveZoom?.()||.035);v.onDriveZoom=e=>this.eng?.setDriveZoom(Math.exp(Number(e.target.value)));v.driveZoomIn=()=>this.eng?.zoom(.7);v.driveZoomOut=()=>this.eng?.zoom(1.4);v.driveZoomReset=()=>this.eng?.resetDriveZoom();
   return v;
  }
 };
}
