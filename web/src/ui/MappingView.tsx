import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileSpreadsheet,
  GitFork,
  Layers,
  Network,
  Play,
  Table2,
} from 'lucide-react';
import type { DualTpzController } from '../core/engines';
import { exportObjectsToExcelSpec } from '../core/excelExport';
import type {
  FieldMappingRow,
  MappingGraphNode,
  MappingPayload,
  TpzArchiveSummary,
  TpzObjectDetail,
  TpzObjectSummary,
} from '../core/types';
import { downloadTextFile } from './CodeViewer';
import { MappingGraphCanvas } from './MappingGraphCanvas';
import { MappingSimulatorView } from './MappingSimulatorView';
import type { Strings } from './strings';
import { loadStructure, mergePaths, normPath, normSeg, type SNode } from './structure';

const isEmptyRule = (f: FieldMappingRow) => {
  const e = (f.expression || '').trim();
  return (!e || e === "''" || e === '(empty)') && f.sources.length === 0;
};

type RuleKind = 'udf' | 'func' | 'const' | 'direct' | 'empty';

function classifyRule(f: FieldMappingRow | undefined): RuleKind {
  if (!f || isEmptyRule(f)) return 'empty';
  if (f.udfs.length > 0) return 'udf';
  const e = f.expression.trim();
  if (f.sources.length === 1 && (e === f.sources[0] || normPath(e) === normPath(f.sources[0]))) return 'direct';
  if (f.sources.length === 0 && f.constants.length > 0) return 'const';
  return 'func';
}

const NODE_FUNCTIONS = new Set([
  'useOneAsMany', 'SplitByValue', 'collapseContext', 'removeContexts', 'createIf', 'exists', 'mapWithDefault', 'formatByExample', 'sortByKey',
]);

