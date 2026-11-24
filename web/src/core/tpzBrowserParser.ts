import { unzipSync } from 'fflate';
import { formatBrowserClassPseudoJava, inspectJvmClassBytes } from './jvmClassInspector';
import type {
  ChannelAttribute,
  ChannelDetails,
  ClassResource,
  ContainerSummary,
  DecompileResult,
  FieldMappingRow,
  GlobalSearchResults,
  KnownDevlineEntry,
  MappingGraphEdge,
  MappingGraphNode,
  MappingPayload,
  MultilingualText,
  ObjectLink,
  ProcessStepInfo,
  PvcMembershipInfo,
  PvcVersionInfo,
  TextualResource,
  TptCrcIntegrity,
  TpzArchiveSummary,
  TpzObjectDetail,
  TpzObjectSummary,
  UdfDefinition,
} from './types';

const TPT_CHUNK_SIZE = 1048576; // 1 MiB
const TPT_CHUNK_SEED = 0xdc358a91;
const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32IsoHdlc(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readUint64Be(bytes: Uint8Array, offset: number): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return dv.getUint32(0, false) * 4294967296 + dv.getUint32(4, false);
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return dv.getUint32(0, false);
}

function readInt64Be(bytes: Uint8Array, offset: number): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  const hi = dv.getInt32(0, false);
  const lo = dv.getUint32(4, false);
  return hi * 4294967296 + lo;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function normalizeUuidHex(raw: string): string {
  if (!raw) return '';
  const cleaned = raw.trim().replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(cleaned) ? cleaned : '';
}

function formatUuidDashed(hex32: string): string {
  const h = normalizeUuidHex(hex32);
  if (!h) return hex32 || '';
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function extractHeaderVersionSetId(hdrXmlText: string): string {
  const m = hdrXmlText.match(/<[\w:.-]*versionSet\b[^>]*\bid\s*=\s*"([^"]+)"/i);
  return m ? normalizeUuidHex(m[1]) : '';
}

function decodeCleanText(b: Uint8Array): string {
  if (!b.length) return '';
  return utf8Dec.decode(b).replace(/\x00/g, '').trim();
}

function parsePvcElementTlvs(raw: Uint8Array): PvcVersionInfo | null {
  const n = raw.length;
  if (n < 12) return null;
  const version = readUint32Be(raw, 0);
  if (version !== 1 && version !== 2) return null;
  let pos = 4;
  const readField = (): Uint8Array | null => {
    if (pos + 4 > n) return null;
    const flen = readUint32Be(raw, pos);
    pos += 4;
    if (flen > n - pos) return null;
    const val = raw.subarray(pos, pos + flen);
    pos += flen;
    return val;
  };
  const u32 = (b?: Uint8Array) => (b && b.length === 4 ? readUint32Be(b, 0) : 0);
  const i64 = (b?: Uint8Array) => (b && b.length === 8 ? readInt64Be(b, 0) : 0);

  const prologue: Uint8Array[] = [];
  for (let i = 0; i < 16; i++) {
    const f = readField();
    if (!f) break;
    prologue.push(f);
  }
  if (prologue.length < 7) return null;

  const f1 = prologue[0].length === 16 ? bytesToHex(prologue[0]) : '';
  const f6 = prologue[5].length === 16 ? bytesToHex(prologue[5]) : '';
  const f7 = prologue[6].length === 16 ? bytesToHex(prologue[6]) : '';
  const f8 = prologue.length >= 8 && prologue[7].length === 16 ? bytesToHex(prologue[7]) : '';

  let rowCount = 0;
  let predecessorRows = 0;
  let visRelationRows = 0;
  let r3Count = 0;
  const ownerVsIds: string[] = [];
  const ownerVsIdCounts: Record<string, number> = {};
  const tailVersionSetIds: string[] = [];
  const tailVsetSeen = new Set<string>();
  const r17Values: number[] = [];
  const r17Seen = new Set<number>();
  let exactConsumed = false;

  if (prologue.length === 16 && pos + 4 <= n) {
    rowCount = readUint32Be(raw, pos);
    pos += 4;
    if (rowCount <= 2048) {
      let okRows = true;
      for (let r = 0; r < rowCount; r++) {
        const rowFields: Uint8Array[] = [];
        for (let k = 0; k < 18; k++) {
          const rf = readField();
          if (!rf) {
            okRows = false;
            break;
          }
          rowFields.push(rf);
        }
        if (!okRows) break;
        if (rowFields[2].length === 16) {
          r3Count++;
          const r3Hex = bytesToHex(rowFields[2]);
          if (ownerVsIdCounts[r3Hex] === undefined) {
            ownerVsIds.push(r3Hex);
            ownerVsIdCounts[r3Hex] = 1;
          } else {
            ownerVsIdCounts[r3Hex] += 1;
          }
        }
        if (rowFields[4].length === 16) predecessorRows++;
        if (rowFields[14].length === 16 && rowFields[15].length === 16) {
          visRelationRows++;
          const r16Hex = bytesToHex(rowFields[15]);
          if (!tailVsetSeen.has(r16Hex)) {
            tailVsetSeen.add(r16Hex);
            tailVersionSetIds.push(r16Hex);
          }
          if (rowFields[16].length === 4) {
            const r17Val = u32(rowFields[16]);
            if (!r17Seen.has(r17Val)) {
              r17Seen.add(r17Val);
              r17Values.push(r17Val);
            }
          }
        }
      }
      if (okRows && pos === n) exactConsumed = true;
    }
  }

  return {
    version,
    oid: f1,
    vid: f6,
    oidConsistent: Boolean(f1 && f1 === f7),
    branchIdCandidate: f8,
    modelVersion: prologue.length > 2 ? decodeCleanText(prologue[2]) : '',
    branchSeqNo: u32(prologue[8]),
    objState: u32(prologue[9]),
    isDeleted: Boolean(u32(prologue[10])),
    creatorName: prologue.length > 11 ? decodeCleanText(prologue[11]) : '',
    creationTimeMs: i64(prologue[12]),
    lastModifiedMs: i64(prologue[13]),
    isArchived: Boolean(u32(prologue[14])),
    relationRows: rowCount,
    predecessorRows,
    visRelationRows,
    r3Count,
    ownerVsIds,
    ownerVsIdCounts,
    tailVersionSetIds,
    r17Values,
    exactConsumed,
  };
}

interface ParsedVSetRow {
  vid: string;
  oid: string;
  versionSetId: string;
  v4: number;
  v5: number;
  timestampMs: number;
  v6v7Equal: boolean;
}

function parsePvcVersionSetTlvs(raw: Uint8Array): {
  versionSetId: string;
  secondTlvHex: string;
  rowCount: number;
  exactConsumed: boolean;
  rows: ParsedVSetRow[];
} | null {
  const n = raw.length;
  if (n < 12) return null;
  let pos = 4;
  const readField = (): Uint8Array | null => {
    if (pos + 4 > n) return null;
    const flen = readUint32Be(raw, pos);
    pos += 4;
    if (flen > n - pos) return null;
    const val = raw.subarray(pos, pos + flen);
    pos += flen;
    return val;
  };
  const prologue: Uint8Array[] = [];
  for (let i = 0; i < 16; i++) {
    const f = readField();
    if (!f) return null;
    prologue.push(f);
  }
  if (pos + 4 > n) return null;
  const rowCount = readUint32Be(raw, pos);
  pos += 4;
  if (rowCount > 500000) return null;

  const firstTlv = prologue[0].length === 16 ? bytesToHex(prologue[0]) : '';
  const secondTlvHex = prologue[1].length === 16 ? bytesToHex(prologue[1]) : '';
  const rows: ParsedVSetRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    const rfs: Uint8Array[] = [];
    for (let k = 0; k < 9; k++) {
      const rf = readField();
      if (!rf) return null;
      rfs.push(rf);
    }
    if (!(rfs[0].length === 16 && rfs[1].length === 16 && rfs[2].length === 16)) return null;
    const v6 = rfs[5].length === 8 ? readInt64Be(rfs[5], 0) : 0;
    let eq67 = rfs[5].length === rfs[6].length;
    if (eq67) {
      for (let b = 0; b < rfs[5].length; b++) {
        if (rfs[5][b] !== rfs[6][b]) {
          eq67 = false;
          break;
        }
      }
    }
    rows.push({
      vid: bytesToHex(rfs[0]),
      oid: bytesToHex(rfs[1]),
      versionSetId: bytesToHex(rfs[2]),
      v4: rfs[3].length === 4 ? readUint32Be(rfs[3], 0) : 0,
      v5: rfs[4].length === 4 ? readUint32Be(rfs[4], 0) : 0,
      timestampMs: v6,
      v6v7Equal: eq67,
    });
  }
  return { versionSetId: firstTlv, secondTlvHex, rowCount, exactConsumed: pos === n, rows };
}

