precision highp float;
varying vec3 vP;
varying vec3 vN;
uniform vec3 uSun;
uniform vec3 uEarth;
uniform vec3 uCam;
uniform float uLineW;
uniform sampler2D uAlbedo;
uniform sampler2D uHeightGlobal;
uniform sampler2D uHeightPolar;
uniform sampler2D uHeightFine;
const float PI=3.141592653589793;
const float R=1737400.;
float decodeHeight(vec3 c){return (c.r*255.*256.+c.g*255.)*.5-10000.;}
float elevation(vec3 u){
 float lat=asin(clamp(u.z,-1.,1.)),lon=atan(u.y,u.x);
 if(lat<radians(-79.9)){
  float rho=2.*R*tan((PI/2.+lat)/2.);
  vec2 p=rho*vec2(sin(lon),cos(lon));
  if(max(abs(p.x),abs(p.y))<163700.)return decodeHeight(texture2D(uHeightFine,(p+163840.)/327680.).rgb);
  if(max(abs(p.x),abs(p.y))<303700.)return decodeHeight(texture2D(uHeightPolar,(p+304000.)/608000.).rgb);
 }
 return decodeHeight(texture2D(uHeightGlobal,vec2(lon/(2.*PI)+.5,lat/PI+.5)).rgb);
}
void main(){
 vec3 N=normalize(vP),V=normalize(uCam-vP);
 float lat=asin(clamp(N.z,-1.,1.)),lon=atan(N.y,N.x);
 // Screen-resolved, measured DEM normals. No procedural bump/noise or invented craters.
 vec3 east=normalize(vec3(-N.y,N.x,0.)+vec3(.000000001,0.,0.));
 vec3 north=normalize(cross(N,east));
 float stepM=mix(80.,2700.,smoothstep(radians(-83.),radians(-79.5),lat));
 float a=stepM/R;
 float de=(elevation(normalize(N+east*a))-elevation(normalize(N-east*a)))/(2.*stepM);
 float dn=(elevation(normalize(N+north*a))-elevation(normalize(N-north*a)))/(2.*stepM);
 vec3 n=normalize(N-east*de-north*dn);
 vec3 alb=texture2D(uAlbedo,vec2(lon/(2.*PI)+.5,lat/PI+.5)).rgb;
 float mu0=max(dot(n,uSun),0.),mu=max(dot(n,V),.02);
 float br=mix(2.*mu0/(mu0+mu),mu0,.35);
 float terminator=smoothstep(-.015,.04,dot(N,uSun));
 vec3 col=alb*.32*br*terminator*2.6;
 col+=alb*.012*max(dot(N,uEarth),0.)*vec3(.55,.7,1.);
 col=vec3(1.)-exp(-col*1.6);col=pow(col,vec3(1./2.2));
 float zr=(1.-smoothstep(0.,uLineW*1.4,abs(degrees(lat)+84.)))*step(.45,fract(degrees(lon)/3.));
 col=mix(col,vec3(1.,.84,.04),zr*.35);
 gl_FragColor=vec4(col,1.);
}
