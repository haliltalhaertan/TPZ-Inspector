import { simulateMappingInBrowser } from './browserMappingSimulator';
import { BrowserTpzStore } from './tpzBrowserParser';
import type {
  DecompileResult,
  EngineCapabilities,
  EngineMode,
  GlobalSearchResults,
  MappingPayload,
  RepackOptions,
  SimulationResult,
  TpzArchiveSummary,
  TpzObjectDetail,
} from './types';

const DEFAULT_LOCAL_BASES = ['', 'http://127.0.0.1:8765'];

export class DualTpzController {
  private browserStore = new BrowserTpzStore();
  private localBaseUrl: string | null = null;
  private mode: EngineMode = 'browser';
  private lastLocalCaps: Partial<EngineCapabilities> = {};

  getMode(): EngineMode {
    return this.mode;
  }

  setMode(next: EngineMode) {
    if (next === 'local' && !this.localBaseUrl && this.localBaseUrl !== '') {
      throw new Error('Local Power Engine is not reachable.');
    }
    this.mode = next;
  }

  async probeLocalBackend(): Promise<EngineCapabilities> {
    for (const base of DEFAULT_LOCAL_BASES) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1400);
        const resp = await fetch(`${base}/api/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.ok) {
            this.localBaseUrl = base;
            this.lastLocalCaps = data;
            return {
              mode: this.mode === 'local' ? 'local-power' : 'browser',
              localAvailable: true,
              hasJava: Boolean(data.hasJava),
              hasJavac: Boolean(data.hasJavac),
              hasJavap: Boolean(data.hasJavap),
              hasCfr: Boolean(data.hasCfr),
              hasRepack: Boolean(data.hasRepack),
              hasSimulator: Boolean(data.hasSimulator),
              cfrJar: data.cfrJar || null,
              loadedArchives: data.loadedArchives || 0,
              loadedObjects: data.loadedObjects || 0,
            };
          }
        }
      } catch {
        // Ignore unreachable candidate
      }
    }
    this.localBaseUrl = null;
    if (this.mode === 'local') {
      this.mode = 'browser';
    }
    return {
      mode: 'browser',
      localAvailable: false,
      hasJava: false,
      hasJavap: false,
      hasCfr: false,
      cfrJar: null,
      loadedArchives: this.browserStore.archives.size,
      loadedObjects: this.browserStore.objects.size,
    };
  }

  async listArchives(): Promise<TpzArchiveSummary[]> {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const resp = await fetch(`${this.localBaseUrl}/api/archives`);
      if (!resp.ok) throw new Error('Failed to list archives from local engine');
      const data = await resp.json();
      return data.archives || [];
    }
    return Array.from(this.browserStore.archives.values());
  }

  async loadFiles(files: FileList | File[]): Promise<TpzArchiveSummary[]> {
    const arr = Array.from(files);
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const form = new FormData();
      for (const f of arr) form.append('files', f);
      const resp = await fetch(`${this.localBaseUrl}/api/archives/upload`, {
        method: 'POST',
        body: form,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || 'Upload failed');
      }
      const data = await resp.json();
      return data.loaded || [];
    }

    const loaded: TpzArchiveSummary[] = [];
    for (const f of arr) {
      const buf = await f.arrayBuffer();
      loaded.push(this.browserStore.loadTpzBuffer(f.name, buf));
    }
    return loaded;
  }

  async loadDiskPath(diskPath: string): Promise<{ loaded: TpzArchiveSummary[]; errors: Array<{ file: string; error: string }> }> {
    if (this.localBaseUrl === null) {
      throw new Error('Local Power Engine must be running to read disk paths directly.');
    }
    this.mode = 'local';
    const resp = await fetch(`${this.localBaseUrl}/api/archives/load-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: diskPath }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || 'Failed to load path');
    }
    return resp.json();
  }

  async removeArchive(archiveId: string): Promise<void> {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      await fetch(`${this.localBaseUrl}/api/archives/${archiveId}`, { method: 'DELETE' });
      return;
    }
    this.browserStore.clearArchive(archiveId);
  }

  async getObjectDetail(objectId: string): Promise<TpzObjectDetail> {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const resp = await fetch(`${this.localBaseUrl}/api/objects/${objectId}`);
      if (!resp.ok) throw new Error('Failed to load object details');
      return resp.json();
    }
    return this.browserStore.getObjectDetail(objectId);
  }

  async decompileClass(objectId: string, resourceIndex: number): Promise<DecompileResult> {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const resp = await fetch(`${this.localBaseUrl}/api/objects/${objectId}/decompile/${resourceIndex}`, {
        method: 'POST',
      });
      if (!resp.ok) throw new Error('Decompilation failed');
      return resp.json();
    }
    return this.browserStore.inspectClass(objectId, resourceIndex);
  }

  async search(query: string): Promise<GlobalSearchResults> {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const resp = await fetch(`${this.localBaseUrl}/api/search?q=${encodeURIComponent(query)}`);
      if (!resp.ok) throw new Error('Search failed');
      return resp.json();
    }
    return this.browserStore.search(query);
  }

  async verifyArchive(archiveId: string) {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const resp = await fetch(`${this.localBaseUrl}/api/archives/${encodeURIComponent(archiveId)}/verify`);
      if (!resp.ok) throw new Error('Archive verification failed');
      return resp.json();
    }
    const arch = this.browserStore.archives.get(archiveId);
    if (!arch) throw new Error(`Archive not found: ${archiveId}`);
    const containers = arch.containers.map((c) => ({
      container: c.name,
      ...(c.crcIntegrity || { validMagic: false, verified: false, errors: ['Non-standard container'] }),
    }));
    return {
      archiveId,
      fileName: arch.fileName,
      allVerified: containers.length > 0 && containers.every((c) => c.verified),
      containerCount: containers.length,
      containers,
    };
  }

  async repackArchive(archiveId: string, options: RepackOptions): Promise<{ blob: Blob; fileName: string; summary: Record<string, unknown> }> {
    if (this.localBaseUrl === null) {
      throw new Error('Local Power Engine must be active to repack/sanitize .tpz archives.');
    }
    const resp = await fetch(`${this.localBaseUrl}/api/archives/${encodeURIComponent(archiveId)}/repack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || 'TPZ repack failed');
    }
    const disp = resp.headers.get('Content-Disposition') || '';
    const fnMatch = disp.match(/filename="([^"]+)"/i);
    const fileName = fnMatch ? fnMatch[1] : options.outputName || 'repacked.tpz';
    const summaryHeader = resp.headers.get('X-TPZ-Repack-Summary');
    const summary = summaryHeader ? JSON.parse(summaryHeader) : {};
    const blob = await resp.blob();
    return { blob, fileName, summary };
  }

  async simulateMapping(
    objectId: string,
    mapping: MappingPayload,
    sourceXml: string,
    executeJavaUdfs = true
  ): Promise<SimulationResult> {
    if (this.mode === 'local' && this.localBaseUrl !== null) {
      const resp = await fetch(`${this.localBaseUrl}/api/objects/${encodeURIComponent(objectId)}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceXml, executeJavaUdfs }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || 'Simulation failed');
      }
      return resp.json();
    }
    return simulateMappingInBrowser(mapping, sourceXml);
  }

  getLocalCapSnapshot() {
    return this.lastLocalCaps;
  }
}