function parseKnownDevlinesTlvs(raw: Uint8Array): {
  rowCount: number;
  exactConsumed: boolean;
  byId: Map<string, KnownDevlineEntry>;
} | null {
  const n = raw.length;
  if (n < 4) return null;
  const rowCount = readUint32Be(raw, 0);
  if (rowCount > 100000) return null;
  let pos = 4;
  const readField = (): Uint8Array | null => {
    if (pos + 4 > n) return null;
    const flen = readUint32Be(raw, pos);
    pos += 4;
    if (flen > n - pos) return null;
    const val = raw.subarray(pos, pos + flen);
    pos += flen;
    return val;
  };
  const decodeVar = (b: Uint8Array) => {
    if (!b.length) return '';
    const s = decodeCleanText(b);
    return /^[\x20-\x7e\u00a0-\uffff\t\r\n]+$/.test(s) ? s : bytesToHex(b).slice(0, 64);
  };
  const byId = new Map<string, KnownDevlineEntry>();
  for (let i = 0; i < rowCount; i++) {
    const fs: Uint8Array[] = [];
    for (let k = 0; k < 5; k++) {
      const f = readField();
      if (!f) return null;
      fs.push(f);
    }
    if (!(fs[0].length === 16 && fs[1].length === 8 && fs[2].length === 16)) return null;
    const idHex = bytesToHex(fs[0]);
    byId.set(idHex, {
      idHex,
      id: formatUuidDashed(idHex),
      field2Hex: bytesToHex(fs[1]),
      field3: formatUuidDashed(bytesToHex(fs[2])),
      field4: decodeVar(fs[3]),
      field5: decodeVar(fs[4]),
    });
  }
  return { rowCount, exactConsumed: pos === n, byId };
}

function parsePvcVSetSpecializationTlvs(raw: Uint8Array): {
  versionSetId: string;
  specCode: number;
  exactConsumed: boolean;
} | null {
  const n = raw.length;
  if (n < 12) return null;
  let pos = 4;
  const readField = (): Uint8Array | null => {
    if (pos + 4 > n) return null;
    const flen = readUint32Be(raw, pos);
    pos += 4;
    if (flen > n - pos) return null;
    const val = raw.subarray(pos, pos + flen);
    pos += flen;
    return val;
  };
  const f1 = readField();
  const f2 = readField();
  if (!f1 || !f2 || f1.length !== 16 || f2.length !== 4) return null;
  return {
    versionSetId: bytesToHex(f1),
    specCode: readUint32Be(f2, 0),
    exactConsumed: pos === n,
  };
}

function isStandardTptMagic(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 64 &&
    bytes[0] === 0 &&
    bytes[1] === 0 &&
    bytes[2] === 0 &&
    bytes[3] === 0 &&
    bytes[4] === 0xdc &&
    bytes[5] === 0x35 &&
    bytes[6] === 0x8a &&
    bytes[7] === 0x91
  );
}

