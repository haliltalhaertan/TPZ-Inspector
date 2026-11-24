export type EngineMode = 'browser' | 'local';
export type Lang = 'en' | 'tr';

export interface EngineCapabilities {
  mode: 'browser' | 'local-power';
  localAvailable: boolean;
  hasJava: boolean;
  hasJavac?: boolean;
  hasJavap: boolean;
  hasCfr: boolean;
  hasRepack?: boolean;
  hasSimulator?: boolean;
  cfrJar?: string | null;
  loadedArchives: number;
  loadedObjects: number;
}

export interface SimulatedStepQueue {
  nodeId: string;
  kind: 'source' | 'func' | 'udf' | 'const' | 'target';
  label: string;
  path?: string;
  queue: string[];
  error?: string;
}

export interface SimulatedTargetQueue {
  targetPath: string;
  expression: string;
  queue: string[];
  nonSuppressedCount: number;
  suppressedCount: number;
  contextCount: number;
  udfsExecuted: string[];
  stepQueues: SimulatedStepQueue[];
}

export interface UdfExecutionStatus {
  name: string;
  cacheType: string;
  status: 'ok' | 'compile_error' | 'runtime_error' | 'skipped';
  calls: number;
  compiledWith: string;
  error: string;
}

export interface SimulationResult {
  ok: boolean;
  error?: string;
  engine: string;
  durationMs: number;
  targetXml: string;
  targetQueues: SimulatedTargetQueue[];
  udfExecutions: UdfExecutionStatus[];
  traces: Array<{ level: string; source: string; message: string }>;
  warnings: string[];
}

export interface TptCrcIntegrity {
  validMagic: boolean;
  verified: boolean;
  physicalBytes: number;
  logicalBytes: number;
  chunksChecked: number;
  chunksOk: number;
  headerCrcOk: boolean;
  preCatalogCrcOk: boolean;
  catMode: string;
  catalogStartsXml: boolean;
  segmentCount: number;
  contiguousSegments: boolean;
  modelElementsExact: number;
  modelElementsTotal: number;
  pvcElementsTotal?: number;
  pvcOidConsistent?: number;
  catMarkersChecked?: number;
  catMarkersOk?: number;
  headerVersionSetId?: string;
  vsetFirstTlvMatchesHeader?: boolean | null;
  vsetSecondTlvId?: string;
  vsetSecondTlvInDevlines?: boolean | null;
  vsetSecondTlvDevlineLabel?: string;
  vsetSpecCode?: number | null;
  vsetSpecMatchesHeader?: boolean | null;
  zipFlagBit3?: boolean;
  vsetMembershipRows?: number;
  vsetMembershipMatchesHeader?: number;
  vsetMembershipJoinedPvc?: number;
  pvcR16Total?: number;
  pvcR16MatchesHeader?: number;
  knownDevlinesCount?: number;
  pvcR3Total?: number;
  pvcR3ResolvedDevlines?: number;
  pvcR3UnresolvedUnique?: number;
  pvcR3UnresolvedIds?: string[];
  errors: string[];
}

export interface ContainerSummary {
  name: string;
  kind: 'primary' | 'delta';
  bytes: number;
  segments: number;
  objects: number;
  crcIntegrity?: TptCrcIntegrity | null;
}

export interface RepackOptions {
  replacements?: Array<{ find: string; replace: string }>;
  channelPatches?: Array<{ channelName?: string; attribute: string; value: string }>;
  sanitize?: boolean;
  includeHeader?: boolean;
  outputName?: string;
}

export interface ArchiveStats {
  totalObjects: number;
  typeCounts: Record<string, number>;
  messageMappings: number;
  fieldMappings: number;
  udfs: number;
  javaClasses: number;
  xsltFiles: number;
  channels: number;
  ccBpmProcesses: number;
  complexityScore: number;
  complexityTier: string;
}

export interface TpzObjectSummary {
  id: string;
  archiveId: string;
  archiveName: string;
  containerName: string;
  typeId: string;
  oid: string;
  vid: string;
  name: string;
  namespace: string;
  swcv: string;
  modifBy: string;
  modifAt: string;
  owner: string;
  depth: number;
  parentOid?: string | null;
  linkCount: number;
  textCount: number;
  fieldMappingCount: number;
  udfCount: number;
  classCount: number;
  schemaCount: number;
  hasChannel: boolean;
  adapterType: string;
  direction: string;
}

export interface TpzArchiveSummary {
  archiveId: string;
  fileName: string;
  sizeBytes: number;
  parsedInMs: number;
  metadata: Record<string, string>;
  containers: ContainerSummary[];
  warnings: string[];
  stats: ArchiveStats;
  objects: TpzObjectSummary[];
}

export interface ObjectLink {
  role: string;
  kpos: string;
  rMode: string;
  targetType: string;
  targetOid: string;
  targetName: string;
  targetNamespace: string;
  elems: string[];
}

