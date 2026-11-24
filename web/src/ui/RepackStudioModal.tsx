import React, { useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Download,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import type { DualTpzController } from '../core/engines';
import type { ChannelAttribute, TptCrcIntegrity, TpzArchiveSummary } from '../core/types';
import type { Strings } from './strings';

interface VerifyResponse {
  archiveId: string;
  fileName: string;
  allVerified: boolean;
  containerCount: number;
  containers: Array<TptCrcIntegrity & { container: string }>;
}

export interface RepackPreload {
  archiveId: string;
  tab?: 'verify' | 'sanitize' | 'patch';
  channelName?: string;
  attributeName?: string;
}

export const RepackStudioModal: React.FC<{
  archives: TpzArchiveSummary[];
  controller: DualTpzController;
  localAvailable: boolean;
  s: Strings;
  initial?: RepackPreload;
  onLoadedFile: (files: File[]) => Promise<void>;
  onClose: () => void;
}> = ({ archives, controller, localAvailable, s, initial, onLoadedFile, onClose }) => {
  const [archId, setArchId] = useState(initial?.archiveId || archives[0]?.archiveId || '');
  const [tab, setTab] = useState<'verify' | 'sanitize' | 'patch'>(initial?.tab || 'verify');
  const [verifyData, setVerifyData] = useState<VerifyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [lastSummary, setLastSummary] = useState<Record<string, unknown> | null>(null);

  // Sanitizer state
  const [includeHeader, setIncludeHeader] = useState(true);

  // Patcher state
  const [selectedChannel, setSelectedChannel] = useState(initial?.channelName || '');
  const [chanAttrs, setChanAttrs] = useState<ChannelAttribute[]>([]);
  const [attrName, setAttrName] = useState(initial?.attributeName || '');
  const [attrValue, setAttrValue] = useState('');
  const [patches, setPatches] = useState<Array<{ channelName?: string; attribute: string; value: string }>>([]);
  const [findTxt, setFindTxt] = useState('');
  const [replTxt, setReplTxt] = useState('');
  const [replacements, setReplacements] = useState<Array<{ find: string; replace: string }>>([]);
  const [outputName, setOutputName] = useState('');

  const archive = useMemo(() => archives.find((a) => a.archiveId === archId) || archives[0], [archives, archId]);
  const channels = useMemo(() => (archive ? archive.objects.filter((o) => o.typeId === 'Channel') : []), [archive]);

  useEffect(() => {
    if (!archive) return;
    setOutputName(archive.fileName.replace(/\.tpz$/i, '_repacked.tpz'));
    setVerifyData(null);
    setErr(null);
    setOkMsg(null);
    runVerify(archive.archiveId);
  }, [archive?.archiveId]); // eslint-disable-line

  useEffect(() => {
    if (!selectedChannel || !archive) { setChanAttrs([]); return; }
    const obj = channels.find((c) => c.name === selectedChannel);
    if (!obj) { setChanAttrs([]); return; }
    controller.getObjectDetail(obj.id).then((d) => {
      const attrs = d.channel?.attributes || [];
      setChanAttrs(attrs);
      if (initial?.attributeName && attrs.some((a) => a.name === initial.attributeName)) {
        setAttrName(initial.attributeName);
        setAttrValue(attrs.find((a) => a.name === initial.attributeName)?.value || '');
      }
    }).catch(() => setChanAttrs([]));
  }, [selectedChannel, archive?.archiveId]); // eslint-disable-line

  const runVerify = async (id: string) => {
    setBusy(true); setErr(null);
    try {
      const res = await controller.verifyArchive(id);
      setVerifyData(res as VerifyResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const triggerDownload = (blob: Blob, fname: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runSanitize = async (alsoLoad: boolean) => {
    if (!archive) return;
    setBusy(true); setErr(null); setOkMsg(null); setLastSummary(null);
    try {
      const outFn = archive.fileName.replace(/\.tpz$/i, '_sanitized.tpz');
      const res = await controller.repackArchive(archive.archiveId, {
        sanitize: true,
        includeHeader,
        outputName: outFn,
      });
      setLastSummary(res.summary);
      setOkMsg(s.repackSuccess);
      triggerDownload(res.blob, res.fileName);
      if (alsoLoad) {
        const f = new File([res.blob], res.fileName, { type: 'application/zip' });
        await onLoadedFile([f]);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runPatchRepack = async (alsoLoad: boolean) => {
    if (!archive) return;
    if (patches.length === 0 && replacements.length === 0) {
      setErr(s.repackNoEdits);
      return;
    }
    setBusy(true); setErr(null); setOkMsg(null); setLastSummary(null);
    try {
      const res = await controller.repackArchive(archive.archiveId, {
        channelPatches: patches,
        replacements,
        outputName: outputName.trim() || archive.fileName.replace(/\.tpz$/i, '_repacked.tpz'),
      });
      setLastSummary(res.summary);
      setOkMsg(s.repackSuccess);
      if (alsoLoad) {
        const f = new File([res.blob], res.fileName, { type: 'application/zip' });
        await onLoadedFile([f]);
      } else {
        triggerDownload(res.blob, res.fileName);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="veil" onMouseDown={onClose}>
      <div className="dialog dialog-lg" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-top">
          <div className="dlg-title">
            <ShieldCheck size={18} style={{ color: 'var(--ok)' }} />
            <span>{s.repackTitle}</span>
          </div>
          <button className="btn sm" onClick={onClose} aria-label={s.close}><X size={16} /></button>
        </div>

        <div className="dlg-archbar">
          <label className="small muted">{s.repackSelectArchive}</label>
          <select className="select" value={archId} onChange={(e) => setArchId(e.target.value)}>
            {archives.map((a) => (
              <option key={a.archiveId} value={a.archiveId}>{a.fileName} ({(a.sizeBytes / 1024).toFixed(0)} KB)</option>
            ))}
          </select>
          <div className="seg" style={{ marginLeft: 'auto' }}>
            <button className={tab === 'verify' ? 'on' : ''} onClick={() => setTab('verify')}>
              <ShieldCheck size={13} /><span>{s.repackTabVerify}</span>
            </button>
            <button className={tab === 'sanitize' ? 'on' : ''} onClick={() => setTab('sanitize')}>
              <Sparkles size={13} /><span>{s.repackTabSanitize}</span>
            </button>
            <button className={tab === 'patch' ? 'on' : ''} onClick={() => setTab('patch')}>
              <Wrench size={13} /><span>{s.repackTabPatch}</span>
            </button>
          </div>
        </div>

        <div className="dlg-body">
          {err && <div className="alert-box err">{err}</div>}
          {okMsg && (
            <div className="alert-box ok" style={{ flexWrap: 'wrap' }}>
              <CheckCircle2 size={15} />
              <span>{okMsg}</span>
              {lastSummary && (
                <div style={{ display: 'inline-flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
                  {Array.isArray(lastSummary.containers) && (
                    <span className="pill-stat">
                      {(lastSummary.containers as Array<Record<string, number>>).reduce((a, c) => a + (c.totalEdits || 0), 0)} edits
                    </span>
                  )}
                  {Array.isArray(lastSummary.containers) && (
                    <span className="pill-stat">
                      {(lastSummary.containers as Array<Record<string, number>>).reduce((a, c) => a + (c.segmentsModified || 0), 0)} segments
                    </span>
                  )}
                  <span className="crc-pill sm ok">CRC32 OK ✓</span>
                </div>
              )}
            </div>
          )}

          {/* TAB 1: CRC32 Binary Verification */}
          {tab === 'verify' && (
            <div>
              <div className="tools">
                {verifyData && (
                  <span className={`crc-pill ${verifyData.allVerified ? 'ok' : 'warn'}`}>
                    {verifyData.allVerified ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
                    <span>{verifyData.allVerified ? s.crcVerified : s.crcUnverified} · {verifyData.containerCount} container</span>
                  </span>
                )}
                <span className="spacer" />
                {archive && (
                  <button className="btn sm line" disabled={busy} onClick={() => runVerify(archive.archiveId)}>
                    <RefreshCw size={13} /><span>{s.repackVerifyRun}</span>
                  </button>
                )}
              </div>

              {verifyData && verifyData.containers.map((c, idx) => (
                <div className="crc-card" key={idx}>
                  <div className="crc-card-head">
                    <strong className="mono">{c.container}</strong>
                    <span className={`crc-pill sm ${c.verified ? 'ok' : 'warn'}`}>
                      {c.verified ? 'CRC-32/ISO-HDLC OK' : 'CHECK'}
                    </span>
                    <span className="muted small mono" style={{ marginLeft: 'auto' }}>
                      {(c.physicalBytes / 1024).toFixed(1)} KB phys → {(c.logicalBytes / 1024).toFixed(1)} KB log
                    </span>
                  </div>
                  <div className="crc-grid">
                    <div className={`crc-cell ${c.validMagic ? 'ok' : 'bad'}`}>
                      <span>{s.repackMagic}</span>
                      <strong className="mono">{c.validMagic ? 'DC358A91 ✓' : '✗'}</strong>
                    </div>
                    <div className={`crc-cell ${c.headerCrcOk ? 'ok' : 'bad'}`}>
                      <span>{s.repackHeaderCrc}</span>
                      <strong className="mono">{c.headerCrcOk ? 'MATCH ✓' : '✗'}</strong>
                    </div>
                    <div className={`crc-cell ${c.chunksOk === c.chunksChecked ? 'ok' : 'bad'}`}>
                      <span>{s.repackChunks}</span>
                      <strong className="mono">{c.chunksOk}/{c.chunksChecked} ✓</strong>
                    </div>
                    <div
                      className={`crc-cell ${c.preCatalogCrcOk ? 'ok' : 'bad'}`}
                      title={
                        typeof c.zipFlagBit3 === 'boolean'
                          ? `Inner CRC scope: ${c.catMode} · Outer ZIP flag bit 3 (data descriptor): ${c.zipFlagBit3 ? 'set' : 'clear'}`
                          : undefined
                      }
                    >
                      <span>{s.repackPreCat}</span>
                      <strong className="mono">{c.catMode} {c.preCatalogCrcOk ? '✓' : '✗'}</strong>
                    </div>
                    <div className={`crc-cell ${c.contiguousSegments ? 'ok' : 'bad'}`}>
                      <span>{s.repackSegments}</span>
                      <strong className="mono">{c.segmentCount} {c.contiguousSegments ? '✓' : '✗'}</strong>
                    </div>
                    <div className={`crc-cell ${c.modelElementsExact === c.modelElementsTotal ? 'ok' : 'warn'}`}>
                      <span>{s.repackElements}</span>
                      <strong className="mono">{c.modelElementsExact}/{c.modelElementsTotal}</strong>
                    </div>
                    {typeof c.pvcElementsTotal === 'number' && c.pvcElementsTotal > 0 && (
                      <div className={`crc-cell ${c.pvcOidConsistent === c.pvcElementsTotal ? 'ok' : 'warn'}`}>
                        <span>pvcElement TLV (OID/VID)</span>
                        <strong className="mono">{c.pvcOidConsistent}/{c.pvcElementsTotal} ✓</strong>
                      </div>
                    )}
                    {typeof c.catMarkersChecked === 'number' && c.catMarkersChecked > 0 && (
                      <div className={`crc-cell ${c.catMarkersOk === c.catMarkersChecked ? 'ok' : 'bad'}`}>
                        <span>Multi-Block Catalog CRCs</span>
                        <strong className="mono">{c.catMarkersOk}/{c.catMarkersChecked} ✓</strong>
                      </div>
                    )}
                    {c.headerVersionSetId && (
                      <div
                        className={`crc-cell ${c.vsetFirstTlvMatchesHeader === false || c.vsetSpecMatchesHeader === false ? 'bad' : 'ok'}`}
                        title={[
                          `header/versionSet@id (network byte order): ${c.headerVersionSetId}`,
                          typeof c.vsetSpecCode === 'number'
                            ? `pvcVersionSetSpecialization: code=${c.vsetSpecCode}${c.vsetSpecMatchesHeader === true ? ' (TLV1 = header ✓)' : c.vsetSpecMatchesHeader === false ? ' (TLV1 ≠ header ✗)' : ''}`
                            : '',
                          c.vsetSecondTlvId
                            ? `TLV2 (baseVersionSetID candidate): ${c.vsetSecondTlvId}${c.vsetSecondTlvInDevlines === true ? ` → knownDevlines ✓${c.vsetSecondTlvDevlineLabel ? ` [${c.vsetSecondTlvDevlineLabel}]` : ''}` : ''}`
                            : '',
                        ].filter(Boolean).join(' · ')}
                      >
                        <span>VersionSet UUID Chain</span>
                        <strong className="mono">
                          {c.headerVersionSetId.slice(0, 8)}… {c.vsetFirstTlvMatchesHeader === true ? '= TLV1 ✓' : c.vsetFirstTlvMatchesHeader === false ? '≠ TLV1 ✗' : ''}
                          {typeof c.vsetSpecCode === 'number' ? ` · spec=${c.vsetSpecCode}` : ''}
                        </strong>
                      </div>
                    )}
                    {typeof c.vsetMembershipRows === 'number' && c.vsetMembershipRows > 0 && (
                      <div
                        className={`crc-cell ${c.vsetMembershipJoinedPvc === c.vsetMembershipRows && c.vsetMembershipMatchesHeader === c.vsetMembershipRows ? 'ok' : 'warn'}`}
                        title={`pvcVersionSet rows matching header UUID: ${c.vsetMembershipMatchesHeader}/${c.vsetMembershipRows} · 1:1 (VID,OID) join to pvcElement: ${c.vsetMembershipJoinedPvc}/${c.vsetMembershipRows}`}
                      >
                        <span>pvcVersionSet Membership</span>
                        <strong className="mono">{c.vsetMembershipJoinedPvc}/{c.vsetMembershipRows} ✓</strong>
                      </div>
                    )}
                    {typeof c.pvcR16Total === 'number' && c.pvcR16Total > 0 && (
                      <div className={`crc-cell ${c.pvcR16MatchesHeader === c.pvcR16Total ? 'ok' : 'warn'}`}>
                        <span>Relation Tail R16 = VSet</span>
                        <strong className="mono">{c.pvcR16MatchesHeader}/{c.pvcR16Total} ✓</strong>
                      </div>
                    )}
                    {((typeof c.knownDevlinesCount === 'number' && c.knownDevlinesCount > 0) ||
                      (typeof c.pvcR3Total === 'number' && c.pvcR3Total > 0)) && (() => {
                      const r3Total = c.pvcR3Total ?? 0;
                      const r3Resolved = c.pvcR3ResolvedDevlines ?? 0;
                      const unresRows = Math.max(0, r3Total - r3Resolved);
                      const unresUniq = c.pvcR3UnresolvedUnique ?? 0;
                      const allResolved = r3Total === 0 || r3Resolved === r3Total;
                      const tip = [
                        `knownDevlines entries: ${c.knownDevlinesCount ?? 0}`,
                        r3Total ? `R3 (ownerVSID) rows locally resolved: ${r3Resolved}/${r3Total}` : '',
                        unresRows > 0
                          ? `External/unexported R3 refs: ${unresRows} row(s) across ${unresUniq} distinct devline UUID(s) — R3 field bytes parsed cleanly, target record is not present in this member's knownDevlines (load a complementary TPZ to resolve cross-archive)`
                          : '',
                        c.pvcR3UnresolvedIds && c.pvcR3UnresolvedIds.length > 0
                          ? `Unresolved UUIDs: ${c.pvcR3UnresolvedIds.slice(0, 6).join(', ')}${c.pvcR3UnresolvedIds.length > 6 ? '…' : ''}`
                          : '',
                      ].filter(Boolean).join(' · ');
                      return (
                        <div className={`crc-cell ${allResolved ? 'ok' : 'warn'}`} title={tip}>
                          <span>knownDevlines (R3)</span>
                          <strong className="mono">
                            {c.knownDevlinesCount ?? 0} dl
                            {r3Total > 0
                              ? allResolved
                                ? ` · ${r3Resolved}/${r3Total} ✓`
                                : ` · ${r3Resolved}/${r3Total} (${unresUniq} ext)`
                              : ''}
                          </strong>
                        </div>
                      );
                    })()}
                  </div>
                  {c.errors?.length > 0 && (
                    <div className="small" style={{ color: 'var(--bad)', marginTop: 8 }}>{c.errors.join(' · ')}</div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* TAB 2: 1-Click Sanitizer */}
          {tab === 'sanitize' && (
            <div className="repack-panel">
              {!localAvailable && <div className="alert-box warn">{s.repackNeedLocal}</div>}
              <p className="muted" style={{ marginTop: 0 }}>{s.repackSanitizeDesc}</p>
              <label className="check" style={{ marginBottom: 18 }}>
                <input type="checkbox" checked={includeHeader} onChange={(e) => setIncludeHeader(e.target.checked)} />
                {s.repackIncludeHeader}
              </label>
              <div className="row-actions">
                <button className="btn primary" disabled={busy || !localAvailable} onClick={() => runSanitize(false)}>
                  <Download size={14} /><span>{s.repackSanitizeBtn}</span>
                </button>
                <button className="btn line" disabled={busy || !localAvailable} onClick={() => runSanitize(true)}>
                  <Upload size={14} /><span>{s.repackBuildAndLoad}</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: Channel Patch & Bulk Find/Replace */}
          {tab === 'patch' && (
            <div className="repack-panel">
              {!localAvailable && <div className="alert-box warn">{s.repackNeedLocal}</div>}

              <div className="sect">{s.channel} Patch</div>
              <div className="patch-form">
                <select className="select" value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)}>
                  <option value="">{s.repackChannelSelect} ({channels.length})</option>
                  {channels.map((c) => <option key={c.id} value={c.name}>{c.name} ({c.adapterType || c.namespace})</option>)}
                </select>
                <input
                  className="input"
                  list="chan-attr-list"
                  placeholder={s.repackAttrSelect}
                  value={attrName}
                  onChange={(e) => {
                    setAttrName(e.target.value);
                    const found = chanAttrs.find((a) => a.name === e.target.value);
                    if (found) setAttrValue(found.value);
                  }}
                />
                <datalist id="chan-attr-list">
                  {chanAttrs.map((a, i) => <option key={a.name + i} value={a.name}>{a.value.slice(0, 60)}</option>)}
                </datalist>
                <input className="input" placeholder={s.repackNewValue} value={attrValue} onChange={(e) => setAttrValue(e.target.value)} />
                <button
                  className="btn line"
                  disabled={!attrName.trim()}
                  onClick={() => {
                    setPatches((p) => [...p, { channelName: selectedChannel || undefined, attribute: attrName.trim(), value: attrValue }]);
                    setAttrName(''); setAttrValue('');
                  }}
                >
                  <Plus size={14} /><span>{s.repackAddPatch}</span>
                </button>
              </div>

              {patches.length > 0 && (
                <div className="patch-list">
                  {patches.map((pt, i) => (
                    <div className="patch-row" key={i}>
                      <span className="tag">CH</span>
                      <span className="mono small">{pt.channelName || '*'} → <b>{pt.attribute}</b> = {pt.value}</span>
                      <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setPatches((p) => p.filter((_, k) => k !== i))}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="sect" style={{ marginTop: 18 }}>XML Find / Replace</div>
              <div className="patch-form two">
                <input className="input" placeholder={s.repackFindLabel} value={findTxt} onChange={(e) => setFindTxt(e.target.value)} />
                <input className="input" placeholder={s.repackReplaceLabel} value={replTxt} onChange={(e) => setReplTxt(e.target.value)} />
                <button
                  className="btn line"
                  disabled={!findTxt}
                  onClick={() => {
                    setReplacements((r) => [...r, { find: findTxt, replace: replTxt }]);
                    setFindTxt(''); setReplTxt('');
                  }}
                >
                  <Plus size={14} /><span>{s.repackAddReplace}</span>
                </button>
              </div>

              {replacements.length > 0 && (
                <div className="patch-list">
                  {replacements.map((rp, i) => (
                    <div className="patch-row" key={i}>
                      <span className="tag">TXT</span>
                      <span className="mono small">"{rp.find}" → "{rp.replace}"</span>
                      <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setReplacements((r) => r.filter((_, k) => k !== i))}>
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="repack-foot">
                <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span>{s.repackOutputName}:</span>
                  <input className="input" style={{ width: 260 }} value={outputName} onChange={(e) => setOutputName(e.target.value)} />
                </label>
                <div className="row-actions">
                  <button className="btn primary" disabled={busy || !localAvailable} onClick={() => runPatchRepack(false)}>
                    <Download size={14} /><span>{s.repackBuildDownload}</span>
                  </button>
                  <button className="btn line" disabled={busy || !localAvailable} onClick={() => runPatchRepack(true)}>
                    <Upload size={14} /><span>{s.repackBuildAndLoad}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
