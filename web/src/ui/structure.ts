import type { DualTpzController } from '../core/engines';
import type { ObjectLink, TpzObjectSummary } from '../core/types';
import { cachedDetail, findObject } from './links';

/** One row of a message structure (element or attribute). `key` is the prefix-free path. */
export interface SNode {
  key: string;
  name: string;
  depth: number;
  occ: string;
  type: string;
  kids: SNode[];
  extra?: boolean;
  inChoice?: boolean;
}

const XS = 'http://www.w3.org/2001/XMLSchema';
const local = (q: string) => (q.includes(':') ? q.slice(q.indexOf(':') + 1) : q);
const prefixOf = (q: string) => (q.includes(':') ? q.slice(0, q.indexOf(':')) : '');
const builtin = (t: string) => /^(xsd?|xs):/.test(t);
const MAX_NODES = 20000;

/** `ns0:Item[2]` -> `Item[2]`, `@ns1:id` -> `@id` */
export function normSeg(seg: string): string {
  return seg.replace(/^(@?)[\w.-]+:/, '$1');
}
export function normPath(path: string): string {
  return '/' + path.split('/').filter(Boolean).map(normSeg).join('/');
}

interface IfrRef {
  name: string;
  ns: string;
  kind: 'include' | 'import';
  relativeFile?: string;
  relativeBase?: string;
}

const stripSchemaExt = (s: string) => s.replace(/\.(xsd|wsdl)$/i, '');

/**
 * Parse SAP ESR `ifr://schema?keyelements=name|namespace&swc=...&sp=-1` URIs
 * as well as relative schemaLocation filenames inside `ifmextdef` External Definitions
 * (disambiguated by case-insensitive filename + XSD targetNamespace).
 */
