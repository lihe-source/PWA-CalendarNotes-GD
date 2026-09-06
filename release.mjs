// Regenerate after editing any frontend file. Version is controlled in config.js.
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
const context=vm.createContext({window:{}});vm.runInContext(fs.readFileSync('config.js','utf8'),context);const cfg=context.window.APP_CONFIG;
const sw=fs.readFileSync('service-worker.js','utf8').replace(/const VERSION='[^']+';/,`const VERSION='${cfg.VERSION}';`);fs.writeFileSync('service-worker.js',sw);
const files=['./','./index.html','./style.css','./config.js','./app.js','./db.js','./api.js','./auth.js','./recurrence.js','./google-drive.js','./push.js','./holidays.js','./manifest.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];
const assets=Object.fromEntries(files.map(p=>[p,createHash('sha256').update(fs.readFileSync(p==='./'?'index.html':p)).digest('hex')]));
const prior=JSON.parse(fs.readFileSync('version.json','utf8'));fs.writeFileSync('version.json',JSON.stringify({...prior,version:cfg.VERSION,build:cfg.BUILD,assets},null,2)+'\n');
const version=cfg.VERSION.replace(/^V/,'');
for(const name of ['package.json','package-lock.json']){if(!fs.existsSync(name))continue;const p=JSON.parse(fs.readFileSync(name,'utf8'));p.version=version;if(p.packages?.[''])p.packages[''].version=version;fs.writeFileSync(name,JSON.stringify(p,null,2)+'\n');}
const worker=fs.readFileSync('worker.js','utf8').replace(/version:'V[0-9.]+'/g,`version:'${cfg.VERSION}'`);fs.writeFileSync('worker.js',worker);
console.log(`Release manifest generated: ${cfg.VERSION}, ${files.length} assets.`);
