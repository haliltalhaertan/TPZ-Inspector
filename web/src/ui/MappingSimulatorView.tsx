import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Cpu,
  Download,
  FileCode2,
  ListChecks,
  Play,
  Sparkles,
  Terminal,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  generateSampleSourceXml,
  RESULT_CC,
  RESULT_SUPPRESS,
  RESULT_XSI_NIL,
} from '../core/browserMappingSimulator';
import type { DualTpzController } from '../core/engines';
import type { MappingPayload, SimulationResult, TpzObjectDetail } from '../core/types';
import { CodeViewer, downloadTextFile } from './CodeViewer';
import type { SNode } from './structure';
import type { Strings } from './strings';

const QueueStrip: React.FC<{ queue: string[] }> = ({ queue }) => (
  <div className="qstrip">
    {queue.map((item, idx) => {
      if (item === RESULT_CC) {
        return <span key={idx} className="qtok q-cc" title="ResultList.CC (__cC_)">── Context Change ──</span>;
      }
      if (item === RESULT_SUPPRESS) {
        return <span key={idx} className="qtok q-sup" title="ResultList.SUPPRESS (_sUpPresSeD_)">SUPPRESS</span>;
      }
      if (item === RESULT_XSI_NIL) {
        return <span key={idx} className="qtok q-nil" title="ResultList.XSI_NIL (_!xSi#NiL$_)">xsi:nil</span>;
      }
      return (
        <span key={idx} className="qtok q-val" title={item}>
          {item === '' ? <em className="muted">(empty)</em> : item}
        </span>
      );
    })}
  </div>
);