const TOKEN = /('(?:\\.|[^'\\])*')|(\/[^\s,()']+)|([A-Za-z_][\w.]*(?:\[[^\]]*\])?)(?=\()/g;

export const Expr: React.FC<{ text: string; udfNames: Set<string> }> = ({ text, udfNames }) => {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) parts.push(<span key={last} className="x-p">{text.slice(last, m.index)}</span>);
    const base = (m[3] || '').replace(/\[.*$/, '');
    const cls = m[1] ? 'x-c' : m[2] ? 'x-s' : udfNames.has(base) || m[3].includes('[') ? 'x-u' : 'x-f';
    parts.push(<span key={m.index} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(<span key={last} className="x-p">{text.slice(last)}</span>);
  return <>{parts}</>;
};

const ancestors = (key: string): string[] => {
  const segs = key.split('/').filter(Boolean);
  const out: string[] = [];
  let p = '';
  for (let i = 0; i < segs.length - 1; i++) { p += '/' + segs[i]; out.push(p); }
  return out;
};

/* ---------- Structure panel (Source or Target) ---------- */

interface PanelProps {
  title: string;
  name: string;
  roots: SNode[];
  mapped: Set<string>;
  ruleKindByKey?: Map<string, RuleKind>;
  missingMand?: Set<string>;
  selKey: string | null;
  marks: Set<string>;
  q: string;
  onlyMapped: boolean;
  onlyMissing: boolean;
  onSelect: (key: string) => void;
  s: Strings;
  partial: boolean;
}

const StructPanel: React.FC<PanelProps> = ({
  title, name, roots, mapped, ruleKindByKey, missingMand, selKey, marks, q, onlyMapped, onlyMissing, onSelect, s, partial,
}) => {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const body = useRef<HTMLDivElement>(null);

  const { total, live, allExpandable } = useMemo(() => {
    let total = 0;
    const live = new Set<string>();
    const allExpandable = new Set<string>();
    const walk = (n: SNode): boolean => {
      total++;
      if (n.kids.length) allExpandable.add(n.key);
      let any = mapped.has(n.key);
      for (const k of n.kids) any = walk(k) || any;
      if (any) live.add(n.key);
      return any;
    };
    roots.forEach(walk);
    return { total, live, allExpandable };
  }, [roots, mapped]);

  useEffect(() => {
    const next = new Set<string>();
    const walk = (n: SNode) => {
      if (n.kids.length && (total <= 260 || n.depth <= 1 || live.has(n.key))) next.add(n.key);
      n.kids.forEach(walk);
    };
    roots.forEach(walk);
    setOpen(next);
  }, [roots]); // eslint-disable-line

  const revealKey = [...marks].join('\n') + '|' + (selKey || '');
  useEffect(() => {
    const want = [...marks, ...(selKey ? [selKey] : [])];
    if (!want.length) return;
    setOpen((prev) => {
      const next = new Set(prev);
      for (const k of want) for (const a of ancestors(k)) next.add(a);
      return next.size === prev.size ? prev : next;
    });
    const t = setTimeout(() => {
      const el = body.current?.querySelector(marks.size ? 'tr.mark' : 'tr.sel');
      el?.scrollIntoView({ block: 'nearest' });
    }, 80);
    return () => clearTimeout(t);
  }, [revealKey, roots]); // eslint-disable-line

  const filtering = Boolean(q) || onlyMapped || (onlyMissing && Boolean(missingMand));
  const rows = useMemo(() => {
    const out: SNode[] = [];
    const walk = (n: SNode): boolean => {
      if (!filtering) {
        out.push(n);
        if (open.has(n.key)) n.kids.forEach(walk);
        return true;
      }
      const at = out.length;
      out.push(n);
      const self =
        (!q || n.name.toLowerCase().includes(q)) &&
        (!onlyMapped || mapped.has(n.key)) &&
        (!onlyMissing || !missingMand || missingMand.has(n.key));
      let any = false;
      for (const k of n.kids) any = walk(k) || any;
      if (!self && !any) out.length = at;
      return self || any;
    };
    roots.forEach(walk);
    return out;
  }, [roots, open, q, onlyMapped, onlyMissing, missingMand, mapped, filtering]);

  const toggle = (key: string) => setOpen((p) => { const n = new Set(p); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  return (
    <div className="spanel">
      <div className="shead">
        <span className="muted">{title}</span>
        <strong title={name}>{name || '—'}</strong>
        {partial && <span className="muted small" title={s.partialHint}>· {s.partial}</span>}
        <span className="scount muted small">{mapped.size} / {total}</span>
        <button className="btn sm" style={{ height: 22, padding: '0 6px', fontSize: 11.5 }} onClick={() => setOpen(new Set(allExpandable))} title={s.expandAll}>+</button>
        <button className="btn sm" style={{ height: 22, padding: '0 6px', fontSize: 11.5 }} onClick={() => setOpen(new Set())} title={s.collapseAll}>−</button>
      </div>
      <div className="sbody" ref={body}>
        <table className="stable">
          <thead>
            <tr>
              <th>{s.structure}</th>
              <th style={{ width: 76 }}>{s.occ}</th>
              <th style={{ width: 108 }}>{s.type}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 3000).map((n) => {
              const isOpen = filtering || open.has(n.key);
              const on = mapped.has(n.key);
              const rkind = ruleKindByKey?.get(n.key);
              const isMiss = missingMand?.has(n.key);
              return (
                <tr key={n.key} className={`${selKey === n.key ? 'sel' : ''} ${marks.has(n.key) ? 'mark' : ''} ${isMiss ? 'miss-row' : ''}`} onClick={() => onSelect(n.key)}>
                  <td>
                    <span className="tcell" style={{ paddingLeft: n.depth * 14 }}>
                      {n.kids.length > 0 ? (
                        <button className="twist" disabled={filtering} onClick={(e) => { e.stopPropagation(); toggle(n.key); }}>
                          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        </button>
                      ) : <span className="twist" />}
                      <span className={`sdot ${on ? 'on' : ''} ${isMiss ? 'miss' : ''}`} />
                      <span className={`sname ${n.kids.length ? 'node' : ''} ${on || live.has(n.key) || isMiss ? '' : 'idle'}`}>{n.name}</span>
                      {rkind && rkind !== 'empty' && (
                        <span className={`rk-badge rk-${rkind}`}>
                          {rkind === 'udf' ? 'UDF' : rkind === 'const' ? 'C' : rkind === 'direct' ? '1:1' : 'fx'}
                        </span>
                      )}
                      {isMiss && <span className="rk-badge rk-miss" title={s.missingMandatory}>!</span>}
                    </span>
                  </td>
                  <td className="socc">{n.occ}</td>
                  <td className="stype" title={n.type}>{n.type}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty-note">{s.noMatch}</div>}
      </div>
    </div>
  );
};

/* ---------- Quick Inline Flow Graph for bottom ESR pane ---------- */

interface GItem { n: MappingGraphNode; depth: number; kids: GItem[]; row: number }
const GW = 160, GH = 30, GX = 32, GY = 8;

const QuickFlowGraph: React.FC<{ mapping: MappingPayload; target: string; onUdf: (k: string) => void; onSource: (path: string) => void }> = ({ mapping, target, onUdf, onSource }) => {
  const layout = useMemo(() => {
    const nodes = mapping.graphNodes.filter((n) => n.targetGroup === target);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const kidsOf = new Map<string, string[]>();
    for (const e of mapping.graphEdges) {
      if (!byId.has(e.source) || !byId.has(e.target)) continue;
      const l = kidsOf.get(e.target) || [];
      l.push(e.source);
      kidsOf.set(e.target, l);
    }
    const root = nodes.find((n) => n.kind === 'target');
    if (!root) return null;
    let count = 0, leaf = 0, maxDepth = 0;
    const items: GItem[] = [];
    const make = (id: string, depth: number, seen: Set<string>): GItem | null => {
      const n = byId.get(id);
      if (!n || seen.has(id) || count++ > 500) return null;
      const it: GItem = { n, depth, kids: [], row: 0 };
      maxDepth = Math.max(maxDepth, depth);
      const next = new Set(seen).add(id);
      for (const k of kidsOf.get(id) || []) { const c = make(k, depth + 1, next); if (c) it.kids.push(c); }
      if (!it.kids.length) it.row = leaf++;
      else it.row = (it.kids[0].row + it.kids[it.kids.length - 1].row) / 2;
      items.push(it);
      return it;
    };
    if (!make(root.id, 0, new Set())) return null;
    const x = (it: GItem) => (maxDepth - it.depth) * (GW + GX);
    const y = (it: GItem) => it.row * (GH + GY);
    return { items, x, y, width: (maxDepth + 1) * (GW + GX) - GX, height: Math.max(1, leaf) * (GH + GY) - GY };
  }, [mapping, target]);

  if (!layout) return null;
  const { items, x, y, width, height } = layout;
  const text = (n: MappingGraphNode) => (n.kind === 'source' || n.kind === 'target' ? normSeg((n.path || n.label).split('/').pop() || n.label) : n.label);
  const tip = (n: MappingGraphNode) => {
    const p = n.parameters ? Object.entries(n.parameters).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(', ') : '';
    return [n.path || n.label, p].filter(Boolean).join('\n');
  };

  return (
    <div className="graph" style={{ width, height }}>
      <svg width={width} height={height} aria-hidden>
        {items.flatMap((p) => p.kids.map((c) => {
          const x1 = x(c) + GW, y1 = y(c) + GH / 2, x2 = x(p), y2 = y(p) + GH / 2, h = GX / 2;
          return <path key={`${c.n.id}-${p.n.id}-${c.row}`} d={`M${x1} ${y1} C${x1 + h} ${y1} ${x2 - h} ${y2} ${x2} ${y2}`} />;
        }))}
      </svg>
      {items.map((it, i) => {
        const n = it.n;
        const click = n.kind === 'udf' ? () => onUdf(n.udfKey || n.label) : n.kind === 'source' && n.path ? () => onSource(n.path!) : undefined;
        return (
          <div key={n.id + i} className={`gnode g-${n.kind} ${click ? 'clk' : ''}`} style={{ left: x(it), top: y(it), width: GW, height: GH }} title={tip(n)} onClick={click}>
            <span>{text(n)}</span>
          </div>
        );
      })}
    </div>
  );
};

/* ---------- Main Mapping Workbench (4 Sub-Views!) ---------- */

const msgName = (l?: { targetType: string; targetName: string; elems: string[] }) =>
  !l ? '' : l.targetType === 'ifmextmes' && l.elems.length >= 4 && l.elems[2] !== l.elems[0] ? l.elems[2] : l.targetName;
const MSG_KIND: Record<string, string> = { idoc: 'IDoc', rfcmsg: 'RFC', rfc: 'RFC', ifmextmes: 'External Message', ifmmessage: 'Message Type', ifmfaultm: 'Fault Message' };

type SubMode = 'esr' | 'graph' | 'table' | 'sources' | 'sim';

export const MappingWorkbench: React.FC<{
  detail: TpzObjectDetail;
  archives: TpzArchiveSummary[];
  all: TpzObjectSummary[];
  controller: DualTpzController;
  s: Strings;
  focus?: string;
  onUdf: (key: string) => void;
}> = ({ detail, archives, all, controller, s, focus, onUdf }) => {
  const mapping = detail.mapping!;
  const [subMode, setSubMode] = useState<SubMode>('esr');
  const [qRaw, setQ] = useState('');
  const [onlyMapped, setOnlyMapped] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [tableFilterKind, setTableFilterKind] = useState<'all' | RuleKind>('all');
  const [sel, setSel] = useState<{ side: 'src' | 'dst'; key: string } | null>(focus ? { side: 'dst', key: normPath(focus) } : null);
  const [graphTarget, setGraphTarget] = useState<string | null>(focus || null);
  const [botH, setBotH] = useState(260);
  const [struct, setStruct] = useState<{ src: SNode | null; dst: SNode | null }>({ src: null, dst: null });
  const [copied, setCopied] = useState(false);
  const [srcQuery, setSrcQuery] = useState('');
  const [openSrc, setOpenSrc] = useState<string | null>(null);
  const q = qRaw.trim().toLowerCase();

  useEffect(() => {
    setSel(focus ? { side: 'dst', key: normPath(focus) } : null);
    setGraphTarget(focus || null);
  }, [focus, detail.id]);

  const srcLink = detail.links.find((l) => l.role === 'SOURCE_IFR_MESS');
  const dstLink = detail.links.find((l) => l.role === 'TARGET_IFR_MESS');

  const idx = useMemo(() => {
    const rules = new Map<string, FieldMappingRow>();
    const ruleKindByKey = new Map<string, RuleKind>();
    const usedBy = new Map<string, FieldMappingRow[]>();
    const targets: string[] = [];
    const sources: string[] = [];
    let nodeFnCount = 0;

    for (const f of mapping.fieldMappings) {
      const k = normPath(f.targetPath);
      targets.push(f.targetPath);
      if (!rules.has(k) || isEmptyRule(rules.get(k)!)) {
        rules.set(k, f);
        ruleKindByKey.set(k, classifyRule(f));
      }
      for (const x of new Set(f.sources)) {
        const sk = normPath(x);
        if (!usedBy.has(sk)) { usedBy.set(sk, []); sources.push(x); }
        usedBy.get(sk)!.push(f);
      }
    }
    for (const gn of mapping.graphNodes) {
      if (gn.kind === 'func' && NODE_FUNCTIONS.has(gn.label)) nodeFnCount++;
    }
    const mappedDst = new Set([...rules].filter(([, f]) => !isEmptyRule(f)).map(([k]) => k));
    return {
      rules, ruleKindByKey, usedBy, targets, sources: sources.sort(),
      mappedDst, mappedSrc: new Set(usedBy.keys()), nodeFnCount,
    };
  }, [mapping]);

  useEffect(() => {
    let live = true;
    setStruct({ src: null, dst: null });
    const rootOf = (paths: string[]) => (paths[0] ? normSeg(paths[0].split('/').filter(Boolean)[0] || '') : '');
    Promise.all([
      loadStructure(controller, all, detail.archiveId, srcLink, rootOf(idx.sources)).catch(() => null),
      loadStructure(controller, all, detail.archiveId, dstLink, rootOf(idx.targets)).catch(() => null),
    ]).then(([src, dst]) => { if (live) setStruct({ src, dst }); });
    return () => { live = false; };
  }, [detail.id, all.length]); // eslint-disable-line

  const srcRoots = useMemo(() => mergePaths(struct.src, idx.sources), [struct.src, idx]);
  const dstRoots = useMemo(() => mergePaths(struct.dst, idx.targets), [struct.dst, idx]);
  const udfNames = useMemo(() => new Set(mapping.udfs.map((u) => u.name)), [mapping]);

  // Compute mandatory (1..1 / 1..unbounded) leaf target fields that have NO rule (when XSD schema is available)
  // Excludes branches inside <xsd:choice> (choice branches are mutually optional)
  const missingMand = useMemo(() => {
    const miss = new Set<string>();
    if (!struct.dst) return miss;
    const walk = (n: SNode, parentMand: boolean) => {
      if (n.inChoice) return;
      const isMand = n.depth === 0 || n.occ.startsWith('1');
      if (n.kids.length === 0) {
        if (parentMand && isMand && !idx.mappedDst.has(n.key)) miss.add(n.key);
      } else {
        for (const k of n.kids) walk(k, parentMand && isMand);
      }
    };
    dstRoots.forEach((r) => walk(r, true));
    return miss;
  }, [struct.dst, dstRoots, idx.mappedDst]);

  const rule = sel?.side === 'dst' ? idx.rules.get(sel.key) : undefined;
  const srcUse = sel?.side === 'src' ? idx.usedBy.get(sel.key) || [] : [];
  const srcMarks = useMemo(() => new Set(rule ? rule.sources.map(normPath) : []), [rule]);
  const dstMarks = useMemo(() => new Set(srcUse.map((f) => normPath(f.targetPath))), [sel, idx]); // eslint-disable-line
  const none = useMemo(() => new Set<string>(), []);

  // Flat Table rows
  const tableRows = useMemo(() => {
    return mapping.fieldMappings.filter((f) => {
      const rk = classifyRule(f);
      if (tableFilterKind !== 'all' && rk !== tableFilterKind) return false;
      if (!q) return true;
      return (
        f.targetPath.toLowerCase().includes(q) ||
        f.expression.toLowerCase().includes(q) ||
        f.sources.some((x) => x.toLowerCase().includes(q)) ||
        f.constants.some((x) => x.toLowerCase().includes(q)) ||
        f.udfs.some((x) => x.toLowerCase().includes(q))
      );
    });
  }, [mapping.fieldMappings, tableFilterKind, q]);

  // Source Impact Matrix rows
  const sourceMatrix = useMemo(() => {
    const sq = srcQuery.trim().toLowerCase();
    return [...idx.usedBy.entries()]
      .map(([sk, list]) => ({ key: sk, targets: list }))
      .filter((r) => !sq || r.key.toLowerCase().includes(sq) || r.targets.some((t) => t.targetPath.toLowerCase().includes(sq)))
      .sort((a, b) => b.targets.length - a.targets.length || a.key.localeCompare(b.key));
  }, [idx.usedBy, srcQuery]);

  const exportCsv = () => {
    const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Target Path', 'Kind', 'Expression', 'Sources', 'Constants', 'UDFs', 'Format'].map(esc).join(','),
      ...mapping.fieldMappings.map((f) =>
        [f.targetPath, classifyRule(f), f.expression, f.sources.join('; '), f.constants.join(' | '), f.udfs.join(', '), f.schemaFormat]
          .map(esc)
          .join(',')
      ),
    ];
    downloadTextFile(`${detail.name}_mappings.csv`, '\uFEFF' + lines.join('\n'), 'text/csv;charset=utf-8');
  };

  const exportSingleExcel = () => {
    const arch = archives.find((a) => a.archiveId === detail.archiveId);
    exportObjectsToExcelSpec(arch ? [arch] : archives, [detail], `${detail.name}_Spec.xls`);
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = botH;
    const move = (ev: MouseEvent) => setBotH(Math.min(620, Math.max(120, h0 + (y0 - ev.clientY))));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  return (
    <div className="wb">
      {/* Sub-mode switcher + Health metrics strip */}
      <div className="wb-headbar">
        <div className="seg">
          <button className={subMode === 'esr' ? 'on' : ''} onClick={() => setSubMode('esr')}>
            <Layers size={13} /><span>{s.tabWorkbench}</span>
          </button>
          <button className={subMode === 'graph' ? 'on' : ''} onClick={() => { if (rule) setGraphTarget(rule.targetPath); setSubMode('graph'); }}>
            <Network size={13} /><span>{s.tabGraph}</span>
          </button>
          <button className={subMode === 'table' ? 'on' : ''} onClick={() => setSubMode('table')}>
            <Table2 size={13} /><span>{s.tabFields} ({mapping.fieldMappings.length})</span>
          </button>
          <button className={subMode === 'sources' ? 'on' : ''} onClick={() => setSubMode('sources')}>
            <GitFork size={13} /><span>{s.tabSources} ({idx.usedBy.size})</span>
          </button>
          <button className={subMode === 'sim' ? 'on' : ''} onClick={() => setSubMode('sim')}>
            <Play size={13} /><span>{s.tabSimulator}</span>
          </button>
        </div>

        <div className="wb-badges">
          <span className="pill-stat">{idx.mappedDst.size} {s.legendMapped}</span>
          {mapping.udfs.length > 0 && <span className="pill-stat udf"><Code2 size={11} /> {mapping.udfs.length} UDF</span>}
          {idx.nodeFnCount > 0 && <span className="pill-stat warn">{idx.nodeFnCount} {s.nodeFunctions}</span>}
          {missingMand.size > 0 && (
            <button
              className={`pill-stat bad ${onlyMissing ? 'active' : ''}`}
              onClick={() => { setSubMode('esr'); setOnlyMissing((v) => !v); }}
              title={s.onlyMissingMandatory}
            >
              <AlertTriangle size={11} /> {missingMand.size} {s.missingMandatory}
            </button>
          )}
        </div>

        <span className="spacer" />
        <button className="btn sm line" onClick={exportCsv}><Download size={12} /><span>{s.exportCsv}</span></button>
        <button className="btn sm line" onClick={exportSingleExcel}><FileSpreadsheet size={12} /><span>{s.exportMappingExcel}</span></button>
      </div>

      {/* MODE 1: ESR Split Workbench */}
      {subMode === 'esr' && (
        <>
          <div className="wbtools">
            <input className="input" placeholder={s.filterStruct} value={qRaw} onChange={(e) => setQ(e.target.value)} />
            <label className="check"><input type="checkbox" checked={onlyMapped} onChange={(e) => setOnlyMapped(e.target.checked)} />{s.onlyMappedFields}</label>
            {missingMand.size > 0 && (
              <label className="check"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />{s.onlyMissingMandatory} ({missingMand.size})</label>
            )}
            <span className="legend muted small">
              <span className="sdot on" />{s.legendMapped}
              <span className="sdot" style={{ marginLeft: 10 }} />{s.legendIdle}
              {missingMand.size > 0 && <><span className="sdot miss" style={{ marginLeft: 10 }} />{s.legendMissing}</>}
            </span>
          </div>
          <div className="wbtop">
            <StructPanel
              title={MSG_KIND[srcLink?.targetType || ''] || s.kSource} name={msgName(srcLink)}
              roots={srcRoots} mapped={idx.mappedSrc}
              selKey={sel?.side === 'src' ? sel.key : null} marks={sel?.side === 'dst' ? srcMarks : none}
              q={q} onlyMapped={onlyMapped} onlyMissing={false}
              onSelect={(key) => setSel({ side: 'src', key })} s={s} partial={!struct.src}
            />
            <StructPanel
              title={MSG_KIND[dstLink?.targetType || ''] || s.kTarget} name={msgName(dstLink)}
              roots={dstRoots} mapped={idx.mappedDst} ruleKindByKey={idx.ruleKindByKey} missingMand={missingMand}
              selKey={sel?.side === 'dst' ? sel.key : null} marks={sel?.side === 'src' ? dstMarks : none}
              q={q} onlyMapped={onlyMapped} onlyMissing={onlyMissing}
              onSelect={(key) => setSel({ side: 'dst', key })} s={s} partial={!struct.dst}
            />
          </div>
          <div className="wbgrip" onMouseDown={startDrag} />
          <div className="wbbot" style={{ height: botH }}>
            {!sel ? (
              <div className="muted">{s.pickAny}</div>
            ) : sel.side === 'dst' ? (
              !rule || isEmptyRule(rule) ? (
                <div><div className="mono">{sel.key}</div><div className="muted" style={{ marginTop: 6 }}>{s.noRule}</div></div>
              ) : (
                <>
                  <div className="rulebar">
                    <code className="ruletext"><Expr text={rule.expression} udfNames={udfNames} /></code>
                    <button className="btn sm line" onClick={() => { setGraphTarget(rule.targetPath); setSubMode('graph'); }}>
                      <Network size={12} /><span>{s.tabGraph}</span>
                    </button>
                    <button className="btn sm line" onClick={() => navigator.clipboard?.writeText(rule.expression).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}>
                      {copied ? <Check size={12} /> : <Copy size={12} />}<span>{copied ? s.copied : s.copy}</span>
                    </button>
                  </div>
                  <QuickFlowGraph mapping={mapping} target={rule.targetPath} onUdf={onUdf} onSource={(p) => setSel({ side: 'src', key: normPath(p) })} />
                </>
              )
            ) : (
              <>
                <div className="mono">{sel.key}</div>
                {srcUse.length === 0 ? <div className="muted" style={{ marginTop: 6 }}>{s.srcUnused}</div> : (
                  <>
                    <div className="muted small" style={{ margin: '6px 0 4px' }}>{srcUse.length} {s.usedByTargets}</div>
                    {srcUse.map((f, i) => (
                      <div className="userow" key={i}>
                        <button className="link mono" onClick={() => setSel({ side: 'dst', key: normPath(f.targetPath) })}>{f.targetPath}</button>
                        <code className="ruletext one"><Expr text={f.expression} udfNames={udfNames} /></code>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* MODE 2: Full Interactive ReactFlow Visual Graph */}
      {subMode === 'graph' && (
        <div className="wb-fullpane">
          <MappingGraphCanvas
            mapping={mapping}
            s={s}
            selectedTarget={graphTarget}
            onSelectTarget={setGraphTarget}
            onOpenUdf={onUdf}
            onLocateSource={(sp) => { setSel({ side: 'src', key: normPath(sp) }); setSubMode('esr'); }}
          />
        </div>
      )}

      {/* MODE 3: Flat Searchable Field Mappings Spec Table */}
      {subMode === 'table' && (
        <div className="pane">
          <div className="tools">
            <input className="input" placeholder={s.filterFields} value={qRaw} onChange={(e) => setQ(e.target.value)} />
            <div className="chips-row">
              {([
                ['all', s.all],
                ['direct', s.kDirect],
                ['func', s.kFunc],
                ['udf', s.kUdf],
                ['const', s.kConst],
                ['empty', s.kEmpty],
              ] as Array<['all' | RuleKind, string]>).map(([k, lbl]) => (
                <button key={k} className={`chip-btn ${tableFilterKind === k ? 'on' : ''}`} onClick={() => setTableFilterKind(k)}>
                  {lbl}
                </button>
              ))}
            </div>
            <span className="count">{tableRows.length} / {mapping.fieldMappings.length}</span>
          </div>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '28%' }}>{s.target}</th>
                  <th style={{ width: 78 }}>{s.type}</th>
                  <th>{s.rule}</th>
                  <th style={{ width: '20%' }}>{s.sources}</th>
                  <th style={{ width: 92 }} />
                </tr>
              </thead>
              <tbody>
                {tableRows.slice(0, 1500).map((f, i) => {
                  const rk = classifyRule(f);
                  return (
                    <tr key={f.targetPath + i} className="click" onClick={() => { setSel({ side: 'dst', key: normPath(f.targetPath) }); setSubMode('esr'); }}>
                      <td className="mono small">{f.targetPath}</td>
                      <td><span className={`rk-badge rk-${rk}`}>{rk.toUpperCase()}</span></td>
                      <td className="mono small"><Expr text={f.expression} udfNames={udfNames} /></td>
                      <td className="mono small muted">{f.sources.map((x) => normSeg(x.split('/').pop() || x)).join(', ') || '—'}</td>
                      <td className="num" onClick={(e) => e.stopPropagation()}>
                        <button className="btn sm" title={s.tabGraph} onClick={() => { setGraphTarget(f.targetPath); setSubMode('graph'); }}>
                          <Network size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* MODE 4: Source-to-Target Impact Matrix */}
      {subMode === 'sources' && (
        <div className="pane">
          <div className="tools">
            <input className="input" placeholder={s.filterSources} value={srcQuery} onChange={(e) => setSrcQuery(e.target.value)} />
            <span className="muted small">{s.sourcesHint}</span>
            <span className="count">{sourceMatrix.length}</span>
          </div>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{s.sourceField}</th>
                  <th className="num" style={{ width: 130 }}>{s.usedIn}</th>
                </tr>
              </thead>
              <tbody>
                {sourceMatrix.map((r) => {
                  const expanded = openSrc === r.key;
                  return (
                    <React.Fragment key={r.key}>
                      <tr className="click" onClick={() => setOpenSrc(expanded ? null : r.key)}>
                        <td className="mono small">{r.key}</td>
                        <td className="num"><strong>{r.targets.length}</strong></td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={2} className="subrows">
                            {r.targets.map((t, idx2) => (
                              <div className="subrow" key={idx2}>
                                <button className="link mono small" onClick={() => { setSel({ side: 'dst', key: normPath(t.targetPath) }); setSubMode('esr'); }}>
                                  {t.targetPath}
                                </button>
                                <div className="mono small muted" style={{ marginTop: 2 }}>
                                  <Expr text={t.expression} udfNames={udfNames} />
                                </div>
                              </div>
                            ))}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {/* MODE 5: Offline Message Mapping Simulator & SAP Display Queue */}
      {subMode === 'sim' && (
        <MappingSimulatorView
          detail={detail}
          mapping={mapping}
          srcSchema={struct.src}
          controller={controller}
          s={s}
        />
      )}
    </div>
  );
};