export interface MultilingualText {
  lang: string;
  label: string;
  text: string;
}

export interface FieldMappingRow {
  targetPath: string;
  expression: string;
  sources: string[];
  constants: string[];
  udfs: string[];
  schemaFormat: 'brick' | 'legacy_destPath';
}

export interface UdfArgument {
  name: string;
  javaType: string;
}

export interface UdfDefinition {
  key: string;
  name: string;
  title: string;
  tab: string;
  cacheType: string;
  implementationType: string;
  arguments: UdfArgument[];
  javaCode: string;
  lineCount: number;
}

export interface MappingGraphNode {
  id: string;
  kind: 'source' | 'func' | 'udf' | 'const' | 'target';
  label: string;
  path?: string;
  value?: string;
  function?: string;
  namespace?: string;
  parameters?: Record<string, string>;
  udfKey?: string;
  targetGroup: string;
}

export interface MappingGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface MappingPayload {
  fieldMappings: FieldMappingRow[];
  udfs: UdfDefinition[];
  graphNodes: MappingGraphNode[];
  graphEdges: MappingGraphEdge[];
}

export interface ChannelAttribute {
  name: string;
  value: string;
  isKey: boolean;
}

export interface ChannelDetails {
  party: string;
  service: string;
  channelName: string;
  direction: string;
  engineType: string;
  adapterType: string;
  adapterNamespace: string;
  transportProtocol: string;
  transportProtocolVersion: string;
  messageProtocol: string;
  messageProtocolVersion: string;
  description: string;
  attributes: ChannelAttribute[];
}

export interface ProcessStepInfo {
  id: string;
  name: string;
  type: string;
}

export interface TextualResource {
  index: number;
  path: string;
  kind: 'xsd' | 'wsdl' | 'xsl' | 'xml' | 'mappingtool';
  size: number;
  content: string;
}

export interface ClassResource {
  index: number;
  path: string;
  size: number;
  browserInspection?: JvmClassSummary;
}

export interface JvmClassSummary {
  className: string;
  superClassName: string;
  javaVersion: string;
  interfaces: string[];
  fields: string[];
  methods: string[];
  stringLiterals: string[];
}

export interface PvcMembershipInfo {
  versionSetId: string;
  matchesHeader: boolean;
  v4: number;
  v5: number;
  timestampMs: number;
  v6v7Equal: boolean;
}

export interface KnownDevlineEntry {
  idHex: string;
  id: string;
  field2Hex: string;
  field3: string;
  field4: string;
  field5: string;
  scope?: 'local' | 'workspace';
  sourceArchive?: string;
  sourceContainer?: string;
}

export interface PvcVersionInfo {
  version: number;
  oid: string;
  vid: string;
  oidConsistent: boolean;
  branchIdCandidate: string;
  modelVersion: string;
  branchSeqNo: number;
  objState: number;
  isDeleted: boolean;
  creatorName: string;
  creationTimeMs: number;
  lastModifiedMs: number;
  isArchived: boolean;
  relationRows: number;
  predecessorRows: number;
  visRelationRows: number;
  r3Count?: number;
  ownerVsIds?: string[];
  ownerVsIdCounts?: Record<string, number>;
  tailVersionSetIds?: string[];
  r17Values?: number[];
  headerVersionSetId?: string;
  r16MatchesHeader?: boolean;
  membership?: PvcMembershipInfo | null;
  devlines?: KnownDevlineEntry[];
  crossArchiveDevlines?: KnownDevlineEntry[];
  unresolvedOwnerVsIds?: string[];
  exactConsumed: boolean;
}

export interface TpzObjectDetail extends TpzObjectSummary {
  links: ObjectLink[];
  texts: MultilingualText[];
  contentXml: string;
  mapping?: MappingPayload | null;
  channel?: ChannelDetails | null;
  processSteps: ProcessStepInfo[];
  textualResources: TextualResource[];
  classResources: ClassResource[];
  pvcInfo?: PvcVersionInfo | null;
}

export interface DecompileResult {
  path: string;
  size: number;
  cfrJava: string;
  javapText: string;
  decompilerUsed: string;
  browserInspection?: JvmClassSummary;
}

export interface GlobalSearchResults {
  query: string;
  objects: TpzObjectSummary[];
  fieldMappings: Array<FieldMappingRow & { objectId: string; mappingName: string; archiveName: string }>;
  udfs: Array<{ objectId: string; mappingName: string; archiveName: string; name: string; key: string; lineCount: number }>;
  channels: Array<{ objectId: string; channelName: string; archiveName: string; adapterType: string; attributeName: string; attributeValue: string }>;
  texts: Array<MultilingualText & { objectId: string; objectName: string; typeId: string; archiveName: string }>;
}
