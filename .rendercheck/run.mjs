// Minimal browser globals so the screens can mount under node.
globalThis.localStorage = {
  _d: {}, getItem(k){ return this._d[k] ?? null }, setItem(k,v){ this._d[k]=String(v) },
  removeItem(k){ delete this._d[k] }
}
globalThis.document = {
  documentElement: { classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, style:{ setProperty(){} } }
}
globalThis.window = {
  print(){},
  // useReducedMotion() attaches through the old addListener API as a fallback,
  // so the stub needs both spellings or any screen using it fails to render.
  matchMedia: () => ({
    matches: false,
    addEventListener(){}, removeEventListener(){},
    addListener(){}, removeListener(){}
  }),
  addEventListener(){}, removeEventListener(){}
}

/*
 * framer-motion looks these up while deciding whether an element is an SVG
 * node. They only exist in a browser, and without them every screen carrying
 * an animation failed to render here with "SVGElement is not defined" —
 * which is a gap in this harness, not in the application.
 */
globalThis.SVGElement = class SVGElement {}
globalThis.HTMLElement = class HTMLElement {}
globalThis.Element = class Element {}
globalThis.Node = class Node {}
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.fetch = async () => ({ ok:true, status:200, headers:{get:()=>null},
  text: async () => '[]', json: async () => ([]) })
await import('./out.mjs')
