// A small stubbed DOM for the UI smoke (npm run uismoke), borrowed from Eldmoor's (its issue #145). Enough of the DOM for src/ui to
// build, patch and query its panels in Node: elements with real attributes (class, id, data-*, style,
// hidden reflect to attributes), text nodes, events that bubble to the document, <select>/<option>,
// a canvas whose 2D context accepts anything, and a toy layout (every element row is 20 px tall,
// offsetTop is the sum of the previous siblings) so scroll anchoring can be checked.
// install(html) builds the <body> of index.html and installs document/window/localStorage globals.

const ROW=20;
export class Text{constructor(t){this.nodeType=3;this.data=String(t);this.parentNode=null}
  get nodeValue(){return this.data}set nodeValue(v){this.data=String(v)}get textContent(){return this.data}}
const toAttr=k=>'data-'+k.replace(/[A-Z]/g,c=>'-'+c.toLowerCase());
const fromAttr=k=>k.slice(5).replace(/-(\w)/g,(_,x)=>x.toUpperCase());
const REFLECT={className:'class',id:'id',title:'title',htmlFor:'for',type:'type',name:'name',placeholder:'placeholder',href:'href',download:'download',accept:'accept',role:'role'};
const BOOL={hidden:'hidden',disabled:'disabled',open:'open',multiple:'multiple'};

