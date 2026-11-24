import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  KeyRound,
  Pin,
  PinOff,
  Workflow,
  Wrench,
} from 'lucide-react';
import type { DualTpzController } from '../core/engines';
import { generateCpiGroovySkeleton } from '../core/excelExport';
import { formatBrowserClassPseudoJava } from '../core/jvmClassInspector';
import type {
  DecompileResult,
  Lang,
  MappingPayload,
  TpzArchiveSummary,
  TpzObjectDetail,
  TpzObjectSummary,
} from '../core/types';
import { getObjectTypeInfo } from '../i18n/translations';
import { CodeViewer, downloadTextFile, type CodeLang } from './CodeViewer';
import { IcoFlow, OmFlow, UsageTab } from './FlowView';
import { MappingWorkbench } from './MappingView';
import type { RepackPreload } from './RepackStudioModal';
import { SchemaTreeView } from './SchemaTreeView';
import type { Strings } from './strings';

const SECRET_HINT = /(password|passwd|pwd|secret|token|apikey|api_key|privatekey|authorization)/i;
const SCHEMA_TYPES = new Set(['ifmmessage', 'ifmtypedef', 'ifmextdef', 'idoc', 'rfc', 'ifmfaultm']);
const USED_TYPES = new Set(['XI_TRAFO', 'MAPPING', 'Channel', 'ifmmessif', 'Service', 'FUNC_LIB', 'TRAFO_JAR', 'ifmmessage', 'ifmtypedef', 'idoc', 'rfc']);

/* ---------- UDF Lab (Java + CPI Groovy + Side-by-Side + Cross-Ref!) ---------- */

