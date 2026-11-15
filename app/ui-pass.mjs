export function withUIPass(Base, science) {
 return class UIPass extends Base {
  renderVals(){
   const v=super.renderVals();v.appCls+=' ui-pass'+(this.state.view==='drive'?' ui-drive':'');
   v.hud={...v.hud,rate:v.hud.rate.replace('charging ','· ').replace('draining ','· '),sun:v.hud.sun.replace('In sunlight','Sunlit'),earth:v.hud.earth==='Earth link'?'Earth in view':v.hud.earth,skipLabel:v.hud.skipLabel.replace('Skip to Earthrise (','Earthrise in ').replace(')',' →')};
   return v;
  }
 };
}
