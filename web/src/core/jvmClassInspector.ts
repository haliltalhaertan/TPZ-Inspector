import type { JvmClassSummary } from './types';

/**
 * Pure-TypeScript JVM .class (0xCAFEBABE) Constant Pool & Member Signature Inspector.
 * Works 100% offline inside the browser when Local CFR/javap backend is not connected.
 */
export function inspectJvmClassBytes(bytes: Uint8Array): JvmClassSummary | undefined {
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0xcafebabe) return undefined;

  const minor = view.getUint16(4, false);
  const major = view.getUint16(6, false);
  const javaVersion = major >= 45 ? `Java ${major - 44} (bytecode ${major}.${minor})` : `${major}.${minor}`;

  const cpCount = view.getUint16(8, false);
  const utf8Pool = new Map<number, string>();
  const classNameIndex = new Map<number, number>();
  const stringIndex = new Map<number, number>();
  const decoder = new TextDecoder('utf-8', { fatal: false });

  let pos = 10;
  try {
    for (let idx = 1; idx < cpCount; idx++) {
      if (pos >= bytes.length) break;
      const tag = view.getUint8(pos);
      pos += 1;
      switch (tag) {
        case 1: { // CONSTANT_Utf8
          const len = view.getUint16(pos, false);
          pos += 2;
          utf8Pool.set(idx, decoder.decode(bytes.subarray(pos, pos + len)));
          pos += len;
          break;
        }
        case 7: { // CONSTANT_Class
          classNameIndex.set(idx, view.getUint16(pos, false));
          pos += 2;
          break;
        }
        case 8: { // CONSTANT_String
          stringIndex.set(idx, view.getUint16(pos, false));
          pos += 2;
          break;
        }
        case 3:
        case 4:
        case 9:
        case 10:
        case 11:
        case 12:
        case 17:
        case 18:
          pos += 4;
          break;
        case 5: // Long
        case 6: // Double
          pos += 8;
          idx += 1; // takes two slots in constant pool
          break;
        case 15: // MethodHandle
          pos += 3;
          break;
        case 16:
        case 19:
        case 20:
          pos += 2;
          break;
        default:
          return undefined;
      }
    }

    const resolveClass = (cIdx: number): string => {
      const uIdx = classNameIndex.get(cIdx);
      const raw = uIdx ? utf8Pool.get(uIdx) : '';
      return (raw || '').replace(/\//g, '.');
    };

    if (pos + 8 > bytes.length) return undefined;
    const _accessFlags = view.getUint16(pos, false);
    const thisClass = resolveClass(view.getUint16(pos + 2, false));
    const superClass = resolveClass(view.getUint16(pos + 4, false));
    const ifCount = view.getUint16(pos + 6, false);
    pos += 8;

    const interfaces: string[] = [];
    for (let i = 0; i < ifCount; i++) {
      interfaces.push(resolveClass(view.getUint16(pos, false)));
      pos += 2;
    }

    const readMembers = (): string[] => {
      const count = view.getUint16(pos, false);
      pos += 2;
      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        if (pos + 8 > bytes.length) break;
        const flags = view.getUint16(pos, false);
        const nameIdx = view.getUint16(pos + 2, false);
        const descIdx = view.getUint16(pos + 4, false);
        const attrCount = view.getUint16(pos + 6, false);
        pos += 8;
        const mName = utf8Pool.get(nameIdx) || '?';
        const mDesc = utf8Pool.get(descIdx) || '';
        const mods: string[] = [];
        if (flags & 0x0001) mods.push('public');
        if (flags & 0x0002) mods.push('private');
        if (flags & 0x0004) mods.push('protected');
        if (flags & 0x0008) mods.push('static');
        if (flags & 0x0010) mods.push('final');
        out.push(`${mods.join(' ')} ${mName}${mDesc}`.trim());
        for (let a = 0; a < attrCount; a++) {
          if (pos + 6 > bytes.length) break;
          const attrLen = view.getUint32(pos + 2, false);
          pos += 6 + attrLen;
        }
      }
      return out;
    };

    const fields = readMembers();
    const methods = readMembers();
    const stringLiterals: string[] = [];
    for (const uIdx of stringIndex.values()) {
      const s = utf8Pool.get(uIdx);
      if (s && s.trim() && stringLiterals.length < 80) {
        stringLiterals.push(s);
      }
    }

    return {
      className: thisClass || 'UnknownClass',
      superClassName: superClass || 'java.lang.Object',
      javaVersion,
      interfaces,
      fields,
      methods,
      stringLiterals: Array.from(new Set(stringLiterals)),
    };
  } catch {
    return undefined;
  }
}

export function formatBrowserClassPseudoJava(summary: JvmClassSummary): string {
  const lines: string[] = [
    `// Browser Bytecode Inspector (${summary.javaVersion})`,
    `// Tip: Connect Local Power Engine (start.bat / start.sh) for full CFR method body decompilation.`,
    ``,
    `public class ${summary.className}${summary.superClassName && summary.superClassName !== 'java.lang.Object' ? ` extends ${summary.superClassName}` : ''}${summary.interfaces.length ? ` implements ${summary.interfaces.join(', ')}` : ''} {`,
  ];
  if (summary.fields.length) {
    lines.push('  // Fields');
    for (const f of summary.fields) lines.push(`  ${f};`);
    lines.push('');
  }
  if (summary.methods.length) {
    lines.push('  // Methods');
    for (const m of summary.methods) lines.push(`  ${m};`);
    lines.push('');
  }
  if (summary.stringLiterals.length) {
    lines.push('  // Referenced String Constants');
    for (const s of summary.stringLiterals) {
      lines.push(`  // "${s.replace(/\r?\n/g, '\\n')}"`);
    }
  }
  lines.push('}');
  return lines.join('\n');
}
