import type { MappingPayload, SimulatedStepQueue, SimulatedTargetQueue, SimulationResult } from './types';
import type { SNode } from '../ui/structure';

export const RESULT_SUPPRESS = '_sUpPresSeD_';
export const RESULT_CC = '__cC_';
export const RESULT_XSI_NIL = '_!xSi#NiL$_';

const normSeg = (s: string) => s.replace(/^(@?)[\w.-]+:/, '$1').replace(/\[\d+\]$/, '');
const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sampleLeafValue(name: string, type: string, idx: number): string {
  const n = name.toLowerCase();
  const t = (type || '').toLowerCase();
  if (n.includes('tax') || n.includes('vkn')) return idx === 1 ? '123-456-7890' : '987-654-3210';
  if (n.includes('date') || t.includes('date')) return '2026-11-19';
  if (n.includes('curr') || n.includes('waers')) return 'TRY';
  if (n.includes('salesorg') || n.includes('vkorg') || n.includes('bukrs') || n.includes('company')) return '1000';
  if (n.includes('uom') || n.includes('meins') || n.includes('unit')) return idx === 1 ? 'EA' : 'KG';
  if (n.includes('qty') || n.includes('menge') || n.includes('amount') || n.includes('price') || t.includes('dec') || t.includes('int') || t.includes('num')) {
    return idx === 1 ? '10' : '25';
  }
  if (n.includes('matnr') || n.includes('material')) return idx === 1 ? 'MAT-1001' : 'MAT-2002';
  if (n.includes('doc') || n.includes('order') || n.includes('vbeln') || n.includes('id')) return `ORD-2026-00${idx}`;
  if (n.includes('flag') || t.includes('bool')) return 'true';
  return `${name}_${idx}`;
}

/** Generate an editable, realistic Sample Source XML from XSD SNode tree or mapping source paths. */
export function generateSampleSourceXml(schemaRoot: SNode | null, mapping: MappingPayload): string {
  const usedPaths = new Set<string>();
  for (const fm of mapping.fieldMappings) {
    for (const sp of fm.sources) usedPaths.add('/' + sp.split('/').filter(Boolean).map(normSeg).join('/'));
  }

  // Build synthetic SNode tree from mapping source paths if schema is unavailable
  const buildFromPaths = (): SNode | null => {
    const roots: SNode[] = [];
    for (const p of usedPaths) {
      const segs = p.split('/').filter(Boolean);
      let list = roots;
      let key = '';
      for (let i = 0; i < segs.length; i++) {
        key += '/' + segs[i];
        let node = list.find((x) => x.key === key);
        if (!node) {
          node = { key, name: segs[i], depth: i, occ: i === segs.length - 2 && segs.length >= 3 ? '1..unbounded' : '1..1', type: 'xsd:string', kids: [] };
          list.push(node);
        }
        list = node.kids;
      }
    }
    return roots[0] || null;
  };

  const root = schemaRoot || buildFromPaths();
  if (!root) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<SourceMessage>\n  <Field>SAMPLE</Field>\n</SourceMessage>\n';
  }

  // Only emit branches that are either mandatory or referenced by the mapping (keeps huge IDocs compact!)
  const hasUsedDesc = new Map<string, boolean>();
  const markUsed = (n: SNode): boolean => {
    let hit = usedPaths.has(n.key);
    for (const k of n.kids) hit = markUsed(k) || hit;
    hasUsedDesc.set(n.key, hit);
    return hit;
  };
  markUsed(root);

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const emit = (n: SNode, indent: string, instIdx: number, depth: number) => {
    if (depth > 14) return;
    if (n.name.startsWith('@')) return;
    const attrs = n.kids.filter((k) => k.name.startsWith('@') && (hasUsedDesc.get(k.key) || k.occ.startsWith('1')));
    const attrStr = attrs.map((a) => ` ${a.name.slice(1)}="${escXml(sampleLeafValue(a.name.slice(1), a.type, instIdx))}"`).join('');
    const elemKids = n.kids.filter((k) => !k.name.startsWith('@') && (hasUsedDesc.get(k.key) || usedPaths.size === 0 || (k.occ.startsWith('1') && depth < 3)));

    if (elemKids.length === 0) {
      const val = sampleLeafValue(n.name, n.type, instIdx);
      lines.push(`${indent}<${n.name}${attrStr}>${escXml(val)}</${n.name}>`);
      return;
    }

    lines.push(`${indent}<${n.name}${attrStr}>`);
    for (const k of elemKids) {
      const repeats = k.occ.includes('unbounded') || k.occ.includes('..9') || k.occ.includes('..n');
      const count = repeats ? 2 : 1;
      for (let i = 1; i <= count; i++) {
        emit(k, indent + '  ', i, depth + 1);
      }
    }
    lines.push(`${indent}</${n.name}>`);
  };

  emit(root, '', 1, 0);
  return lines.join('\n') + '\n';
}

