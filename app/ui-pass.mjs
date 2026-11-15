import {interpolateVisualState} from "./visual-time.mjs";
export function withUIPass(Base, science) {
 return class UIPass extends Base {
  constructor(...args){super(...args);Object.assign(this.state,{driveTimeScale:60,routeDays:1});}
  renderContinuousTime(ms,now=performance.now()){
   this._visualUTC=ms;const site=this.selSite();if(!this.eng||!site)return;
   const st=interpolateVisualState(science.ephem,ms),topo=this.eph().topo(st,site.lat,site.lon,(this.state.obsH||2)/1000);
   this.eng.set({sunB:st.sun,earthB:st.earth,tSun:topo.sun,tEarth:topo.earth,simUTC:ms});
   if(this._tj?.hmap&&this.state.view!=='region'&&now-(this._continuousShadeAt||0)>250){this._continuousShadeAt=now;this.sendShade({key:this._tj.key,utc:ms,sun:science.ephem.state(ms).sun,bigMap:!!this.state.bigMap});}
  }
  joystickEvent(event,release=false){const el=event.currentTarget;if(release){this.eng?.joystick(0,0);el.style.setProperty('--joy-x','0px');el.style.setProperty('--joy-y','0px');return;}if(event.type==='pointerdown'){this._joystickPointer=event.pointerId;el.setPointerCapture(event.pointerId);}if(!el.hasPointerCapture(event.pointerId))return;const r=el.getBoundingClientRect(),dx=(event.clientX-r.left-r.width/2)/(r.width*.4),dy=(event.clientY-r.top-r.height/2)/(r.height*.4),distance=Math.hypot(dx,dy),scale=distance>.1?Math.min(1,distance)/distance:0;this.eng?.joystick(dx*scale,dy*scale);el.style.setProperty('--joy-x',dx*scale*35+'px');el.style.setProperty('--joy-y',dy*scale*35+'px');event.preventDefault();}
  renderVals(){
   const v=super.renderVals();v.appCls+=' ui-pass'+(this.state.view==='drive'?' ui-drive':'');
   v.hud={...v.hud,rate:v.hud.rate.replace('charging ','· ').replace('draining ','· '),sun:v.hud.sun.replace('In sunlight','Sunlit'),earth:v.hud.earth==='Earth link'?'Earth in view':v.hud.earth,skipLabel:v.hud.skipLabel.replace('Skip to Earthrise (','Earthrise in ').replace(')',' →')};
   for(const c of v.chartRows||[])for(const q of c.panels){q.thrLabelX=Number(q.x1)+6;for(let k=0;k<3;k++)q['e'+k].label='';}
   if(v.sct){for(let k=0;k<6;k++)v.sct['p'+k].t='';}
   const ser=this.series(),met=this.metrics(ser);const explain={Sunlight:'Share of time the Sun is visible.', 'Earth in view':'Earth above the terrain skyline; not a guaranteed radio link.', 'Longest night':'Longest continuous darkness without solar charging.', 'Longest Earth gap':'Longest continuous time with no view of Earth.'};
   for(const col of v.cmpCols||[]){col.moreRows=col.rows.filter((_,i)=>i===2||i===5);col.rows=col.rows.filter((_,i)=>i!==2&&i!==5).map(row=>({...row,name:row.name.replace('Earth contact','Earth in view').replace('Longest darkness','Longest night').replace('Longest without Earth','Longest Earth gap')}));for(const row of col.rows)row.help=explain[row.name]||'';col.why=col.rows.slice(0,2).map(x=>x.name+' '+x.value).join(' · ');}
   if(v.sc){const r=met.res[this.state.sel];if(r)v.sc.rows=[['Sunlight',this.pct(r.sun)],['Earth in view',this.pct(r.ear)],['Longest night',this.dur(r.dark)],['Longest Earth gap',this.dur(r.nocomm)]].map(([name,value])=>({name,value,reason:explain[name],pct:0,color:'#98989F',tgt:-10}));}
   v.driveZoom=Math.log(this.eng?.getDriveZoom?.()||.035);v.onDriveZoom=e=>this.eng?.setDriveZoom(Math.exp(Number(e.target.value)));v.driveZoomIn=()=>this.eng?.zoom(.7);v.driveZoomOut=()=>this.eng?.zoom(1.4);v.driveZoomReset=()=>this.eng?.resetDriveZoom();
   this.eng?.set({driveTimeScale:this.state.driveTimeScale});
   v.driveTimeScale=this.state.driveTimeScale;v.onDriveTimeScale=e=>this.setState({driveTimeScale:Number(e.target.value)});v.toggleTurbo=()=>this.setState({driveTimeScale:this.state.driveTimeScale===300?60:300});v.turbo=this.state.driveTimeScale===300;
   if(this.state.view==='drive'&&this._visualUTC){v.timeSmall=new Date(this._visualUTC).toISOString().slice(11,19)+' UTC · ×'+this.state.driveTimeScale+' time';}
   v.joyDown=e=>this.joystickEvent(e);v.joyMove=e=>this.joystickEvent(e);v.joyUp=e=>this.joystickEvent(e,true);
   return v;
  }
 };
}
