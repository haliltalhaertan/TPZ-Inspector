import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileSpreadsheet,
  FolderOpen,
  GitCompare,
  Home,
  Moon,
  Pin,
  Search,
  ShieldCheck,
  Sun,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { DualTpzController } from './core/engines';
import { exportObjectsToExcelSpec } from './core/excelExport';
import type {
  EngineCapabilities,
  EngineMode,
  Lang,
  TpzArchiveSummary,
  TpzObjectDetail,
  TpzObjectSummary,
} from './core/types';
import { getObjectTypeInfo } from './i18n/translations';
import { DashboardView } from './ui/DashboardView';
import { clearDetailCache } from './ui/links';
import { ObjectView } from './ui/ObjectView';
import { Compare, EngineModal, Palette, PathDialog, SearchPage } from './ui/Panels';
import { RepackStudioModal, type RepackPreload } from './ui/RepackStudioModal';
import { S, SYSTEM_TYPES, typeRank } from './ui/strings';

const controller = new DualTpzController();

type Route =
  | { view: 'home' }
  | { view: 'cmp' }
  | { view: 'search'; q?: string }
  | { view: 'obj'; id: string; target?: string };

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h.startsWith('o/')) {
    const [id, target] = h.slice(2).split('?t=');
    return { view: 'obj', id: decodeURIComponent(id), target: target ? decodeURIComponent(target) : undefined };
  }
  if (h === 'cmp') return { view: 'cmp' };
  if (h.startsWith('search')) {
    const q = h.includes('?q=') ? decodeURIComponent(h.split('?q=')[1]) : '';
    return { view: 'search', q };
  }
  return { view: 'home' };
}
function go(r: Route) {
  window.location.hash =
    r.view === 'obj'
      ? `/o/${encodeURIComponent(r.id)}${r.target ? `?t=${encodeURIComponent(r.target)}` : ''}`
      : r.view === 'cmp'
        ? '/cmp'
        : r.view === 'search'
          ? `/search${r.q ? `?q=${encodeURIComponent(r.q)}` : ''}`
          : '/';
}

