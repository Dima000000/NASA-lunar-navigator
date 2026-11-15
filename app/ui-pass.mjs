export function withUIPass(Base, science) {
 return class UIPass extends Base {
  renderVals(){
   const v=super.renderVals();v.appCls+=' ui-pass'+(this.state.view==='drive'?' ui-drive':'');
   v.hud={...v.hud,rate:v.hud.rate.replace('charging ','· ').replace('draining ','· '),sun:v.hud.sun.replace('In sunlight','Sunlit'),earth:v.hud.earth==='Earth link'?'Earth in view':v.hud.earth,skipLabel:v.hud.skipLabel.replace('Skip to Earthrise (','Earthrise in ').replace(')',' →')};
   for(const c of v.chartRows||[])for(const q of c.panels){q.thrLabelX=Number(q.x1)+6;for(let k=0;k<3;k++)q['e'+k].label='';}
   if(v.sct){for(let k=0;k<6;k++)v.sct['p'+k].t='';}
   return v;
  }
 };
}
