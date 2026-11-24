import React, { useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import { Code2, Copy, Check, Maximize2, Minimize2, ArrowRightCircle, Sliders, Hash, Sparkles, Crosshair } from 'lucide-react';
import type { MappingGraphNode, MappingPayload } from '../core/types';
import { normSeg } from './structure';
import type { Strings } from './strings';

interface MNodeData extends Record<string, unknown> {
  raw: MappingGraphNode;
  title: string;
  sub: string;
  paramSummary: string;
}

const KIND_ICON: Record<MappingGraphNode['kind'], React.ReactNode> = {
  source: <ArrowRightCircle size={13} />,
  func: <Sliders size={13} />,
  udf: <Code2 size={13} />,
  const: <Hash size={13} />,
  target: <Crosshair size={13} />,
};

const MappingNodeCard: React.FC<NodeProps<Node<MNodeData>>> = ({ data, selected }) => {
  const kind = data.raw.kind;
  return (
    <div className={`rf-card rf-${kind} ${selected ? 'rf-sel' : ''}`}>
      {kind !== 'source' && kind !== 'const' && (
        <Handle type="target" position={Position.Left} className="rf-handle" />
      )}
      <div className="rf-card-top">
        <span className="rf-icon">{KIND_ICON[kind]}</span>
        <span className="rf-title" title={data.raw.path || data.raw.label}>{data.title}</span>
      </div>
      {(data.sub || data.paramSummary) && (
        <div className="rf-sub" title={data.sub || data.paramSummary}>
          {data.paramSummary || data.sub}
        </div>
      )}
      {kind !== 'target' && (
        <Handle type="source" position={Position.Right} className="rf-handle" />
      )}
    </div>
  );
};

const nodeTypes = { mapNode: MappingNodeCard };

function layoutDagre(nodes: Node<MNodeData>[], edges: Edge[]): { nodes: Node<MNodeData>[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 72, marginx: 24, marginy: 24 });

  for (const n of nodes) {
    const hasSub = Boolean(n.data.sub || n.data.paramSummary);
    const width = Math.min(240, Math.max(150, n.data.title.length * 8 + 42));
    const height = hasSub ? 52 : 38;
    g.setNode(n.id, { width, height });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }
  dagre.layout(g);

  return {
    nodes: nodes.map((n) => {
      const pos = g.node(n.id);
      const w = pos?.width || 180;
      const h = pos?.height || 44;
      return {
        ...n,
        initialWidth: w,
        initialHeight: h,
        position: {
          x: (pos?.x || 0) - w / 2,
          y: (pos?.y || 0) - h / 2,
        },
      };
    }),
    edges,
  };
}

const FitHelper: React.FC<{ triggerKey: string }> = ({ triggerKey }) => {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const t = setTimeout(() => { fitView({ padding: 0.16, duration: 220 }); }, 40);
    return () => clearTimeout(t);
  }, [triggerKey, fitView]);
  return null;
};

interface CanvasProps {
  mapping: MappingPayload;
  s: Strings;
  selectedTarget: string | null; // null = Overview mode
  onSelectTarget?: (target: string | null) => void;
  onOpenUdf: (udfKey: string) => void;
  onLocateSource?: (sourcePath: string) => void;
  compact?: boolean;
}