/* ---------- 100% Client-Side Browser Fallback Simulator (Zero-Upload) ---------- */

function splitContexts(q: string[]): string[][] {
  const out: string[][] = [[]];
  for (const v of q) {
    if (v === RESULT_CC) out.push([]);
    else out[out.length - 1].push(v);
  }
  return out;
}

function joinContexts(ctxs: string[][]): string[] {
  const out: string[] = [];
  ctxs.forEach((c, i) => {
    if (i > 0) out.push(RESULT_CC);
    out.push(...(c.length ? c : [RESULT_SUPPRESS]));
  });
  return out.length ? out : [RESULT_SUPPRESS];
}

function extractSourceQueue(root: Element, srcPath: string): string[] {
  const segs = srcPath.split('/').filter(Boolean).map(normSeg);
  if (!segs.length) return [RESULT_SUPPRESS];
  const rem = root.localName === segs[0] ? segs.slice(1) : segs;
  let groups: Element[][] = [[root]];
  if (!rem.length) {
    const v = (root.textContent || '').trim();
    return v ? [v] : [RESULT_SUPPRESS];
  }
  let attrName: string | null = null;
  const walkSegs = [...rem];
  if (walkSegs[walkSegs.length - 1].startsWith('@')) {
    attrName = walkSegs.pop()!.slice(1);
  }
  for (const seg of walkSegs) {
    const next: Element[][] = [];
    for (const g of groups) {
      for (const el of g) {
        next.push(Array.from(el.children).filter((c) => c.localName === seg));
      }
    }
    groups = next;
  }
  const ctxs = groups.map((g) => {
    const vals = g.map((el) => {
      if (attrName) {
        const a = el.getAttribute(attrName);
        return a !== null ? a : RESULT_SUPPRESS;
      }
      if (el.getAttribute('xsi:nil') === 'true') return RESULT_XSI_NIL;
      return (el.textContent || '').trim();
    });
    return vals.length ? vals : [RESULT_SUPPRESS];
  });
  return ctxs.length ? joinContexts(ctxs) : [RESULT_SUPPRESS];
}