function parseSel(s){s=s.trim();let scope=false;if(s.startsWith(':scope >')){scope=true;s=s.slice(8).trim()}
  const m={tag:null,cls:[],attrs:[],scope,any:s==='*'};const re=/^([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;let x;
  while((x=re.exec(s))){if(x[1])m.tag=x[1].toUpperCase();else if(x[2])m.cls.push(x[2]);else if(x[3])m.attrs.push(['id',x[3]]);else m.attrs.push([x[4],x[5]])}return m}
function matches(e,m){if(!(e instanceof El))return false;if(m.any)return true;
  if(m.tag&&e.tagName!==m.tag)return false;for(const c of m.cls)if(!e.classList.contains(c))return false;
  for(const [k,v] of m.attrs){const a=e.getAttribute(k);if(a==null)return false;if(v!=null&&a!==v)return false}return true}

let doc=null;
export class El{
  constructor(tag){this.nodeType=1;this.tagName=tag.toUpperCase();this.childNodes=[];this.parentNode=null;this._a=new Map();this._ls={};
    this.scrollTop=0;this.scrollLeft=0;this.offsetWidth=200;this.width=0;this.height=0;if(this.tagName==='OPTION')this.selected=false;
    const self=this;
    this.dataset=new Proxy({},{get:(o,k)=>typeof k==='string'?self.getAttribute(toAttr(k))??undefined:undefined,
      set:(o,k,v)=>{self.setAttribute(toAttr(k),v);return true},deleteProperty:(o,k)=>{self.removeAttribute(toAttr(k));return true},
      has:(o,k)=>self._a.has(toAttr(k)),ownKeys:()=>[...self._a.keys()].filter(k=>k.startsWith('data-')).map(fromAttr),
      getOwnPropertyDescriptor:(o,k)=>self._a.has(toAttr(k))?{enumerable:true,configurable:true,value:self.getAttribute(toAttr(k))}:undefined});
    const st={};this.style=new Proxy(st,{set:(o,k,v)=>{o[k]=v;const css=Object.entries(o).filter(([,x])=>x!==''&&x!=null).map(([a,b])=>a+':'+b).join(';');if(css)self._a.set('style',css);else self._a.delete('style');return true}});
    this.classList={add:(...c)=>{const s=new Set(self.className.split(' ').filter(Boolean));c.forEach(x=>s.add(x));self.className=[...s].join(' ')},
      remove:(...c)=>{self.className=self.className.split(' ').filter(x=>x&&!c.includes(x)).join(' ')},
      contains:c=>self.className.split(' ').includes(c),toggle:(c,f)=>{const has=self.classList.contains(c);const on=f===undefined?!has:f;if(on)self.classList.add(c);else self.classList.remove(c);return on}}}
  get attributes(){return [...this._a].map(([name,value])=>({name,value}))}
  setAttribute(k,v){k=String(k).toLowerCase();this._a.set(k,String(v))}
  getAttribute(k){k=String(k).toLowerCase();return this._a.has(k)?this._a.get(k):null}
  removeAttribute(k){this._a.delete(String(k).toLowerCase())}
  hasAttribute(k){return this._a.has(String(k).toLowerCase())}
  get tabIndex(){const v=this.getAttribute('tabindex');return v==null?-1:+v}set tabIndex(v){this.setAttribute('tabindex',v)}
  get colSpan(){return +(this.getAttribute('colspan')||1)}set colSpan(v){this.setAttribute('colspan',v)}
  get value(){if(this.tagName==='SELECT'){const os=this.children.filter(c=>c.tagName==='OPTION');const s=os.find(o=>o.selected)||os[0];return s?s.value:''}return this._v??(this.tagName==='OPTION'?this.getAttribute('value')??this.textContent:'')}
  set value(v){if(this.tagName==='SELECT'){for(const o of this.children)o.selected=o.value===String(v);return}this._v=String(v)}
  get children(){return this.childNodes.filter(n=>n instanceof El)}
  get firstChild(){return this.childNodes[0]||null}get lastChild(){return this.childNodes[this.childNodes.length-1]||null}
  get firstElementChild(){return this.children[0]||null}
  get nextSibling(){const p=this.parentNode;if(!p)return null;return p.childNodes[p.childNodes.indexOf(this)+1]||null}
  get isConnected(){let e=this;while(e.parentNode)e=e.parentNode;return e===doc?.body}
  get textContent(){return this.childNodes.map(n=>n.textContent).join('')}
  set textContent(v){this.childNodes.forEach(n=>n.parentNode=null);this.childNodes=v===''||v==null?[]:[new Text(v)];this.childNodes.forEach(n=>n.parentNode=this)}
  get innerText(){return this.textContent}
  set innerHTML(v){this.replaceChildren(...parseHTML(String(v)))}
  // toy layout: element children stack in rows of 20 px
  get offsetHeight(){return this.hidden?0:ROW}
  get offsetTop(){const p=this.parentNode;if(!p)return 0;let t=0;for(const c of p.children){if(c===this)break;t+=c.offsetHeight}return t}
  get scrollHeight(){return this.children.reduce((t,c)=>t+c.offsetHeight,0)}
  get clientHeight(){return this._ch??0}set clientHeight(v){this._ch=v}
  get options(){return this.children.filter(c=>c.tagName==='OPTION')}
  _adopt(n){if(typeof n==='string'||typeof n==='number')n=new Text(n);if(n.parentNode)n.parentNode.removeChild(n);n.parentNode=this;return n}
  append(...ns){for(const n of ns)this.childNodes.push(this._adopt(n))}
  appendChild(n){this.append(n);return n}
  prepend(...ns){this.childNodes.unshift(...ns.map(n=>this._adopt(n)))}
  removeChild(n){const i=this.childNodes.indexOf(n);if(i>=0){this.childNodes.splice(i,1);n.parentNode=null}return n}
  remove(){if(this.parentNode)this.parentNode.removeChild(this)}
  replaceChildren(...ns){this.childNodes.forEach(n=>n.parentNode=null);this.childNodes=[];this.append(...ns)}
  replaceChild(nw,old){nw=this._adopt(nw);const j=this.childNodes.indexOf(old);this.childNodes[j]=nw;old.parentNode=null;return old}
  insertBefore(n,ref){n=this._adopt(n);if(!ref){this.childNodes.push(n);return n}const i=this.childNodes.indexOf(ref);this.childNodes.splice(i<0?this.childNodes.length:i,0,n);return n}
  contains(n){while(n){if(n===this)return true;n=n.parentNode}return false}
  closest(s){let e=this;const m=parseSel(s);while(e instanceof El){if(matches(e,m))return e;e=e.parentNode}return null}
  _all(m,out){for(const c of this.children){if(matches(c,m))out.push(c);if(!m.scope)c._all(m,out)}return out}
  querySelectorAll(s){return s.split(',').flatMap(x=>{const parts=x.trim().startsWith(':scope')?[x]:x.trim().split(/\s+/);let set=[this];
    for(const p of parts){const m=parseSel(p),out=[];for(const r of set)r._all(m,out);set=[...new Set(out)]}return set})}
  querySelector(s){return this.querySelectorAll(s)[0]||null}
  addEventListener(t,f){(this._ls[t]||(this._ls[t]=[])).push(f)}
  removeEventListener(t,f){const l=this._ls[t];if(l){const i=l.indexOf(f);if(i>=0)l.splice(i,1)}}
  // bubble from the target up, then the document's listeners (capture listeners are treated as bubbling ones)
  dispatch(t,ev={}){let e=this;ev.type=t;ev.target=ev.target||this;ev.stopPropagation=()=>{ev._stop=true};ev.preventDefault=()=>{ev.defaultPrevented=true};
    if(doc)for(const f of doc._ls[t]||[]){if(ev._stop)break;f(ev)}
    while(e&&!ev._stop){for(const f of (e._ls&&e._ls[t])||[])f(ev);if(!ev._stop&&e['on'+t])e['on'+t](ev);e=e.parentNode}return ev}
  dispatchEvent(ev){this.dispatch(ev.type,ev);return true}
  click(){this.dispatch('click',{})}
  focus(){if(doc){doc.activeElement=this;for(const f of doc._ls.focusin||[])f({target:this})}}
  blur(){if(doc&&doc.activeElement===this)doc.activeElement=doc.body}
  scrollIntoView(){}
  getContext(){return new Proxy({canvas:this},{get:(o,k)=>k in o?o[k]:k==='measureText'?()=>({width:10}):k==='createImageData'?(w,h)=>({data:new Uint8ClampedArray(w*h*4)}):()=>({addColorStop(){}}),set:(o,k,v)=>{o[k]=v;return true}})}
  getBoundingClientRect(){return {left:0,top:0,width:960,height:600}}
  setPointerCapture(){}
}
for(const [p,a] of Object.entries(REFLECT))Object.defineProperty(El.prototype,p,{get(){return this.getAttribute(a)??''},set(v){this.setAttribute(a,v)},configurable:true});
for(const [p,a] of Object.entries(BOOL))Object.defineProperty(El.prototype,p,{get(){return this._a.has(a)},set(v){if(v)this.setAttribute(a,'');else this.removeAttribute(a)},configurable:true});

// ---- a tiny HTML parser (index.html and innerHTML strings) ----
const VOID=new Set(['br','input','meta','link','img','hr','source']);
const ENT={amp:'&',lt:'<',gt:'>',quot:'"',rsquo:'’',lsquo:'‘',times:'×',minus:'−',middot:'·',nbsp:' '};
const unent=s=>s.replace(/&(#\d+|\w+);/g,(m,k)=>k[0]==='#'?String.fromCharCode(+k.slice(1)):ENT[k]??m);
export function parseHTML(html){const root=new El('div');let cur=root;const re=/<!--[\s\S]*?-->|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/g;let m;
  while((m=re.exec(html))){if(m[1]){if(cur.parentNode&&cur.tagName===m[1].toUpperCase())cur=cur.parentNode;else{let e=cur;while(e&&e!==root&&e.tagName!==m[1].toUpperCase())e=e.parentNode;if(e&&e!==root)cur=e.parentNode}continue}
    if(m[2]){const e=new El(m[2]);const ar=/([\w-]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;let a;while((a=ar.exec(m[3]||''))){e.setAttribute(a[1],unent(a[3]??a[4]??a[5]??''))}
      cur.append(e);if(!VOID.has(m[2].toLowerCase())&&!/\/>$/.test(m[0]))cur=e;continue}
    if(m[4]&&!/^<!--/.test(m[0]))cur.append(new Text(unent(m[4])))}
  const out=[...root.childNodes];out.forEach(n=>n.parentNode=null);root.childNodes=[];return out}

export function install(html){const body=new El('body');
  const bm=/<body[^>]*>([\s\S]*)<\/body>/i.exec(html||'');if(bm)body.append(...parseHTML(bm[1].replace(/<script[\s\S]*?<\/script>/gi,'')));
  const byId=(e,id)=>{for(const c of e.children){if(c.getAttribute('id')===id)return c;const r=byId(c,id);if(r)return r}return null};
  doc={body,documentElement:new El('html'),activeElement:body,_ls:{},visibilityState:'visible',
    createElement:t=>new El(t),createTextNode:t=>new Text(t),createDocumentFragment:()=>new El('fragment'),
    getElementById:id=>byId(body,id),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),
    addEventListener(t,f){(this._ls[t]||(this._ls[t]=[])).push(f)},removeEventListener(){}};
  globalThis.document=doc;
  let sel=null;
  globalThis.window={innerWidth:1280,innerHeight:800,devicePixelRatio:1,addEventListener(){},getSelection:()=>sel||{isCollapsed:true,rangeCount:0},_setSelection:s=>{sel=s}};
  const store={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
  globalThis.localStorage=store;window.localStorage=store;
  globalThis.Option=class{constructor(t,v,d,s){const o=new El('option');o.textContent=t;o.value=v==null?t:v;if(s)o.selected=true;return o}};
  globalThis.ResizeObserver=class{observe(){}disconnect(){}};
  return doc}
