import React, { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, FolderTree } from 'lucide-react';
import type { DualTpzController } from '../core/engines';
import type { TpzObjectDetail, TpzObjectSummary } from '../core/types';
import { loadStructure, type SNode } from './structure';
import type { Strings } from './strings';

const XS = 'http://www.w3.org/2001/XMLSchema';

/** Parse any standalone XSD/WSDL XML document directly into top-level SNode trees. */
export function parseXmlSchemasToNodes(xml: string): SNode[] {
  if (!xml) return [];
  let doc: Document;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return []; }
  const schemas = Array.from(doc.getElementsByTagNameNS(XS, 'schema'));
  if (!schemas.length) return [];

  const elements = new Map<string, Element>();
  const types = new Map<string, Element>();
  for (const sc of schemas) {
    for (const c of Array.from(sc.children)) {
      const nm = c.getAttribute('name');
      if (!nm) continue;
      if (c.localName === 'element' && !elements.has(nm)) elements.set(nm, c);
      else if ((c.localName === 'complexType' || c.localName === 'simpleType') && !types.has(nm)) types.set(nm, c);
    }
  }

  const local = (q: string) => (q.includes(':') ? q.slice(q.indexOf(':') + 1) : q);
  const xsKid = (el: Element, nm: string) => Array.from(el.children).find((c) => c.localName === nm && c.namespaceURI === XS);
  const occOf = (el: Element) => `${el.getAttribute('minOccurs') ?? '1'}..${el.getAttribute('maxOccurs') ?? '1'}`;
  const simpleBase = (st: Element) => xsKid(st, 'restriction')?.getAttribute('base') || '';
  let count = 0;

  const particles = (container: Element, node: SNode, stack: string[], simple: boolean) => {
    for (const c of Array.from(container.children)) {
      if (c.namespaceURI !== XS || count > 15000) continue;
      switch (c.localName) {
        case 'sequence': case 'choice': case 'all': case 'complexContent':
          particles(c, node, stack, false); break;
        case 'simpleContent':
          particles(c, node, stack, true); break;
        case 'element': {
          const k = fromEl(c, node, stack);
          if (k) node.kids.push(k);
          break;
        }
        case 'attribute': {
          const nm = c.getAttribute('name') || local(c.getAttribute('ref') || '');
          if (!nm) break;
          count++;
          node.kids.push({
            key: `${node.key}/@${nm}`, name: `@${nm}`, depth: node.depth + 1,
            occ: c.getAttribute('use') === 'required' ? '1..1' : '0..1', type: c.getAttribute('type') || 'xs:string', kids: [],
          });
          break;
        }
        case 'extension': case 'restriction': {
          const baseAttr = c.getAttribute('base') || '';
          const base = local(baseAttr);
          const bdef = types.get(base);
          if (bdef && bdef.localName === 'complexType' && !stack.includes(base)) particles(bdef, node, [...stack, base], simple);
          else if (simple || bdef?.localName === 'simpleType') node.type = bdef ? simpleBase(bdef) || baseAttr : baseAttr;
          particles(c, node, stack, simple);
          break;
        }
      }
    }
  };

  const fromEl = (el: Element, parent: SNode | null, stack: string[]): SNode | null => {
    if (count++ > 15000) return null;
    const ref = el.getAttribute('ref');
    const decl = ref ? elements.get(local(ref)) : el;
    const nm = decl?.getAttribute('name') || local(ref || '');
    if (!nm) return null;
    const depth = parent ? parent.depth + 1 : 0;
    const node: SNode = { key: `${parent ? parent.key : ''}/${nm}`, name: nm, depth, occ: parent ? occOf(el) : '1..1', type: '', kids: [] };
    if (!decl) return node;
    const tAttr = decl.getAttribute('type');
    const inlineC = xsKid(decl, 'complexType');
    const inlineS = xsKid(decl, 'simpleType');
    if (inlineC) particles(inlineC, node, stack, false);
    else if (inlineS) node.type = simpleBase(inlineS);
    else if (tAttr) {
      const tn = local(tAttr);
      const tdef = types.get(tn);
      if (tdef && tdef.localName === 'complexType') {
        if (stack.includes(tn) || depth > 22) node.type = `${tn} …`;
        else particles(tdef, node, [...stack, tn], false);
      } else if (tdef) node.type = simpleBase(tdef) || tAttr;
      else node.type = tAttr;
    }
    return node;
  };

  const roots: SNode[] = [];
  for (const [, el] of elements) {
    const r = fromEl(el, null, []);
    if (r) roots.push(r);
  }
  if (!roots.length) {
    for (const [tn, td] of types) {
      const node: SNode = { key: `/${tn}`, name: tn, depth: 0, occ: '1..1', type: '', kids: [] };
      if (td.localName === 'complexType') particles(td, node, [tn], false);
      else node.type = simpleBase(td);
      roots.push(node);
    }
  }
  return roots;
}