const stored = (k: string, d: string) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const store = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const App: React.FC = () => {
  const [lang, setLang] = useState<Lang>(stored('tpz.lang', 'tr') as Lang);
  const [theme, setTheme] = useState(stored('tpz.theme', 'light'));
  const [sideW, setSideW] = useState(Number(stored('tpz.side', '285')));
  const [mode, setMode] = useState<EngineMode>('browser');
  const [caps, setCaps] = useState<EngineCapabilities | null>(null);
  const [archives, setArchives] = useState<TpzArchiveSummary[]>([]);
  const [route, setRoute] = useState<Route>(parseHash());
  const [detail, setDetail] = useState<TpzObjectDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const [pathDlg, setPathDlg] = useState(false);
  const [engineDlg, setEngineDlg] = useState(false);
  const [repackDlg, setRepackDlg] = useState<RepackPreload | null>(null);
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragCount = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const s = S[lang];

  useEffect(() => { document.documentElement.dataset.theme = theme; store('tpz.theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.lang = lang; document.title = s.app; store('tpz.lang', lang); }, [lang, s.app]);

  const refresh = useCallback(async () => setArchives(await controller.listArchives()), []);

  const probe = useCallback(async (autoSwitch = false) => {
    const c = await controller.probeLocalBackend();
    setCaps(c);
    if (autoSwitch && c.localAvailable) {
      controller.setMode('local');
      setMode('local');
    } else {
      setMode(controller.getMode());
    }
    await refresh().catch((e) => setError(String(e)));
  }, [refresh]);

  useEffect(() => {
    probe(true);
    const onHash = () => setRoute(parseHash());
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(true); }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); window.history.back(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); window.history.forward(); }
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('keydown', onKey); };
  }, [probe]);

  const switchEngine = async (next: EngineMode) => {
    try {
      controller.setMode(next);
      setMode(next);
      clearDetailCache();
      setOpenTabs([]);
      setDetail(null);
      go({ view: 'home' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const objId = route.view === 'obj' ? route.id : null;
  useEffect(() => {
    if (!objId) { setDetail(null); return; }
    let live = true;
    controller.getObjectDetail(objId)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setError(null);
        setOpenTabs((prev) => (prev.includes(objId) ? prev : [...prev.slice(-11), objId]));
      })
      .catch(() => { if (live) { setDetail(null); setError(s.notFound); } });
    return () => { live = false; };
  }, [objId, archives.length]); // eslint-disable-line

  useEffect(() => {
    if (!detail) return;
    setOpenNodes((p) => ({ ...p, [`a:${detail.archiveId}`]: true, [`n:${detail.archiveId}:${detail.namespace || ''}`]: true }));
    setTimeout(() => document.querySelector('.titem.sel')?.scrollIntoView({ block: 'nearest' }), 60);
  }, [detail?.id]); // eslint-disable-line

  const loadFiles = async (files: FileList | File[]) => {
    setError(null); setBusy(s.parsing);
    try { await controller.loadFiles(files); clearDetailCache(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const loadPath = async (p: string) => {
    setPathDlg(false); setError(null); setBusy(s.parsing);
    try {
      const r = await controller.loadDiskPath(p);
      setMode('local');
      clearDetailCache();
      if (r.errors?.length) setError(r.errors.map((x) => `${x.file}: ${x.error}`).join(' | '));
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const closeArchive = async (id: string) => {
    const dead = new Set((archives.find((a) => a.archiveId === id)?.objects || []).map((o) => o.id));
    await controller.removeArchive(id);
    clearDetailCache();
    setOpenTabs((prev) => prev.filter((tid) => !dead.has(tid)));
    setPinnedIds((prev) => prev.filter((pid) => !dead.has(pid)));
    if (detail?.archiveId === id) go({ view: 'home' });
    await refresh();
  };
  const exportExcel = async () => {
    setBusy(s.working);
    try {
      const list: TpzObjectDetail[] = [];
      for (const a of archives) for (const o of a.objects)
        if (o.fieldMappingCount > 0 || o.udfCount > 0 || o.hasChannel) list.push(await controller.getObjectDetail(o.id));
      const base = archives.length === 1 ? archives[0].fileName.replace(/\.tpz$/i, '') : 'TPZ';
      exportObjectsToExcelSpec(archives, list, `${base}_Teknik_Dokuman.xls`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const all = useMemo(() => archives.flatMap((a) => a.objects), [archives]);
  const byId = useMemo(() => new Map(all.map((o) => [o.id, o])), [all]);

  const types = useMemo(() => {
    const set = new Set(all.filter((o) => !SYSTEM_TYPES.has(o.typeId)).map((o) => o.typeId));
    return [...set].sort((a, b) => typeRank(a) - typeRank(b) || a.localeCompare(b));
  }, [all]);

  const tree = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return archives.map((a) => {
      const groups = new Map<string, TpzObjectSummary[]>();
      let count = 0;
      for (const o of a.objects) {
        if (!showSystem && SYSTEM_TYPES.has(o.typeId)) continue;
        if (typeFilter && o.typeId !== typeFilter) continue;
        if (q && !o.name.toLowerCase().includes(q) && !o.namespace.toLowerCase().includes(q) && !o.adapterType.toLowerCase().includes(q)) continue;
        const k = o.namespace || '';
        const l = groups.get(k) || [];
        l.push(o); groups.set(k, l); count++;
      }
      const list = [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]));
      for (const [, items] of list) items.sort((x, y) => typeRank(x.typeId) - typeRank(y.typeId) || x.name.localeCompare(y.name));
      return { a, groups: list, count };
    });
  }, [archives, filter, typeFilter, showSystem]);

  const filtering = Boolean(filter.trim() || typeFilter);
  const isOpen = (key: string, dflt: boolean) => (filtering ? true : openNodes[key] ?? dflt);
  const toggle = (key: string, dflt: boolean) => setOpenNodes((p) => ({ ...p, [key]: !(p[key] ?? dflt) }));

  const expandAllTree = () => {
    const next: Record<string, boolean> = {};
    for (const t of tree) {
      next[`a:${t.a.archiveId}`] = true;
      for (const [ns] of t.groups) next[`n:${t.a.archiveId}:${ns}`] = true;
    }
    setOpenNodes(next);
  };
  const collapseAllTree = () => {
    const next: Record<string, boolean> = {};
    for (const t of tree) {
      next[`a:${t.a.archiveId}`] = false;
      for (const [ns] of t.groups) next[`n:${t.a.archiveId}:${ns}`] = false;
    }
    setOpenNodes(next);
  };

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => setSideW(Math.min(640, Math.max(230, ev.clientX)));
    const up = (ev: MouseEvent) => {
      store('tpz.side', String(Math.min(640, Math.max(230, ev.clientX))));
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };

  const openObj = (id: string, target?: string) => go({ view: 'obj', id, target });
  const closeTab = (id: string) => {
    const next = openTabs.filter((x) => x !== id);
    setOpenTabs(next);
    if (objId === id) {
      if (next.length) openObj(next[next.length - 1]);
      else go({ view: 'home' });
    }
  };
  const togglePin = (id: string) => setPinnedIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const localAvailable = Boolean(caps?.localAvailable);
  const pinnedObjs = pinnedIds.map((id) => byId.get(id)).filter(Boolean) as TpzObjectSummary[];

  return (
    <div
      className="app"
      onDragEnter={(e) => { e.preventDefault(); dragCount.current++; setDragging(true); }}
      onDragLeave={(e) => { e.preventDefault(); dragCount.current = Math.max(0, dragCount.current - 1); if (dragCount.current === 0) setDragging(false); }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setDragging(false);
        if (e.dataTransfer.files?.length) loadFiles(e.dataTransfer.files);
      }}
    >
      <header className="bar">
        <button className="brand" onClick={() => go({ view: 'home' })}>
          <span className="brand-mark">TPZ</span>
          <span className="brand-name">{s.app}</span>
        </button>

        <button className="btn primary" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /><span>{s.open}</span>
        </button>
        <input ref={fileRef} type="file" accept=".tpz,.zip" multiple hidden onChange={(e) => { if (e.target.files?.length) loadFiles(e.target.files); e.target.value = ''; }} />

        {localAvailable && (
          <button className="btn" onClick={() => setPathDlg(true)} title={s.openPath}>
            <FolderOpen size={14} /><span className="nav-lbl">{s.openPath}</span>
          </button>
        )}

        {archives.length > 0 && (
          <nav className="bar-nav">
            <button className={`btn ${route.view === 'home' ? 'on' : ''}`} onClick={() => go({ view: 'home' })} title={s.home}>
              <Home size={14} /><span className="nav-lbl">{s.home}</span>
            </button>
            <button className={`btn ${route.view === 'search' ? 'on' : ''}`} onClick={() => go({ view: 'search' })} title={s.searchPage}>
              <Search size={14} /><span className="nav-lbl">{s.searchPage}</span>
            </button>
            <button className={`btn ${route.view === 'cmp' ? 'on' : ''}`} onClick={() => go({ view: 'cmp' })} title={s.compare}>
              <GitCompare size={14} /><span className="nav-lbl">{s.compare}</span>
            </button>
            <button className="btn" onClick={() => setRepackDlg({ archiveId: archives[0].archiveId, tab: 'verify' })} title={s.repackStudio}>
              <ShieldCheck size={14} /><span className="nav-lbl">{s.repackStudio}</span>
            </button>
            <button className="btn" onClick={exportExcel} title={s.excel}>
              <FileSpreadsheet size={14} /><span className="nav-lbl">{s.excel}</span>
            </button>
          </nav>
        )}

        <span className="spacer" />

        {archives.length > 0 && (
          <button className="searchbtn" onClick={() => setPalette(true)}>
            <Search size={14} /><span>{s.searchHint}</span><kbd>Ctrl K</kbd>
          </button>
        )}

        <button className="engine-pill" onClick={() => setEngineDlg(true)} title={s.engineTitle}>
          <span className={`dot ${mode === 'local' ? 'on' : 'browser'}`} />
          <span className="lbl">{mode === 'local' ? s.localOn : s.localOff}</span>
          {mode === 'local' && caps?.hasCfr && <span className="mini-tag">CFR</span>}
        </button>

        <button className="btn" onClick={() => setLang(lang === 'tr' ? 'en' : 'tr')}>{lang.toUpperCase()}</button>
        <button className="btn" title={s.theme} aria-label={s.theme} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </header>

      {error && <div className="notice err"><span>{error}</span><span className="spacer" /><button className="btn sm" onClick={() => setError(null)}>×</button></div>}
      {busy && <div className="notice busy">{busy}</div>}

      <div className="body">
        {archives.length > 0 && (
          <>
            <aside className="side" style={{ width: sideW }}>
              <div className="side-top">
                <input className="input" placeholder={s.filterTree} value={filter} onChange={(e) => setFilter(e.target.value)} />
                <div style={{ display: 'flex', gap: 6 }}>
                  <select className="select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="">{s.allTypes}</option>
                    {types.map((t) => <option key={t} value={t}>{getObjectTypeInfo(t, lang).label}</option>)}
                  </select>
                  <button className="btn sm line" onClick={expandAllTree} title={s.expandAll}>+</button>
                  <button className="btn sm line" onClick={collapseAllTree} title={s.collapseAll}>−</button>
                </div>
                <label className="check"><input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />{s.showSystem}</label>
              </div>

              <div className="tree">
                {pinnedObjs.length > 0 && (
                  <div className="pin-section">
                    <div className="pin-head"><Pin size={11} /><span>{s.pinned}</span></div>
                    {pinnedObjs.map((o) => {
                      const info = getObjectTypeInfo(o.typeId, lang);
                      return (
                        <button key={o.id} className={`tnode titem flat ${objId === o.id ? 'sel' : ''}`} onClick={() => openObj(o.id)}>
                          <span className="tbadge" style={{ '--tc': info.color } as React.CSSProperties}>{info.short}</span>
                          <span className="nm">{o.name}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {tree.every((t) => t.count === 0) && <div className="empty-note">{s.noMatch}</div>}
                {tree.map(({ a, groups, count }) => {
                  if (filtering && count === 0) return null;
                  const aKey = `a:${a.archiveId}`;
                  const aOpen = isOpen(aKey, archives.length <= 3);
                  const nsDefault = count <= 80;
                  const allCrcOk = a.containers.length > 0 && a.containers.every((c) => c.crcIntegrity?.verified);
                  return (
                    <div key={a.archiveId}>
                      <div className="arch-row">
                        <button className="tnode arch" onClick={() => toggle(aKey, archives.length <= 3)}>
                          {aOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          <span className={`dot ${allCrcOk ? 'on' : ''}`} title={allCrcOk ? s.crcVerified : s.crcUnverified} style={{ marginTop: 6, flexShrink: 0 }} />
                          <span className="nm" title={a.fileName} style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{a.fileName}</span>
                          <span className="cnt">{count}</span>
                        </button>
                        <div className="arch-actions">
                          <button className="icon-act" title={s.repackStudio} onClick={() => setRepackDlg({ archiveId: a.archiveId, tab: 'verify' })}>
                            <Wrench size={12} />
                          </button>
                          <button className="icon-act" title={s.remove} onClick={() => closeArchive(a.archiveId)}>
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                      {aOpen && groups.map(([ns, items]) => {
                        const nKey = `n:${a.archiveId}:${ns}`;
                        const nOpen = isOpen(nKey, nsDefault);
                        return (
                          <div key={ns}>
                            <button className="tnode grp" onClick={() => toggle(nKey, nsDefault)}>
                              {nOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              <span className="gname">{ns || (a.objects.some((o) => o.swcv) ? s.noNamespace : s.directory)}</span>
                              <span className="cnt">{items.length}</span>
                            </button>
                            {nOpen && items.map((o) => {
                              const info = getObjectTypeInfo(o.typeId, lang);
                              const sub = o.fieldMappingCount > 0 ? `${o.fieldMappingCount} ${s.fields.toLowerCase()}${o.udfCount ? ` · ${o.udfCount} UDF` : ''}` : [o.adapterType, o.direction].filter(Boolean).join(' · ');
                              return (
                                <button key={o.id} className={`tnode titem ${objId === o.id ? 'sel' : ''}`} title={info.label} onClick={() => openObj(o.id)}>
                                  <span className="tbadge" style={{ '--tc': info.color } as React.CSSProperties}>{info.short}</span>
                                  <span className="nm">{o.name}{sub && <span className="sub">{sub}</span>}</span>
                                </button>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </aside>
            <div className="grip" onMouseDown={startDrag} />
          </>
        )}

        <main className="main">
          {/* Open Object Tab Bar + Back/Forward History */}
          {archives.length > 0 && openTabs.length > 0 && (
            <div className="tabbar">
              <button className="tab-nav" onClick={() => window.history.back()} title={s.back}><ArrowLeft size={13} /></button>
              <button className="tab-nav" onClick={() => window.history.forward()} title={s.forward}><ArrowRight size={13} /></button>
              <div className="tab-strip">
                {openTabs.map((tid) => {
                  const o = byId.get(tid);
                  if (!o) return null;
                  const info = getObjectTypeInfo(o.typeId, lang);
                  const active = route.view === 'obj' && route.id === tid;
                  return (
                    <div key={tid} className={`wtab ${active ? 'on' : ''}`} onClick={() => openObj(tid)}>
                      <span className="tbadge xs" style={{ '--tc': info.color } as React.CSSProperties}>{info.short}</span>
                      <span className="wtab-nm" title={o.name}>{o.name}</span>
                      <button className="wtab-x" title={s.closeTab} onClick={(e) => { e.stopPropagation(); closeTab(tid); }}><X size={11} /></button>
                    </div>
                  );
                })}
              </div>
              {openTabs.length > 1 && (
                <button className="btn sm" style={{ marginLeft: 'auto', fontSize: 11.5 }} onClick={() => { setOpenTabs([]); if (route.view === 'obj') go({ view: 'home' }); }}>
                  {s.closeAllTabs}
                </button>
              )}
            </div>
          )}

          {archives.length === 0 ? (
            <div className="page">
              <div className="welcome-hero">
                <div className="welcome-badge">
                  <Cpu size={13} />
                  <span>{s.appTagline}</span>
                </div>
                <h1>{s.dropTitle}</h1>
                <p>{s.dropText}</p>
                <div className="row">
                  <button className="btn primary lg" onClick={() => fileRef.current?.click()}>
                    <Upload size={15} /><span>{s.open}</span>
                  </button>
                  {localAvailable && (
                    <button className="btn line lg" onClick={() => setPathDlg(true)}>
                      <FolderOpen size={15} /><span>{s.openPath}</span>
                    </button>
                  )}
                </div>
                <div className="muted small" style={{ marginTop: 12 }}>
                  {mode === 'local' ? `${s.localOn}${caps?.hasCfr ? ' · CFR 0.152 · CRC32 Repack' : ''}` : s.browserOnly}
                </div>

                <div className="feat-grid">
                  <div className="feat-card">
                    <strong>{s.feat1Title}</strong>
                    <p>{s.feat1Desc}</p>
                  </div>
                  <div className="feat-card">
                    <strong>{s.feat2Title}</strong>
                    <p>{s.feat2Desc}</p>
                  </div>
                  <div className="feat-card">
                    <strong>{s.feat3Title}</strong>
                    <p>{s.feat3Desc}</p>
                  </div>
                  <div className="feat-card">
                    <strong>{s.feat4Title}</strong>
                    <p>{s.feat4Desc}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : route.view === 'cmp' ? (
            <Compare
              archives={archives} controller={controller} s={s} lang={lang}
              onOpen={(id) => openObj(id)}
              onAddFile={() => fileRef.current?.click()}
            />
          ) : route.view === 'search' ? (
            <SearchPage controller={controller} s={s} lang={lang} initialQuery={route.q} onPick={openObj} />
          ) : route.view === 'obj' && detail ? (
            <ObjectView
              detail={detail} archives={archives} all={all} controller={controller} lang={lang} s={s}
              focusTarget={route.target}
              pinned={pinnedIds.includes(detail.id)}
              onTogglePin={togglePin}
              onOpen={(id) => openObj(id)}
              onHome={() => go({ view: 'home' })}
              onOpenRepack={(pre) => setRepackDlg(pre)}
            />
          ) : route.view === 'obj' ? (
            <div className="page muted">{error ? '' : s.loading}</div>
          ) : (
            <DashboardView
              archives={archives} all={all} lang={lang} s={s}
              onOpen={(id) => openObj(id)}
              onCloseArchive={closeArchive}
              onOpenRepack={(pre) => setRepackDlg(pre)}
              onFilterType={(t) => setTypeFilter((cur) => (cur === t ? '' : t))}
            />
          )}
        </main>
      </div>

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-box">
            <Upload size={32} />
            <strong>{s.dropRelease}</strong>
            <span className="muted small">.tpz / .zip</span>
          </div>
        </div>
      )}

      {palette && (
        <Palette
          controller={controller} s={s} lang={lang}
          onPick={openObj}
          onOpenSearchPage={(q) => go({ view: 'search', q })}
          onClose={() => setPalette(false)}
        />
      )}
      {pathDlg && <PathDialog s={s} onLoad={loadPath} onClose={() => setPathDlg(false)} />}
      {engineDlg && (
        <EngineModal
          mode={mode} caps={caps} s={s}
          onSelectMode={switchEngine}
          onReprobe={() => probe(false)}
          onClose={() => setEngineDlg(false)}
        />
      )}
      {repackDlg && (
        <RepackStudioModal
          archives={archives} controller={controller} localAvailable={localAvailable} s={s}
          initial={repackDlg}
          onLoadedFile={async (files) => { await loadFiles(files); }}
          onClose={() => setRepackDlg(null)}
        />
      )}
    </div>
  );
};
