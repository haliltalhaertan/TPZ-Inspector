import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Cpu,
  Download,
  Globe,
  RefreshCw,
  Search,
  Upload,
  X,
  XCircle,
} from 'lucide-react';
import type { DualTpzController } from '../core/engines';
import type {
  EngineCapabilities,
  EngineMode,
  GlobalSearchResults,
  Lang,
  TpzArchiveSummary,
  TpzObjectDetail,
  TpzObjectSummary,
} from '../core/types';
import { getObjectTypeInfo } from '../i18n/translations';
import { downloadTextFile } from './CodeViewer';
import { SYSTEM_TYPES, type Strings } from './strings';

/* ---------- Search palette (Ctrl+K) ---------- */

type HitCat = 'all' | 'obj' | 'field' | 'udf' | 'ch' | 'doc';
interface Hit { cat: Exclude<HitCat, 'all'>; group: string; id: string; title: string; sub: string; target?: string }

export const Palette: React.FC<{
  controller: DualTpzController;
  s: Strings;
  lang: Lang;
  onPick: (id: string, target?: string) => void;
  onOpenSearchPage: (query: string) => void;
  onClose: () => void;
}> = ({ controller, s, lang, onPick, onOpenSearchPage, onClose }) => {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<HitCat>('all');
  const [hits, setHits] = useState<Hit[]>([]);
  const [act, setAct] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setHits([]); return; }
    const my = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        const r: GlobalSearchResults = await controller.search(needle);
        if (my !== seq.current) return;
        const out: Hit[] = [];
        for (const o of (r.objects || []).slice(0, 25))
          out.push({ cat: 'obj', group: s.secObjects, id: o.id, title: o.name, sub: `${getObjectTypeInfo(o.typeId, lang).label} · ${o.namespace || o.archiveName}` });
        for (const f of (r.fieldMappings || []).slice(0, 25))
          out.push({ cat: 'field', group: s.secFields, id: f.objectId, title: f.targetPath, sub: `${f.mappingName} · ${f.expression.slice(0, 90)}`, target: f.targetPath });
        for (const u of (r.udfs || []).slice(0, 15))
          out.push({ cat: 'udf', group: s.secUdfs, id: u.objectId, title: u.name, sub: `${u.mappingName} · ${u.lineCount} L` });
        for (const c of (r.channels || []).slice(0, 20))
          out.push({ cat: 'ch', group: s.secChannels, id: c.objectId, title: `${c.attributeName} = ${c.attributeValue}`.slice(0, 120), sub: `${c.channelName} · ${c.adapterType}` });
        for (const t of (r.texts || []).slice(0, 15))
          out.push({ cat: 'doc', group: s.secDocs, id: t.objectId, title: t.text.slice(0, 120), sub: `${t.objectName} · ${t.lang || '—'}` });
        setHits(out);
        setAct(0);
      } catch {
        if (my === seq.current) setHits([]);
      }
    }, 160);
    return () => clearTimeout(timer);
  }, [q]); // eslint-disable-line

  const visible = useMemo(() => (cat === 'all' ? hits : hits.filter((h) => h.cat === cat)), [hits, cat]);
  const pick = (h?: Hit) => { if (h) { onPick(h.id, h.target); onClose(); } };

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dhead">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Search size={15} className="muted" />
            <input
              className="input"
              autoFocus
              placeholder={s.searchHint}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose();
                else if (e.key === 'ArrowDown') { e.preventDefault(); setAct((a) => Math.min(a + 1, Math.max(0, visible.length - 1))); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setAct((a) => Math.max(a - 1, 0)); }
                else if (e.key === 'Enter') pick(visible[act]);
              }}
            />
          </div>
          {hits.length > 0 && (
            <div className="chips-row" style={{ padding: '6px 4px 2px' }}>
              {([
                ['all', `${s.all} (${hits.length})`],
                ['obj', `${s.secObjects} (${hits.filter((h) => h.cat === 'obj').length})`],
                ['field', `${s.secFields} (${hits.filter((h) => h.cat === 'field').length})`],
                ['udf', `UDF (${hits.filter((h) => h.cat === 'udf').length})`],
                ['ch', `${s.channels} (${hits.filter((h) => h.cat === 'ch').length})`],
                ['doc', `${s.tabDocs} (${hits.filter((h) => h.cat === 'doc').length})`],
              ] as Array<[HitCat, string]>).map(([k, lbl]) => (
                <button key={k} className={`chip-btn ${cat === k ? 'on' : ''}`} onClick={() => { setCat(k); setAct(0); }}>{lbl}</button>
              ))}
            </div>
          )}
        </div>
        <div className="dbody">
          {q.trim().length >= 2 && visible.length === 0 && <div className="empty-note">{s.noMatch}</div>}
          {visible.map((h, i) => (
            <React.Fragment key={i}>
              {(i === 0 || visible[i - 1].group !== h.group) && <div className="pgroup">{h.group}</div>}
              <button className={`pitem ${i === act ? 'act' : ''}`} onMouseEnter={() => setAct(i)} onClick={() => pick(h)}>
                <span className="nm">{h.title}<span className="sub">{h.sub}</span></span>
              </button>
            </React.Fragment>
          ))}
        </div>
        {q.trim().length >= 2 && (
          <div className="pfoot">
            <button className="link small" onClick={() => { onOpenSearchPage(q.trim()); onClose(); }}>
              {s.viewAllResults} <ArrowRight size={12} style={{ verticalAlign: -2 }} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- Full-Page Cross-Archive Impact Search (#/search) ---------- */

export const SearchPage: React.FC<{
  controller: DualTpzController;
  s: Strings;
  lang: Lang;
  initialQuery?: string;
  onPick: (id: string, target?: string) => void;
}> = ({ controller, s, lang, initialQuery = '', onPick }) => {
  const [q, setQ] = useState(initialQuery);
  const [tab, setTab] = useState<'objects' | 'fields' | 'udfs' | 'channels' | 'texts'>('objects');
  const [res, setRes] = useState<GlobalSearchResults | null>(null);
  const [busy, setBusy] = useState(false);

  const runSearch = async (needle: string) => {
    const clean = needle.trim();
    if (clean.length < 2) { setRes(null); return; }
    setBusy(true);
    try {
      const r = await controller.search(clean);
      setRes(r);
      // Automatically focus the first non-empty bucket
      if (r.objects?.length) setTab('objects');
      else if (r.fieldMappings?.length) setTab('fields');
      else if (r.udfs?.length) setTab('udfs');
      else if (r.channels?.length) setTab('channels');
      else if (r.texts?.length) setTab('texts');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (initialQuery.trim().length >= 2) {
      setQ(initialQuery);
      runSearch(initialQuery);
    }
  }, [initialQuery]); // eslint-disable-line

  const exportCsv = () => {
    if (!res) return;
    const esc = (v: string) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows: string[] = [['Category', 'Archive', 'Object', 'Detail', 'Value'].map(esc).join(',')];
    for (const o of res.objects || []) rows.push(['Object', o.archiveName, o.name, o.typeId, o.namespace].map(esc).join(','));
    for (const f of res.fieldMappings || []) rows.push(['Field Mapping', f.archiveName, f.mappingName, f.targetPath, f.expression].map(esc).join(','));
    for (const u of res.udfs || []) rows.push(['UDF', u.archiveName, u.mappingName, u.name, `${u.lineCount} lines`].map(esc).join(','));
    for (const c of res.channels || []) rows.push(['Channel', c.archiveName, c.channelName, c.attributeName, c.attributeValue].map(esc).join(','));
    for (const t of res.texts || []) rows.push(['Doc', t.archiveName, t.objectName, t.lang, t.text].map(esc).join(','));
    downloadTextFile(`tpz_search_${q.trim().replace(/[^\w.-]+/g, '_')}.csv`, '\uFEFF' + rows.join('\n'), 'text/csv;charset=utf-8');
  };

  const totalHits = res
    ? (res.objects?.length || 0) + (res.fieldMappings?.length || 0) + (res.udfs?.length || 0) + (res.channels?.length || 0) + (res.texts?.length || 0)
    : 0;

  return (
    <div className="page">
      <h1>{s.searchPage}</h1>
      <p className="muted" style={{ marginTop: 4 }}>{s.searchPrompt}</p>
      <form
        className="search-hero"
        onSubmit={(e) => { e.preventDefault(); runSearch(q); }}
      >
        <input
          className="input"
          autoFocus
          placeholder={s.searchHint}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit" className="btn primary" disabled={busy || q.trim().length < 2}>
          <Search size={14} /><span>{s.search}</span>
        </button>
        {res && totalHits > 0 && (
          <button type="button" className="btn line" onClick={exportCsv}>
            <Download size={14} /><span>{s.exportCsv} ({totalHits})</span>
          </button>
        )}
      </form>

      {busy && <div className="muted">{s.working}</div>}
      {!busy && res && (
        <>
          <div className="seg" style={{ marginBottom: 14 }}>
            <button className={tab === 'objects' ? 'on' : ''} onClick={() => setTab('objects')}>{s.secObjects} ({res.objects?.length || 0})</button>
            <button className={tab === 'fields' ? 'on' : ''} onClick={() => setTab('fields')}>{s.secFields} ({res.fieldMappings?.length || 0})</button>
            <button className={tab === 'udfs' ? 'on' : ''} onClick={() => setTab('udfs')}>{s.secUdfs} ({res.udfs?.length || 0})</button>
            <button className={tab === 'channels' ? 'on' : ''} onClick={() => setTab('channels')}>{s.secChannels} ({res.channels?.length || 0})</button>
            <button className={tab === 'texts' ? 'on' : ''} onClick={() => setTab('texts')}>{s.secDocs} ({res.texts?.length || 0})</button>
          </div>

          {tab === 'objects' && (
            <div className="tablewrap">
              <table className="table">
                <thead><tr><th style={{ width: 190 }}>{s.type}</th><th>{s.name}</th><th>{s.namespace}</th><th style={{ width: 170 }}>{s.file}</th></tr></thead>
                <tbody>
                  {(res.objects || []).map((o) => {
                    const info = getObjectTypeInfo(o.typeId, lang);
                    return (
                      <tr key={o.id} className="click" onClick={() => onPick(o.id)}>
                        <td><span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>{info.label}</td>
                        <td style={{ fontWeight: 500 }}>{o.name}</td>
                        <td className="muted small">{o.namespace}</td>
                        <td className="muted small">{o.archiveName}</td>
                      </tr>
                    );
                  })}
                  {!(res.objects?.length) && <tr><td colSpan={4} className="muted">{s.noMatch}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'fields' && (
            <div className="tablewrap">
              <table className="table">
                <thead><tr><th style={{ width: 220 }}>{s.mappingList}</th><th style={{ width: '28%' }}>{s.target}</th><th>{s.rule}</th><th style={{ width: 150 }}>{s.file}</th></tr></thead>
                <tbody>
                  {(res.fieldMappings || []).map((f, i) => (
                    <tr key={i} className="click" onClick={() => onPick(f.objectId, f.targetPath)}>
                      <td style={{ fontWeight: 500 }}>{f.mappingName}</td>
                      <td className="mono small">{f.targetPath}</td>
                      <td className="mono small">{f.expression}</td>
                      <td className="muted small">{f.archiveName}</td>
                    </tr>
                  ))}
                  {!(res.fieldMappings?.length) && <tr><td colSpan={4} className="muted">{s.noMatch}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'udfs' && (
            <div className="tablewrap">
              <table className="table">
                <thead><tr><th>UDF</th><th>{s.mappingList}</th><th className="num" style={{ width: 90 }}>Lines</th><th style={{ width: 170 }}>{s.file}</th></tr></thead>
                <tbody>
                  {(res.udfs || []).map((u, i) => (
                    <tr key={i} className="click" onClick={() => onPick(u.objectId)}>
                      <td className="mono" style={{ fontWeight: 600 }}>{u.name}</td>
                      <td>{u.mappingName}</td>
                      <td className="num">{u.lineCount}</td>
                      <td className="muted small">{u.archiveName}</td>
                    </tr>
                  ))}
                  {!(res.udfs?.length) && <tr><td colSpan={4} className="muted">{s.noMatch}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'channels' && (
            <div className="tablewrap">
              <table className="table">
                <thead><tr><th style={{ width: 220 }}>{s.channel}</th><th style={{ width: 110 }}>{s.adapter}</th><th style={{ width: 220 }}>{s.param}</th><th>{s.value}</th></tr></thead>
                <tbody>
                  {(res.channels || []).map((c, i) => (
                    <tr key={i} className="click" onClick={() => onPick(c.objectId)}>
                      <td style={{ fontWeight: 500 }}>{c.channelName}</td>
                      <td><span className="pill-stat">{c.adapterType || '—'}</span></td>
                      <td className="mono small">{c.attributeName}</td>
                      <td className="mono small">{c.attributeValue}</td>
                    </tr>
                  ))}
                  {!(res.channels?.length) && <tr><td colSpan={4} className="muted">{s.noMatch}</td></tr>}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'texts' && (
            <div className="tablewrap">
              <table className="table">
                <thead><tr><th style={{ width: 220 }}>{s.name}</th><th style={{ width: 70 }}>Lang</th><th>{s.tabDocs}</th><th style={{ width: 160 }}>{s.file}</th></tr></thead>
                <tbody>
                  {(res.texts || []).map((t, i) => (
                    <tr key={i} className="click" onClick={() => onPick(t.objectId)}>
                      <td style={{ fontWeight: 500 }}>{t.objectName}</td>
                      <td className="mono small">{t.lang || '—'}</td>
                      <td className="small">{t.text.slice(0, 260)}</td>
                      <td className="muted small">{t.archiveName}</td>
                    </tr>
                  ))}
                  {!(res.texts?.length) && <tr><td colSpan={4} className="muted">{s.noMatch}</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

/* ---------- Engine Switcher Modal ---------- */

export const EngineModal: React.FC<{
  mode: EngineMode;
  caps: EngineCapabilities | null;
  s: Strings;
  onSelectMode: (m: EngineMode) => void;
  onReprobe: () => Promise<void>;
  onClose: () => void;
}> = ({ mode, caps, s, onSelectMode, onReprobe, onClose }) => {
  const [checking, setChecking] = useState(false);
  const localOk = Boolean(caps?.localAvailable);

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-top">
          <div className="dlg-title"><Cpu size={16} /><span>{s.engineTitle}</span></div>
          <button className="btn sm" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="dpad">
          <div className="engine-cards">
            <button
              className={`engine-card ${mode === 'local' ? 'on' : ''}`}
              disabled={!localOk}
              onClick={() => { onSelectMode('local'); onClose(); }}
            >
              <div className="engine-card-head">
                <Cpu size={16} />
                <strong>{s.localOn}</strong>
                <span className={`crc-pill sm ${localOk ? 'ok' : ''}`} style={{ marginLeft: 'auto' }}>
                  {localOk ? 'ONLINE' : 'OFFLINE'}
                </span>
              </div>
              <p className="muted small" style={{ margin: '6px 0 10px' }}>{s.engineLocalDesc}</p>
              <div className="cap-row">
                <span className={`cap-tag ${caps?.hasJava ? 'ok' : ''}`}>{caps?.hasJava ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {s.capJava}</span>
                <span className={`cap-tag ${caps?.hasJavac ? 'ok' : ''}`}>{caps?.hasJavac ? <CheckCircle2 size={11} /> : <XCircle size={11} />} javac (UDF)</span>
                <span className={`cap-tag ${caps?.hasJavap ? 'ok' : ''}`}>{caps?.hasJavap ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {s.capJavap}</span>
                <span className={`cap-tag ${caps?.hasCfr ? 'ok' : ''}`}>{caps?.hasCfr ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {s.capCfr}</span>
                <span className={`cap-tag ${caps?.hasRepack ? 'ok' : ''}`}>{caps?.hasRepack ? <CheckCircle2 size={11} /> : <XCircle size={11} />} {s.capRepack}</span>
              </div>
            </button>

            <button
              className={`engine-card ${mode === 'browser' ? 'on' : ''}`}
              onClick={() => { onSelectMode('browser'); onClose(); }}
            >
              <div className="engine-card-head">
                <Globe size={16} />
                <strong>{s.localOff}</strong>
                <span className="crc-pill sm ok" style={{ marginLeft: 'auto' }}>ZERO-UPLOAD</span>
              </div>
              <p className="muted small" style={{ margin: '6px 0 0' }}>{s.engineBrowserDesc}</p>
            </button>
          </div>

          {!localOk && <div className="muted small" style={{ marginTop: 10 }}>{s.engineOfflineHint}</div>}

          <div className="dfoot">
            <button
              className="btn line"
              disabled={checking}
              onClick={async () => { setChecking(true); try { await onReprobe(); } finally { setChecking(false); } }}
            >
              <RefreshCw size={13} /><span>{s.engineReprobe}</span>
            </button>
            <button className="btn primary" onClick={onClose}>{s.close}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---------- Disk path dialog ---------- */

export const PathDialog: React.FC<{ s: Strings; onLoad: (p: string) => void; onClose: () => void }> = ({ s, onLoad, onClose }) => {
  const [p, setP] = useState('');
  return (
    <div className="veil" onMouseDown={onClose}>
      <form className="dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (p.trim()) onLoad(p.trim()); }}>
        <div className="dpad">
          <strong>{s.pathTitle}</strong>
          <input className="input" style={{ marginTop: 10 }} autoFocus placeholder={s.pathHint} value={p} onChange={(e) => setP(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()} />
          <div className="dfoot">
            <button type="button" className="btn line" onClick={onClose}>{s.cancel}</button>
            <button type="submit" className="btn primary">{s.load}</button>
          </div>
        </div>
      </form>
    </div>
  );
};

/* ---------- Enhanced Compare (TPZ Diff with UDF Java code diff + Link diff + Filter + Export) ---------- */

interface Change { kind: '+' | '-' | '~'; what: string; oldV?: string; newV?: string }
interface Changed { base: TpzObjectSummary; other: TpzObjectSummary; changes: Change[] }
interface Result { added: TpzObjectSummary[]; removed: TpzObjectSummary[]; changed: Changed[]; same: number }

function maskContainerKey(xml: string): string {
  // Mask export-varying container@key attributes on Operation Mappings so identical content is not flagged as modified.
  return xml.replace(/(<[\w:.-]*container\b[^>]*\bkey\s*=\s*")([^"]*)(")/gi, '$1__MASKED__$3');
}

function diffDetails(b: TpzObjectDetail, c: TpzObjectDetail): Change[] {
  const out: Change[] = [];
  const mapDiff = (bm: Map<string, string>, cm: Map<string, string>, label: string) => {
    for (const [k, v] of cm) {
      if (!bm.has(k)) out.push({ kind: '+', what: `${label}${k}`, newV: v });
      else if (bm.get(k) !== v) out.push({ kind: '~', what: `${label}${k}`, oldV: bm.get(k), newV: v });
    }
    for (const [k, v] of bm) if (!cm.has(k)) out.push({ kind: '-', what: `${label}${k}`, oldV: v });
  };
  if (b.mapping && c.mapping) {
    mapDiff(new Map(b.mapping.fieldMappings.map((f) => [f.targetPath, f.expression])), new Map(c.mapping.fieldMappings.map((f) => [f.targetPath, f.expression])), '');
    const bu = new Map(b.mapping.udfs.map((u) => [u.name, u.javaCode || '']));
    const cu = new Map(c.mapping.udfs.map((u) => [u.name, u.javaCode || '']));
    for (const [k, v] of cu) {
      if (!bu.has(k)) out.push({ kind: '+', what: `UDF ${k}`, newV: v.slice(0, 600) });
      else if (bu.get(k) !== v) out.push({ kind: '~', what: `UDF ${k}`, oldV: bu.get(k)!.slice(0, 600), newV: v.slice(0, 600) });
    }
    for (const [k, v] of bu) if (!cu.has(k)) out.push({ kind: '-', what: `UDF ${k}`, oldV: v.slice(0, 600) });
  } else if (b.channel && c.channel) {
    mapDiff(new Map(b.channel.attributes.map((a) => [a.name, a.value])), new Map(c.channel.attributes.map((a) => [a.name, a.value])), '');
  } else {
    const bl = new Map(b.links.map((l) => [`${l.role}:${l.kpos}`, `${l.targetType} ${l.targetName} (${l.targetNamespace})`]));
    const cl = new Map(c.links.map((l) => [`${l.role}:${l.kpos}`, `${l.targetType} ${l.targetName} (${l.targetNamespace})`]));
    mapDiff(bl, cl, 'Link ');
  }
  if (out.length === 0 && maskContainerKey(b.contentXml || '') !== maskContainerKey(c.contentXml || '')) {
    out.push({ kind: '~', what: 'XML', oldV: `${(b.contentXml || '').length} B`, newV: `${(c.contentXml || '').length} B` });
  }
  return out;
}

export const Compare: React.FC<{
  archives: TpzArchiveSummary[];
  controller: DualTpzController;
  s: Strings;
  lang: Lang;
  onOpen: (id: string) => void;
  onAddFile: () => void;
}> = ({ archives, controller, s, lang, onOpen, onAddFile }) => {
  const [baseId, setBaseId] = useState(archives[0]?.archiveId || '');
  const [otherId, setOtherId] = useState(archives[1]?.archiveId || '');
  const [res, setRes] = useState<Result | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [secFilter, setSecFilter] = useState<'all' | 'changed' | 'added' | 'removed'>('all');
  const [q, setQ] = useState('');
  const runId = useRef(0);

  useEffect(() => {
    if (!archives.some((a) => a.archiveId === baseId)) setBaseId(archives[0]?.archiveId || '');
    if (!archives.some((a) => a.archiveId === otherId)) setOtherId(archives[1]?.archiveId || '');
  }, [archives, baseId, otherId]);

  useEffect(() => { setRes(null); }, [baseId, otherId]);

  if (archives.length < 2) {
    return (
      <div className="page">
        <h1>{s.cmpTitle}</h1>
        <p className="muted">{s.cmpNeedTwo}</p>
        <button className="btn primary" onClick={onAddFile}>
          <Upload size={14} /><span>{s.cmpAddSecond}</span>
        </button>
      </div>
    );
  }

  const run = async () => {
    const A = archives.find((a) => a.archiveId === baseId);
    const B = archives.find((a) => a.archiveId === otherId);
    if (!A || !B || A === B) return;
    const my = ++runId.current;
    const key = (o: TpzObjectSummary) => `${o.typeId}\u0001${o.namespace}\u0001${o.name}`;
    const ao = A.objects.filter((o) => !SYSTEM_TYPES.has(o.typeId));
    const bo2 = B.objects.filter((o) => !SYSTEM_TYPES.has(o.typeId));
    const am = new Map(ao.map((o) => [key(o), o]));
    const bm = new Map(bo2.map((o) => [key(o), o]));
    const added = bo2.filter((o) => !am.has(key(o)));
    const removed = ao.filter((o) => !bm.has(key(o)));
    const pairs = [...am].filter(([k]) => bm.has(k)).map(([k, o]) => [o, bm.get(k)!] as const);
    const changed: Changed[] = [];
    let same = 0;
    for (let i = 0; i < pairs.length; i++) {
      if (my !== runId.current) return;
      const [bo, co] = pairs[i];
      if (i % 10 === 0) setProgress(`${s.cmpProgress} ${i} / ${pairs.length}`);
      try {
        const [bd, cd] = await Promise.all([controller.getObjectDetail(bo.id), controller.getObjectDetail(co.id)]);
        const ch = diffDetails(bd, cd);
        if (ch.length) changed.push({ base: bo, other: co, changes: ch }); else same++;
      } catch { same++; }
    }
    if (my !== runId.current) return;
    setProgress(null);
    setRes({ added, removed, changed, same });
    // Auto-expand first 3 changed objects for immediate insight
    const autoOpen: Record<string, boolean> = {};
    changed.slice(0, 3).forEach((c) => { autoOpen[c.base.id] = true; });
    setOpen(autoOpen);
  };

  const exportMarkdown = () => {
    if (!res) return;
    const A = archives.find((a) => a.archiveId === baseId)?.fileName || 'Base';
    const B = archives.find((a) => a.archiveId === otherId)?.fileName || 'Target';
    const md: string[] = [
      `# TPZ Diff Report: ${A} → ${B}`,
      '',
      `- **Changed:** ${res.changed.length}`,
      `- **Added:** ${res.added.length}`,
      `- **Removed:** ${res.removed.length}`,
      `- **Identical:** ${res.same}`,
      '',
    ];
    if (res.changed.length) {
      md.push('## Changed Objects', '');
      for (const c of res.changed) {
        md.push(`### ${c.base.typeId} — ${c.base.name} (${c.base.namespace})`);
        for (const x of c.changes) {
          md.push(`- \`${x.kind}\` **${x.what}**`);
          if (x.oldV !== undefined) md.push(`  - Old: \`${x.oldV.replace(/\n/g, ' ')}\``);
          if (x.newV !== undefined) md.push(`  - New: \`${x.newV.replace(/\n/g, ' ')}\``);
        }
        md.push('');
      }
    }
    if (res.added.length) {
      md.push('## Added Objects', '');
      res.added.forEach((o) => md.push(`- \`+\` ${o.typeId}: ${o.name} (${o.namespace})`));
      md.push('');
    }
    if (res.removed.length) {
      md.push('## Removed Objects', '');
      res.removed.forEach((o) => md.push(`- \`-\` ${o.typeId}: ${o.name} (${o.namespace})`));
    }
    downloadTextFile(`TPZ_Diff_${A}_vs_${B}.md`, md.join('\n'), 'text/markdown;charset=utf-8');
  };

  const needle = q.trim().toLowerCase();
  const fChanged = res ? res.changed.filter((c) => !needle || c.base.name.toLowerCase().includes(needle) || c.changes.some((x) => x.what.toLowerCase().includes(needle))) : [];
  const fAdded = res ? res.added.filter((o) => !needle || o.name.toLowerCase().includes(needle) || o.namespace.toLowerCase().includes(needle)) : [];
  const fRemoved = res ? res.removed.filter((o) => !needle || o.name.toLowerCase().includes(needle) || o.namespace.toLowerCase().includes(needle)) : [];

  const objRow = (o: TpzObjectSummary, sign: '+' | '-') => {
    const info = getObjectTypeInfo(o.typeId, lang);
    return (
      <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
        <td style={{ width: 210 }}>
          <span className={`diff-sign ${sign === '+' ? 'add' : 'rem'}`}>{sign}</span>
          <span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>
          {info.label}
        </td>
        <td style={{ fontWeight: 500 }}>{o.name}</td>
        <td className="muted small">{o.namespace}</td>
      </tr>
    );
  };

  return (
    <div className="page">
      <h1>{s.cmpTitle}</h1>
      <div className="cmpbar">
        <label>{s.cmpBase}
          <select className="select" value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            {archives.map((a) => <option key={a.archiveId} value={a.archiveId}>{a.fileName}</option>)}
          </select>
        </label>
        <label>{s.cmpOther}
          <select className="select" value={otherId} onChange={(e) => setOtherId(e.target.value)}>
            {archives.map((a) => <option key={a.archiveId} value={a.archiveId}>{a.fileName}</option>)}
          </select>
        </label>
        <button className="btn primary" disabled={!!progress || baseId === otherId} onClick={run}>{s.cmpRun}</button>
        {res && (
          <button className="btn line" onClick={exportMarkdown}>
            <Download size={14} /><span>{s.cmpExportMd}</span>
          </button>
        )}
        {progress && <span className="muted small">{progress}</span>}
      </div>

      {res && (
        <>
          <div className="tools">
            <div className="seg">
              <button className={secFilter === 'all' ? 'on' : ''} onClick={() => setSecFilter('all')}>{s.all}</button>
              <button className={secFilter === 'changed' ? 'on' : ''} onClick={() => setSecFilter('changed')}>{s.cmpChanged} ({res.changed.length})</button>
              <button className={secFilter === 'added' ? 'on' : ''} onClick={() => setSecFilter('added')}>{s.cmpAdded} ({res.added.length})</button>
              <button className={secFilter === 'removed' ? 'on' : ''} onClick={() => setSecFilter('removed')}>{s.cmpRemoved} ({res.removed.length})</button>
            </div>
            <input className="input" style={{ width: 240 }} placeholder={s.cmpFilterPlaceholder} value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="count">{s.cmpSame}: <strong>{res.same}</strong></span>
          </div>

          {(secFilter === 'all' || secFilter === 'changed') && fChanged.length > 0 && (
            <>
              <h2>{s.cmpChanged} ({fChanged.length})</h2>
              <div className="tablewrap"><table className="table"><tbody>
                {fChanged.map((c) => {
                  const info = getObjectTypeInfo(c.base.typeId, lang);
                  return (
                    <React.Fragment key={c.base.id}>
                      <tr className="click" onClick={() => setOpen((p) => ({ ...p, [c.base.id]: !p[c.base.id] }))}>
                        <td style={{ width: 210 }}>
                          <span className="diff-sign mod">~</span>
                          <span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>
                          {info.label}
                        </td>
                        <td style={{ fontWeight: 500 }}>{c.base.name}</td>
                        <td className="num muted">{c.changes.length} diff</td>
                      </tr>
                      {open[c.base.id] && (
                        <tr><td colSpan={3} style={{ background: 'var(--sunken)', padding: '10px 16px' }}>
                          <div style={{ marginBottom: 8, display: 'flex', gap: 14 }}>
                            <button className="link small" onClick={() => onOpen(c.base.id)}>{s.old} →</button>
                            <button className="link small" onClick={() => onOpen(c.other.id)}>{s.neu} →</button>
                          </div>
                          {c.changes.slice(0, 300).map((x, i) => (
                            <div className="chg" key={i}>
                              <div style={{ fontWeight: 600 }}>{x.kind} {x.what}</div>
                              {x.oldV !== undefined && <pre className="diff-line o">− {x.oldV}</pre>}
                              {x.newV !== undefined && <pre className="diff-line n">+ {x.newV}</pre>}
                            </div>
                          ))}
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody></table></div>
            </>
          )}

          {(secFilter === 'all' || secFilter === 'added') && fAdded.length > 0 && (
            <><h2>{s.cmpAdded} ({fAdded.length})</h2><div className="tablewrap"><table className="table"><tbody>{fAdded.map((o) => objRow(o, '+'))}</tbody></table></div></>
          )}
          {(secFilter === 'all' || secFilter === 'removed') && fRemoved.length > 0 && (
            <><h2>{s.cmpRemoved} ({fRemoved.length})</h2><div className="tablewrap"><table className="table"><tbody>{fRemoved.map((o) => objRow(o, '-'))}</tbody></table></div></>
          )}
        </>
      )}
    </div>
  );
};
