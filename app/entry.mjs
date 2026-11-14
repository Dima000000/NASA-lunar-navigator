import './standalone-runtime.js';
import './component.js';
import {loadRealMoon} from './real-moon.js';
import {loadScience,enhancedComponent} from './science-runtime.mjs';
try{
 window.RealMoon=await loadRealMoon(text=>document.getElementById('loadStatus').textContent=text);
 document.getElementById('loadStatus').textContent='Loading measured site grids and 300 km horizons…';
 window.SCIENCE=await loadScience(window.RealMoon);
 window.mountNASAL(enhancedComponent(window.NASALComponent,window.SCIENCE),document.getElementById('app-template').content.firstElementChild.cloneNode(true));
 document.getElementById('realMoonLoading').remove();
}catch(e){console.error(e);document.getElementById('loadStatus').textContent=e.message}
