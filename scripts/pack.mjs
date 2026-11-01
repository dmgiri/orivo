import { mkdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const dest=path.join(root,'dist','orivo');
await mkdir(dest,{recursive:true});
for(const name of ['main.cjs','host-security.cjs','product-store.cjs','product-diagnostics.cjs','trace-store.cjs','editor-source.cjs','trace-health.cjs','project-map-store.cjs','page-runtime.cjs','session-navigation.cjs','diagram-studio.cjs','trace-to-diagram.cjs','preload.cjs','package.json','package-lock.json','README.md','THIRD_PARTY_NOTICES.md','Start Orivo.cmd','.gitignore','resources','renderer','engine','adapters','demo','vendor','scripts','test','docs'])await cp(path.join(root,name),path.join(dest,name),{recursive:true,force:true});
console.log(`Standalone source package prepared: ${dest}\nRun npm install then npm start in that folder. No installer has been built.`);
