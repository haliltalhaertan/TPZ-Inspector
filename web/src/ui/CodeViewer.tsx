import React, { useMemo, useState } from 'react';
import { Check, Copy, Download, Search, WrapText, Hash, Minimize2 } from 'lucide-react';
import type { Strings } from './strings';

export type CodeLang = 'xml' | 'java' | 'groovy' | 'javap' | 'plain';

const MAX_RENDER = 260_000;
const MAX_HIGHLIGHT = 90_000;

export function downloadTextFile(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Collapse long base64 payloads inside SAP XML tags like <content>...</content> or <trf:data> */
function collapseBase64Blobs(xml: string): { text: string; count: number } {
  let count = 0;
  const text = xml.replace(/>([A-Za-z0-9+/=\r\n]{240,})</g, (match, body: string) => {
    const clean = body.replace(/\s+/g, '');
    if (clean.length < 240 || !/^[A-Za-z0-9+/=]+$/.test(clean)) return match;
    count++;
    const kb = (clean.length * 0.75 / 1024).toFixed(1);
    return `>[BASE64_BLOB: ${clean.length.toLocaleString()} chars (~${kb} KB) — ${clean.slice(0, 32)}…]<`;
  });
  return { text, count };
}

const JAVA_KW = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const',
  'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float',
  'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new',
  'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super',
  'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while',
  'def', 'as', 'in', 'true', 'false', 'null', 'String', 'Object', 'List', 'Map', 'Set', 'ArrayList',
  'HashMap', 'ResultList', 'Container', 'GlobalContainer', 'MappingTrace', 'MappingContext', 'Exception',
]);

function highlightLine(line: string, lang: CodeLang): React.ReactNode {
  if (lang === 'plain' || !line) return line || '\u00A0';

  if (lang === 'xml') {
    const parts: React.ReactNode[] = [];
    const re = /(<!--[\s\S]*?-->)|(<!\[CDATA\[[\s\S]*?\]\]>)|(<\/?[\w:.-]+)|(\/?>)|([\w:.-]+=)("[^"]*"|'[^']*')|(\[BASE64_BLOB:[^\]]+\])/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[1]) parts.push(<span key={m.index} className="hl-com">{m[1]}</span>);
      else if (m[2]) parts.push(<span key={m.index} className="hl-str">{m[2]}</span>);
      else if (m[3] || m[4]) parts.push(<span key={m.index} className="hl-tag">{m[3] || m[4]}</span>);
      else if (m[5]) {
        parts.push(<span key={m.index} className="hl-attr">{m[5]}</span>);
        parts.push(<span key={m.index + 0.5} className="hl-str">{m[6]}</span>);
      } else if (m[7]) parts.push(<span key={m.index} className="hl-blob">{m[7]}</span>);
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts;
  }

  if (lang === 'java' || lang === 'groovy') {
    const parts: React.ReactNode[] = [];
    const re = /(\/\/.*$)|(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(@[A-Za-z_]\w*)|(\b[A-Za-z_]\w*\b)|(\b\d+(?:\.\d+)?\b)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[1] || m[2]) parts.push(<span key={m.index} className="hl-com">{m[0]}</span>);
      else if (m[3]) parts.push(<span key={m.index} className="hl-str">{m[0]}</span>);
      else if (m[4]) parts.push(<span key={m.index} className="hl-ann">{m[0]}</span>);
      else if (m[5]) {
        if (JAVA_KW.has(m[5])) parts.push(<span key={m.index} className="hl-kw">{m[5]}</span>);
        else parts.push(m[5]);
      } else if (m[6]) parts.push(<span key={m.index} className="hl-num">{m[6]}</span>);
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts;
  }

  if (lang === 'javap') {
    const parts: React.ReactNode[] = [];
    const re = /(\/\/.*$)|(\b(?:invokevirtual|invokespecial|invokestatic|invokeinterface|getfield|putfield|getstatic|putstatic|aload_\d|astore_\d|iload_\d|istore_\d|ldc|ldc_w|new|dup|return|areturn|ireturn|ifnull|ifnonnull|ifeq|ifne|goto|checkcast|athrow)\b)|(\b\d+:\s)|(\b(?:public|private|protected|static|final|class|extends|implements|Code|LineNumberTable|LocalVariableTable|Exception table)\b)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (m[1]) parts.push(<span key={m.index} className="hl-com">{m[1]}</span>);
      else if (m[2]) parts.push(<span key={m.index} className="hl-tag">{m[2]}</span>);
      else if (m[3]) parts.push(<span key={m.index} className="hl-num">{m[3]}</span>);
      else if (m[4]) parts.push(<span key={m.index} className="hl-kw">{m[4]}</span>);
      last = m.index + m[0].length;
    }
    if (last < line.length) parts.push(line.slice(last));
    return parts;
  }

  return line;
}