function unchunkTptExact(raw: Uint8Array): {
  logical: Uint8Array;
  segments: CatalogSegment[];
  report: TptCrcIntegrity;
  pvcByOidVid: Map<string, PvcVersionInfo>;
  pvcByOid: Map<string, PvcVersionInfo>;
  devlinesById: Map<string, KnownDevlineEntry>;
} | null {
  if (!isStandardTptMagic(raw)) return null;
  const eofLogical = readUint64Be(raw, raw.length - 8);
  if (eofLogical < 38 || eofLogical >= raw.length) return null;

  const logical = new Uint8Array(eofLogical);
  let writePos = 0;
  let pos = 0;
  let blkIdx = 0;
  let chunksChecked = 0;
  let chunksOk = 0;
  let lastCalcCrc = 0;
  const errors: string[] = [];

  while (writePos < eofLogical) {
    const need = Math.min(TPT_CHUNK_SIZE, eofLogical - writePos);
    if (pos + need > raw.length - 8) return null;
    const blk = raw.subarray(pos, pos + need);
    logical.set(blk, writePos);
    lastCalcCrc = crc32IsoHdlc(blk, blkIdx === 0 ? 0 : TPT_CHUNK_SEED);
    writePos += need;
    pos += need;
    if (need === TPT_CHUNK_SIZE && writePos < eofLogical) {
      if (pos + 8 > raw.length - 8) return null;
      const z4 = readUint32Be(raw, pos);
      const stored = readUint32Be(raw, pos + 4);
      chunksChecked++;
      if (z4 === 0 && stored === lastCalcCrc) {
        chunksOk++;
      } else {
        errors.push(`chunk[${blkIdx}] CRC mismatch`);
      }
      pos += 8;
      blkIdx++;
    }
  }

  if (pos + 8 > raw.length - 8) return null;
  const preZ4 = readUint32Be(raw, pos);
  const preStored = readUint32Be(raw, pos + 4);
  const rawCat = raw.subarray(pos + 8, raw.length - 8);

  // Multi-block catalog continuation framing
  const tail = eofLogical % TPT_CHUNK_SIZE;
  const firstGap = tail > 0 ? TPT_CHUNK_SIZE - tail : TPT_CHUNK_SIZE;
  let catMarkersChecked = 0;
  let catMarkersOk = 0;
  let catSlice: Uint8Array;

  if (rawCat.length <= firstGap) {
    catSlice = rawCat;
  } else {
    const parts: Uint8Array[] = [];
    let totalLen = 0;
    if (firstGap + 8 > rawCat.length) {
      errors.push('Truncated catalog marker 1');
      catSlice = rawCat;
    } else {
      const seg0 = rawCat.subarray(0, firstGap);
      const mz4 = readUint32Be(rawCat, firstGap);
      const mstored = readUint32Be(rawCat, firstGap + 4);
      const expect0 = crc32IsoHdlc(seg0, lastCalcCrc);
      catMarkersChecked++;
      if (mz4 === 0 && mstored === expect0) catMarkersOk++;
      else errors.push('Catalog marker[0] CRC mismatch');
      parts.push(seg0);
      totalLen += seg0.length;

      let cpos = firstGap + 8;
      while (rawCat.length - cpos > TPT_CHUNK_SIZE) {
        if (cpos + TPT_CHUNK_SIZE + 8 > rawCat.length) {
          errors.push(`Truncated catalog marker ${catMarkersChecked + 1}`);
          break;
        }
        const seg = rawCat.subarray(cpos, cpos + TPT_CHUNK_SIZE);
        const cz4 = readUint32Be(rawCat, cpos + TPT_CHUNK_SIZE);
        const cstored = readUint32Be(rawCat, cpos + TPT_CHUNK_SIZE + 4);
        const cexpect = crc32IsoHdlc(seg, TPT_CHUNK_SEED);
        catMarkersChecked++;
        if (cz4 === 0 && cstored === cexpect) catMarkersOk++;
        else errors.push(`Catalog marker[${catMarkersChecked - 1}] CRC mismatch`);
        parts.push(seg);
        totalLen += seg.length;
        cpos += TPT_CHUNK_SIZE + 8;
      }
      const rem = rawCat.subarray(cpos);
      parts.push(rem);
      totalLen += rem.length;

      catSlice = new Uint8Array(totalLen);
      let w = 0;
      for (const p of parts) {
        catSlice.set(p, w);
        w += p.length;
      }
    }
  }

  const catTextHead = latin1Dec.decode(catSlice.subarray(0, 16));
  const catalogStartsXml = catTextHead.startsWith('<?xml');
  const catCrc = crc32IsoHdlc(catSlice, 0);

  let catMode = 'mismatch';
  let preCatalogCrcOk = false;
  if (preZ4 === 0 && preStored === lastCalcCrc) {
    catMode = 'stream_crc';
    preCatalogCrcOk = true;
  } else if (preZ4 === 0 && preStored === catCrc) {
    catMode = 'cat_crc';
    preCatalogCrcOk = true;
  } else {
    errors.push('Pre-catalog CRC mismatch');
  }

  const segments = parseCatalog(catSlice, logical.length);
  let headerCrcOk = false;
  let headerVsetHex = '';
  const hdrSeg = segments.find((s) => s.type === 'header');
  if (hdrSeg && hdrSeg.length >= 16) {
    const hLen = readUint64Be(logical, hdrSeg.offset);
    const hZero = readUint32Be(logical, hdrSeg.offset + 8);
    const hCrc = readUint32Be(logical, hdrSeg.offset + 12);
    const hdrXmlSlice = logical.subarray(hdrSeg.offset + 16, hdrSeg.offset + hdrSeg.length);
    const calcHdr = crc32IsoHdlc(hdrXmlSlice, 0);
    headerCrcOk = hZero === 0 && hLen + 8 === hdrSeg.length && hCrc === calcHdr;
    headerVsetHex = extractHeaderVersionSetId(utf8Dec.decode(hdrXmlSlice));
    if (!headerCrcOk) errors.push('Header CRC mismatch');
  } else {
    errors.push('Missing header segment');
  }

  let contiguous = segments.length > 0 && segments[0].offset === 38;
  if (contiguous) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i].offset + segments[i].length !== segments[i + 1].offset) {
        contiguous = false;
        break;
      }
    }
    if (segments[segments.length - 1].offset + segments[segments.length - 1].length !== logical.length) {
      contiguous = false;
    }
  }

  let meTotal = 0;
  let meExact = 0;
  let pvcTotal = 0;
  let pvcOk = 0;
  let pvcR16Total = 0;
  let pvcR16MatchesHeader = 0;
  const pvcR3RowCounts = new Map<string, number>();
  const pvcByOidVid = new Map<string, PvcVersionInfo>();
  const pvcByOid = new Map<string, PvcVersionInfo>();
  let vsetParsed: ReturnType<typeof parsePvcVersionSetTlvs> = null;
  let vsetSpecParsed: ReturnType<typeof parsePvcVSetSpecializationTlvs> = null;
  let devlinesParsed: ReturnType<typeof parseKnownDevlinesTlvs> = null;

  for (const s of segments) {
    if (s.type === 'pvcVersionSet' && !vsetParsed) {
      vsetParsed = parsePvcVersionSetTlvs(logical.subarray(s.offset, s.offset + s.length));
    } else if (s.type === 'pvcVersionSetSpecialization' && !vsetSpecParsed) {
      vsetSpecParsed = parsePvcVSetSpecializationTlvs(logical.subarray(s.offset, s.offset + s.length));
    } else if (s.type === 'knownDevlines' && !devlinesParsed) {
      devlinesParsed = parseKnownDevlinesTlvs(logical.subarray(s.offset, s.offset + s.length));
    }
  }

  const headerVsetDashed = headerVsetHex ? formatUuidDashed(headerVsetHex) : '';
  const vsetByOidVid = new Map<string, PvcMembershipInfo>();
  let vsetFirstMatchesHdr: boolean | null = null;
  let vsetSpecCode: number | null = null;
  let vsetSpecMatchesHdr: boolean | null = null;
  if (vsetSpecParsed && vsetSpecParsed.exactConsumed) {
    vsetSpecCode = vsetSpecParsed.specCode;
    if (headerVsetHex && vsetSpecParsed.versionSetId) {
      vsetSpecMatchesHdr = vsetSpecParsed.versionSetId === headerVsetHex;
    }
  }
  let vsetRowsTotal = 0;
  let vsetRowsMatchHdr = 0;
  if (vsetParsed && vsetParsed.exactConsumed) {
    vsetRowsTotal = vsetParsed.rowCount;
    if (headerVsetHex && vsetParsed.versionSetId) {
      vsetFirstMatchesHdr = vsetParsed.versionSetId === headerVsetHex;
    }
    for (const row of vsetParsed.rows) {
      const matchHdr = Boolean(headerVsetHex && row.versionSetId === headerVsetHex);
      if (matchHdr) vsetRowsMatchHdr++;
      vsetByOidVid.set(`${row.oid}:${row.vid}`, {
        versionSetId: formatUuidDashed(row.versionSetId),
        matchesHeader: matchHdr,
        v4: row.v4,
        v5: row.v5,
        timestampMs: row.timestampMs,
        v6v7Equal: row.v6v7Equal,
      });
    }
  }

  const dlById = devlinesParsed && devlinesParsed.exactConsumed ? devlinesParsed.byId : new Map<string, KnownDevlineEntry>();
  let vsetRowsJoinedPvc = 0;

  for (const s of segments) {
    if (s.type === 'modelElement') {
      meTotal++;
      if (s.length >= 8 && readUint64Be(logical, s.offset) + 8 === s.length) {
        meExact++;
      }
    } else if (s.type === 'pvcElement') {
      pvcTotal++;
      const parsedPvc = parsePvcElementTlvs(logical.subarray(s.offset, s.offset + s.length));
      if (parsedPvc) {
        if (parsedPvc.oidConsistent) pvcOk++;
        if (headerVsetDashed) parsedPvc.headerVersionSetId = headerVsetDashed;
        if (parsedPvc.tailVersionSetIds && parsedPvc.tailVersionSetIds.length > 0) {
          for (const r16 of parsedPvc.tailVersionSetIds) {
            pvcR16Total++;
            if (headerVsetHex && r16 === headerVsetHex) pvcR16MatchesHeader++;
          }
          parsedPvc.r16MatchesHeader = Boolean(
            headerVsetHex && parsedPvc.tailVersionSetIds.every((t) => t === headerVsetHex),
          );
        }
        if (parsedPvc.ownerVsIdCounts) {
          for (const [r3Hex, cnt] of Object.entries(parsedPvc.ownerVsIdCounts)) {
            pvcR3RowCounts.set(r3Hex, (pvcR3RowCounts.get(r3Hex) || 0) + cnt);
          }
        }
        if (parsedPvc.ownerVsIds && parsedPvc.ownerVsIds.length > 0) {
          const dls: KnownDevlineEntry[] = [];
          const unres: string[] = [];
          for (const r3 of parsedPvc.ownerVsIds) {
            const hit = dlById.get(r3);
            if (hit) dls.push({ ...hit, scope: 'local' });
            else unres.push(formatUuidDashed(r3));
          }
          if (dls.length > 0) parsedPvc.devlines = dls;
          if (unres.length > 0) parsedPvc.unresolvedOwnerVsIds = unres;
        }
        const key = `${parsedPvc.oid}:${parsedPvc.vid}`;
        const mem = vsetByOidVid.get(key);
        if (mem) {
          parsedPvc.membership = mem;
          vsetRowsJoinedPvc++;
        }
        if (parsedPvc.oid && parsedPvc.vid) pvcByOidVid.set(key, parsedPvc);
        if (parsedPvc.oid) pvcByOid.set(parsedPvc.oid, parsedPvc);
      }
    }
  }

  const knownDevlinesCount = devlinesParsed && devlinesParsed.exactConsumed ? devlinesParsed.rowCount : 0;
  let pvcR3Total = 0;
  let pvcR3Resolved = 0;
  const unresolvedEntries: Array<[string, number]> = [];
  for (const [r3Hex, cnt] of pvcR3RowCounts.entries()) {
    pvcR3Total += cnt;
    if (dlById.has(r3Hex)) pvcR3Resolved += cnt;
    else unresolvedEntries.push([r3Hex, cnt]);
  }
  unresolvedEntries.sort((a, b) => b[1] - a[1]);
  const pvcR3UnresolvedIds = unresolvedEntries.slice(0, 32).map(([h]) => formatUuidDashed(h));

  let vsetSecondTlvId = '';
  let vsetSecondTlvInDevlines: boolean | null = null;
  let vsetSecondTlvDevlineLabel = '';
  if (vsetParsed && vsetParsed.exactConsumed && vsetParsed.secondTlvHex) {
    vsetSecondTlvId = formatUuidDashed(vsetParsed.secondTlvHex);
    if (dlById.size > 0) {
      const hit2 = dlById.get(vsetParsed.secondTlvHex);
      vsetSecondTlvInDevlines = Boolean(hit2);
      if (hit2) vsetSecondTlvDevlineLabel = hit2.field4 || hit2.field5 || '';
    }
  }

  const report: TptCrcIntegrity = {
    validMagic: true,
    verified:
      errors.length === 0 &&
      chunksOk === chunksChecked &&
      catMarkersOk === catMarkersChecked &&
      headerCrcOk &&
      preCatalogCrcOk &&
      catalogStartsXml,
    physicalBytes: raw.length,
    logicalBytes: logical.length,
    chunksChecked,
    chunksOk,
    headerCrcOk,
    preCatalogCrcOk,
    catMode,
    catalogStartsXml,
    segmentCount: segments.length,
    contiguousSegments: contiguous,
    modelElementsExact: meExact,
    modelElementsTotal: meTotal,
    pvcElementsTotal: pvcTotal,
    pvcOidConsistent: pvcOk,
    catMarkersChecked,
    catMarkersOk,
    headerVersionSetId: headerVsetDashed,
    vsetFirstTlvMatchesHeader: vsetFirstMatchesHdr,
    vsetSecondTlvId,
    vsetSecondTlvInDevlines,
    vsetSecondTlvDevlineLabel,
    vsetSpecCode,
    vsetSpecMatchesHeader: vsetSpecMatchesHdr,
    vsetMembershipRows: vsetRowsTotal,
    vsetMembershipMatchesHeader: vsetRowsMatchHdr,
    vsetMembershipJoinedPvc: vsetRowsJoinedPvc,
    pvcR16Total,
    pvcR16MatchesHeader,
    knownDevlinesCount,
    pvcR3Total,
    pvcR3ResolvedDevlines: pvcR3Resolved,
    pvcR3UnresolvedUnique: unresolvedEntries.length,
    pvcR3UnresolvedIds,
    errors,
  };

  return { logical, segments, report, pvcByOidVid, pvcByOid, devlinesById: dlById };
}

const KEY_CHANNEL_ATTRS = [
  'url', 'targetdirectory', 'filename', 'file.encoding', 'file.transfer',
  'user', 'password', 'timeout', 'adapterstatus', 'qualityofservice',
  'processingmode', 'directory', 'file.name', 'ftp.', 'http.', 'proxy',
  'authentication', 'header', 'jms.', 'mail.', 'rfc.', 'sftp', 'soap', 'rest',
];

const utf8Dec = new TextDecoder('utf-8', { fatal: false });
const latin1Dec = new TextDecoder('iso-8859-1');

function localName(node: Element): string {
  return node.localName || node.nodeName.split(':').pop() || '';
}

function childByLocal(el: Element, name: string): Element | undefined {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (localName(c) === name) return c;
  }
  return undefined;
}

