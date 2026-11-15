export function skyPanorama(series,profile,index){
 const W=380,H=144,X=32,Y=12,width=332,height=100;
 const xy=(az,el)=>[X+az/360*width,Y+(15-Math.max(-5,Math.min(15,el)))/20*height];
 let terrain='M32 112';for(let a=0;a<=360;a+=2){const f=(a%360)/360*(profile?.length||1),i=Math.floor(f),e=profile?profile[i]*(1-f+i)+profile[(i+1)%profile.length]*(f-i):0,p=xy(a,e);terrain+='L'+p.join(' ');}terrain+='L364 112Z';
 const track=(az,el,horizon)=>{let visible='',hidden='',prev=null,lastHidden=false;const step=Math.max(1,Math.floor(az.length/300));for(let i=0;i<az.length;i+=step){const p=xy(az[i],el[i]),isHidden=el[i]<horizon[i];let cmd=(!prev||Math.abs(p[0]-prev[0])>width/2||isHidden!==lastHidden)?'M':'L';if(isHidden)hidden+=cmd+p.join(' ');else visible+=cmd+p.join(' ');prev=p;lastHidden=isHidden;}return{visible,hidden};};
 const sun=track(series.sAz,series.sEl,series.sH),earth=track(series.eAz,series.eEl,series.eH),s=xy(series.sAz[index],series.sEl[index]),e=xy(series.eAz[index],series.eEl[index]);
 return {terrain,sun:sun.visible,sunHidden:sun.hidden,earth:earth.visible,earthHidden:earth.hidden,sx:s[0],sy:s[1],ex:e[0],ey:e[1],summary:(series.sEl[index]<series.sH[index]?'Sun hidden by hills':'Sun visible')+' · '+(series.eEl[index]<series.eH[index]?'Earth hidden by hills':'Earth visible')};
}