export const MappingSimulatorView: React.FC<{
  detail: TpzObjectDetail;
  mapping: MappingPayload;
  srcSchema: SNode | null;
  controller: DualTpzController;
  s: Strings;
}> = ({ detail, mapping, srcSchema, controller, s }) => {
  const [sourceXml, setSourceXml] = useState('');
  const [runJava, setRunJava] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [outTab, setOutTab] = useState<'xml' | 'queue' | 'udf'>('xml');
  const [queueSearch, setQueueSearch] = useState('');
  const [expandedTarget, setExpandedTarget] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-generate initial sample XML when mapping or source schema loads
  useEffect(() => {
    setSourceXml(generateSampleSourceXml(srcSchema, mapping));
    setResult(null);
    setErr(null);
  }, [detail.id, Boolean(srcSchema)]); // eslint-disable-line

  const runSimulation = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await controller.simulateMapping(detail.id, mapping, sourceXml, runJava);
      setResult(res);
      if (!res.ok && res.error) setErr(res.error);
      if (res.ok && res.targetQueues.length > 0 && !expandedTarget) {
        setExpandedTarget(res.targetQueues[0].targetPath);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const filteredQueues = useMemo(() => {
    if (!result) return [];
    const q = queueSearch.trim().toLowerCase();
    return result.targetQueues.filter(
      (tq) => !q || tq.targetPath.toLowerCase().includes(q) || tq.expression.toLowerCase().includes(q) || tq.queue.some((v) => v.toLowerCase().includes(q))
    );
  }, [result, queueSearch]);

  const isLocal = controller.getMode() === 'local';

  return (
    <div className="sim-wrap">
      {/* Simulator Toolbar */}
      <div className="sim-bar">
        <button className="btn primary" disabled={busy || !sourceXml.trim()} onClick={runSimulation}>
          <Play size={14} /><span>{busy ? s.working : s.simRun}</span>
        </button>
        <button className="btn line" onClick={() => setSourceXml(generateSampleSourceXml(srcSchema, mapping))}>
          <Sparkles size={13} /><span>{s.simGenSample}</span>
        </button>
        <button className="btn line" onClick={() => fileRef.current?.click()}>
          <Upload size={13} /><span>{s.simUploadXml}</span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xml,.txt"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setSourceXml(await f.text());
            e.target.value = '';
          }}
        />
        {isLocal && mapping.udfs.length > 0 && (
          <label className="check">
            <input type="checkbox" checked={runJava} onChange={(e) => setRunJava(e.target.checked)} />
            <span>{s.simExecJava} ({mapping.udfs.length} UDF)</span>
          </label>
        )}
        <span className="spacer" />
        {result && result.ok && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className={`crc-pill sm ${result.engine === 'local-java-udf' ? 'ok' : ''}`}>
              <Cpu size={12} />
              <span>{result.engine === 'local-java-udf' ? 'JVM UDF + Queue' : result.engine} · {result.durationMs} ms</span>
            </span>
            <button
              className="btn sm line"
              onClick={() => downloadTextFile(`${detail.name}_target.xml`, result.targetXml, 'application/xml')}
            >
              <Download size={12} /><span>{s.simDownloadOut}</span>
            </button>
          </div>
        )}
      </div>

      {err && <div className="alert-box err" style={{ margin: '10px 20px 0' }}>{err}</div>}

      {/* Split Source Editor | Output & Display Queue */}
      <div className="sim-split">
        <div className="sim-pane">
          <div className="shead">
            <FileCode2 size={14} />
            <strong>{s.simSourceXml}</strong>
            <span className="scount muted small mono">{sourceXml.split(/\r?\n/).length} L</span>
          </div>
          <textarea
            className="sim-editor"
            spellCheck={false}
            value={sourceXml}
            onChange={(e) => setSourceXml(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                runSimulation();
              }
            }}
          />
        </div>

        <div className="sim-pane">
          <div className="shead">
            <div className="seg">
              <button className={outTab === 'xml' ? 'on' : ''} onClick={() => setOutTab('xml')}>
                <FileCode2 size={12} /><span>{s.simTargetXml}</span>
              </button>
              <button className={outTab === 'queue' ? 'on' : ''} onClick={() => setOutTab('queue')}>
                <ListChecks size={12} /><span>Display Queue ({result?.targetQueues.length || 0})</span>
              </button>
              <button className={outTab === 'udf' ? 'on' : ''} onClick={() => setOutTab('udf')}>
                <Terminal size={12} /><span>UDF & Trace ({(result?.udfExecutions.length || 0) + (result?.traces.length || 0)})</span>
              </button>
            </div>
            <span className="scount muted small">ResultList: SUPPRESS · CC · xsi:nil</span>
          </div>

          <div className="sim-outbody">
            {!result ? (
              <div className="sim-empty">
                <Play size={26} style={{ opacity: 0.45 }} />
                <strong>{s.simEmptyTitle}</strong>
                <span className="muted small">{s.simEmptyHint}</span>
              </div>
            ) : outTab === 'xml' ? (
              <div style={{ padding: 10 }}>
                <CodeViewer text={result.targetXml} lang="xml" s={s} fileName={`${detail.name}_output.xml`} />
              </div>
            ) : outTab === 'queue' ? (
              <div style={{ padding: 12 }}>
                <div className="tools" style={{ marginBottom: 10 }}>
                  <input className="input" placeholder={s.filterFields} value={queueSearch} onChange={(e) => setQueueSearch(e.target.value)} />
                  <div className="qlegend small muted">
                    <span className="qtok q-val">val</span>
                    <span className="qtok q-cc">CC</span>
                    <span className="qtok q-sup">SUPPRESS</span>
                    <span className="qtok q-nil">xsi:nil</span>
                  </div>
                </div>
                <div className="qlist">
                  {filteredQueues.map((tq) => {
                    const isOpen = expandedTarget === tq.targetPath;
                    return (
                      <div className="qcard" key={tq.targetPath}>
                        <div className="qcard-head" onClick={() => setExpandedTarget(isOpen ? null : tq.targetPath)}>
                          <strong className="mono small">{tq.targetPath}</strong>
                          <div style={{ display: 'inline-flex', gap: 5, marginLeft: 'auto', flexShrink: 0 }}>
                            {tq.udfsExecuted.map((u) => (
                              <span key={u} className="rk-badge rk-udf"><Code2 size={10} style={{ marginRight: 2 }} />{u}</span>
                            ))}
                            <span className="pill-stat">{tq.nonSuppressedCount} val · {tq.contextCount} ctx</span>
                          </div>
                        </div>
                        <div className="qcard-body">
                          <QueueStrip queue={tq.queue} />
                          {isOpen && tq.stepQueues.length > 0 && (
                            <div className="qsteps">
                              <div className="flabel" style={{ marginTop: 6 }}>{s.simStepQueues}</div>
                              {tq.stepQueues.map((st, k) => (
                                <div className="qstep-row" key={st.nodeId + k}>
                                  <span className={`rk-badge rk-${st.kind === 'source' ? 'direct' : st.kind === 'udf' ? 'udf' : st.kind === 'const' ? 'const' : 'func'}`}>
                                    {st.kind.toUpperCase()}
                                  </span>
                                  <span className="mono small qstep-lbl" title={st.path || st.label}>{st.label}</span>
                                  <QueueStrip queue={st.queue} />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ padding: 14 }}>
                <div className="sect" style={{ marginTop: 0 }}>{s.simUdfRuns} ({result.udfExecutions.length})</div>
                {result.udfExecutions.length === 0 ? (
                  <div className="muted small">{s.noMatch}</div>
                ) : (
                  <div className="tablewrap" style={{ marginBottom: 16 }}>
                    <table className="table">
                      <thead><tr><th>UDF</th><th>Cache</th><th>Status</th><th className="num">Calls</th><th>Runtime</th></tr></thead>
                      <tbody>
                        {result.udfExecutions.map((u, i) => (
                          <React.Fragment key={u.name + i}>
                            <tr>
                              <td className="mono small" style={{ fontWeight: 600 }}>{u.name}</td>
                              <td className="small">{u.cacheType}</td>
                              <td>
                                {u.status === 'ok' ? (
                                  <span className="txt-ok"><CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> OK</span>
                                ) : u.status === 'skipped' ? (
                                  <span className="muted small">Skipped</span>
                                ) : (
                                  <span style={{ color: 'var(--bad)' }}><XCircle size={13} style={{ verticalAlign: -2 }} /> {u.status}</span>
                                )}
                              </td>
                              <td className="num">{u.calls}</td>
                              <td className="mono small muted">{u.compiledWith}</td>
                            </tr>
                            {u.error && (
                              <tr><td colSpan={5} style={{ background: 'var(--bad-soft)', color: 'var(--bad)' }} className="mono small">{u.error}</td></tr>
                            )}
                          </React.Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div className="sect">MappingTrace ({result.traces.length})</div>
                {result.traces.length === 0 ? (
                  <div className="muted small">—</div>
                ) : (
                  <div className="trace-list">
                    {result.traces.map((t, i) => (
                      <div key={i} className="trace-row mono small">
                        <span className="pill-stat">{t.level}</span>
                        <strong>{t.source}:</strong>
                        <span>{t.message}</span>
                      </div>
                    ))}
                  </div>
                )}

                {result.warnings.length > 0 && (
                  <>
                    <div className="sect">{s.cpiWarnings} ({result.warnings.length})</div>
                    {result.warnings.map((w, i) => (
                      <div key={i} className="alert-box warn"><AlertTriangle size={14} /><span>{w}</span></div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
