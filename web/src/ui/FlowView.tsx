import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Cloud, GitBranch, Layers } from 'lucide-react';
import type { DualTpzController } from '../core/engines';
import type { Lang, ObjectLink, TpzObjectDetail, TpzObjectSummary } from '../core/types';
import { getObjectTypeInfo } from '../i18n/translations';
import { cachedDetail, findObject, linkTarget, useUsage } from './links';
import type { Strings } from './strings';

interface Ctx { all: TpzObjectSummary[]; archiveId: string; s: Strings; lang: Lang; onOpen: (id: string) => void }

const TypePill: React.FC<{ typeId: string; lang: Lang }> = ({ typeId, lang }) => {
  const info = getObjectTypeInfo(typeId, lang);
  return <span className="tbadge" style={{ '--tc': info.color } as React.CSSProperties}>{info.short}</span>;
};

const Ref: React.FC<{ ctx: Ctx; typeId: string; name: string; ns?: string; showNs?: boolean; extra?: string }> = ({ ctx, typeId, name, ns, showNs, extra }) => {
  const hit = name ? findObject(ctx.all, typeId, name, ns, ctx.archiveId) : undefined;
  const more = [extra, hit && typeId === 'Channel' ? [hit.adapterType, hit.direction].filter(Boolean).join(' · ') : ''].filter(Boolean).join(' · ');
  return (
    <div className="ref">
      <div className="ref-row">
        {name && <TypePill typeId={typeId} lang={ctx.lang} />}
        {hit ? <button className="link" onClick={() => ctx.onOpen(hit.id)}><Name text={name} /></button> : <span>{name ? <Name text={name} /> : '—'}</span>}
      </div>
      {more && <div className="muted small">{more}</div>}
      {showNs && ns && <div className="muted small">{ns}</div>}
      {!hit && name && typeId !== 'Service' && !ns?.startsWith('urn:sap-com:document:sap:') && <div className="muted small">{ctx.s.notInFile}</div>}
    </div>
  );
};

export const Name: React.FC<{ text: string }> = ({ text }) => (
  <>{text.split(/(?<=[_./])/).map((part, i) => <React.Fragment key={i}>{i > 0 && <wbr />}{part}</React.Fragment>)}</>
);

const Arrow = () => <div className="arrow" aria-hidden>→</div>;
const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="flabel">{children}</div>;

function useOmMappings(ctx: Ctx, controller: DualTpzController, oms: Array<{ name: string; ns: string }>) {
  const [map, setMap] = useState<Record<string, ObjectLink[]>>({});
  const key = oms.map((o) => `${o.ns}|${o.name}`).join('\n');
  useEffect(() => {
    let live = true;
    setMap({});
    (async () => {
      const out: Record<string, ObjectLink[]> = {};
      for (const o of oms) {
        const hit = findObject(ctx.all, 'MAPPING', o.name, o.ns, ctx.archiveId);
        if (!hit) continue;
        try {
          const d = await cachedDetail(controller, hit.id);
          out[`${o.ns}|${o.name}`] = d.links.filter((l) => l.role.endsWith('_TRAFO'));
        } catch { /* ignore */ }
      }
      if (live) setMap(out);
    })();
    return () => { live = false; };
  }, [key, ctx.all.length]); // eslint-disable-line
  return map;
}

/* ---------- ICO ---------- */

const kids = (el: Element | null | undefined, name: string): Element[] => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string): Element | undefined => kids(el, name)[0];
const txt = (el: Element | null | undefined, name: string): string => (kid(el, name)?.textContent || '').trim();
function extractor(el: Element | undefined): { type: string; value: string } {
  const x = kid(el, 'TRD_EXTRACTOR');
  return { type: txt(x, 'TYPE'), value: txt(x, 'VALUE') };
}

interface IcoInterface { name: string; ns: string; operation: string; counter: string; cond: string; cpiCond: string; connId: string; lookups: string[] }
interface IcoReceiver { id: string; party: string; service: string; dynamic: boolean; qos: string; cond: string; cpiCond: string; interfaces: IcoInterface[] }
interface IcoModel {
  receivers: IcoReceiver[];
  params: Array<[string, string]>;
  conn: Record<string, Array<[string, string]>>;
  virus: string;
  koCount: number;
  xpCount: number;
  cpiRoutes: Array<{ target: string; expr: string }>;
}

