import { useEffect, useState } from 'react';
import type { DualTpzController } from '../core/engines';
import type { ObjectLink, TpzObjectDetail, TpzObjectSummary } from '../core/types';

/** Finds a loaded object by type + name (+ namespace), preferring the given archive. */
export function findObject(
  all: TpzObjectSummary[], typeId: string, name: string, ns: string | undefined, preferArchive?: string
): TpzObjectSummary | undefined {
  let best: TpzObjectSummary | undefined;
  for (const o of all) {
    if (o.typeId !== typeId || o.name !== name) continue;
    if (ns !== undefined && ns !== '') {
      const ons = o.namespace || '';
      const ok = typeId === 'Channel' ? ons === ns || ons.endsWith(`/ ${ns}`) : ons === ns;
      if (!ok) continue;
    }
    if (o.archiveId === preferArchive) return o;
    best = best || o;
  }
  return best;
}

/** Channel links carry [service, channelName]; everything else [name, namespace]. */
export function linkTarget(l: ObjectLink): { name: string; ns: string } {
  if (l.targetType === 'Channel' && l.elems.length >= 2) return { name: l.elems[l.elems.length - 1], ns: l.elems[l.elems.length - 2] };
  return { name: l.targetName, ns: l.targetNamespace };
}

export function resolveLink(all: TpzObjectSummary[], l: ObjectLink, preferArchive?: string) {
  const t = linkTarget(l);
  return findObject(all, l.targetType, t.name, t.ns, preferArchive);
}

/* ---------- details cache + "where used" index ---------- */

const detailCache = new Map<string, Promise<TpzObjectDetail>>();
export function clearDetailCache() {
  detailCache.clear();
}
export function cachedDetail(controller: DualTpzController, id: string): Promise<TpzObjectDetail> {
  let p = detailCache.get(id);
  if (!p) {
    p = controller.getObjectDetail(id);
    p.catch(() => detailCache.delete(id));
    detailCache.set(id, p);
  }
  return p;
}

const REFERRERS = new Set(['MAPPING', 'AllInOne', 'MappingRelation', 'OutboundBinding', 'InboundBinding', 'RoutingRelation']);
const MAX_REFERRERS = 800;

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

function pointsTo(l: ObjectLink, o: TpzObjectSummary): boolean {
  if (l.targetType !== o.typeId) return false;
  if (l.targetOid && l.targetOid === o.oid) return true;
  const t = linkTarget(l);
  if (t.name !== o.name) return false;
  const ons = o.namespace || '';
  return o.typeId === 'Channel' ? ons === t.ns || ons.endsWith(`/ ${t.ns}`) : !t.ns || ons === t.ns;
}

export interface Usage { obj: TpzObjectSummary; role: string; via?: TpzObjectSummary }

/** Which loaded Operation Mappings / ICOs use this object (ICOs also through an Operation Mapping). */
export function useUsage(detail: TpzObjectSummary, all: TpzObjectSummary[], controller: DualTpzController) {
  const [state, setState] = useState<{ list: Usage[]; done: boolean; capped: boolean }>({ list: [], done: false, capped: false });
  useEffect(() => {
    let live = true;
    setState({ list: [], done: false, capped: false });
    const refs = all.filter((o) => REFERRERS.has(o.typeId) && o.id !== detail.id);
    const capped = refs.length > MAX_REFERRERS;
    const take = refs.slice(0, MAX_REFERRERS);
    (async () => {
      const details = await pool(take, 6, (o) => cachedDetail(controller, o.id).catch(() => null));
      if (!live) return;
      const list: Usage[] = [];
      const direct: TpzObjectSummary[] = [];
      details.forEach((d, i) => {
        if (!d) return;
        const hit = d.links.find((l) => pointsTo(l, detail));
        if (hit) { list.push({ obj: take[i], role: hit.role }); if (take[i].typeId === 'MAPPING') direct.push(take[i]); }
      });
      // second hop: configuration objects that use an Operation Mapping which uses this object
      if (direct.length) {
        details.forEach((d, i) => {
          if (!d || take[i].typeId === 'MAPPING' || list.some((u) => u.obj.id === take[i].id)) return;
          for (const om of direct) {
            const hit = d.links.find((l) => pointsTo(l, om));
            if (hit) { list.push({ obj: take[i], role: hit.role, via: om }); break; }
          }
        });
      }
      setState({ list, done: true, capped });
    })();
    return () => { live = false; };
  }, [detail.id, all.length]); // eslint-disable-line
  return state;
}