function parseSchemaRef(uri: string, kind: 'include' | 'import', targetNs: string): IfrRef | null {
  if (!uri) return null;
  if (uri.toLowerCase().startsWith('ifr:')) {
    const qIdx = uri.indexOf('?');
    if (qIdx < 0) return null;
    const params = new URLSearchParams(uri.slice(qIdx + 1));
    const ke = params.get('keyelements') || '';
    if (!ke) return null;
    const [name, ns = ''] = ke.split('|');
    if (!name) return null;
    return { name: name.trim(), ns: ns.trim(), kind };
  }
  if (!/^https?:/i.test(uri)) {
    const clean = uri.split(/[?#]/)[0] || '';
    const fileBase = clean.split(/[\\/]/).pop()?.trim() || '';
    const stem = stripSchemaExt(fileBase);
    if (stem) return { name: stem, ns: targetNs, kind, relativeFile: uri, relativeBase: fileBase };
  }
  return null;
}

function extractSchemaTargetNamespaces(xml: string): Set<string> {
  const out = new Set<string>();
  const re = /targetNamespace\s*=\s*["']([^"']*)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) out.add(m[1].trim());
  }
  return out;
}

class Pool {
  elements = new Map<string, Element>(); // localName -> Element (fallback)
  qElements = new Map<string, Element>(); // {ns}localName -> Element (exact QName)
  types = new Map<string, Element>(); // localName -> Element (fallback)
  qTypes = new Map<string, Element>(); // {ns}localName -> Element (exact QName)
  missing = new Set<string>(); // local or {ns}local
  ifrRefs: IfrRef[] = [];

  private qkey(ns: string, nm: string) {
    return ns ? `{${ns}}${nm}` : nm;
  }

  resolveQName(el: Element, qname: string): { ns: string; localName: string } {
    const ln = local(qname);
    const pfx = prefixOf(qname);
    let ns = '';
    try {
      ns = pfx ? el.lookupNamespaceURI(pfx) || '' : el.lookupNamespaceURI(null) || '';
    } catch {
      ns = '';
    }
    if (!ns) {
      let cur: Element | null = el;
      while (cur) {
        if (cur.localName === 'schema' && cur.namespaceURI === XS) {
          ns = cur.getAttribute('targetNamespace') || '';
          break;
        }
        cur = cur.parentElement;
      }
    }
    return { ns, localName: ln };
  }

  getType(el: Element, qname: string): Element | undefined {
    const { ns, localName } = this.resolveQName(el, qname);
    return (ns ? this.qTypes.get(this.qkey(ns, localName)) : undefined) || this.types.get(localName);
  }

  getElement(el: Element, qname: string): Element | undefined {
    const { ns, localName } = this.resolveQName(el, qname);
    return (ns ? this.qElements.get(this.qkey(ns, localName)) : undefined) || this.elements.get(localName);
  }

  add(xml: string) {
    let doc: Document;
    try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return; }
    for (const schema of Array.from(doc.getElementsByTagNameNS(XS, 'schema'))) {
      const tns = schema.getAttribute('targetNamespace') || '';
      for (const c of Array.from(schema.children)) {
        if (c.namespaceURI === XS && (c.localName === 'include' || c.localName === 'import')) {
          const loc = c.getAttribute('schemaLocation') || '';
          const impNs = c.getAttribute('namespace') || tns;
          const parsed = parseSchemaRef(loc, c.localName as 'include' | 'import', impNs);
          if (parsed) this.ifrRefs.push(parsed);
          continue;
        }
        const name = c.getAttribute('name');
        if (!name) continue;
        const qk = this.qkey(tns, name);
        if (c.localName === 'element') {
          if (!this.qElements.has(qk)) this.qElements.set(qk, c);
          if (!this.elements.has(name)) this.elements.set(name, c);
        } else if (c.localName === 'complexType' || c.localName === 'simpleType') {
          if (!this.qTypes.has(qk)) this.qTypes.set(qk, c);
          if (!this.types.has(name)) this.types.set(name, c);
        }
      }
    }
  }
}

const xsKid = (el: Element, name: string) => Array.from(el.children).find((c) => c.localName === name && c.namespaceURI === XS);

function simpleBase(st: Element): string {
  const r = xsKid(st, 'restriction');
  return r?.getAttribute('base') || '';
}

function build(pool: Pool, rootName: string, rootType?: string, rootNs?: string): SNode | null {
  let count = 0;
  pool.missing.clear();

  const occOf = (el: Element) => {
    const min = el.getAttribute('minOccurs') ?? '1';
    const max = el.getAttribute('maxOccurs') ?? '1';
    return `${min}..${max}`;
  };

  function particles(container: Element, node: SNode, stack: string[], simple: boolean, inChoice: boolean) {
    for (const c of Array.from(container.children)) {
      if (c.namespaceURI !== XS || count > MAX_NODES) continue;
      switch (c.localName) {
        case 'sequence': case 'all':
          particles(c, node, stack, false, inChoice); break;
        case 'choice':
          particles(c, node, stack, false, true); break;
        case 'element': {
          const k = fromElement(c, node, stack, inChoice);
          if (k) node.kids.push(k);
          break;
        }
        case 'attribute': {
          const name = c.getAttribute('name') || local(c.getAttribute('ref') || '');
          if (!name) break;
          count++;
          node.kids.push({
            key: `${node.key}/@${name}`, name: `@${name}`, depth: node.depth + 1,
            occ: c.getAttribute('use') === 'required' ? '1..1' : '0..1', type: c.getAttribute('type') || '',
            kids: [], inChoice,
          });
          break;
        }
        case 'complexContent': particles(c, node, stack, false, inChoice); break;
        case 'simpleContent': particles(c, node, stack, true, inChoice); break;
        case 'extension': case 'restriction': {
          const baseAttr = c.getAttribute('base') || '';
          const base = local(baseAttr);
          const bdef = pool.getType(c, baseAttr);
          if (bdef && bdef.localName === 'complexType' && !stack.includes(base)) particles(bdef, node, [...stack, base], simple, inChoice);
          else if (simple || bdef?.localName === 'simpleType') node.type = bdef ? simpleBase(bdef) || baseAttr : baseAttr;
          else if (baseAttr && !builtin(baseAttr) && !bdef) pool.missing.add(base);
          particles(c, node, stack, simple, inChoice);
          break;
        }
        default: break;
      }
    }
  }

  function fromElement(el: Element, parent: SNode | null, stack: string[], inChoice: boolean): SNode | null {
    if (count++ > MAX_NODES) return null;
    const ref = el.getAttribute('ref');
    let decl: Element | undefined = el;
    if (ref) decl = pool.getElement(el, ref);
    const name = decl?.getAttribute('name') || local(ref || '');
    if (!name) return null;
    const depth = parent ? parent.depth + 1 : 0;
    const node: SNode = {
      key: `${parent ? parent.key : ''}/${name}`, name, depth,
      occ: parent ? occOf(el) : '1..1', type: '', kids: [], inChoice,
    };
    if (!decl) return node;
    const tAttr = decl.getAttribute('type');
    const inlineC = xsKid(decl, 'complexType');
    const inlineS = xsKid(decl, 'simpleType');
    if (inlineC) particles(inlineC, node, stack, false, false);
    else if (inlineS) node.type = simpleBase(inlineS);
    else if (tAttr) {
      const tn = local(tAttr);
      const tdef = pool.getType(decl, tAttr);
      if (tdef && tdef.localName === 'complexType') {
        if (stack.includes(tn) || depth > 24) node.type = `${tn} …`;
        else particles(tdef, node, [...stack, tn], false, false);
      } else if (tdef) node.type = simpleBase(tdef) || tAttr;
      else { node.type = tAttr; if (!builtin(tAttr)) pool.missing.add(tn); }
    }
    return node;
  }

  const el = (rootNs ? pool.qElements.get(`{${rootNs}}${rootName}`) : undefined) || pool.elements.get(rootName);
  if (el) return fromElement(el, null, [], false);
  if (rootType) {
    const tdef = (rootNs ? pool.qTypes.get(`{${rootNs}}${rootType}`) : undefined) || pool.types.get(rootType);
    if (!tdef) { pool.missing.add(rootType); return null; }
    const node: SNode = { key: `/${rootName}`, name: rootName, depth: 0, occ: '1..1', type: '', kids: [] };
    if (tdef.localName === 'complexType') particles(tdef, node, [rootType], false, false); else node.type = simpleBase(tdef);
    return node;
  }
  return null;
}

/**
 * Reads the full structure of a mapping's source or target message from the loaded files
 * (IDoc, RFC, External Definition, Message Type + recursive Data Types via BOTH ESR `TYPE` links
 * and `xs:include`/`xs:import` `ifr://schema?keyelements=name|namespace` URIs).
 */
export async function loadStructure(
  controller: DualTpzController, all: TpzObjectSummary[], archiveId: string, link: ObjectLink | undefined, rootName: string
): Promise<SNode | null> {
  if (!link || !rootName) return null;
  const pool = new Pool();
  const loadedObjIds = new Set<string>();
  const pendingTypeLinks: Array<{ typeId: string; name: string; ns: string }> = [];

  const addObj = async (o?: TpzObjectSummary) => {
    if (!o || loadedObjIds.has(o.id)) return null;
    loadedObjIds.add(o.id);
    try {
      const d = await cachedDetail(controller, o.id);
      pool.add(d.contentXml || '');
      // Also index embedded XSD/WSDL textualResources (solves relative includes inside ifmextdef!)
      for (const r of d.textualResources || []) {
        if (r.kind === 'xsd' || r.kind === 'wsdl') pool.add(r.content);
      }
      // Follow ESR ifmtypedef -> TYPE -> ifmtypedef edges
      for (const l of d.links) {
        if (l.role === 'TYPE' && (l.targetType === 'ifmtypedef' || l.targetType === 'ifmextdef')) {
          pendingTypeLinks.push({ typeId: l.targetType, name: l.targetName, ns: l.targetNamespace });
        }
      }
      return d;
    } catch {
      return null;
    }
  };

  let rootType: string | undefined;
  const name = link.targetName;
  const ns = link.targetNamespace;

  switch (link.targetType) {
    case 'idoc': await addObj(findObject(all, 'idoc', name, ns, archiveId)); break;
    case 'rfcmsg': case 'rfc':
      await addObj(findObject(all, 'rfc', name, ns, archiveId) || findObject(all, 'rfc', name.replace(/\.(Response|Exception)$/, ''), ns, archiveId));
      break;
    case 'ifmextmes': case 'ifmextdef': {
      const first = findObject(all, 'ifmextdef', link.elems[0] || name, link.elems[1] || ns, archiveId) || findObject(all, 'ifmextdef', name, ns, archiveId);
      await addObj(first);
      if (!pool.elements.has(rootName)) {
        const same = all.filter((o) => o.typeId === 'ifmextdef' && o.namespace === ns && o !== first).slice(0, 12);
        for (const o of same) { await addObj(o); if (pool.elements.has(rootName)) break; }
      }
      break;
    }
    case 'ifmmessage': case 'ifmfaultm': {
      const d = await addObj(findObject(all, link.targetType, name, ns, archiveId));
      const t = d?.links.find((l) => l.role === 'TYPE' || l.targetType === 'ifmtypedef');
      if (t) {
        rootType = t.targetName;
        const dt = await addObj(findObject(all, t.targetType, t.targetName, t.targetNamespace, archiveId));
        if (dt && !pool.types.has(rootType) && pool.elements.has(rootType)) { rootName = rootType; rootType = undefined; }
      }
      break;
    }
    default: await addObj(findObject(all, link.targetType, name, ns, archiveId));
  }

  // Resolve xs:include / xs:import (ifr://schema?keyelements=name|namespace) + ESR TYPE chains recursively
  const triedIfr = new Set<string>();
  const triedMissing = new Set<string>();
  let root = build(pool, rootName, rootType, ns);

  const resolveRelativeExtDef = async (ref: IfrRef): Promise<TpzObjectSummary | undefined> => {
    const rawLower = (ref.relativeBase || ref.name).toLowerCase();
    const stemLower = stripSchemaExt(rawLower).toLowerCase();
    const matchName = (o: TpzObjectSummary) => {
      const nLower = o.name.toLowerCase();
      return nLower === rawLower || stripSchemaExt(nLower) === stemLower;
    };
    const sameArch = all.filter((o) => o.typeId === 'ifmextdef' && o.archiveId === archiveId && matchName(o));
    const otherArch = all.filter((o) => o.typeId === 'ifmextdef' && o.archiveId !== archiveId && matchName(o));
    const groups = [sameArch, otherArch];

    for (const group of groups) {
      if (group.length === 0) continue;
      // 1. Exact case-insensitive filename + ESR namespace match
      if (ref.ns) {
        const esrExact = group.filter((o) => o.namespace === ref.ns);
        if (esrExact.length === 1) return esrExact[0];
        // 2. Exact case-insensitive filename + XSD targetNamespace match
        const tnsMatched: TpzObjectSummary[] = [];
        for (const cand of group.slice(0, 8)) {
          try {
            const d = await cachedDetail(controller, cand.id);
            const tnsSet = extractSchemaTargetNamespaces(d.contentXml || '');
            for (const r of d.textualResources || []) {
              if (r.kind === 'xsd' || r.kind === 'wsdl') {
                for (const t of extractSchemaTargetNamespaces(r.content)) tnsSet.add(t);
              }
            }
            if (tnsSet.has(ref.ns)) tnsMatched.push(cand);
          } catch {
            // ignore unreadable candidate
          }
        }
        if (tnsMatched.length === 1) return tnsMatched[0];
        if (tnsMatched.length > 1) return tnsMatched[0];
        if (esrExact.length > 0) return esrExact[0];
      }
      // 3. Unique filename match in the same archive (handles chameleon/no-namespace includes)
      if (group.length === 1) return group[0];
    }
    return undefined;
  };

  for (let round = 0; round < 8 && loadedObjIds.size < 120; round++) {
    let added = false;

    // 1. Drain ESR TYPE links (ifmtypedef -> TYPE -> ifmtypedef)
    while (pendingTypeLinks.length > 0 && loadedObjIds.size < 120) {
      const tl = pendingTypeLinks.shift()!;
      const o = findObject(all, tl.typeId, tl.name, tl.ns, archiveId) || findObject(all, tl.typeId, tl.name, undefined, archiveId);
      if (o && (await addObj(o))) added = true;
    }

    // 2. Drain xs:include / xs:import (both ifr://schema?keyelements= and relative ifmextdef filename+namespace)
    for (const ref of [...pool.ifrRefs]) {
      const rk = `${ref.kind}|${ref.ns}|${(ref.relativeBase || ref.name).toLowerCase()}`;
      if (triedIfr.has(rk) || loadedObjIds.size >= 120) continue;
      triedIfr.add(rk);
      let o: TpzObjectSummary | undefined;
      if (ref.relativeFile) {
        o = await resolveRelativeExtDef(ref);
      } else {
        o =
          findObject(all, 'ifmtypedef', ref.name, ref.ns, archiveId) ||
          findObject(all, 'ifmextdef', ref.name, ref.ns, archiveId) ||
          findObject(all, 'ifmtypedef', ref.name, undefined, archiveId);
      }
      if (o && (await addObj(o))) added = true;
    }

    // 3. Fallback by missing type name
    const want = [...pool.missing].filter((t) => !triedMissing.has(t));
    for (const t of want) {
      if (loadedObjIds.size >= 120) break;
      triedMissing.add(t);
      const o = findObject(all, 'ifmtypedef', t, ns, archiveId) || findObject(all, 'ifmtypedef', t, undefined, archiveId);
      if (o && (await addObj(o))) added = true;
    }

    if (!added) break;
    root = build(pool, rootName, rootType, ns);
  }
  return root;
}

/**
 * Lays the paths used by the mapping over the schema structure. Paths the schema does not
 * know (duplicated subtrees like `Item[1]`, variables) are added; without a schema the tree
 * is built from the mapping paths alone.
 */
export function mergePaths(schemaRoot: SNode | null, paths: string[]): SNode[] {
  const clone = (n: SNode): SNode => ({ ...n, kids: n.kids.map(clone) });
  const roots: SNode[] = [];
  if (schemaRoot) {
    const first = paths[0] ? normSeg(paths[0].split('/').filter(Boolean)[0] || '') : schemaRoot.name;
    if (!paths.length || first === schemaRoot.name) roots.push(clone(schemaRoot));
  }
  const fromSchema = roots.length > 0;
  for (const p of paths) {
    const segs = p.split('/').filter(Boolean);
    let list = roots;
    let shadow: SNode[] | undefined = roots;
    let key = '';
    for (let i = 0; i < segs.length; i++) {
      const n = normSeg(segs[i]);
      key += '/' + n;
      const base = n.replace(/\[\d+\]$/, '');
      const twin: SNode | undefined = shadow?.find((k) => normSeg(k.name) === base);
      let node = list.find((k) => k.key === key);
      if (!node) {
        node = {
          key, name: fromSchema ? n : segs[i], depth: i, occ: twin?.occ || '',
          type: twin && !twin.kids.length ? twin.type : '', kids: [], extra: fromSchema && !twin,
          inChoice: twin?.inChoice,
        };
        let at = -1;
        list.forEach((k, idx) => { if (normSeg(k.name).replace(/\[\d+\]$/, '') === base) at = idx; });
        if (at >= 0) list.splice(at + 1, 0, node); else list.push(node);
      }
      list = node.kids;
      shadow = twin?.kids;
    }
  }
  return roots;
}
