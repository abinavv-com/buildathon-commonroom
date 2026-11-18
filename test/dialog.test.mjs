import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SERVICES, buildJobRequest, parseRoute } from '../public/contracts.js';

test('closing a dialog removes its fullscreen blur layer and restores scrolling', () => {
  const overlay={hidden:false,className:'overlay',innerHTML:'<section>Dialog</section>'};
  const body={style:{overflow:'hidden'},dataset:{}};
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const context=vm.createContext({SERVICES,buildJobRequest,parseRoute,console,
    window:{CR:{escapeHtml:String},addEventListener(){}},
    document:{body,activeElement:null,querySelector:(selector)=>selector==='#modal-root'?overlay:null,addEventListener(){}},
    location:{pathname:'/',hash:'',origin:'http://localhost'},
    localStorage:{getItem:()=>null},
  });
  const code=source.replace(/^import[^\n]*\n/,'').slice(0,source.replace(/^import[^\n]*\n/,'').indexOf('\nawait renderRoute();'));
  vm.runInContext(code+'\ncloseModal();',context);
  assert.equal(overlay.hidden,true);
  assert.equal(overlay.className,'');
  assert.equal(overlay.innerHTML,'');
  assert.equal(body.style.overflow,'');
});