function childTextByLocal(el: Element, name: string): string {
  const c = childByLocal(el, name);
  return (c?.textContent || '').trim();
}

function hashId(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0, ch; i < input.length; i++) {
    ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')).slice(0, 16);
}

/**
 * Strip binary segment header NUL runs (e.g. \x00\x00\x00\x00 + 4B header) interleaved inside .tpt/.dlt streams
 * while protecting '<?xml', '<p1:xi', and '</' tag starts from ever being eaten.
 */
function repairBinaryStreamToText(slice: Uint8Array): string {
  const out = new Uint8Array(slice.length);
  let w = 0;
  let i = 0;
  const n = slice.length;
  while (i < n) {
    if (slice[i] === 0 && i + 1 < n && slice[i + 1] === 0) {
      while (i < n && slice[i] === 0) i++;
      let skip = 0;
      while (skip < 4 && i < n) {
        if (slice[i] === 60) {
          // '<' — stop if '<?xml', '<p1:xi', or '</'
          const b1 = slice[i + 1];
          const b2 = slice[i + 2];
          if (b1 === 63 || b1 === 47 || (b1 === 112 && b2 === 49)) {
            break;
          }
        }
        i++;
        skip++;
      }
      continue;
    }
    const b = slice[i++];
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) continue;
    out[w++] = b;
  }
  return utf8Dec.decode(out.subarray(0, w));
}

interface CatalogSegment {
  type: string;
  offset: number;
  length: number;
  inObjectList: boolean;
}

function findCatalogOffset(bytes: Uint8Array): number {
  // Search backwards from tail for "<catalog"
  const needle = [60, 99, 97, 116, 97, 108, 111, 103]; // "<catalog"
  for (let i = bytes.length - needle.length; i >= 0; i--) {
    if (bytes[i] === 60 && bytes[i + 1] === 99 && bytes[i + 2] === 97 && bytes[i + 3] === 116) {
      let ok = true;
      for (let j = 4; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (ok) return i;
    }
  }
  return -1;
}

function parseCatalog(catSlice: Uint8Array, totalSize: number): CatalogSegment[] {
  const txt = latin1Dec.decode(catSlice);
  const objStart = txt.indexOf('<objectList');
  const objEnd = txt.indexOf('</objectList>');
  const segRe = /<segment\b([^>]*)>/g;
  const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  const segs: CatalogSegment[] = [];

  let m: RegExpExecArray | null;
  while ((m = segRe.exec(txt)) !== null) {
    const attrs: Record<string, string> = {};
    let am: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((am = attrRe.exec(m[1])) !== null) {
      attrs[am[1].toLowerCase()] = am[2];
    }
    const offset = parseInt(attrs['offset'] || '-1', 10);
    const length = parseInt(attrs['length'] || '-1', 10);
    if (isNaN(offset) || isNaN(length) || offset < 0 || length <= 0 || offset >= totalSize) continue;
    const pos = m.index;
    const inObj = objStart >= 0 && pos > objStart && (objEnd < 0 || pos < objEnd);
    segs.push({
      type: attrs['type'] || '?',
      offset,
      length: Math.min(length, totalSize - offset),
      inObjectList: inObj,
    });
  }
  return segs;
}

/**
 * Depth-aware <p1:xiObj> scanner with zero-array-allocation CDATA & XML comment masking
 */
function scanXiObjectsFromText(streamText: string): string[] {
  const mask = streamText.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => ' '.repeat(m.length));
  const n = streamText.length;
  const OPEN = '<p1:xiObj';
  const CLOSE = '</p1:xiObj>';

  const findTagEnd = (start: number): number => {
    let idx = start + 1;
    let quote = '';
    while (idx < n) {
      const ch = mask[idx];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        return idx;
      }
      idx++;
    }
    return -1;
  };

  const isSelfClosing = (start: number, end: number): boolean => {
    let j = end - 1;
    while (j > start && /\s/.test(streamText[j])) j--;
    return streamText[j] === '/';
  };

  const findValidOpen = (fromIdx: number): number => {
    let k = mask.indexOf(OPEN, fromIdx);
    while (k >= 0) {
      const nextCh = streamText[k + OPEN.length];
      if (!nextCh || nextCh === '>' || nextCh === '/' || /\s/.test(nextCh)) {
        return k;
      }
      k = mask.indexOf(OPEN, k + 1);
    }
    return -1;
  };

  const results: string[] = [];
  let pos = 0;
  let depth = 0;
  let objStart = 0;

  while (pos < n) {
    if (depth === 0) {
      const k = findValidOpen(pos);
      if (k < 0) break;
      const end = findTagEnd(k);
      if (end < 0) break;
      if (isSelfClosing(k, end)) {
        results.push(streamText.slice(k, end + 1));
        pos = end + 1;
        continue;
      }
      depth = 1;
      objStart = k;
      pos = end + 1;
    } else {
      const no = findValidOpen(pos);
      const nc = mask.indexOf(CLOSE, pos);
      if (nc < 0 && no < 0) {
        results.push(streamText.slice(objStart));
        break;
      }
      if (nc < 0 || (no >= 0 && no < nc)) {
        const end = findTagEnd(no);
        if (end < 0) {
          results.push(streamText.slice(objStart));
          break;
        }
        if (!isSelfClosing(no, end)) {
          depth++;
        }
        pos = end + 1;
      } else {
        depth--;
        pos = nc + CLOSE.length;
        if (depth === 0) {
          results.push(streamText.slice(objStart, pos));
        }
      }
    }
  }
  return results;
}

function parseXmlDomSafe(xmlText: string): Element | null {
  let clean = xmlText.trim();
  if (clean.startsWith('<?xml')) {
    const gt = clean.indexOf('?>');
    if (gt > 0) clean = clean.slice(gt + 2).trim();
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(clean, 'application/xml');
  if (doc.querySelector('parsererror')) {
    // Strip stray control chars and retry
    const stripped = clean.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/g, '');
    const doc2 = parser.parseFromString(stripped, 'application/xml');
    if (doc2.querySelector('parsererror')) return null;
    return doc2.documentElement;
  }
  return doc.documentElement;
}

function serializeXmlPretty(el: Element): string {
  try {
    return new XMLSerializer().serializeToString(el);
  } catch {
    return '';
  }
}

interface InternalResource {
  path: string;
  kind: 'xsd' | 'wsdl' | 'xsl' | 'xml' | 'mappingtool' | 'class' | 'other';
  size: number;
  bytes: Uint8Array;
}

function decodeBase64ToBytes(b64: string): Uint8Array | null {
  const clean = b64.replace(/\s+/g, '');
  if (!clean) return null;
  const pad = (4 - (clean.length % 4)) % 4;
  const padded = clean + '='.repeat(pad);
  try {
    const bin = atob(padded);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch {
    return null;
  }
}

function isZipBytes(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

function isClassBytes(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xca && b[1] === 0xfe && b[2] === 0xba && b[3] === 0xbe;
}

function classifyPayload(relPath: string, data: Uint8Array): InternalResource['kind'] {
  const low = relPath.toLowerCase();
  if (isClassBytes(data) || low.endsWith('.class')) return 'class';
  const head = utf8Dec.decode(data.subarray(0, Math.min(300, data.length))).trimStart();
  if (head.includes('<mappingtool')) return 'mappingtool';
  if (low.endsWith('.wsdl') || head.includes('wsdl:definitions') || head.includes('<definitions')) return 'wsdl';
  if (low.endsWith('.xsd') || head.includes(':schema') || head.includes('<schema')) return 'xsd';
  if (low.endsWith('.xsl') || low.endsWith('.xslt') || head.includes(':stylesheet') || head.includes(':transform')) return 'xsl';
  if (low.endsWith('.xml') || head.startsWith('<?xml') || head.startsWith('<')) return 'xml';
  return 'other';
}

function unpackEmbeddedBlobs(contentXml: string, maxDepth = 5): InternalResource[] {
  const resources: InternalResource[] = [];

  const expandZip = (zipData: Uint8Array, prefix: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(zipData);
    } catch {
      return;
    }
    for (const [entryName, payload] of Object.entries(entries)) {
      if (entryName.endsWith('/') || payload.length === 0) continue;
      const cleanName = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
      const rel = prefix ? `${prefix}/${cleanName}` : cleanName;
      if (isZipBytes(payload)) {
        expandZip(payload, rel, depth + 1);
      } else {
        resources.push({
          path: rel,
          kind: classifyPayload(rel, payload),
          size: payload.length,
          bytes: payload,
        });
      }
    }
  };

  const blobRe = /!(zip|jar|xml)!([^<]*)/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = blobRe.exec(contentXml)) !== null) {
    const kind = m[1].toLowerCase();
    const decoded = decodeBase64ToBytes(m[2]);
    if (!decoded) continue;
    idx++;
    const prefix = `blob_${idx}_${kind}`;
    if (isZipBytes(decoded)) {
      expandZip(decoded, prefix, 1);
    } else {
      const rPath = `${prefix}.${kind}`;
      resources.push({
        path: rPath,
        kind: classifyPayload(rPath, decoded),
        size: decoded.length,
        bytes: decoded,
      });
    }
  }
  return resources;
}

