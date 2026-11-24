import React, { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Code2,
  FileCode2,
  GitBranch,
  Layers,
  Plug,
  ShieldAlert,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import type { Lang, TpzArchiveSummary, TpzObjectSummary } from '../core/types';
import { getObjectTypeInfo } from '../i18n/translations';
import { SYSTEM_TYPES, type Strings, typeRank } from './strings';
import type { RepackPreload } from './RepackStudioModal';

type InvTab = 'mappings' | 'channels' | 'scenarios' | 'code' | 'schemas';

export const DashboardView: React.FC<{
  archives: TpzArchiveSummary[];
  all: TpzObjectSummary[];
  lang: Lang;
  s: Strings;
  onOpen: (id: string) => void;
  onCloseArchive: (archiveId: string) => void;
  onOpenRepack: (pre: RepackPreload) => void;
  onFilterType: (typeId: string) => void;
}> = ({ archives, all, lang, s, onOpen, onCloseArchive, onOpenRepack, onFilterType }) => {
  const [invTab, setInvTab] = useState<InvTab>('mappings');
  const [invQ, setInvQ] = useState('');
  const [sort, setSort] = useState<{ col: 'name' | 'fields' | 'udf'; dir: 1 | -1 }>({ col: 'fields', dir: -1 });

  const stats = useMemo(() => {
    let totalObjects = 0, mappings = 0, fields = 0, udfs = 0, classes = 0, xslt = 0, channels = 0, bpm = 0, score = 0;
    let totalContainers = 0, verifiedContainers = 0;
    const typeCounts: Record<string, number> = {};
    const adapterCounts: Record<string, number> = {};

    for (const a of archives) {
      totalObjects += a.stats.totalObjects;
      mappings += a.stats.messageMappings;
      fields += a.stats.fieldMappings;
      udfs += a.stats.udfs;
      classes += a.stats.javaClasses;
      xslt += a.stats.xsltFiles;
      channels += a.stats.channels;
      bpm += a.stats.ccBpmProcesses;
      score += a.stats.complexityScore;
      for (const c of a.containers) {
        totalContainers++;
        if (c.crcIntegrity?.verified) verifiedContainers++;
      }
      for (const [t, n] of Object.entries(a.stats.typeCounts || {})) {
        if (!SYSTEM_TYPES.has(t)) typeCounts[t] = (typeCounts[t] || 0) + n;
      }
    }
    for (const o of all) {
      if (o.typeId === 'Channel' && o.adapterType) {
        adapterCounts[o.adapterType] = (adapterCounts[o.adapterType] || 0) + 1;
      }
    }
    const tier = score < 25 ? s.cpiTierLow : score < 100 ? s.cpiTierMedium : score < 300 ? s.cpiTierHigh : s.cpiTierEnterprise;
    const tierKind = score < 25 ? 'ok' : score < 100 ? 'accent' : score < 300 ? 'warn' : 'bad';
    const sortedTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1] || typeRank(a[0]) - typeRank(b[0]));
    const sortedAdapters = Object.entries(adapterCounts).sort((a, b) => b[1] - a[1]);
    return {
      totalObjects, mappings, fields, udfs, classes, xslt, channels, bpm, score, tier, tierKind,
      totalContainers, verifiedContainers, sortedTypes, sortedAdapters,
    };
  }, [archives, all, s]);

  const q = invQ.trim().toLowerCase();

  const mappingRows = useMemo(() => {
    const list = all.filter((o) => o.typeId === 'XI_TRAFO' && (!q || o.name.toLowerCase().includes(q) || o.namespace.toLowerCase().includes(q)));
    const val = (o: TpzObjectSummary) => (sort.col === 'fields' ? o.fieldMappingCount : sort.col === 'udf' ? o.udfCount : 0);
    return list.sort((x, y) => (sort.col === 'name' ? x.name.localeCompare(y.name) : val(x) - val(y)) * sort.dir);
  }, [all, q, sort]);

  const channelRows = useMemo(() => {
    return all
      .filter((o) => o.typeId === 'Channel' && (!q || o.name.toLowerCase().includes(q) || o.adapterType.toLowerCase().includes(q) || o.namespace.toLowerCase().includes(q)))
      .sort((a, b) => a.adapterType.localeCompare(b.adapterType) || a.name.localeCompare(b.name));
  }, [all, q]);

  const scenarioRows = useMemo(() => {
    return all
      .filter((o) => (o.typeId === 'AllInOne' || o.typeId === 'MAPPING') && (!q || o.name.toLowerCase().includes(q) || o.namespace.toLowerCase().includes(q)))
      .sort((a, b) => typeRank(a.typeId) - typeRank(b.typeId) || a.name.localeCompare(b.name));
  }, [all, q]);

  const codeRows = useMemo(() => {
    return all
      .filter((o) => (o.typeId === 'TRAFO_JAR' || o.typeId === 'FUNC_LIB' || o.classCount > 0) && o.typeId !== 'XI_TRAFO' && (!q || o.name.toLowerCase().includes(q) || o.namespace.toLowerCase().includes(q)))
      .sort((a, b) => b.classCount - a.classCount || a.name.localeCompare(b.name));
  }, [all, q]);

  const schemaRows = useMemo(() => {
    const SET = new Set(['ifmmessif', 'ifmmessage', 'ifmtypedef', 'ifmextdef', 'idoc', 'rfc', 'ifmfaultm', 'process', 'RepBProcess', 'DOCU']);
    return all
      .filter((o) => SET.has(o.typeId) && (!q || o.name.toLowerCase().includes(q) || o.namespace.toLowerCase().includes(q)))
      .sort((a, b) => typeRank(a.typeId) - typeRank(b.typeId) || a.name.localeCompare(b.name));
  }, [all, q]);

  const sortBy = (col: 'name' | 'fields' | 'udf') => setSort((p) => ({ col, dir: p.col === col ? (p.dir === 1 ? -1 : 1) : col === 'name' ? 1 : -1 }));
  const arrow = (col: string) => (sort.col === col ? (sort.dir === 1 ? ' ↑' : ' ↓') : '');
  const fmtDate = (ms?: string) => { const n = Number(ms); return n ? new Date(n).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-GB') : ''; };
  const totalNonSys = stats.sortedTypes.reduce((acc, [, n]) => acc + n, 0) || 1;

  return (
    <div className="page">
      {/* Executive KPI Strip */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-lbl"><Archive size={13} /><span>{s.kpiArchives}</span></div>
          <div className="kpi-val">{archives.length}</div>
          <div className="kpi-sub">
            {stats.verifiedContainers === stats.totalContainers && stats.totalContainers > 0 ? (
              <span className="txt-ok"><ShieldCheck size={12} style={{ verticalAlign: -2 }} /> {stats.verifiedContainers}/{stats.totalContainers} CRC OK</span>
            ) : (
              <span>{stats.verifiedContainers}/{stats.totalContainers} CRC</span>
            )}
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-lbl"><Layers size={13} /><span>{s.kpiObjects}</span></div>
          <div className="kpi-val">{stats.totalObjects.toLocaleString()}</div>
          <div className="kpi-sub">{stats.sortedTypes.length} {s.type.toLowerCase()}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-lbl"><GitBranch size={13} /><span>{s.kpiMappings}</span></div>
          <div className="kpi-val">{stats.mappings.toLocaleString()}</div>
          <div className="kpi-sub">{stats.fields.toLocaleString()} {s.kpiFieldRules.toLowerCase()}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-lbl"><Code2 size={13} /><span>{s.kpiUdfs}</span></div>
          <div className="kpi-val">{stats.udfs.toLocaleString()}</div>
          <div className="kpi-sub">{stats.classes.toLocaleString()} .class · {stats.xslt} XSLT</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-lbl"><Plug size={13} /><span>{s.kpiChannels}</span></div>
          <div className="kpi-val">{stats.channels.toLocaleString()}</div>
          <div className="kpi-sub">{stats.sortedAdapters.length} {s.adapter.toLowerCase()}</div>
        </div>
        <div className={`kpi-card kpi-${stats.tierKind}`}>
          <div className="kpi-lbl"><Activity size={13} /><span>{s.kpiCpiEffort}</span></div>
          <div className="kpi-val">{stats.score}</div>
          <div className="kpi-sub"><strong>{stats.tier}</strong></div>
        </div>
      </div>

      {/* 2-Column Analytics: Type Distribution + CPI Migration Readiness */}
      <div className="dash-two">
        <div className="dash-card">
          <div className="dash-card-head">{s.typeDistribution}</div>
          <div className="dist-bar">
            {stats.sortedTypes.slice(0, 12).map(([t, n]) => {
              const info = getObjectTypeInfo(t, lang);
              return (
                <div
                  key={t}
                  className="dist-seg"
                  style={{ width: `${Math.max(2, (n / totalNonSys) * 100)}%`, background: info.color }}
                  title={`${info.label}: ${n}`}
                  onClick={() => onFilterType(t)}
                />
              );
            })}
          </div>
          <div className="type-pills">
            {stats.sortedTypes.slice(0, 14).map(([t, n]) => {
              const info = getObjectTypeInfo(t, lang);
              return (
                <button key={t} className="type-pill" onClick={() => onFilterType(t)}>
                  <span className="tbadge" style={{ '--tc': info.color } as React.CSSProperties}>{info.short}</span>
                  <span>{info.label}</span>
                  <strong>{n}</strong>
                </button>
              );
            })}
          </div>
        </div>

        <div className="dash-card">
          <div className="dash-card-head">{s.cpiReadiness}</div>
          <div className="cpi-list">
            {stats.udfs > 0 && (
              <div className="cpi-item warn">
                <Code2 size={14} />
                <span><strong>{stats.udfs} UDF</strong> — {s.cpiUdfRisk}</span>
              </div>
            )}
            {stats.classes > 0 && (
              <div className="cpi-item warn">
                <FileCode2 size={14} />
                <span><strong>{stats.classes} .class</strong> — {s.cpiJarRisk}</span>
              </div>
            )}
            {stats.bpm > 0 && (
              <div className="cpi-item bad">
                <AlertTriangle size={14} />
                <span><strong>{stats.bpm} ccBPM</strong> — {s.cpiBpmRisk}</span>
              </div>
            )}
            {stats.xslt > 0 && (
              <div className="cpi-item ok">
                <CheckCircle2 size={14} />
                <span><strong>{stats.xslt} XSLT</strong> — {s.cpiXsltRisk}</span>
              </div>
            )}
            {stats.udfs === 0 && stats.classes === 0 && stats.bpm === 0 && (
              <div className="cpi-item ok">
                <CheckCircle2 size={14} />
                <span>Standard SAP PO artifacts — clean CPI migration profile</span>
              </div>
            )}
          </div>
          {stats.sortedAdapters.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="flabel" style={{ marginTop: 0 }}>{s.cpiAdapterDist}</div>
              <div className="adapter-chips">
                {stats.sortedAdapters.map(([ad, cnt]) => (
                  <span key={ad} className="pill-stat">{ad} <b>{cnt}</b></span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Archives Table with CRC32 Badges & Repack Actions */}
      <h2>{s.files} <span className="muted" style={{ fontWeight: 400 }}>({archives.length})</span></h2>
      <div className="tablewrap">
        <table className="table table-archives">
          <thead>
            <tr>
              <th style={{ minWidth: 190 }}>{s.file}</th>
              <th style={{ width: 105 }}>CRC32</th>
              <th style={{ minWidth: 140 }}>{s.swcv} / {s.system}</th>
              <th style={{ width: 110 }}>{s.exportedBy}</th>
              <th style={{ width: 92 }}>{s.date}</th>
              <th className="num" style={{ width: 68 }}>{s.objects}</th>
              <th className="num" style={{ width: 72 }}>{s.mappings}</th>
              <th className="num" style={{ width: 68 }}>{s.channels}</th>
              <th style={{ width: 142 }} />
            </tr>
          </thead>
          <tbody>
            {archives.map((a) => {
              const allOk = a.containers.length > 0 && a.containers.every((c) => c.crcIntegrity?.verified);
              const anyCrc = a.containers.some((c) => Boolean(c.crcIntegrity));
              const swcv = a.objects.find((o) => o.swcv)?.swcv;
              return (
                <tr key={a.archiveId}>
                  <td>
                    <div style={{ fontWeight: 600, wordBreak: 'break-word' }}>{a.fileName}</div>
                    <div className="muted small mono">{(a.sizeBytes / 1024).toFixed(0)} KB · {a.parsedInMs} ms</div>
                    {a.warnings?.length > 0 && <div className="small" style={{ color: 'var(--warn)' }}>{a.warnings.join(' · ')}</div>}
                  </td>
                  <td>
                    <button
                      className={`crc-pill sm ${allOk ? 'ok' : anyCrc ? 'warn' : ''}`}
                      onClick={() => onOpenRepack({ archiveId: a.archiveId, tab: 'verify' })}
                      title={s.repackTabVerify}
                    >
                      {allOk ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
                      <span>{allOk ? 'CRC OK' : anyCrc ? 'CHECK' : 'RAW'}</span>
                    </button>
                  </td>
                  <td className="small">
                    <div>{swcv || '—'}</div>
                    {a.metadata?.sourcesystem && <div className="muted mono">{a.metadata.sourcesystem}</div>}
                  </td>
                  <td className="small">{a.metadata?.exportUser || '—'}</td>
                  <td className="small mono" style={{ whiteSpace: 'nowrap' }}>{fmtDate(a.metadata?.dateLong) || '—'}</td>
                  <td className="num">{a.stats.totalObjects}</td>
                  <td className="num">{a.stats.messageMappings}</td>
                  <td className="num">{a.stats.channels}</td>
                  <td className="num">
                    <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center', whiteSpace: 'nowrap' }}>
                      <button className="btn sm line" onClick={() => onOpenRepack({ archiveId: a.archiveId, tab: 'patch' })} title={s.repackStudio}>
                        <Wrench size={12} /><span>Repack</span>
                      </button>
                      <button className="link small" onClick={() => onCloseArchive(a.archiveId)}>{s.remove}</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Multi-Inventory Explorer */}
      <div className="inv-header">
        <div className="seg">
          <button className={invTab === 'mappings' ? 'on' : ''} onClick={() => setInvTab('mappings')}>{s.mappingList} ({mappingRows.length})</button>
          <button className={invTab === 'channels' ? 'on' : ''} onClick={() => setInvTab('channels')}>{s.channelList} ({channelRows.length})</button>
          <button className={invTab === 'scenarios' ? 'on' : ''} onClick={() => setInvTab('scenarios')}>{s.scenarioList} ({scenarioRows.length})</button>
          <button className={invTab === 'code' ? 'on' : ''} onClick={() => setInvTab('code')}>{s.codeList} ({codeRows.length})</button>
          <button className={invTab === 'schemas' ? 'on' : ''} onClick={() => setInvTab('schemas')}>{s.schemaList} ({schemaRows.length})</button>
        </div>
        <input className="input" style={{ width: 260, marginLeft: 'auto' }} placeholder={s.filterTree} value={invQ} onChange={(e) => setInvQ(e.target.value)} />
      </div>

      {invTab === 'mappings' && (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th className="sortable" onClick={() => sortBy('name')}>{s.name}{arrow('name')}</th>
                <th>{s.namespace}</th>
                <th style={{ width: 170 }}>{s.file}</th>
                <th className="num sortable" style={{ width: 92 }} onClick={() => sortBy('fields')}>{s.fields}{arrow('fields')}</th>
                <th className="num sortable" style={{ width: 82 }} onClick={() => sortBy('udf')}>{s.udf}{arrow('udf')}</th>
              </tr>
            </thead>
            <tbody>
              {mappingRows.slice(0, 500).map((o) => (
                <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
                  <td style={{ fontWeight: 500 }}>{o.name}</td>
                  <td className="muted small">{o.namespace}</td>
                  <td className="muted small">{o.archiveName}</td>
                  <td className="num">{o.fieldMappingCount}</td>
                  <td className="num">{o.udfCount > 0 ? <span className="rk-badge rk-udf">{o.udfCount}</span> : '0'}</td>
                </tr>
              ))}
              {mappingRows.length === 0 && <tr><td colSpan={5} className="muted">{s.noMatch}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {invTab === 'channels' && (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>{s.name}</th>
                <th style={{ width: 130 }}>{s.adapter}</th>
                <th style={{ width: 160 }}>{s.direction}</th>
                <th>{s.component}</th>
                <th style={{ width: 170 }}>{s.file}</th>
              </tr>
            </thead>
            <tbody>
              {channelRows.slice(0, 500).map((o) => (
                <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
                  <td style={{ fontWeight: 500 }}>{o.name}</td>
                  <td><span className="pill-stat">{o.adapterType || '—'}</span></td>
                  <td className="small">{o.direction || '—'}</td>
                  <td className="muted small">{o.namespace}</td>
                  <td className="muted small">{o.archiveName}</td>
                </tr>
              ))}
              {channelRows.length === 0 && <tr><td colSpan={5} className="muted">{s.noMatch}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {invTab === 'scenarios' && (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 185 }}>{s.type}</th>
                <th>{s.name}</th>
                <th>{s.namespace}</th>
                <th className="num" style={{ width: 90 }}>{s.tabLinks}</th>
                <th style={{ width: 170 }}>{s.file}</th>
              </tr>
            </thead>
            <tbody>
              {scenarioRows.slice(0, 500).map((o) => {
                const info = getObjectTypeInfo(o.typeId, lang);
                return (
                  <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
                    <td><span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>{info.label}</td>
                    <td style={{ fontWeight: 500 }}>{o.name}</td>
                    <td className="muted small">{o.namespace}</td>
                    <td className="num">{o.linkCount}</td>
                    <td className="muted small">{o.archiveName}</td>
                  </tr>
                );
              })}
              {scenarioRows.length === 0 && <tr><td colSpan={5} className="muted">{s.noMatch}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {invTab === 'code' && (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 195 }}>{s.type}</th>
                <th>{s.name}</th>
                <th>{s.namespace}</th>
                <th className="num" style={{ width: 90 }}>.class</th>
                <th className="num" style={{ width: 90 }}>{s.tabSchemas}</th>
              </tr>
            </thead>
            <tbody>
              {codeRows.slice(0, 500).map((o) => {
                const info = getObjectTypeInfo(o.typeId, lang);
                return (
                  <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
                    <td><span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>{info.label}</td>
                    <td style={{ fontWeight: 500 }}>{o.name}</td>
                    <td className="muted small">{o.namespace}</td>
                    <td className="num">{o.classCount}</td>
                    <td className="num">{o.schemaCount}</td>
                  </tr>
                );
              })}
              {codeRows.length === 0 && <tr><td colSpan={5} className="muted">{s.noMatch}</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {invTab === 'schemas' && (
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 195 }}>{s.type}</th>
                <th>{s.name}</th>
                <th>{s.namespace}</th>
                <th style={{ width: 170 }}>{s.file}</th>
              </tr>
            </thead>
            <tbody>
              {schemaRows.slice(0, 500).map((o) => {
                const info = getObjectTypeInfo(o.typeId, lang);
                return (
                  <tr key={o.id} className="click" onClick={() => onOpen(o.id)}>
                    <td><span className="tbadge" style={{ '--tc': info.color, marginRight: 6 } as React.CSSProperties}>{info.short}</span>{info.label}</td>
                    <td style={{ fontWeight: 500 }}>{o.name}</td>
                    <td className="muted small">{o.namespace}</td>
                    <td className="muted small">{o.archiveName}</td>
                  </tr>
                );
              })}
              {schemaRows.length === 0 && <tr><td colSpan={4} className="muted">{s.noMatch}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