function UdfTab({
  mapping, s, focusKey, onJumpTarget,
}: {
  mapping: MappingPayload; s: Strings; focusKey?: string; onJumpTarget: (targetPath: string) => void;
}) {
  const udfs = mapping.udfs;
  const find = (k?: string) => {
    if (!k) return -1;
    const low = k.toLowerCase();
    return udfs.findIndex((u) => u.key.toLowerCase() === low || u.name.toLowerCase() === low);
  };
  const firstWithCode = Math.max(0, udfs.findIndex((u) => u.javaCode));
  const [idx, setIdx] = useState(find(focusKey) >= 0 ? find(focusKey) : firstWithCode);
  const [viewMode, setViewMode] = useState<'java' | 'groovy' | 'split'>('java');
  useEffect(() => { const i = find(focusKey); if (i >= 0) setIdx(i); }, [focusKey]); // eslint-disable-line

  const u = udfs[idx];
  const usedIn = useMemo(() => {
    if (!u) return [];
    const nm = u.name.toLowerCase();
    const ky = u.key.toLowerCase();
    return mapping.fieldMappings.filter((f) => f.udfs.some((x) => x.toLowerCase() === nm || x.toLowerCase() === ky));
  }, [u, mapping.fieldMappings]);

  if (!u) return <div className="pane muted">{s.noCode}</div>;
  const groovyCode = generateCpiGroovySkeleton(u.name, u.arguments, u.javaCode);

  return (
    <div className="pane">
      <div className="twocol">
        <div className="list">
          {udfs.map((x, i) => (
            <button key={x.key + i} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
              <div style={{ fontWeight: 500 }}>{x.name}</div>
              <div className="muted small">{x.cacheType || 'Value'} · {x.lineCount} L</div>
            </button>
          ))}
        </div>
        <div className="detail">
          <div className="tools" style={{ marginBottom: 12 }}>
            <div>
              <strong style={{ fontSize: 15 }}>{u.name}</strong>
              <span className="muted small mono" style={{ marginLeft: 8 }}>
                ({u.arguments.map((a) => `${a.javaType} ${a.name}`).join(', ')})
              </span>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {u.cacheType && <span className="pill-stat">Cache: {u.cacheType}</span>}
                {u.implementationType && <span className="pill-stat">{u.implementationType}</span>}
                <span className="pill-stat udf">{usedIn.length} {s.usedIn.toLowerCase()}</span>
              </div>
            </div>
            <div className="seg" style={{ marginLeft: 'auto' }}>
              <button className={viewMode === 'java' ? 'on' : ''} onClick={() => setViewMode('java')}>{s.javaCode}</button>
              <button className={viewMode === 'groovy' ? 'on' : ''} onClick={() => setViewMode('groovy')}>{s.groovy}</button>
              <button className={viewMode === 'split' ? 'on' : ''} onClick={() => setViewMode('split')}>{s.sideBySide}</button>
            </div>
          </div>

          {viewMode === 'java' && (
            u.javaCode
              ? <CodeViewer text={u.javaCode} lang="java" s={s} fileName={`${u.name}.java`} />
              : <div className="muted">{s.noCode}</div>
          )}
          {viewMode === 'groovy' && (
            <CodeViewer text={groovyCode} lang="groovy" s={s} fileName={`${u.name}.groovy`} />
          )}
          {viewMode === 'split' && (
            <div className="split-code">
              <div>
                <div className="flabel" style={{ marginTop: 0 }}>{s.javaCode}</div>
                <CodeViewer text={u.javaCode || '// empty'} lang="java" s={s} fileName={`${u.name}.java`} />
              </div>
              <div>
                <div className="flabel" style={{ marginTop: 0 }}>{s.groovy}</div>
                <CodeViewer text={groovyCode} lang="groovy" s={s} fileName={`${u.name}.groovy`} />
              </div>
            </div>
          )}

          <div className="sect" style={{ marginTop: 18 }}>{s.usedInFields} ({usedIn.length})</div>
          {usedIn.length === 0 ? (
            <div className="muted small">{s.notUsedInMapping}</div>
          ) : (
            <div className="xref-list">
              {usedIn.map((f, k) => (
                <button key={k} className="xref-chip mono small" onClick={() => onJumpTarget(f.targetPath)}>
                  {f.targetPath}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- Communication Channel Inspector (Key Cards + Secret Masking + Repack Shortcut!) ---------- */

function ParamsTab({
  detail, s, onOpenRepack,
}: {
  detail: TpzObjectDetail; s: Strings; onOpenRepack: (pre: RepackPreload) => void;
}) {
  const ch = detail.channel!;
  const [q, setQ] = useState('');
  const [hideEmpty, setHideEmpty] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const keyAttrs = useMemo(() => ch.attributes.filter((a) => a.isKey && a.value), [ch.attributes]);
  const rows = ch.attributes.filter((a) => {
    if (hideEmpty && !a.value) return false;
    const n = q.trim().toLowerCase();
    return !n || a.name.toLowerCase().includes(n) || a.value.toLowerCase().includes(n);
  });

  const renderVal = (name: string, val: string) => {
    if (!val) return <span className="muted">—</span>;
    const isSec = SECRET_HINT.test(name);
    if (!isSec) return val;
    const shown = Boolean(revealed[name]);
    return (
      <span className="secret-wrap">
        <span>{shown ? val : '••••••••••••'}</span>
        <button className="btn sm" onClick={() => setRevealed((p) => ({ ...p, [name]: !p[name] }))} title={shown ? s.hideSecret : s.revealSecret}>
          {shown ? <EyeOff size={12} /> : <Eye size={12} />}
        </button>
      </span>
    );
  };

  const facts: Array<[string, string]> = [
    [s.adapter, ch.adapterType],
    [s.direction, ch.direction],
    [s.transport, [ch.transportProtocol, ch.transportProtocolVersion].filter(Boolean).join(' ')],
    [s.message, [ch.messageProtocol, ch.messageProtocolVersion].filter(Boolean).join(' ')],
    [s.component, ch.service],
    [s.party, ch.party],
  ];

  return (
    <div className="pane">
      <div className="ch-toprow">
        <dl className="facts" style={{ marginBottom: 0 }}>
          {facts.filter(([, v]) => v).map(([k, v]) => (<React.Fragment key={k}><dt>{k}</dt><dd style={{ fontWeight: 500 }}>{v}</dd></React.Fragment>))}
        </dl>
        <button
          className="btn primary"
          onClick={() => onOpenRepack({ archiveId: detail.archiveId, tab: 'patch', channelName: ch.channelName || detail.name })}
        >
          <Wrench size={14} /><span>{s.editChannelRepack}</span>
        </button>
      </div>

      {keyAttrs.length > 0 && (
        <>
          <div className="sect" style={{ marginTop: 20 }}>
            <KeyRound size={12} style={{ verticalAlign: -1, marginRight: 5 }} />{s.keyParams} ({keyAttrs.length})
          </div>
          <div className="keyparam-grid">
            {keyAttrs.map((a, i) => (
              <div className="keyparam-card" key={a.name + i}>
                <div className="keyparam-top">
                  <span className="mono small muted">{a.name}</span>
                  <button
                    className="btn sm"
                    style={{ height: 22, padding: '0 6px' }}
                    title={s.editChannelRepack}
                    onClick={() => onOpenRepack({ archiveId: detail.archiveId, tab: 'patch', channelName: ch.channelName || detail.name, attributeName: a.name })}
                  >
                    <Wrench size={11} />
                  </button>
                </div>
                <div className="mono small keyparam-val">{renderVal(a.name, a.value)}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sect" style={{ marginTop: 22 }}>{s.allParams}</div>
      <div className="tools">
        <input className="input" placeholder={s.filterParams} value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />{s.hideEmpty}</label>
        <span className="count">{rows.length} / {ch.attributes.length}</span>
      </div>
      <div className="tablewrap">
        <table className="table">
          <thead><tr><th style={{ width: '34%' }}>{s.param}</th><th>{s.value}</th><th style={{ width: 64 }} /></tr></thead>
          <tbody>
            {rows.map((a, i) => (
              <tr key={a.name + i}>
                <td className="mono small">
                  {a.isKey && <span className="rk-badge rk-direct" style={{ marginRight: 6 }}>KEY</span>}
                  {a.name}
                </td>
                <td className="mono small">{renderVal(a.name, a.value)}</td>
                <td className="num">
                  <button
                    className="btn sm"
                    title={s.editChannelRepack}
                    onClick={() => onOpenRepack({ archiveId: detail.archiveId, tab: 'patch', channelName: ch.channelName || detail.name, attributeName: a.name })}
                  >
                    <Wrench size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Links Tab ---------- */

function LinksTab({ detail, all, s, lang, onOpen }: { detail: TpzObjectDetail; all: TpzObjectSummary[]; s: Strings; lang: Lang; onOpen: (id: string) => void }) {
  const byOid = useMemo(() => {
    const m = new Map<string, TpzObjectSummary>();
    for (const o of all) if (!m.has(o.oid) || o.archiveId === detail.archiveId) m.set(o.oid, o);
    return m;
  }, [all, detail.archiveId]);
  return (
    <div className="pane">
      <div className="tablewrap">
        <table className="table">
          <thead><tr><th style={{ width: 200 }}>{s.role}</th><th style={{ width: 200 }}>{s.type}</th><th>{s.name}</th><th>{s.namespace}</th></tr></thead>
          <tbody>
            {detail.links.map((l, i) => {
              const hit = byOid.get(l.targetOid);
              const info = getObjectTypeInfo(l.targetType, lang);
              return (
                <tr key={i} className={hit ? 'click' : ''} onClick={() => hit && onOpen(hit.id)}>
                  <td className="mono small">{l.role}</td>
                  <td><span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>{info.label}</td>
                  <td>{hit ? <button className="link" onClick={(e) => { e.stopPropagation(); onOpen(hit.id); }}>{l.targetName}</button> : l.targetName}</td>
                  <td className="muted small">{l.targetNamespace}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------- Embedded Schemas / XSD / WSDL / XSLT ---------- */

function SchemasTab({ detail, s }: { detail: TpzObjectDetail; s: Strings }) {
  const [idx, setIdx] = useState(0);
  const r = detail.textualResources[idx];
  return (
    <div className="pane">
      <div className="twocol">
        <div className="list">
          {detail.textualResources.map((x, i) => (
            <button key={i} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>
              <div style={{ fontWeight: 500 }}>{x.path.split('/').pop()}</div>
              <div className="muted small">{x.kind.toUpperCase()} · {Math.max(1, Math.ceil(x.size / 1024))} KB</div>
            </button>
          ))}
        </div>
        <div className="detail">
          {r && <CodeViewer text={r.content} lang="xml" s={s} fileName={r.path.split('/').pop() || `schema.${r.kind}`} />}
        </div>
      </div>
    </div>
  );
}

/* ---------- Java Classes Decompiler Lab (CFR .java | javap -p -c | JVM Inspector) ---------- */

function ClassesTab({ detail, controller, s }: { detail: TpzObjectDetail; controller: DualTpzController; s: Strings }) {
  const [idx, setIdx] = useState<number | null>(detail.classResources[0]?.index ?? null);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'cfr' | 'javap' | 'jvm'>('cfr');
  const [cache, setCache] = useState<Record<number, DecompileResult | { error: string }>>({});
  const [busy, setBusy] = useState(false);

  const run = async (resIndex: number) => {
    setIdx(resIndex);
    if (cache[resIndex] !== undefined) return;
    setBusy(true);
    try {
      const d = await controller.decompileClass(detail.id, resIndex);
      setCache((p) => ({ ...p, [resIndex]: d }));
    } catch (e) {
      setCache((p) => ({ ...p, [resIndex]: { error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (detail.classResources.length > 0) run(detail.classResources[0].index);
  }, [detail.id]); // eslint-disable-line

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return detail.classResources.filter((c) => !needle || c.path.toLowerCase().includes(needle));
  }, [detail.classResources, q]);

  const active = idx !== null ? cache[idx] : undefined;
  const activeRes = detail.classResources.find((c) => c.index === idx);
  const isErr = active && 'error' in active;
  const dec = active && !('error' in active) ? active : null;

  let codeText = '';
  let codeLang: CodeLang = 'java';
  if (dec) {
    if (view === 'cfr') {
      codeText = dec.cfrJava || (dec.browserInspection ? formatBrowserClassPseudoJava(dec.browserInspection) : dec.javapText || s.noCode);
      codeLang = 'java';
    } else if (view === 'javap') {
      codeText = dec.javapText || s.noCode;
      codeLang = 'javap';
    } else {
      codeText = dec.browserInspection ? formatBrowserClassPseudoJava(dec.browserInspection) : (dec.cfrJava || dec.javapText || s.noCode);
      codeLang = 'java';
    }
  }

  return (
    <div className="pane">
      <div className="twocol">
        <div className="list" style={{ width: 270 }}>
          <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
            <input className="input" placeholder={s.filterTree} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ maxHeight: 540, overflow: 'auto' }}>
            {filtered.map((c) => (
              <button key={c.index} className={c.index === idx ? 'on' : ''} onClick={() => run(c.index)}>
                <div className="mono small" style={{ fontWeight: 500 }}>{c.path.split('/').pop()}</div>
                <div className="muted small">{(c.size / 1024).toFixed(1)} KB</div>
              </button>
            ))}
          </div>
        </div>

        <div className="detail">
          <div className="tools">
            <strong className="mono small">{activeRes?.path || '—'}</strong>
            {dec?.decompilerUsed && <span className="pill-stat">{dec.decompilerUsed}</span>}
            <div className="seg" style={{ marginLeft: 'auto' }}>
              <button className={view === 'cfr' ? 'on' : ''} onClick={() => setView('cfr')}>{s.decompileCfr}</button>
              <button className={view === 'javap' ? 'on' : ''} onClick={() => setView('javap')} disabled={Boolean(dec && !dec.javapText)}>{s.decompileJavap}</button>
              <button className={view === 'jvm' ? 'on' : ''} onClick={() => setView('jvm')} disabled={Boolean(dec && !dec.browserInspection)}>{s.decompileJvm}</button>
            </div>
          </div>

          {idx === null ? (
            <div className="muted">{s.decompile}</div>
          ) : busy && !active ? (
            <div className="muted">{s.working}</div>
          ) : isErr ? (
            <div className="alert-box err">{active.error}</div>
          ) : (
            <CodeViewer
              text={codeText}
              lang={codeLang}
              s={s}
              fileName={`${(activeRes?.path.split('/').pop() || 'Class').replace(/\.class$/i, '')}.${view === 'javap' ? 'javap.txt' : 'java'}`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- ccBPM Visual Step Timeline ---------- */

function ProcessStepsTab({ detail, s }: { detail: TpzObjectDetail; s: Strings }) {
  return (
    <div className="pane">
      <div className="bpm-timeline">
        {detail.processSteps.map((p, i) => (
          <div className="bpm-step" key={p.id + i}>
            <div className="bpm-num">{i + 1}</div>
            <div className="bpm-card">
              <div className="bpm-head">
                <Workflow size={14} style={{ color: 'var(--accent)' }} />
                <strong>{p.name || p.id}</strong>
                <span className="pill-stat" style={{ marginLeft: 'auto' }}>{p.type}</span>
              </div>
              {p.id && p.id !== p.name && <div className="muted small mono" style={{ marginTop: 4 }}>ID: {p.id}</div>}
            </div>
          </div>
        ))}
        {detail.processSteps.length === 0 && <div className="muted">{s.noMatch}</div>}
      </div>
    </div>
  );
}

/* ---------- Multilingual Docs & Texts Tab ---------- */

function DocsTab({ detail, s }: { detail: TpzObjectDetail; s: Strings }) {
  const [langFilter, setLangFilter] = useState('');
  const langs = useMemo(() => Array.from(new Set(detail.texts.map((t) => t.lang).filter(Boolean))), [detail.texts]);
  const rows = detail.texts.filter((t) => !langFilter || t.lang === langFilter);
  if (!detail.texts.length) return <div className="pane muted">{s.docsEmpty}</div>;
  return (
    <div className="pane">
      {langs.length > 1 && (
        <div className="chips-row" style={{ marginBottom: 12 }}>
          <button className={`chip-btn ${!langFilter ? 'on' : ''}`} onClick={() => setLangFilter('')}>{s.all} ({detail.texts.length})</button>
          {langs.map((l) => (
            <button key={l} className={`chip-btn ${langFilter === l ? 'on' : ''}`} onClick={() => setLangFilter(l)}>{l}</button>
          ))}
        </div>
      )}
      <div className="doc-grid">
        {rows.map((t, i) => (
          <div className="doc-card" key={i}>
            <div className="doc-head">
              <FileText size={13} />
              <span className="pill-stat">{t.lang || '—'}</span>
              {t.label && <span className="mono small muted">{t.label}</span>}
            </div>
            <div className="doc-body">{t.text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Main ObjectView ---------- */

type TabId = 'flow' | 'fields' | 'udf' | 'params' | 'schemaTree' | 'steps' | 'usage' | 'links' | 'schemas' | 'classes' | 'docs' | 'xml';

interface Props {
  detail: TpzObjectDetail;
  archives: TpzArchiveSummary[];
  all: TpzObjectSummary[];
  controller: DualTpzController;
  lang: Lang;
  s: Strings;
  focusTarget?: string;
  pinned: boolean;
  onTogglePin: (id: string) => void;
  onOpen: (id: string) => void;
  onHome: () => void;
  onOpenRepack: (pre: RepackPreload) => void;
}

export const ObjectView: React.FC<Props> = ({
  detail, archives, all, controller, lang, s, focusTarget, pinned, onTogglePin, onOpen, onHome, onOpenRepack,
}) => {
  const tabs = useMemo(() => {
    const t: Array<{ id: TabId; label: string; n?: number }> = [];
    const m = detail.mapping;
    if (detail.typeId === 'AllInOne' || detail.typeId === 'MAPPING') t.push({ id: 'flow', label: s.tabFlow });
    if (m && m.fieldMappings.length) t.push({ id: 'fields', label: s.tabDefinition, n: m.fieldMappings.length });
    if (m && m.udfs.length) t.push({ id: 'udf', label: s.tabUdf, n: m.udfs.filter((u) => u.javaCode).length || m.udfs.length });
    if (detail.channel) t.push({ id: 'params', label: s.tabParams, n: detail.channel.attributes.length });
    if (SCHEMA_TYPES.has(detail.typeId)) t.push({ id: 'schemaTree', label: s.tabSchemaTree });
    if (detail.processSteps?.length) t.push({ id: 'steps', label: s.tabSteps, n: detail.processSteps.length });
    if (detail.typeId === 'TRAFO_JAR' && detail.classResources.length) t.push({ id: 'classes', label: s.tabClasses, n: detail.classResources.length });
    if (detail.typeId === 'DOCU' || detail.texts.length > 0) t.push({ id: 'docs', label: s.tabDocs, n: detail.texts.length });
    if (USED_TYPES.has(detail.typeId)) t.push({ id: 'usage', label: s.tabUsage });
    if (detail.links.length) t.push({ id: 'links', label: s.tabLinks, n: detail.links.length });
    if (detail.textualResources.length) t.push({ id: 'schemas', label: s.tabSchemas, n: detail.textualResources.length });
    if (detail.typeId !== 'TRAFO_JAR' && detail.classResources.length) t.push({ id: 'classes', label: s.tabClasses, n: detail.classResources.length });
    t.push({ id: 'xml', label: s.tabXml });
    return t;
  }, [detail, s]);

  const [tab, setTab] = useState<TabId>(tabs[0].id);
  const [udfKey, setUdfKey] = useState<string | undefined>();
  const [fieldFocus, setFieldFocus] = useState<string | undefined>(focusTarget);
  const [copiedNm, setCopiedNm] = useState(false);

  useEffect(() => {
    setTab(focusTarget && detail.mapping ? 'fields' : tabs[0].id);
    setUdfKey(undefined);
    setFieldFocus(focusTarget);
  }, [detail.id, focusTarget]); // eslint-disable-line

  const msg = (role: string) => detail.links.filter((l) => l.role === role).map((l) => l.targetName).join(', ');
  const srcMsg = msg('SOURCE_IFR_MESS');
  const dstMsg = msg('TARGET_IFR_MESS');
  const info = getObjectTypeInfo(detail.typeId, lang);

  return (
    <>
      <div className="ohead">
        <div className="crumb-row">
          <div className="crumbs small muted">
            <button className="link small" onClick={onHome}>{s.home}</button>
            <span>/</span>
            <span>{detail.archiveName}</span>
            {detail.namespace && <><span>/</span><span className="mono">{detail.namespace}</span></>}
          </div>
          <div className="ohead-actions">
            <button className={`btn sm ${pinned ? 'on' : 'line'}`} onClick={() => onTogglePin(detail.id)} title={pinned ? s.unpinObject : s.pinObject}>
              {pinned ? <PinOff size={13} /> : <Pin size={13} />}
              <span>{pinned ? s.unpinObject : s.pinObject}</span>
            </button>
            <button
              className="btn sm line"
              onClick={() => navigator.clipboard?.writeText(detail.namespace ? `${detail.namespace} :: ${detail.name}` : detail.name).then(() => { setCopiedNm(true); setTimeout(() => setCopiedNm(false), 1100); })}
            >
              {copiedNm ? <Check size={12} /> : <Copy size={12} />}<span>{copiedNm ? s.copied : s.copy}</span>
            </button>
            {detail.contentXml && (
              <button className="btn sm line" onClick={() => downloadTextFile(`${detail.name.replace(/[^\w.-]+/g, '_')}.xml`, detail.contentXml, 'application/xml')}>
                <Download size={12} /><span>XML</span>
              </button>
            )}
          </div>
        </div>

        <div className="otitle-row">
          <span className="tbadge lg" style={{ '--tc': info.color } as React.CSSProperties}>{info.short}</span>
          <h1>{detail.name}</h1>
        </div>

        <div className="meta">
          <b>{info.label}</b>
          {detail.swcv && <> · {detail.swcv}</>}
          {detail.modifBy && <> · {s.changedBy}: {detail.modifBy}{detail.modifAt ? `, ${detail.modifAt.slice(0, 16)}` : ''}</>}
          {detail.containerName && <> · <span className="mono">{detail.containerName}</span></>}
          {detail.pvcInfo && (
            <>
              {' · '}
              <span
                className="pill-stat"
                title={[
                  `PVC v${detail.pvcInfo.modelVersion || detail.pvcInfo.version}`,
                  `Creator: ${detail.pvcInfo.creatorName || '—'}`,
                  `Relations: ${detail.pvcInfo.relationRows} (predecessors: ${detail.pvcInfo.predecessorRows}, tail R15-R18: ${detail.pvcInfo.visRelationRows}${detail.pvcInfo.r17Values && detail.pvcInfo.r17Values.length > 0 ? `, R17=${detail.pvcInfo.r17Values.join(',')}` : ''})`,
                  detail.pvcInfo.branchIdCandidate ? `Branch(F8): ${detail.pvcInfo.branchIdCandidate.slice(0, 12)}…` : '',
                  detail.pvcInfo.headerVersionSetId ? `VersionSet: ${detail.pvcInfo.headerVersionSetId}${detail.pvcInfo.r16MatchesHeader ? ' (R16 ✓)' : ''}` : '',
                  detail.pvcInfo.membership
                    ? `Membership: V4=${detail.pvcInfo.membership.v4}, V5=${detail.pvcInfo.membership.v5}${detail.pvcInfo.membership.timestampMs > 0 ? `, ts=${new Date(detail.pvcInfo.membership.timestampMs).toISOString().slice(0, 19)}Z` : ''}`
                    : '',
                  detail.pvcInfo.devlines && detail.pvcInfo.devlines.length > 0
                    ? `Devline(R3, local): ${detail.pvcInfo.devlines.map((d) => d.field4 || d.field5 || d.id.slice(0, 8)).join(', ')}`
                    : '',
                  detail.pvcInfo.crossArchiveDevlines && detail.pvcInfo.crossArchiveDevlines.length > 0
                    ? `Devline(R3, workspace): ${detail.pvcInfo.crossArchiveDevlines.map((d) => `${d.field4 || d.field5 || d.id.slice(0, 8)} [${d.sourceArchive || 'other TPZ'}]`).join(', ')}`
                    : '',
                  detail.pvcInfo.unresolvedOwnerVsIds && detail.pvcInfo.unresolvedOwnerVsIds.length > 0
                    ? `External R3 devline(s) not in archive knownDevlines: ${detail.pvcInfo.unresolvedOwnerVsIds.join(', ')}`
                    : '',
                ].filter(Boolean).join(' · ')}
              >
                PVC #{detail.pvcInfo.branchSeqNo} · {detail.pvcInfo.relationRows} rel
                {detail.pvcInfo.predecessorRows > 0 ? ` (${detail.pvcInfo.predecessorRows} pred)` : ''}
                {detail.pvcInfo.membership?.matchesHeader ? ' · VSet ✓' : ''}
                {detail.pvcInfo.devlines && detail.pvcInfo.devlines.length > 0
                  ? ` · ${detail.pvcInfo.devlines[0].field4 || detail.pvcInfo.devlines[0].field5 || detail.pvcInfo.devlines[0].id.slice(0, 8)}`
                  : detail.pvcInfo.crossArchiveDevlines && detail.pvcInfo.crossArchiveDevlines.length > 0
                    ? ` · ${detail.pvcInfo.crossArchiveDevlines[0].field4 || detail.pvcInfo.crossArchiveDevlines[0].field5 || detail.pvcInfo.crossArchiveDevlines[0].id.slice(0, 8)} ↗`
                    : detail.pvcInfo.unresolvedOwnerVsIds && detail.pvcInfo.unresolvedOwnerVsIds.length > 0
                      ? ` · ${detail.pvcInfo.unresolvedOwnerVsIds.length} ext R3`
                      : ''}
              </span>
            </>
          )}
        </div>

        {(srcMsg || dstMsg) && (
          <div className="msgline">
            <span className="muted">{s.kSource}</span> <strong>{srcMsg || '—'}</strong>
            <span className="arrow" style={{ margin: '0 8px' }}>→</span>
            <span className="muted">{s.kTarget}</span> <strong>{dstMsg || '—'}</strong>
          </div>
        )}

        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" className={`tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
              {t.label}{t.n !== undefined && <span className="n">{t.n}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'flow' && detail.typeId === 'AllInOne' && <IcoFlow detail={detail} controller={controller} all={all} s={s} lang={lang} onOpen={onOpen} />}
      {tab === 'flow' && detail.typeId === 'MAPPING' && <OmFlow detail={detail} all={all} s={s} lang={lang} onOpen={onOpen} />}
      {tab === 'fields' && detail.mapping && (
        <MappingWorkbench
          detail={detail} archives={archives} all={all} controller={controller} s={s} focus={fieldFocus}
          onUdf={(k) => { setUdfKey(k); setTab('udf'); }}
        />
      )}
      {tab === 'udf' && detail.mapping && (
        <UdfTab
          mapping={detail.mapping} s={s} focusKey={udfKey}
          onJumpTarget={(tp) => { setFieldFocus(tp); setTab('fields'); }}
        />
      )}
      {tab === 'params' && detail.channel && <ParamsTab detail={detail} s={s} onOpenRepack={onOpenRepack} />}
      {tab === 'schemaTree' && <SchemaTreeView detail={detail} all={all} controller={controller} s={s} />}
      {tab === 'steps' && <ProcessStepsTab detail={detail} s={s} />}
      {tab === 'docs' && <DocsTab detail={detail} s={s} />}
      {tab === 'usage' && <UsageTab detail={detail} controller={controller} all={all} s={s} lang={lang} onOpen={onOpen} />}
      {tab === 'links' && <LinksTab detail={detail} all={all} s={s} lang={lang} onOpen={onOpen} />}
      {tab === 'schemas' && <SchemasTab detail={detail} s={s} />}
      {tab === 'classes' && <ClassesTab detail={detail} controller={controller} s={s} />}
      {tab === 'xml' && (
        <div className="pane">
          <CodeViewer
            text={detail.contentXml || ''}
            lang="xml"
            s={s}
            fileName={`${detail.name.replace(/[^\w.-]+/g, '_')}.xml`}
            defaultCollapseBase64
          />
        </div>
      )}
    </>
  );
};