function parseMappingToolPayload(bytes: Uint8Array): MappingPayload {
  const xmlText = utf8Dec.decode(bytes);
  const root = parseXmlDomSafe(xmlText);
  if (!root) return { fieldMappings: [], udfs: [], graphNodes: [], graphEdges: [] };

  // 1) Parse UDF functionmodels
  const udfs: UdfDefinition[] = [];
  const allEls = root.getElementsByTagName('*');
  for (let i = 0; i < allEls.length; i++) {
    const fm = allEls[i];
    if (localName(fm).toLowerCase() !== 'functionmodel') continue;
    let name = '';
    let key = '';
    let title = '';
    let uiTitle = '';
    let tab = '';
    let cacheType = '';
    let implType = '';
    let javaCode = '';
    const args: Array<{ name: string; javaType: string }> = [];

    for (let c = 0; c < fm.children.length; c++) {
      const ch = fm.children[c];
      const tn = localName(ch);
      if (tn === 'name') name = (ch.textContent || '').trim();
      else if (tn === 'key') key = (ch.textContent || '').trim();
      else if (tn === 'title') title = (ch.textContent || '').trim();
      else if (tn === 'uiTitle') uiTitle = (ch.textContent || '').trim();
      else if (tn === 'tab') tab = (ch.textContent || '').trim();
      else if (tn === 'signature') {
        cacheType = ch.getAttribute('cacheType') || '';
        for (let a = 0; a < ch.children.length; a++) {
          const argEl = ch.children[a];
          if (localName(argEl) === 'argument') {
            args.push({
              name: argEl.getAttribute('nm') || '',
              javaType: argEl.getAttribute('jtp') || '',
            });
          }
        }
      } else if (tn === 'implementation') {
        implType = ch.getAttribute('type') || '';
        const jt = childByLocal(ch, 'javaText');
        if (jt?.textContent) javaCode = jt.textContent.trim();
      }
    }
    if (!key && !name && !javaCode) continue;
    udfs.push({
      key: key || name,
      name: name || title || key,
      title: title || uiTitle || name,
      tab,
      cacheType,
      implementationType: implType,
      arguments: args,
      javaCode,
      lineCount: javaCode ? javaCode.split(/\r?\n/).length : 0,
    });
  }

  const udfByKey = new Map<string, UdfDefinition>();
  for (const u of udfs) {
    if (u.key) udfByKey.set(u.key.trim().toLowerCase(), u);
  }

  const fieldMappings: FieldMappingRow[] = [];
  const graphNodes: MappingGraphNode[] = [];
  const graphEdges: MappingGraphEdge[] = [];
  let seq = 0;
  const nextId = () => `n_${++seq}`;

  const getConstVal = (brick: Element): string => {
    for (let i = 0; i < brick.children.length; i++) {
      const b = brick.children[i];
      if (localName(b) !== 'bindings') continue;
      for (let j = 0; j < b.children.length; j++) {
        const p = b.children[j];
        if (p.getAttribute('name') === 'value') {
          const vals = p.getElementsByTagName('*');
          for (let k = 0; k < vals.length; k++) {
            if (localName(vals[k]) === 'value' && (vals[k].textContent || '').trim()) {
              return (vals[k].textContent || '').trim();
            }
          }
        }
      }
    }
    return '';
  };

  const getParams = (brick: Element): Record<string, string> => {
    const out: Record<string, string> = {};
    for (let i = 0; i < brick.children.length; i++) {
      const b = brick.children[i];
      if (localName(b) !== 'bindings') continue;
      for (let j = 0; j < b.children.length; j++) {
        const p = b.children[j];
        const pname = p.getAttribute('name') || '';
        if (!pname) continue;
        const vals = p.getElementsByTagName('*');
        for (let k = 0; k < vals.length; k++) {
          if (localName(vals[k]) === 'value' && vals[k].textContent !== null) {
            out[pname] = (vals[k].textContent || '').trim();
            break;
          }
        }
      }
    }
    return out;
  };

  const renderBrick = (
    brick: Element,
    srcs: string[],
    consts: string[],
    usedUdfs: string[],
    targetGroup: string,
    parentId: string | null,
    pinLabel: string,
    depth: number
  ): string => {
    if (depth > 45) return '...';
    const btype = brick.getAttribute('type') || 'UNKNOWN';
    const nid = nextId();

    if (btype === 'Src') {
      const spath = brick.getAttribute('path') || '?';
      if (spath && spath !== '?') srcs.push(spath);
      graphNodes.push({
        id: nid,
        kind: 'source',
        label: spath.split('/').pop() || spath,
        path: spath,
        targetGroup,
      });
      if (parentId) {
        graphEdges.push({ id: `e_${nid}_${parentId}`, source: nid, target: parentId, label: pinLabel });
      }
      return spath;
    }

    const fname = brick.getAttribute('fname') || '?';
    const fns = brick.getAttribute('fns') || '';
    const params = getParams(brick);

    if (fname === 'const') {
      const cval = getConstVal(brick);
      if (cval) consts.push(cval);
      graphNodes.push({
        id: nid,
        kind: 'const',
        label: `'${cval}'`,
        value: cval,
        targetGroup,
      });
      if (parentId) {
        graphEdges.push({ id: `e_${nid}_${parentId}`, source: nid, target: parentId, label: pinLabel });
      }
      return `'${cval.replace(/'/g, "\\'")}'`;
    }

    const resolvedUdf = udfByKey.get(fname.trim().toLowerCase());
    const isUdf = fns === 'usernamespace' || Boolean(resolvedUdf);
    const displayFn = resolvedUdf?.name || fname;
    if (isUdf) usedUdfs.push(displayFn);

    graphNodes.push({
      id: nid,
      kind: isUdf ? 'udf' : 'func',
      label: displayFn,
      function: fname,
      namespace: fns,
      parameters: params,
      udfKey: resolvedUdf?.key || (isUdf ? fname : ''),
      targetGroup,
    });
    if (parentId) {
      graphEdges.push({ id: `e_${nid}_${parentId}`, source: nid, target: parentId, label: pinLabel });
    }

    const argExprs: string[] = [];
    let argIdx = 0;
    for (let i = 0; i < brick.children.length; i++) {
      const ch = brick.children[i];
      if (localName(ch) !== 'arg') continue;
      const pin = ch.getAttribute('pin') || String(argIdx++);
      for (let j = 0; j < ch.children.length; j++) {
        const sub = ch.children[j];
        if (localName(sub) === 'brick') {
          argExprs.push(renderBrick(sub, srcs, consts, usedUdfs, targetGroup, nid, `arg[${pin}]`, depth + 1));
        }
      }
    }
    const lbl = !fns || fns === 'dflt' || fns === 'usernamespace' ? displayFn : `${displayFn}[${fns}]`;
    return `${lbl}(${argExprs.join(', ')})`;
  };

  // Standard <brick type="Dst">
  for (let i = 0; i < allEls.length; i++) {
    const el = allEls[i];
    if (localName(el) === 'brick' && el.getAttribute('type') === 'Dst') {
      const tpath = el.getAttribute('path') || '';
      const tid = nextId();
      graphNodes.push({
        id: tid,
        kind: 'target',
        label: tpath.split('/').pop() || tpath,
        path: tpath,
        targetGroup: tpath,
      });
      const srcs: string[] = [];
      const consts: string[] = [];
      const usedUdfs: string[] = [];
      const exprs: string[] = [];
      let argIdx = 0;
      for (let c = 0; c < el.children.length; c++) {
        const ch = el.children[c];
        if (localName(ch) !== 'arg') continue;
        const pin = ch.getAttribute('pin') || String(argIdx++);
        for (let s = 0; s < ch.children.length; s++) {
          const sub = ch.children[s];
          if (localName(sub) === 'brick') {
            exprs.push(renderBrick(sub, srcs, consts, usedUdfs, tpath, tid, `in[${pin}]`, 1));
          }
        }
      }
      fieldMappings.push({
        targetPath: tpath,
        expression: exprs.length ? exprs.join(' | ') : '(empty)',
        sources: Array.from(new Set(srcs)),
        constants: Array.from(new Set(consts)),
        udfs: Array.from(new Set(usedUdfs)),
        schemaFormat: 'brick',
      });
    }
  }

  // Fallback: legacy <mapping destPath="...">
  if (fieldMappings.length === 0) {
    const parseLegacyModel = (
      model: Element,
      srcs: string[],
      consts: string[],
      tpath: string,
      parentId: string,
      pinLbl: string
    ): string => {
      const cname = model.getAttribute('classname') || '';
      const nid = nextId();
      if (cname === 'NodeArgument') {
        const spath = model.getAttribute('path') || '?';
        srcs.push(spath);
        graphNodes.push({
          id: nid,
          kind: 'source',
          label: spath.split('/').pop() || spath,
          path: spath,
          targetGroup: tpath,
        });
        graphEdges.push({ id: `e_${nid}_${parentId}`, source: nid, target: parentId, label: pinLbl });
        return spath;
      }
      if (cname === 'Function') {
        const fname = model.getAttribute('name') || '?';
        const ns = model.getAttribute('namespace') || 'dflt';
        const params: Record<string, string> = {};
        const argEls: Element[] = [];
        for (let i = 0; i < model.children.length; i++) {
          const ch = model.children[i];
          if (localName(ch) === 'parameter') {
            const pn = childTextByLocal(ch, 'name');
            const pd = childTextByLocal(ch, 'default');
            if (pn) params[pn] = pd;
          } else if (localName(ch) === 'argument') {
            argEls.push(ch);
          }
        }
        if (fname === 'const') {
          const cval = params['value'] || '';
          consts.push(cval);
          graphNodes.push({
            id: nid,
            kind: 'const',
            label: `'${cval}'`,
            value: cval,
            targetGroup: tpath,
          });
          graphEdges.push({ id: `e_${nid}_${parentId}`, source: nid, target: parentId, label: pinLbl });
          return `'${cval}'`;
        }
        graphNodes.push({
          id: nid,
          kind: 'func',
          label: fname,
          function: fname,
          namespace: ns,
          parameters: params,
          targetGroup: tpath,
        });
        graphEdges.push({ id: `e_${nid}_${parentId}`, source: nid, target: parentId, label: pinLbl });

        argEls.sort((a, b) => parseInt(a.getAttribute('pin') || '0', 10) - parseInt(b.getAttribute('pin') || '0', 10));
        const exprArgs: string[] = [];
        for (const a of argEls) {
          const pin = a.getAttribute('pin') || '0';
          const lnk = childByLocal(a, 'link');
          if (lnk) {
            for (let m = 0; m < lnk.children.length; m++) {
              if (localName(lnk.children[m]) === 'model') {
                exprArgs.push(parseLegacyModel(lnk.children[m], srcs, consts, tpath, nid, `arg[${pin}]`));
              }
            }
          }
        }
        for (const [k, v] of Object.entries(params)) {
          exprArgs.push(`${k}='${v}'`);
          if (v) consts.push(v);
        }
        const lbl = ns === 'dflt' ? fname : `${fname}[${ns}]`;
        return `${lbl}(${exprArgs.join(', ')})`;
      }
      return '?';
    };

    for (let i = 0; i < allEls.length; i++) {
      const mp = allEls[i];
      if (localName(mp) === 'mapping' && mp.hasAttribute('destPath')) {
        const tpath = mp.getAttribute('destPath') || '';
        const tid = nextId();
        graphNodes.push({
          id: tid,
          kind: 'target',
          label: tpath.split('/').pop() || tpath,
          path: tpath,
          targetGroup: tpath,
        });
        const srcs: string[] = [];
        const consts: string[] = [];
        const exprs: string[] = [];
        for (let c = 0; c < mp.children.length; c++) {
          const dv = mp.children[c];
          if (localName(dv) === 'model' && dv.getAttribute('classname') === 'DestinationValue') {
            const lnk = childByLocal(dv, 'link');
            if (lnk) {
              for (let m = 0; m < lnk.children.length; m++) {
                if (localName(lnk.children[m]) === 'model') {
                  exprs.push(parseLegacyModel(lnk.children[m], srcs, consts, tpath, tid, 'in'));
                }
              }
            }
          }
        }
        fieldMappings.push({
          targetPath: tpath,
          expression: exprs.length ? exprs.join(' | ') : '(empty)',
          sources: Array.from(new Set(srcs)),
          constants: Array.from(new Set(consts)),
          udfs: [],
          schemaFormat: 'legacy_destPath',
        });
      }
    }
  }

  return { fieldMappings, udfs, graphNodes, graphEdges };
}

