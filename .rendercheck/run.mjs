// Minimal browser globals so the screens can mount under node.
globalThis.localStorage = {
  _d: {}, getItem(k){ return this._d[k] ?? null }, setItem(k,v){ this._d[k]=String(v) },
  removeItem(k){ delete this._d[k] }
}
globalThis.document = {
  documentElement: { classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, style:{ setProperty(){} } }
}
globalThis.window = { print(){}, matchMedia: () => ({ matches:false }) }
globalThis.fetch = async () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '[]', json: async () => ([]) })
await import('./out.mjs')