const OPS: Record<string, string> = { EQ: '=', NE: '≠', CP: '≈', EX: '∃' };

function parseCondShort(c: Element | undefined, s: Strings): { human: string; cpi: string } {
  if (!c) return { human: '', cpi: '' };
  const groups = new Map<string, string[]>();
  const cpiGroups = new Map<string, string[]>();
  for (const line of kids(c, 'CONDLINE')) {
    const l = extractor(kid(line, 'LEXTRACTOR'));
    const r = extractor(kid(line, 'REXTRACTOR'));
    const op = txt(line, 'COMPOP');
    const text = op === 'EX' ? `${l.value} ${s.exists}` : `${l.value} ${OPS[op] || op} ${r.value}`;
    const lhs = l.type === 'XP' ? l.value : `'${l.value}'`;
    const rhs = r.type === 'XP' ? r.value : `'${r.value}'`;
    const cpiText =
      op === 'EX' ? `boolean(${lhs})`
      : op === 'NE' ? `${lhs} != ${rhs}`
      : op === 'CP' ? `contains(${lhs}, ${rhs.replace(/\*/g, '')})`
      : `${lhs} = ${rhs}`;
    const g = txt(line, 'COMPGROUP');
    groups.set(g, [...(groups.get(g) || []), text]);
    cpiGroups.set(g, [...(cpiGroups.get(g) || []), cpiText]);
  }
  return {
    human: [...groups.values()].map((g) => g.join(` ${s.and} `)).join(`\n${s.or} `),
    cpi: [...cpiGroups.values()].map((g) => (g.length > 1 ? `(${g.join(' and ')})` : g[0])).join(' or '),
  };
}

function parseIco(xml: string, s: Strings): IcoModel | null {
  let doc: Document;
  try { doc = new DOMParser().parseFromString(xml, 'application/xml'); } catch { return null; }
  const root = Array.from(doc.getElementsByTagName('*')).find((e) => e.localName === 'AllInOne');
  if (!root) return null;

  let koCount = 0;
  let xpCount = 0;
  for (const ex of Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === 'TRD_EXTRACTOR')) {
    const t = txt(ex, 'TYPE');
    if (t === 'KO') koCount++;
    else if (t === 'XP') xpCount++;
  }

  const conds = new Map<string, { human: string; cpi: string }>();
  for (const c of kids(kid(root, 'Conditions'), 'RDS_CONDSHORT')) {
    conds.set(txt(c, 'CONDITIONID'), parseCondShort(c, s));
  }

  const recvCond = new Map<string, { human: string; cpi: string }>();
  for (const a of kids(kid(root, 'ReceiverAssignmentList'), 'ReceiverAssignment')) {
    const cid = txt(a, 'ReceiverConditionId');
    for (const r of kids(kid(a, 'ReceiverIds'), 'ReceiverId')) {
      recvCond.set((r.textContent || '').trim(), cid && conds.has(cid) ? conds.get(cid)! : { human: '', cpi: '' });
    }
  }

  const cpiRoutes: Array<{ target: string; expr: string }> = [];
  const receivers: IcoReceiver[] = kids(kid(root, 'ReceiverConfigurations'), 'ReceiverConfiguration').map((rc) => {
    const r = kid(rc, 'Receiver');
    const svc = extractor(kid(r, 'ServiceExtractor'));
    const id = txt(rc, 'ReceiverId');
    const rcCond = recvCond.get(id) || { human: '', cpi: '' };
    if (rcCond.cpi) cpiRoutes.push({ target: `Receiver: ${svc.value || id}`, expr: rcCond.cpi });
    const interfaces: IcoInterface[] = [];
    for (const det of kids(kid(rc, 'InterfaceDeterminations'), 'InterfaceDetermination')) {
      const cid = txt(det, 'InterfaceConditionId');
      // Support BOTH referenced InterfaceConditionId AND inline InterfaceDetermination/Condition/RDS_CONDSHORT
      const inlineShort = kid(kid(det, 'Condition'), 'RDS_CONDSHORT');
      const detCond = inlineShort ? parseCondShort(inlineShort, s) : (cid && conds.has(cid) ? conds.get(cid)! : { human: '', cpi: '' });
      const lookups = kids(kid(kid(det, 'Binding'), 'properties'), 'property').map((p) => p.getAttribute('name') || '').filter(Boolean);
      for (const i of kids(kid(det, 'Interfaces'), 'Interface')) {
        const ifName = txt(i, 'InterfaceName');
        if (detCond.cpi) cpiRoutes.push({ target: `Interface: ${ifName || det.getAttribute('Counter') || ''}`, expr: detCond.cpi });
        interfaces.push({
          name: ifName, ns: txt(i, 'InterfaceNamespace'), operation: txt(det, 'Operation'),
          counter: txt(det, 'Counter'), cond: detCond.human, cpiCond: detCond.cpi, connId: txt(i, 'ReceiverConnectivityId'), lookups,
        });
      }
    }
    return {
      id, party: extractor(kid(r, 'PartyExtractor')).value, service: svc.value,
      dynamic: svc.type !== 'KO' && svc.type !== '', qos: txt(rc, 'QualityOfService'),
      cond: rcCond.human, cpiCond: rcCond.cpi, interfaces,
    };
  });

  const params: Array<[string, string]> = kids(kid(kid(root, 'ScenarioConfiguration'), 'Parameters'), 'Parameter').map((p) => [txt(p, 'Name'), txt(p, 'Value')]);
  const conn: Record<string, Array<[string, string]>> = {};
  for (const c of kids(kid(root, 'ReceiverConnectivityList'), 'ReceiverConnectivity')) {
    conn[txt(c, 'ReceiverConnectivityId')] = kids(kid(kid(c, 'AllInOneAttributes'), 'AdapterTypeData'), 'Attribute')
      .map((a) => [txt(a, 'Name'), txt(a, 'Value')] as [string, string]).filter(([, v]) => v !== '' && v !== '0');
  }
  return { receivers, params, conn, virus: txt(kid(root, 'SenderConnectivity'), 'VirusScanMode'), koCount, xpCount, cpiRoutes };
}