function parseChannelDom(
  contentEl: Element | undefined,
  links: ObjectLink[],
  party: string,
  service: string,
  channelName: string
): ChannelDetails | null {
  if (!contentEl) return null;
  let chEl: Element | null = null;
  const all = contentEl.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (localName(all[i]) === 'Channel') {
      chEl = all[i];
      break;
    }
  }
  if (!chEl) return null;

  const scalars: Record<string, string> = {};
  for (let i = 0; i < chEl.children.length; i++) {
    const c = chEl.children[i];
    if (c.children.length === 0 && (c.textContent || '').trim()) {
      scalars[localName(c)] = (c.textContent || '').trim();
    }
  }

  let adapterName = '';
  let adapterNs = '';
  for (const lk of links) {
    if (lk.role.toUpperCase() === 'ADAPTER' || lk.role.toUpperCase() === 'ADAPTERMETADATA') {
      adapterName = lk.targetName;
      adapterNs = lk.targetNamespace;
      break;
    }
  }
  if (!adapterName) {
    adapterName = scalars['MessageProtocol'] || scalars['TransportProtocol'] || '';
  }

  const attributes: ChannelAttribute[] = [];
  const subEls = chEl.getElementsByTagName('*');
  for (let i = 0; i < subEls.length; i++) {
    const attr = subEls[i];
    if (localName(attr) !== 'Attribute') continue;
    const aname = childTextByLocal(attr, 'Name');
    const aval = childTextByLocal(attr, 'Value');
    if (!aname && !aval) continue;
    attributes.push({
      name: aname,
      value: aval,
      isKey: KEY_CHANNEL_ATTRS.some((k) => aname.toLowerCase().includes(k)),
    });
  }

  const rawDir = scalars['ChannelDirection'] || '';
  const direction =
    rawDir === 'I' ? 'Sender (Inbound)' : rawDir === 'O' ? 'Receiver (Outbound)' : rawDir;

  return {
    party: party || scalars['PartyName'] || '',
    service: service || scalars['ServiceName'] || '',
    channelName: channelName || scalars['ChannelName'] || '',
    direction,
    engineType: scalars['EngineType'] || '',
    adapterType: adapterName,
    adapterNamespace: adapterNs,
    transportProtocol: scalars['TransportProtocol'] || '',
    transportProtocolVersion: scalars['TransportProtocolVersion'] || '',
    messageProtocol: scalars['MessageProtocol'] || '',
    messageProtocolVersion: scalars['MessageProtocolVersion'] || '',
    description: scalars['Description'] || '',
    attributes,
  };
}

interface BrowserStoredObject {
  detail: TpzObjectDetail;
  classRawBytes: Map<number, Uint8Array>;
}

export class BrowserTpzStore {
  archives = new Map<string, TpzArchiveSummary>();
  archiveDevlines = new Map<string, Map<string, KnownDevlineEntry>>();
  objects = new Map<string, BrowserStoredObject>();

  clearArchive(archiveId: string) {
    this.archives.delete(archiveId);
    this.archiveDevlines.delete(archiveId);
    for (const [id, entry] of this.objects.entries()) {
      if (entry.detail.archiveId === archiveId) {
        this.objects.delete(id);
      }
    }
  }

  getObjectDetail(objectId: string): TpzObjectDetail {
    const found = this.objects.get(objectId);
    if (!found) throw new Error(`Object not found: ${objectId}`);
    const det = found.detail;
    const pvc = det.pvcInfo;
    if (pvc && pvc.unresolvedOwnerVsIds && pvc.unresolvedOwnerVsIds.length > 0) {
      const crossDls: KnownDevlineEntry[] = [];
      const stillUnresolved: string[] = [];
      for (const dashedId of pvc.unresolvedOwnerVsIds) {
        const normId = normalizeUuidHex(dashedId);
        let hit: KnownDevlineEntry | undefined;
        for (const [otherAid, dlMap] of this.archiveDevlines.entries()) {
          if (otherAid !== det.archiveId) {
            const candidate = dlMap.get(normId);
            if (candidate) {
              hit = { ...candidate, scope: 'workspace' };
              break;
            }
          }
        }
        if (hit) crossDls.push(hit);
        else stillUnresolved.push(dashedId);
      }
      if (crossDls.length > 0) {
        return {
          ...det,
          pvcInfo: {
            ...pvc,
            crossArchiveDevlines: crossDls,
            unresolvedOwnerVsIds: stillUnresolved,
          },
        };
      }
    }
    return det;
  }