const toBool = (s: string) => ['true', '1', 'yes'].includes((s || '').trim().toLowerCase());
const toNum = (s: string) => { const n = Number(String(s).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

function alignOp(args: string[][], fn: (vs: string[]) => string): string[] {
  if (!args.length) return [fn([])];
  const argCtxs = args.map(splitContexts);
  const maxC = Math.max(...argCtxs.map((c) => c.length));
  const out: string[][] = [];
  for (let ci = 0; ci < maxC; ci++) {
    const cur = argCtxs.map((c) => c[Math.min(ci, c.length - 1)]);
    const maxV = Math.max(...cur.map((l) => l.length));
    const cOut: string[] = [];
    for (let vi = 0; vi < maxV; vi++) {
      const vs = cur.map((l) => (vi < l.length ? l[vi] : l[l.length - 1] ?? RESULT_SUPPRESS));
      cOut.push(vs.some((v) => v === RESULT_SUPPRESS) ? RESULT_SUPPRESS : fn(vs));
    }
    out.push(cOut);
  }
  return joinContexts(out);
}

export function simulateMappingInBrowser(mapping: MappingPayload, sourceXml: string): SimulationResult {
  const t0 = performance.now();
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(sourceXml, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr || !doc.documentElement) {
    return {
      ok: false,
      error: `Invalid Source XML: ${parseErr?.textContent?.slice(0, 180) || 'parse error'}`,
      engine: 'browser-queue',
      durationMs: Math.round(performance.now() - t0),
      targetXml: '',
      targetQueues: [],
      udfExecutions: [],
      traces: [],
      warnings: [],
    };
  }

  const root = doc.documentElement;
  const nodesById = new Map(mapping.graphNodes.map((n) => [n.id, n]));
  const incoming = new Map<string, Array<{ pin: number; src: string }>>();
  for (const e of mapping.graphEdges) {
    const m = (e.label || '').match(/(\d+)/);
    const pin = m ? Number(m[1]) : 0;
    const list = incoming.get(e.target) || [];
    list.push({ pin, src: e.source });
    incoming.set(e.target, list);
  }
  for (const list of incoming.values()) list.sort((a, b) => a.pin - b.pin);
  const exprByTarget = new Map(mapping.fieldMappings.map((f) => [f.targetPath, f.expression]));
  const udfExecMap = new Map<string, { name: string; cacheType: string; status: 'skipped'; calls: number; compiledWith: string; error: string }>();

  const evalNode = (nid: string, steps: SimulatedStepQueue[], udfsHit: string[], depth = 0): string[] => {
    if (depth > 40) return [RESULT_SUPPRESS];
    const node = nodesById.get(nid);
    if (!node) return [RESULT_SUPPRESS];
    if (node.kind === 'source') {
      const q = extractSourceQueue(root, node.path || '');
      steps.push({ nodeId: nid, kind: 'source', label: node.label, path: node.path, queue: q });
      return q;
    }
    if (node.kind === 'const') {
      const q = [node.value || ''];
      steps.push({ nodeId: nid, kind: 'const', label: node.label, queue: q });
      return q;
    }
    const childQs = (incoming.get(nid) || []).map((x) => evalNode(x.src, steps, udfsHit, depth + 1));
    if (node.kind === 'target') {
      const q = childQs[0] || [RESULT_SUPPRESS];
      steps.push({ nodeId: nid, kind: 'target', label: node.label, path: node.path, queue: q });
      return q;
    }
    if (node.kind === 'udf') {
      udfsHit.push(node.label);
      if (!udfExecMap.has(node.label)) {
        udfExecMap.set(node.label, {
          name: node.label, cacheType: 'value', status: 'skipped', calls: 0, compiledWith: 'browser-passthrough',
          error: 'Switch to Local Power Engine (javac) for real Java UDF execution.',
        });
      }
      udfExecMap.get(node.label)!.calls++;
      const q = childQs[0] || [RESULT_SUPPRESS];
      steps.push({ nodeId: nid, kind: 'udf', label: node.label, queue: q, error: 'Browser passthrough' });
      return q;
    }
    const fn = (node.function || node.label || '').toLowerCase();
    const p = node.parameters || {};
    let q: string[];
    if (fn === 'const') q = [p.value || ''];
    else if (fn === 'concat') q = alignOp(childQs, (vs) => vs.join(p.delimeter ?? p.delimiter ?? ''));
    else if (fn === 'substring') {
      const st = toNum(p.from ?? p.start ?? '0'), cnt = toNum(p.count ?? p.length ?? '9999');
      q = alignOp(childQs, (vs) => (vs[0] || '').slice(st, st + cnt));
    } else if (fn === 'equalss' || fn === 'equals') q = alignOp(childQs, (vs) => (vs[0] === vs[1] ? 'true' : 'false'));
    else if (fn === 'if' || fn === 'ifs') q = alignOp(childQs, (vs) => (toBool(vs[0]) ? vs[1] || '' : vs[2] || ''));
    else if (fn === 'ifwithoutelse' || fn === 'ifwithoutelses') q = alignOp(childQs, (vs) => (toBool(vs[0]) ? vs[1] || '' : RESULT_SUPPRESS));
    else if (fn === 'exists') q = joinContexts(splitContexts(childQs[0] || []).map((c) => [c.some((x) => x !== RESULT_SUPPRESS) ? 'true' : 'false']));
    else if (fn === 'createif') q = (childQs[0] || []).map((v) => (v === RESULT_CC ? RESULT_CC : toBool(v) ? '' : RESULT_SUPPRESS));
    else if (fn === 'removecontexts') q = (childQs[0] || []).filter((v) => v !== RESULT_CC);
    else if (fn === 'collapsecontext') q = splitContexts(childQs[0] || []).map((c) => c.find((x) => x !== RESULT_SUPPRESS) ?? '');
    else if (fn === 'mapwithdefault') {
      const d = p.default ?? p.value ?? '';
      q = joinContexts(splitContexts(childQs[0] || []).map((c) => (c.every((x) => x === RESULT_SUPPRESS) ? [d] : c)));
    } else if (fn === 'useoneasmany' && childQs.length >= 3) {
      const vals = childQs[0].filter((v) => v !== RESULT_CC && v !== RESULT_SUPPRESS);
      const c1 = splitContexts(childQs[1]);
      const c2 = splitContexts(childQs[2]);
      q = joinContexts(c2.map((ctx, ci) => Array(Math.max(1, (c1[ci] || ctx).length)).fill(vals[Math.min(ci, vals.length - 1)] ?? RESULT_SUPPRESS)));
    } else if (fn === 'touppercase') q = alignOp(childQs, (vs) => (vs[0] || '').toUpperCase());
    else if (fn === 'tolowercase') q = alignOp(childQs, (vs) => (vs[0] || '').toLowerCase());
    else if (fn === 'trim') q = alignOp(childQs, (vs) => (vs[0] || '').trim());
    else if (fn === 'add') q = alignOp(childQs, (vs) => String(toNum(vs[0]) + toNum(vs[1])));
    else if (fn === 'subtract') q = alignOp(childQs, (vs) => String(toNum(vs[0]) - toNum(vs[1])));
    else if (fn === 'multiply') q = alignOp(childQs, (vs) => String(toNum(vs[0]) * toNum(vs[1])));
    else {
      q = childQs[0] || [RESULT_SUPPRESS];
      warnings.push(`Function '${node.label}' approximated in Browser Mode`);
    }
    if (!q.length) q = [RESULT_SUPPRESS];
    steps.push({ nodeId: nid, kind: 'func', label: node.label, queue: q });
    return q;
  };

  const targetQueues: SimulatedTargetQueue[] = [];
  for (const tn of mapping.graphNodes.filter((n) => n.kind === 'target')) {
    const tpath = tn.path || tn.targetGroup;
    const steps: SimulatedStepQueue[] = [];
    const udfsHit: string[] = [];
    const q = evalNode(tn.id, steps, udfsHit);
    targetQueues.push({
      targetPath: tpath,
      expression: exprByTarget.get(tpath) || '',
      queue: q,
      nonSuppressedCount: q.filter((v) => v !== RESULT_CC && v !== RESULT_SUPPRESS).length,
      suppressedCount: q.filter((v) => v === RESULT_SUPPRESS).length,
      contextCount: 1 + q.filter((v) => v === RESULT_CC).length,
      udfsExecuted: Array.from(new Set(udfsHit)),
      stepQueues: steps,
    });
  }

  // Build target XML string cleanly
  const targetXml = buildTargetXmlClient(targetQueues);
  return {
    ok: true,
    engine: 'browser-queue',
    durationMs: Math.round(performance.now() - t0),
    targetXml,
    targetQueues,
    udfExecutions: Array.from(udfExecMap.values()),
    traces: [],
    warnings: Array.from(new Set(warnings)),
  };
}

function buildTargetXmlClient(targetQueues: SimulatedTargetQueue[]): string {
  const entries = targetQueues
    .map((tq) => ({
      segs: tq.targetPath.split('/').filter(Boolean).map(normSeg),
      vals: tq.queue.filter((v) => v !== RESULT_CC && v !== RESULT_SUPPRESS),
    }))
    .filter((e) => e.segs.length > 0 && e.vals.length > 0);
  if (!entries.length) return '<?xml version="1.0" encoding="UTF-8"?>\n<!-- All target queues suppressed -->\n';

  interface NodeObj { tag: string; attrs: Record<string, string>; text?: string; kids: NodeObj[] }
  const root: NodeObj = { tag: entries[0].segs[0], attrs: {}, kids: [] };
  const repeatParents = new Set<string>();
  for (const e of entries) {
    if (e.vals.length > 1 && e.segs.length >= 3) repeatParents.add(e.segs.slice(0, -1).join('/'));
  }
  const cache = new Map<string, NodeObj>([[`${root.tag}#0`, root]]);
  const getNode = (segs: string[], idx: number): NodeObj => {
    const key = `${segs.join('/')}#${idx}`;
    if (cache.has(key)) return cache.get(key)!;
    const pSegs = segs.slice(0, -1);
    const pIdx = repeatParents.has(pSegs.join('/')) ? idx : 0;
    const parent = getNode(pSegs, pIdx);
    const el: NodeObj = { tag: segs[segs.length - 1], attrs: {}, kids: [] };
    parent.kids.push(el);
    cache.set(key, el);
    return el;
  };
  for (const e of entries) {
    const last = e.segs[e.segs.length - 1];
    const pSegs = e.segs.slice(0, -1);
    if (last.startsWith('@')) {
      e.vals.forEach((v, idx) => { getNode(pSegs, repeatParents.has(pSegs.join('/')) ? idx : 0).attrs[last.slice(1)] = v; });
      continue;
    }
    const rep = repeatParents.has(pSegs.join('/'));
    e.vals.forEach((v, idx) => {
      const el: NodeObj = rep || e.vals.length > 1 ? { tag: last, attrs: {}, kids: [] } : getNode(e.segs, 0);
      if (rep) getNode(pSegs, idx).kids.push(el);
      else if (e.vals.length > 1) getNode(pSegs, 0).kids.push(el);
      if (v === RESULT_XSI_NIL) { root.attrs['xmlns:xsi'] = 'http://www.w3.org/2001/XMLSchema-instance'; el.attrs['xsi:nil'] = 'true'; }
      else el.text = v;
    });
  }
  const render = (n: NodeObj, ind: string): string => {
    const a = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escXml(v)}"`).join('');
    if (!n.kids.length) return n.text !== undefined ? `${ind}<${n.tag}${a}>${escXml(n.text)}</${n.tag}>` : `${ind}<${n.tag}${a}/>`;
    return `${ind}<${n.tag}${a}>\n${n.kids.map((k) => render(k, ind + '  ')).join('\n')}\n${ind}</${n.tag}>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n${render(root, '')}\n`;
}
