import fs from 'node:fs';
const root=new URL('../',import.meta.url),p=new URL('app/template.html',root),s=fs.readFileSync(p,'utf8');
const template=s.replace(/(\s)([\w:-]+)(\s*=\s*["'])([^"']*\{\{[^"']*)(["'])/g,(_,a,b,c,d,e)=>a+'data-bind-'+b+c+d+e);
const index=new URL('index.html',root),html=fs.readFileSync(index,'utf8').replace(/(<template id="app-template">)[\s\S]*?(<\/template>)/,(_,a,b)=>a+template+b);fs.writeFileSync(index,html);