  loadTpzBuffer(fileName: string, arrayBuffer: ArrayBuffer): TpzArchiveSummary {
    const t0 = performance.now();
    const rawBytes = new Uint8Array(arrayBuffer);
    const archiveId = hashId(`${fileName}:${rawBytes.length}:${rawBytes[0] || 0}:${rawBytes[rawBytes.length - 1] || 0}`).slice(0, 12);
    this.clearArchive(archiveId);

    const unzipped = unzipSync(rawBytes);
    const metadata: Record<string, string> = {};
    const warnings: string[] = [];
    const containers: ContainerSummary[] = [];
    const createdSummaries: TpzObjectSummary[] = [];

    for (const [entryName, entryBytes] of Object.entries(unzipped)) {
      const low = entryName.toLowerCase();
      if (low.endsWith('metadata.properties') || low.endsWith('export.inf')) {
        const txt = utf8Dec.decode(entryBytes);
        for (const line of txt.split(/\r?\n/)) {
          const eq = line.indexOf('=');
          if (eq > 0 && !line.trimStart().startsWith('#')) {
            metadata[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        }
      }
    }

    let seqCounter = 0;
    for (const [entryName, entryBytes] of Object.entries(unzipped)) {
      const low = entryName.toLowerCase();
      if (!low.endsWith('.tpt') && !low.endsWith('.dlt')) continue;

      const cname = entryName.split('/').pop() || entryName;
      let segCount = 0;
      let rawXiStrings: string[] = [];
      let crcIntegrity: TptCrcIntegrity | null = null;

      const exact = unchunkTptExact(entryBytes);
      if (exact && exact.devlinesById.size > 0) {
        let archDl = this.archiveDevlines.get(archiveId);
        if (!archDl) {
          archDl = new Map<string, KnownDevlineEntry>();
          this.archiveDevlines.set(archiveId, archDl);
        }
        for (const [dlHex, dlEntry] of exact.devlinesById.entries()) {
          archDl.set(dlHex, { ...dlEntry, sourceArchive: fileName, sourceContainer: cname });
        }
      }
      if (
        exact &&
        ((exact.report.modelElementsTotal > 0 && exact.report.modelElementsExact === exact.report.modelElementsTotal) ||
          exact.report.contiguousSegments)
      ) {
        segCount = exact.segments.length;
        crcIntegrity = exact.report;
        for (const seg of exact.segments) {
          if (seg.type === 'modelElement' && seg.length > 8) {
            rawXiStrings.push(utf8Dec.decode(exact.logical.subarray(seg.offset + 8, seg.offset + seg.length)));
          }
        }
      } else {
        const catOff = findCatalogOffset(entryBytes);
        let scanStart = 0;
        let scanEnd = entryBytes.length;

        if (catOff >= 0) {
          const segs = parseCatalog(entryBytes.subarray(catOff), entryBytes.length);
          segCount = segs.length;
          const objSegs = segs.filter((s) => s.inObjectList && s.type === 'modelElement');
          if (objSegs.length > 0) {
            scanStart = Math.min(...objSegs.map((s) => s.offset));
          } else {
            const mgd = segs.find((s) => s.type === 'modelGeneralData');
            if (mgd) scanStart = mgd.offset + mgd.length;
          }
          scanEnd = catOff;
        }

        const sliceText = scanStart < scanEnd ? repairBinaryStreamToText(entryBytes.subarray(scanStart, scanEnd)) : '';
        rawXiStrings = sliceText ? scanXiObjectsFromText(sliceText) : [];
      }
      let containerObjCount = 0;

      const walkXiElement = (elem: Element, depth: number, parentOid: string | null) => {
        seqCounter++;
        const parsed = this.buildStoredObject(elem, archiveId, fileName, cname, depth, parentOid, seqCounter);
        if (exact && (exact.pvcByOidVid.size > 0 || exact.pvcByOid.size > 0)) {
          const normOid = normalizeUuidHex(parsed.detail.oid) || parsed.detail.oid.replace(/-/g, '').toLowerCase();
          const normVid = normalizeUuidHex(parsed.detail.vid) || parsed.detail.vid.replace(/-/g, '').toLowerCase();
          const pvc = exact.pvcByOidVid.get(`${normOid}:${normVid}`) || exact.pvcByOid.get(normOid);
          if (pvc) parsed.detail.pvcInfo = pvc;
        }
        this.objects.set(parsed.detail.id, parsed);
        createdSummaries.push(this.toSummary(parsed.detail));
        containerObjCount++;

        const nextParent = parsed.detail.oid || parentOid;
        const walkChildren = (node: Element) => {
          for (let i = 0; i < node.children.length; i++) {
            const sub = node.children[i];
            if (localName(sub) === 'xiObj') {
              walkXiElement(sub, depth + 1, nextParent);
            } else {
              walkChildren(sub);
            }
          }
        };
        walkChildren(elem);
      };

      for (const rawXi of rawXiStrings) {
        const rootEl = parseXmlDomSafe(rawXi);
        if (!rootEl) {
          warnings.push(`${cname}: skipped malformed xiObj XML block`);
          continue;
        }
        walkXiElement(rootEl, 0, null);
      }

      containers.push({
        name: cname,
        kind: low.endsWith('.dlt') ? 'delta' : 'primary',
        bytes: entryBytes.length,
        segments: segCount,
        objects: containerObjCount,
        crcIntegrity,
      });
    }

    const typeCounts: Record<string, number> = {};
    let messageMappings = 0;
    let fieldMappings = 0;
    let udfs = 0;
    let javaClasses = 0;
    let xsltFiles = 0;
    let channels = 0;

    for (const s of createdSummaries) {
      typeCounts[s.typeId] = (typeCounts[s.typeId] || 0) + 1;
      const full = this.objects.get(s.id)?.detail;
      if (full?.mapping) {
        messageMappings++;
        fieldMappings += full.mapping.fieldMappings.length;
        udfs += full.mapping.udfs.length;
      }
      if (full?.channel) channels++;
      javaClasses += s.classCount;
      if (full) {
        xsltFiles += full.textualResources.filter((r) => r.kind === 'xsl').length;
      }
    }

    const ccBpmProcesses = typeCounts['process'] || 0;
    const complexityScore =
      messageMappings * 2 +
      udfs * 4 +
      javaClasses * 5 +
      xsltFiles * 3 +
      channels * 2 +
      ccBpmProcesses * 12;

    const complexityTier =
      complexityScore < 25 ? 'Low' : complexityScore < 100 ? 'Medium' : complexityScore < 300 ? 'High' : 'Enterprise / Very High';

    const summary: TpzArchiveSummary = {
      archiveId,
      fileName,
      sizeBytes: rawBytes.length,
      parsedInMs: Math.round(performance.now() - t0),
      metadata,
      containers,
      warnings,
      stats: {
        totalObjects: createdSummaries.length,
        typeCounts,
        messageMappings,
        fieldMappings,
        udfs,
        javaClasses,
        xsltFiles,
        channels,
        ccBpmProcesses,
        complexityScore,
        complexityTier,
      },
      objects: createdSummaries,
    };

    this.archives.set(archiveId, summary);
    return summary;
  }

  private toSummary(d: TpzObjectDetail): TpzObjectSummary {
    return {
      id: d.id,
      archiveId: d.archiveId,
      archiveName: d.archiveName,
      containerName: d.containerName,
      typeId: d.typeId,
      oid: d.oid,
      vid: d.vid,
      name: d.name,
      namespace: d.namespace,
      swcv: d.swcv,
      modifBy: d.modifBy,
      modifAt: d.modifAt,
      owner: d.owner,
      depth: d.depth,
      parentOid: d.parentOid,
      linkCount: d.linkCount,
      textCount: d.textCount,
      fieldMappingCount: d.fieldMappingCount,
      udfCount: d.udfCount,
      classCount: d.classCount,
      schemaCount: d.schemaCount,
      hasChannel: d.hasChannel,
      adapterType: d.adapterType,
      direction: d.direction,
    };
  }

  private buildStoredObject(
    elem: Element,
    archiveId: string,
    archiveName: string,
    containerName: string,
    depth: number,
    parentOid: string | null,
    seq: number
  ): BrowserStoredObject {
    let typeId = '';
    let oid = '';
    let vid = '';
    let name = '';
    let namespace = '';
    let swcv = '';
    let partyVal = '';
    let serviceVal = '';
    let modifBy = '';
    let modifAt = '';
    let owner = '';
    const links: ObjectLink[] = [];
    const texts: MultilingualText[] = [];

    const idInfo = childByLocal(elem, 'idInfo');
    if (idInfo) {
      vid = idInfo.getAttribute('VID') || '';
      const vc = childByLocal(idInfo, 'vc');
      if (vc) swcv = vc.getAttribute('caption') || '';
      const key = childByLocal(idInfo, 'key');
      if (key) {
        typeId = key.getAttribute('typeID') || '';
        oid = key.getAttribute('oid') || '';
        const rawElems: string[] = [];
        for (let i = 0; i < key.children.length; i++) {
          if (localName(key.children[i]) === 'elem') {
            rawElems.push((key.children[i].textContent || '').trim());
          }
        }
        if (typeId === 'Channel' && rawElems.length >= 3) {
          partyVal = rawElems[0];
          serviceVal = rawElems[1];
          name = rawElems[2];
          namespace = [partyVal, serviceVal].filter(Boolean).join(' / ');
        } else if (typeId === 'Service' && rawElems.length >= 2) {
          partyVal = rawElems[0];
          name = rawElems[1];
          namespace = partyVal || 'Business Component';
        } else if (
          ['AllInOne', 'IntegratedConfiguration', 'SenderAgreement', 'ReceiverDetermination', 'InterfaceDetermination', 'ReceiverAgreement'].includes(typeId) &&
          rawElems.length >= 4
        ) {
          const snd = rawElems[1] || rawElems[0] || '*';
          const isThirdNs = rawElems[2].startsWith('http://') || rawElems[2].startsWith('urn:') || rawElems[2].includes('/');
          const ifName = isThirdNs ? rawElems[3] || 'Interface' : rawElems[2] || 'Interface';
          const ifNs = isThirdNs ? rawElems[2] : rawElems[3];
          name = `${snd} → ${ifName}`;
          namespace = ifNs || 'Directory';
        } else {
          const nonEmpty = rawElems.filter(Boolean);
          if (nonEmpty.length > 0) name = nonEmpty[0];
          if (nonEmpty.length > 1) namespace = nonEmpty[1];
        }
      }
    }

    const generic = childByLocal(elem, 'generic');
    if (generic) {
      const adm = childByLocal(generic, 'admInf');
      if (adm) {
        modifBy = childTextByLocal(adm, 'modifBy');
        modifAt = childTextByLocal(adm, 'modifAt');
        owner = childTextByLocal(adm, 'owner');
      }
      const lnks = childByLocal(generic, 'lnks');
      if (lnks) {
        for (let i = 0; i < lnks.children.length; i++) {
          const lr = lnks.children[i];
          if (localName(lr) !== 'lnkRole') continue;
          const role = lr.getAttribute('role') || '';
          const kpos = lr.getAttribute('kpos') || '';
          for (let j = 0; j < lr.children.length; j++) {
            const lk = lr.children[j];
            if (localName(lk) !== 'lnk') continue;
            const rMode = lk.getAttribute('rMode') || '';
            const k = childByLocal(lk, 'key');
            if (!k) continue;
            const targetType = k.getAttribute('typeID') || '';
            const rawLinkElems: string[] = [];
            for (let e = 0; e < k.children.length; e++) {
              if (localName(k.children[e]) === 'elem') {
                rawLinkElems.push((k.children[e].textContent || '').trim());
              }
            }
            const nonEmptyElems = rawLinkElems.filter(Boolean);
            let targetName = nonEmptyElems[0] || '';
            let targetNamespace = nonEmptyElems[1] || '';
            if (targetType === 'Channel' && rawLinkElems.length >= 3) {
              targetName = rawLinkElems[2];
              targetNamespace = [rawLinkElems[0], rawLinkElems[1]].filter(Boolean).join(' / ');
            } else if (targetType === 'Service' && rawLinkElems.length >= 2) {
              targetName = rawLinkElems[1];
              targetNamespace = rawLinkElems[0];
            }
            links.push({
              role,
              kpos,
              rMode,
              targetType,
              targetOid: k.getAttribute('oid') || '',
              targetName,
              targetNamespace,
              elems: nonEmptyElems,
            });
          }
        }
      }
      const ti = childByLocal(generic, 'textInfo');
      if (ti) {
        for (let i = 0; i < ti.children.length; i++) {
          const tobj = ti.children[i];
          if (localName(tobj) !== 'textObj') continue;
          const masterL = tobj.getAttribute('masterL') || '';
          for (let j = 0; j < tobj.children.length; j++) {
            const txs = tobj.children[j];
            if (localName(txs) !== 'texts') continue;
            const lang = txs.getAttribute('lang') || masterL;
            for (let k = 0; k < txs.children.length; k++) {
              const tx = txs.children[k];
              if (localName(tx) !== 'text') continue;
              const body = (tx.textContent || '').trim();
              if (body) {
                texts.push({ lang, label: tx.getAttribute('label') || '', text: body });
              }
            }
          }
        }
      }
    }

    const contentEl = childByLocal(elem, 'content');
    const contentXml = contentEl ? serializeXmlPretty(contentEl) : '';
    const resources = contentXml ? unpackEmbeddedBlobs(contentXml) : [];

    let mapping: MappingPayload | null = null;
    const textualResources: TextualResource[] = [];
    const classResources: ClassResource[] = [];
    const classRawBytes = new Map<number, Uint8Array>();

    resources.forEach((res, idx) => {
      if (res.kind === 'mappingtool' && !mapping) {
        mapping = parseMappingToolPayload(res.bytes);
      }
      if (res.kind === 'class') {
        const browserInspection = inspectJvmClassBytes(res.bytes);
        classResources.push({ index: idx, path: res.path, size: res.size, browserInspection });
        classRawBytes.set(idx, res.bytes);
      } else if (res.kind === 'xsd' || res.kind === 'wsdl' || res.kind === 'xsl' || res.kind === 'xml' || res.kind === 'mappingtool') {
        textualResources.push({
          index: idx,
          path: res.path,
          kind: res.kind,
          size: res.size,
          content: utf8Dec.decode(res.bytes),
        });
      }
    });

    const channel = parseChannelDom(contentEl, links, partyVal, serviceVal, name);

    const processSteps: ProcessStepInfo[] = [];
    if (typeId === 'process' && contentEl) {
      const roleMap = new Map<string, string>();
      for (const l of links) {
        if (l.role && l.targetName) roleMap.set(l.role.toLowerCase(), l.targetName);
      }
      const all = contentEl.getElementsByTagName('*');
      for (let i = 0; i < all.length; i++) {
        const tn = localName(all[i]);
        if (tn === 'processstep_process' || tn === 'componentprocess') {
          const sid = all[i].getAttribute('id') || '';
          processSteps.push({
            id: sid,
            name: all[i].getAttribute('name') || roleMap.get(sid.toLowerCase()) || sid,
            type: all[i].getAttribute('type') || tn,
          });
        }
      }
    }

    const id = hashId(`${archiveId}:${containerName}:${typeId}:${oid}:${vid}:${name}:${seq}`);
    const detail: TpzObjectDetail = {
      id,
      archiveId,
      archiveName,
      containerName,
      typeId: typeId || 'UNKNOWN',
      oid,
      vid,
      name: name || oid || 'Unnamed',
      namespace,
      swcv,
      modifBy,
      modifAt,
      owner,
      depth,
      parentOid,
      linkCount: links.length,
      textCount: texts.length,
      fieldMappingCount: mapping ? (mapping as MappingPayload).fieldMappings.length : 0,
      udfCount: mapping ? (mapping as MappingPayload).udfs.length : 0,
      classCount: classResources.length,
      schemaCount: textualResources.filter((r) => r.kind !== 'mappingtool').length,
      hasChannel: Boolean(channel),
      adapterType: channel?.adapterType || '',
      direction: channel?.direction || '',
      links,
      texts,
      contentXml,
      mapping,
      channel,
      processSteps,
      textualResources,
      classResources,
    };

    return { detail, classRawBytes };
  }

  inspectClass(objectId: string, resourceIndex: number): DecompileResult {
    const entry = this.objects.get(objectId);
    if (!entry) throw new Error('Object not found');
    const raw = entry.classRawBytes.get(resourceIndex);
    const clsMeta = entry.detail.classResources.find((c) => c.index === resourceIndex);
    if (!raw || !clsMeta) throw new Error('Class resource not found');
    const summary = clsMeta.browserInspection || inspectJvmClassBytes(raw);
    const pseudo = summary ? formatBrowserClassPseudoJava(summary) : '// Unable to parse .class constant pool';
    return {
      path: clsMeta.path,
      size: clsMeta.size,
      cfrJava: pseudo,
      javapText: '',
      decompilerUsed: 'browser-bytecode-inspector',
      browserInspection: summary,
    };
  }

  search(query: string, limit = 200): GlobalSearchResults {
    const q = query.trim().toLowerCase();
    const out: GlobalSearchResults = {
      query,
      objects: [],
      fieldMappings: [],
      udfs: [],
      channels: [],
      texts: [],
    };
    if (!q) return out;

    for (const { detail: o } of this.objects.values()) {
      if (
        o.name.toLowerCase().includes(q) ||
        o.namespace.toLowerCase().includes(q) ||
        o.typeId.toLowerCase().includes(q) ||
        o.oid.toLowerCase().includes(q)
      ) {
        if (out.objects.length < limit) out.objects.push(this.toSummary(o));
      }
      if (o.mapping) {
        for (const fm of o.mapping.fieldMappings) {
          if (
            fm.targetPath.toLowerCase().includes(q) ||
            fm.expression.toLowerCase().includes(q) ||
            fm.sources.some((s) => s.toLowerCase().includes(q)) ||
            fm.constants.some((c) => c.toLowerCase().includes(q)) ||
            fm.udfs.some((u) => u.toLowerCase().includes(q))
          ) {
            if (out.fieldMappings.length < limit) {
              out.fieldMappings.push({
                objectId: o.id,
                mappingName: o.name,
                archiveName: o.archiveName,
                ...fm,
              });
            }
          }
        }
        for (const u of o.mapping.udfs) {
          if (u.name.toLowerCase().includes(q) || u.javaCode.toLowerCase().includes(q)) {
            if (out.udfs.length < limit) {
              out.udfs.push({
                objectId: o.id,
                mappingName: o.name,
                archiveName: o.archiveName,
                name: u.name,
                key: u.key,
                lineCount: u.lineCount,
              });
            }
          }
        }
      }
      if (o.channel) {
        for (const attr of o.channel.attributes) {
          if (attr.name.toLowerCase().includes(q) || attr.value.toLowerCase().includes(q)) {
            if (out.channels.length < limit) {
              out.channels.push({
                objectId: o.id,
                channelName: o.name,
                archiveName: o.archiveName,
                adapterType: o.channel.adapterType,
                attributeName: attr.name,
                attributeValue: attr.value,
              });
            }
          }
        }
      }
      for (const tx of o.texts) {
        if (tx.text.toLowerCase().includes(q) || tx.label.toLowerCase().includes(q)) {
          if (out.texts.length < limit) {
            out.texts.push({
              objectId: o.id,
              objectName: o.name,
              typeId: o.typeId,
              archiveName: o.archiveName,
              ...tx,
            });
          }
        }
      }
    }
    return out;
  }
}