export const CodeViewer: React.FC<{
  text: string;
  lang?: CodeLang;
  s: Strings;
  fileName?: string;
  defaultCollapseBase64?: boolean;
  maxHeight?: number | string;
}> = ({ text, lang = 'plain', s, fileName, defaultCollapseBase64 = false, maxHeight }) => {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [showLines, setShowLines] = useState(true);
  const [collapseB64, setCollapseB64] = useState(defaultCollapseBase64 && lang === 'xml');
  const [find, setFind] = useState('');

  const { display, blobCount, truncated } = useMemo(() => {
    let base = text || '';
    let count = 0;
    if (collapseB64 && lang === 'xml') {
      const c = collapseBase64Blobs(base);
      base = c.text;
      count = c.count;
    }
    const truncated = base.length > MAX_RENDER;
    return { display: truncated ? base.slice(0, MAX_RENDER) : base, blobCount: count, truncated };
  }, [text, collapseB64, lang]);

  const lines = useMemo(() => display.split(/\r?\n/), [display]);
  const needle = find.trim().toLowerCase();
  const matchSet = useMemo(() => {
    if (!needle) return null;
    const set = new Set<number>();
    lines.forEach((l, i) => { if (l.toLowerCase().includes(needle)) set.add(i); });
    return set;
  }, [lines, needle]);

  const doHighlight = display.length <= MAX_HIGHLIGHT;

  return (
    <div className="cv">
      <div className="cv-bar">
        <div className="cv-search">
          <Search size={13} />
          <input
            className="cv-input"
            placeholder={s.findInCode}
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
          {matchSet && <span className="cv-hits">{matchSet.size}</span>}
        </div>
        <span className="cv-meta muted small">{lines.length.toLocaleString()} L · {(text.length / 1024).toFixed(1)} KB</span>
        {lang === 'xml' && (
          <button
            className={`btn sm ${collapseB64 ? 'on' : ''}`}
            title={s.collapseBase64}
            onClick={() => setCollapseB64((v) => !v)}
          >
            <Minimize2 size={13} />
            <span>{s.collapseBase64}{blobCount > 0 ? ` (${blobCount})` : ''}</span>
          </button>
        )}
        <button className={`btn sm ${showLines ? 'on' : ''}`} title={s.lineNumbers} onClick={() => setShowLines((v) => !v)}>
          <Hash size={13} />
        </button>
        <button className={`btn sm ${wrap ? 'on' : ''}`} title={s.wrapLines} onClick={() => setWrap((v) => !v)}>
          <WrapText size={13} />
        </button>
        {fileName && (
          <button className="btn sm line" onClick={() => downloadTextFile(fileName, text)}>
            <Download size={13} /><span>{s.download}</span>
          </button>
        )}
        <button
          className="btn sm line"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{copied ? s.copied : s.copy}</span>
        </button>
      </div>
      {truncated && <div className="cv-warn small">{s.truncated}</div>}
      <div className={`cv-body ${wrap ? 'wrap' : ''}`} style={maxHeight ? { maxHeight } : undefined}>
        <pre className="cv-pre">
          {doHighlight ? (
            lines.map((line, i) => {
              const hit = matchSet?.has(i);
              return (
                <div key={i} className={`cv-line ${hit ? 'hit' : ''}`}>
                  {showLines && <span className="cv-ln">{i + 1}</span>}
                  <span className="cv-txt">{highlightLine(line, lang)}</span>
                </div>
              );
            })
          ) : (
            lines.map((line, i) => (
              <div key={i} className={`cv-line ${matchSet?.has(i) ? 'hit' : ''}`}>
                {showLines && <span className="cv-ln">{i + 1}</span>}
                <span className="cv-txt">{line || '\u00A0'}</span>
              </div>
            ))
          )}
        </pre>
      </div>
    </div>
  );
};