const InnerCanvas: React.FC<CanvasProps> = ({
  mapping, s, selectedTarget, onSelectTarget, onOpenUdf, onLocateSource, compact = false,
}) => {
  const [picked, setPicked] = useState<MappingGraphNode | null>(null);
  const [full, setFull] = useState(false);
  const [copied, setCopied] = useState(false);

  const targets = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const fm of mapping.fieldMappings) {
      if (fm.expression && fm.expression !== '(empty)' && !seen.has(fm.targetPath)) {
        seen.add(fm.targetPath);
        list.push(fm.targetPath);
      }
    }
    return list;
  }, [mapping]);

  const activeGroups = useMemo(() => {
    if (selectedTarget) return new Set([selectedTarget]);
    return new Set(targets.slice(0, 18));
  }, [selectedTarget, targets]);

  const { nodes, edges } = useMemo(() => {
    const filteredNodes = mapping.graphNodes.filter((n) => activeGroups.has(n.targetGroup));
    const allowed = new Set(filteredNodes.map((n) => n.id));
    const rfNodes: Node<MNodeData>[] = filteredNodes.map((n) => {
      const title = n.kind === 'source' || n.kind === 'target'
        ? normSeg((n.path || n.label).split('/').pop() || n.label)
        : n.label;
      const paramSummary = n.parameters
        ? Object.entries(n.parameters).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(', ')
        : '';
      const sub = n.kind === 'source' || n.kind === 'target'
        ? (n.path || '').split('/').slice(-3, -1).map(normSeg).join('/')
        : n.kind === 'udf'
          ? 'Java UDF'
          : n.kind === 'const'
            ? s.kConst
            : (n.namespace && n.namespace !== 'dflt' ? n.namespace : '');
      return {
        id: n.id,
        type: 'mapNode',
        position: { x: 0, y: 0 },
        data: { raw: n, title, sub, paramSummary },
      };
    });

    const rfEdges: Edge[] = mapping.graphEdges
      .filter((e) => allowed.has(e.source) && allowed.has(e.target))
      .map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label && e.label !== 'in' ? e.label : undefined,
        type: 'smoothstep',
        animated: Boolean(selectedTarget),
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
        style: { strokeWidth: 1.5 },
        labelStyle: { fontSize: 10.5, fontFamily: 'var(--mono)' },
      }));

    return layoutDagre(rfNodes, rfEdges);
  }, [mapping, activeGroups, selectedTarget, s.kConst]);

  useEffect(() => { setPicked(null); }, [selectedTarget]);

  const pickedUdf = useMemo(() => {
    if (!picked || picked.kind !== 'udf') return null;
    const key = (picked.udfKey || picked.label || '').toLowerCase();
    return mapping.udfs.find((u) => u.key.toLowerCase() === key || u.name.toLowerCase() === key) || null;
  }, [picked, mapping.udfs]);

  const activeRule = useMemo(() => {
    if (!selectedTarget) return null;
    return mapping.fieldMappings.find((f) => f.targetPath === selectedTarget) || null;
  }, [mapping.fieldMappings, selectedTarget]);

  const triggerKey = `${selectedTarget || 'ALL'}|${nodes.length}|${full ? 1 : 0}`;

  return (
    <div className={`rf-shell ${full ? 'rf-fullscreen' : ''} ${compact ? 'rf-compact' : ''}`}>
      <div className="rf-toolbar">
        {onSelectTarget && (
          <select
            className="select rf-target-sel"
            value={selectedTarget || ''}
            onChange={(e) => onSelectTarget(e.target.value || null)}
          >
            <option value="">{s.allTargetsGraph} ({targets.length})</option>
            {targets.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        )}
        <div className="rf-legend">
          <span className="rf-chip c-source">{s.kSource}</span>
          <span className="rf-chip c-func">{s.kFunc}</span>
          <span className="rf-chip c-udf"><Sparkles size={11} /> {s.kUdf}</span>
          <span className="rf-chip c-const">{s.kConst}</span>
          <span className="rf-chip c-target">{s.kTarget}</span>
        </div>
        <span className="spacer" />
        {activeRule && (
          <button
            className="btn sm line"
            onClick={() => navigator.clipboard?.writeText(activeRule.expression).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            <span>{copied ? s.copied : s.copy}</span>
          </button>
        )}
        <button className="btn sm line" onClick={() => setFull((v) => !v)} title={full ? s.exitFullscreen : s.fullscreen}>
          {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          <span>{full ? s.exitFullscreen : s.fullscreen}</span>
        </button>
      </div>

      <div className="rf-body">
        <div className="rf-canvas">
          {nodes.length === 0 ? (
            <div className="empty-note">{s.noRule}</div>
          ) : (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodeClick={(_e, node) => setPicked((node.data as MNodeData).raw)}
              onPaneClick={() => setPicked(null)}
              minZoom={0.2}
              maxZoom={2.2}
              fitView
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls showInteractive={false} />
              {!compact && (
                <MiniMap
                  pannable
                  zoomable
                  nodeStrokeWidth={2}
                  maskColor="rgba(128, 138, 152, 0.14)"
                  nodeColor={(n) => {
                    const k = (n.data as MNodeData | undefined)?.raw?.kind;
                    if (k === 'udf') return '#8b5cf6';
                    if (k === 'const') return '#22c55e';
                    if (k === 'target') return '#3b82f6';
                    if (k === 'func') return '#0ea5e9';
                    return '#64748b';
                  }}
                />
              )}
              <FitHelper triggerKey={triggerKey} />
            </ReactFlow>
          )}
        </div>

        {!compact && (
          <aside className={`rf-inspector ${picked ? 'has-pick' : ''}`}>
            <div className="rf-insp-head">{s.nodeInspector}</div>
            {!picked ? (
              <div className="muted small" style={{ padding: 14 }}>{s.nodeInspectHint}</div>
            ) : (
              <div className="rf-insp-body">
                <div className="rf-insp-kind">
                  <span className={`rf-chip c-${picked.kind}`}>{picked.kind.toUpperCase()}</span>
                </div>
                <div className="rf-insp-title">{picked.label}</div>
                {picked.path && (
                  <div className="rf-insp-block">
                    <div className="flabel">XPath</div>
                    <div className="mono small" style={{ overflowWrap: 'anywhere' }}>{picked.path}</div>
                    {picked.kind === 'source' && onLocateSource && (
                      <button className="btn sm line" style={{ marginTop: 8 }} onClick={() => onLocateSource(picked.path!)}>
                        {s.jumpToSource}
                      </button>
                    )}
                  </div>
                )}
                {picked.value !== undefined && (
                  <div className="rf-insp-block">
                    <div className="flabel">{s.value}</div>
                    <div className="mono small">{picked.value || '(empty)'}</div>
                  </div>
                )}
                {picked.namespace && picked.namespace !== 'dflt' && (
                  <div className="rf-insp-block">
                    <div className="flabel">{s.namespace}</div>
                    <div className="mono small">{picked.namespace}</div>
                  </div>
                )}
                {picked.parameters && Object.keys(picked.parameters).length > 0 && (
                  <div className="rf-insp-block">
                    <div className="flabel">{s.tabParams}</div>
                    <dl className="rf-kv">
                      {Object.entries(picked.parameters).map(([k, v]) => (
                        <React.Fragment key={k}>
                          <dt className="mono small">{k}</dt>
                          <dd className="mono small">{v || '—'}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  </div>
                )}
                {picked.kind === 'udf' && (
                  <div className="rf-insp-block">
                    <button className="btn sm primary" onClick={() => onOpenUdf(picked.udfKey || picked.label)}>
                      <Code2 size={13} /><span>{s.openInUdfLab}</span>
                    </button>
                    {pickedUdf?.javaCode && (
                      <pre className="code rf-mini-code">{pickedUdf.javaCode.slice(0, 1200)}</pre>
                    )}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
};

export const MappingGraphCanvas: React.FC<CanvasProps> = (props) => (
  <ReactFlowProvider>
    <InnerCanvas {...props} />
  </ReactFlowProvider>
);