export const SchemaTreeView: React.FC<{
  detail: TpzObjectDetail;
  all: TpzObjectSummary[];
  controller: DualTpzController;
  s: Strings;
}> = ({ detail, all, controller, s }) => {
  const [roots, setRoots] = useState<SNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    (async () => {
      // First try resolving via loadStructure (resolves referenced Data Types!)
      const link = {
        role: 'SELF', kpos: '0', rMode: '', targetType: detail.typeId,
        targetOid: detail.oid, targetName: detail.name, targetNamespace: detail.namespace, elems: [detail.name, detail.namespace],
      };
      let list: SNode[] = [];
      const fromLoader = await loadStructure(controller, all, detail.archiveId, link, detail.name).catch(() => null);
      if (fromLoader) list = [fromLoader];
      if (!list.length) {
        const direct = parseXmlSchemasToNodes(detail.contentXml || '');
        if (direct.length) list = direct;
      }
      if (!list.length && detail.textualResources.length) {
        for (const r of detail.textualResources) {
          if (r.kind === 'xsd' || r.kind === 'wsdl' || r.kind === 'xml') {
            const parsed = parseXmlSchemasToNodes(r.content);
            if (parsed.length) { list.push(...parsed); break; }
          }
        }
      }
      if (!live) return;
      setRoots(list);
      const init = new Set<string>();
      const walk = (n: SNode) => { if (n.kids.length && n.depth <= 2) init.add(n.key); n.kids.forEach(walk); };
      list.forEach(walk);
      setOpen(init);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [detail.id, all.length]); // eslint-disable-line

  const { allExpandable, totalNodes, mandatoryCount } = useMemo(() => {
    const exp = new Set<string>();
    let total = 0;
    let mand = 0;
    const walk = (n: SNode) => {
      total++;
      if (n.occ.startsWith('1')) mand++;
      if (n.kids.length) exp.add(n.key);
      n.kids.forEach(walk);
    };
    roots.forEach(walk);
    return { allExpandable: exp, totalNodes: total, mandatoryCount: mand };
  }, [roots]);

  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => {
    const out: SNode[] = [];
    const walk = (n: SNode): boolean => {
      if (!needle) {
        out.push(n);
        if (open.has(n.key)) n.kids.forEach(walk);
        return true;
      }
      const at = out.length;
      out.push(n);
      const self = n.name.toLowerCase().includes(needle) || n.type.toLowerCase().includes(needle);
      let any = false;
      for (const k of n.kids) any = walk(k) || any;
      if (!self && !any) out.length = at;
      return self || any;
    };
    roots.forEach(walk);
    return out;
  }, [roots, open, needle]);

  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  if (loading) return <div className="pane muted">{s.loading}</div>;
  if (!roots.length) return <div className="pane muted">{s.schemaNoRoot}</div>;

  return (
    <div className="pane">
      <div className="tools">
        <input className="input" placeholder={s.filterStruct} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn sm line" onClick={() => setOpen(new Set(allExpandable))}>{s.expandAll}</button>
        <button className="btn sm line" onClick={() => setOpen(new Set())}>{s.collapseAll}</button>
        <span className="count">
          <FolderTree size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
          {totalNodes} {s.fields.toLowerCase()} · {mandatoryCount} (1..n)
        </span>
      </div>
      <div className="tablewrap">
        <table className="stable">
          <thead>
            <tr>
              <th>{s.structure}</th>
              <th style={{ width: 110 }}>{s.occ}</th>
              <th style={{ width: 190 }}>{s.type}</th>
              <th style={{ width: 96 }} />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 3000).map((n) => {
              const isOpen = Boolean(needle) || open.has(n.key);
              const isMand = n.occ.startsWith('1');
              const isAttr = n.name.startsWith('@');
              return (
                <tr key={n.key}>
                  <td>
                    <span className="tcell" style={{ paddingLeft: n.depth * 16 }}>
                      {n.kids.length > 0 ? (
                        <button className="twist" disabled={Boolean(needle)} onClick={() => toggle(n.key)}>
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      ) : <span className="twist" />}
                      <span className={`sname ${n.kids.length ? 'node' : ''} ${isAttr ? 'mono' : ''}`}>
                        {n.name}
                      </span>
                    </span>
                  </td>
                  <td className="socc">
                    <span className={`occ-pill ${isMand && !n.inChoice ? 'mand' : ''}`}>{n.occ || '—'}</span>
                    {n.inChoice && <span className="rk-badge rk-const" title="xs:choice branch">choice</span>}
                  </td>
                  <td className="stype" title={n.type}>{n.type || (n.kids.length ? 'complexType' : '—')}</td>
                  <td className="num">
                    <button
                      className="btn sm"
                      title={s.copyXpath}
                      onClick={() => {
                        navigator.clipboard?.writeText(n.key).then(() => {
                          setCopiedKey(n.key);
                          setTimeout(() => setCopiedKey(null), 1100);
                        });
                      }}
                    >
                      {copiedKey === n.key ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