const QOS: Record<string, string> = {
  EO: 'Exactly Once → CPI JMS Queue / Idempotent Process Call',
  EOIO: 'Exactly Once In Order → CPI JMS Exclusive Queue / Data Store',
  BE: 'Best Effort → Synchronous Request-Reply',
};

export const IcoFlow: React.FC<{ detail: TpzObjectDetail; controller: DualTpzController } & Omit<Ctx, 'archiveId'>> = ({ detail, controller, ...rest }) => {
  const ctx: Ctx = { ...rest, archiveId: detail.archiveId };
  const { s } = ctx;
  const [showBlueprint, setShowBlueprint] = useState(true);
  const model = useMemo(() => parseIco(detail.contentXml || '', s), [detail.id, s]); // eslint-disable-line
  const links = detail.links;
  const byRole = (role: string) => links.filter((l) => l.role === role);
  const sndCh = byRole('senderChannel')[0];
  const sndIf = byRole('outboundInterface')[0];
  const senderService = sndCh ? sndCh.elems[0] : detail.name.split(' → ')[0];
  const rcvCh = byRole('receiverChannel');
  const mapOf = (counter: string) => links.find((l) => l.role === `MAP${counter}`);
  const omList = links.filter((l) => /^MAP\d+$/.test(l.role)).map((l) => ({ name: l.targetName, ns: l.targetNamespace }));
  const omMaps = useOmMappings(ctx, controller, omList);

  if (!model) return <div className="pane muted">{s.noFlow}</div>;

  const sndChObj = sndCh ? findObject(ctx.all, 'Channel', sndCh.elems[1], sndCh.elems[0], ctx.archiveId) : undefined;
  const uniqueQos = Array.from(new Set(model.receivers.map((r) => r.qos).filter(Boolean)));
  const hasConditions = model.receivers.some((r) => r.cond || r.interfaces.some((i) => i.cond));
  const hasLookups = model.receivers.some((r) => r.interfaces.some((i) => i.lookups.length > 0));
  const hasDynamic = model.receivers.some((r) => r.dynamic);

  return (
    <div className="pane">
      <div className="flow">
        <div className="fcard">
          <div className="fhead"><GitBranch size={13} /><span>{s.sender}</span></div>
          <div className="fsteps">
            <div className="fstep">
              <Label>{s.component}</Label>
              <Ref ctx={ctx} typeId="Service" name={senderService} />
            </div>
            <Arrow />
            <div className="fstep">
              <Label>{s.channel}</Label>
              {sndCh ? <Ref ctx={ctx} typeId="Channel" name={sndCh.elems[1]} ns={sndCh.elems[0]} /> : <div className="ref muted">—</div>}
            </div>
            <Arrow />
            <div className="fstep">
              <Label>{s.iface}</Label>
              {sndIf ? <Ref ctx={ctx} typeId={sndIf.targetType} name={sndIf.targetName} ns={sndIf.targetNamespace} showNs /> : <div className="ref">{detail.name.split(' → ')[1] || '—'}<div className="muted small">{detail.namespace}</div></div>}
            </div>
          </div>
        </div>

        <div className="fdown" aria-hidden>↓ {model.receivers.length > 1 ? `${model.receivers.length} ${s.receiver.toLowerCase()}` : ''}</div>

        <div className="fstack">
          {model.receivers.map((r) => {
            const chans = rcvCh.filter((c) => c.elems[0] === r.service);
            return (
              <div className="fcard" key={r.id}>
                <div className="fhead">
                  <span>{s.receiver}</span>
                  <span className="fname">{r.dynamic ? `${s.dynamic}: ${r.service}` : <Ref ctx={ctx} typeId="Service" name={r.service} />}</span>
                  {r.party && <span className="muted small">{s.party}: {r.party}</span>}
                  {r.qos && <span className="pill" title={QOS[r.qos] || ''}>{r.qos}</span>}
                </div>
                {r.cond && <div className="fcond"><span className="flabel">{s.condition}</span><pre>{r.cond}</pre></div>}
                {r.interfaces.map((i, idx) => {
                  const om = mapOf(i.counter);
                  const ch = chans.length === r.interfaces.length ? [chans[idx]] : chans;
                  const mms = om ? omMaps[`${om.targetNamespace}|${om.targetName}`] : undefined;
                  const attrs = model.conn[i.connId] || [];
                  return (
                    <div className="fsteps" key={idx}>
                      <div className="fstep">
                        <Label>{s.opMapping}</Label>
                        {om ? <Ref ctx={ctx} typeId="MAPPING" name={om.targetName} ns={om.targetNamespace} /> : <div className="ref muted">{s.noMapping}</div>}
                        {mms && mms.length > 0 && (
                          <div className="fsub">
                            {mms.map((l, k) => (
                              <div key={k} className="fsubrow">
                                <span className="muted small">{l.role.startsWith('RESPONSE') ? s.response : l.role.startsWith('REQUEST') ? s.request : l.role.replace('_TRAFO', '')}{mms.filter((x) => x.role === l.role).length > 1 ? ` ${mms.filter((x) => x.role === l.role).indexOf(l) + 1}` : ''}</span>
                                <Ref ctx={ctx} typeId={l.targetType} name={l.targetName} ns={l.targetNamespace} />
                              </div>
                            ))}
                          </div>
                        )}
                        {i.lookups.length > 0 && <div className="muted small" style={{ marginTop: 6 }}>{s.lookupChannel}: {i.lookups.join(', ')}</div>}
                      </div>
                      <Arrow />
                      <div className="fstep">
                        <Label>{s.iface}</Label>
                        <Ref ctx={ctx} typeId="ifmmessif" name={i.name} ns={i.ns} showNs />
                        {i.cond && <div className="fcond inline"><span className="flabel">{s.condition}</span><pre>{i.cond}</pre></div>}
                      </div>
                      <Arrow />
                      <div className="fstep">
                        <Label>{s.channel}</Label>
                        {ch.length ? ch.map((c, k) => <Ref key={k} ctx={ctx} typeId="Channel" name={c.elems[1]} ns={c.elems[0]} />) : <div className="ref muted">—</div>}
                        {attrs.length > 0 && (
                          <details className="fdet"><summary>{s.connAttrs} ({attrs.length})</summary>
                            {attrs.map(([k, v]) => <div key={k} className="mono small">{k} = {v}</div>)}
                          </details>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {model.receivers.length === 0 && <div className="muted">{s.noFlow}</div>}
        </div>

        {/* CPI iFlow Blueprint Card */}
        <div className="fcard blueprint" style={{ marginTop: 22 }}>
          <div className="fhead" style={{ cursor: 'pointer' }} onClick={() => setShowBlueprint((v) => !v)}>
            <Cloud size={14} style={{ color: 'var(--accent)' }} />
            <span>{s.cpiIcoBlueprint}</span>
            <span className="pill">KO={model.koCount} · XP={model.xpCount}</span>
          </div>
          {showBlueprint && (
            <div className="bp-grid">
              <div className="bp-step">
                <div className="flabel">{s.cpiStepSender}</div>
                <div className="small"><strong>{sndChObj?.adapterType || 'Sender Adapter'}</strong> ({sndCh?.elems[1] || senderService})</div>
              </div>
              <div className="bp-step">
                <div className="flabel">{s.cpiStepModifier}</div>
                <div className="small">
                  {model.koCount > 0 ? `Content Modifier (${model.koCount} KO constant properties)` : 'Standard Headers'}
                  {model.xpCount > 0 ? ` + ${model.xpCount} XPath extractors` : ''}
                </div>
              </div>
              <div className="bp-step">
                <div className="flabel">{s.cpiStepRouter}</div>
                <div className="small">
                  {model.receivers.length > 1 || hasConditions
                    ? `CPI Router (${model.receivers.length} receiver branch${model.receivers.length > 1 ? 'es' : ''}${hasConditions ? ', XPath/Header conditions' : ''})`
                    : 'Direct Linear Route (1 Receiver)'}
                </div>
              </div>
              <div className="bp-step">
                <div className="flabel">{s.cpiStepMapping}</div>
                <div className="small">
                  {omList.length > 0 ? `${omList.length} Operation Mapping(s) → Import .mmap / XSLT / Groovy` : 'Pass-Through (No Mapping)'}
                </div>
              </div>
              <div className="bp-step">
                <div className="flabel">{s.cpiStepQos}</div>
                <div className="small">{uniqueQos.length ? uniqueQos.map((q) => QOS[q] || q).join(' | ') : 'Default Async/Sync'}</div>
              </div>
              <div className="bp-step">
                <div className="flabel">{s.cpiStepReceiver}</div>
                <div className="small">{rcvCh.length} Receiver Channel(s)</div>
              </div>
            </div>
          )}
          {showBlueprint && model.cpiRoutes.length > 0 && (
            <div style={{ padding: '0 14px 12px' }}>
              <div className="flabel" style={{ marginTop: 0 }}>CPI Router XPath Conditions ({model.cpiRoutes.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {model.cpiRoutes.map((rt, k) => (
                  <div key={k} className="trace-row mono small">
                    <span className="pill-stat">{rt.target}</span>
                    <span style={{ overflowWrap: 'anywhere' }}>{rt.expr}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {showBlueprint && (model.virus || hasLookups || hasDynamic) && (
            <div className="bp-warns">
              <AlertTriangle size={14} />
              <span>
                <strong>{s.cpiWarnings}:</strong>{' '}
                {[
                  model.virus && `VirusScanMode=${model.virus} (no direct CPI iFlow equivalent)`,
                  hasLookups && 'Mapping Lookup Channel detected → refactor to CPI Content Enricher / Request-Reply',
                  hasDynamic && 'Dynamic Receiver Determination → implement via CPI Router / Dynamic Endpoint Header',
                ].filter(Boolean).join(' · ')}
              </span>
            </div>
          )}
        </div>
      </div>

      {(model.params.length > 0 || model.virus) && (
        <>
          <div className="sect" style={{ marginTop: 26 }}>{s.settings}</div>
          <dl className="facts">
            {model.virus && (<><dt>{s.virusScan}</dt><dd>{model.virus}</dd></>)}
            {model.params.map(([k, v]) => (<React.Fragment key={k}><dt className="mono">{k}</dt><dd className="mono">{v}</dd></React.Fragment>))}
          </dl>
        </>
      )}
    </div>
  );
};

/* ---------- Operation Mapping ---------- */

export const OmFlow: React.FC<{ detail: TpzObjectDetail } & Omit<Ctx, 'archiveId'>> = ({ detail, ...rest }) => {
  const ctx: Ctx = { ...rest, archiveId: detail.archiveId };
  const { s } = ctx;
  const role = (r: string) => detail.links.filter((l) => l.role === r).sort((a, b) => Number(a.kpos) - Number(b.kpos));
  const src = role('OUTBOUND_IF')[0];
  const dst = role('INBOUND_IF')[0];
  const dirs = [
    { key: 'REQUEST', label: s.request, from: 'REQUEST_OUT_MES', to: 'REQUEST_IN_MES' },
    { key: 'RESPONSE', label: s.response, from: 'RESPONSE_IN_MES', to: 'RESPONSE_OUT_MES' },
    { key: 'FAULT', label: 'Fault', from: 'FAULT_IN_MES', to: 'FAULT_OUT_MES' },
  ].filter((d) => role(`${d.key}_TRAFO`).length > 0);
  const refs = (list: ObjectLink[]) => list.length ? list.map((l, i) => { const t = linkTarget(l); return <Ref key={i} ctx={ctx} typeId={l.targetType} name={t.name} ns={t.ns} showNs />; }) : <div className="ref muted">—</div>;

  return (
    <div className="pane">
      {(src || dst) && (
        <div className="fcard" style={{ maxWidth: 960 }}>
          <div className="fhead"><Layers size={13} /><span>{s.opMapping}</span></div>
          <div className="fsteps top" style={{ padding: '4px 14px 14px' }}>
            <div className="fstep"><Label>{s.srcIface}</Label>{refs(src ? [src] : [])}</div>
            <Arrow />
            <div className="fstep"><Label>{s.dstIface}</Label>{refs(dst ? [dst] : [])}</div>
          </div>
        </div>
      )}
      {dirs.map((d) => (
        <div className="fcard" key={d.key} style={{ marginTop: 14, maxWidth: 1120 }}>
          <div className="fhead">{d.label}</div>
          <div className="fsteps">
            <div className="fstep"><Label>{s.srcMessage}</Label>{refs(role(d.from))}</div>
            <Arrow />
            <div className="fstep">
              <Label>{s.mappingStep}</Label>
              {role(`${d.key}_TRAFO`).map((l, i, arr) => (
                <div key={i} className="fsubrow">
                  {arr.length > 1 && <span className="muted small">{i + 1}.</span>}
                  <Ref ctx={ctx} typeId={l.targetType} name={l.targetName} ns={l.targetNamespace} extra={l.targetType !== 'XI_TRAFO' ? getObjectTypeInfo(l.targetType, ctx.lang).label : ''} />
                </div>
              ))}
            </div>
            <Arrow />
            <div className="fstep"><Label>{s.dstMessage}</Label>{refs(role(d.to))}</div>
          </div>
        </div>
      ))}
      {dirs.length === 0 && <div className="muted">{s.noFlow}</div>}
    </div>
  );
};

/* ---------- Where used ---------- */

export const UsageTab: React.FC<{ detail: TpzObjectDetail; controller: DualTpzController } & Omit<Ctx, 'archiveId'>> = ({ detail, controller, all, s, lang, onOpen }) => {
  const u = useUsage(detail, all, controller);
  if (!u.done) return <div className="pane muted">{s.loading}</div>;
  if (u.list.length === 0) return <div className="pane muted">{s.notUsed}</div>;
  return (
    <div className="pane">
      <div className="tablewrap">
        <table className="table">
          <thead><tr><th style={{ width: 220 }}>{s.type}</th><th>{s.name}</th><th>{s.via}</th><th style={{ width: 200 }}>{s.file}</th></tr></thead>
          <tbody>
            {u.list.map((x) => {
              const info = getObjectTypeInfo(x.obj.typeId, lang);
              return (
                <tr key={x.obj.id} className="click" onClick={() => onOpen(x.obj.id)}>
                  <td>
                    <span className="tbadge" style={{ '--tc': info.color, marginRight: 7 } as React.CSSProperties}>{info.short}</span>
                    {info.label}
                  </td>
                  <td><button className="link" onClick={(e) => { e.stopPropagation(); onOpen(x.obj.id); }}>{x.obj.name}</button><div className="muted small">{x.obj.namespace}</div></td>
                  <td onClick={(e) => e.stopPropagation()}>{x.via ? <button className="link" onClick={() => onOpen(x.via!.id)}>{x.via.name}</button> : <span className="muted">—</span>}</td>
                  <td className="muted small">{x.obj.archiveName}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {u.capped && <div className="muted small" style={{ marginTop: 8 }}>{s.usageCapped}</div>}
    </div>
  );
};
