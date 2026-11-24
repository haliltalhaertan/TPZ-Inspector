import type { TpzArchiveSummary, TpzObjectDetail } from './types';

function escXml(val: string | number | undefined | null): string {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWorksheet(name: string, headers: string[], rows: Array<Array<string | number>>): string {
  const safeName = escXml(name.replace(/[\\/?*[\]:]/g, '_').slice(0, 31));
  const headerCells = headers
    .map((h) => `<Cell ss:StyleID="sHeader"><Data ss:Type="String">${escXml(h)}</Data></Cell>`)
    .join('');
  const bodyRows = rows
    .map(
      (r) =>
        `<Row>${r
          .map((cell) => {
            const isNum = typeof cell === 'number' && Number.isFinite(cell);
            return `<Cell ss:StyleID="sBody"><Data ss:Type="${isNum ? 'Number' : 'String'}">${escXml(cell)}</Data></Cell>`;
          })
          .join('')}</Row>`
    )
    .join('\n');

  return `<Worksheet ss:Name="${safeName}">
    <Table>
      <Row ss:Height="22">${headerCells}</Row>
      ${bodyRows}
    </Table>
  </Worksheet>`;
}

/**
 * Exports a multi-tab Excel Workbook (.xls SpreadsheetML opened natively by Excel)
 * containing Object Inventory, Field Mappings Spec, UDF Catalog, and Channel Configs.
 */
export function exportObjectsToExcelSpec(
  archives: TpzArchiveSummary[],
  detailedObjects: TpzObjectDetail[],
  fileName = 'SAP_PO_TPZ_Technical_Spec.xls'
) {
  const inventoryRows: Array<Array<string | number>> = [];
  for (const arch of archives) {
    for (const o of arch.objects) {
      inventoryRows.push([
        arch.fileName,
        o.typeId,
        o.name,
        o.namespace,
        o.swcv,
        o.fieldMappingCount,
        o.udfCount,
        o.classCount,
        o.adapterType,
        o.modifBy,
        o.modifAt,
      ]);
    }
  }

  const mappingRows: Array<Array<string | number>> = [];
  const udfRows: Array<Array<string | number>> = [];
  const channelRows: Array<Array<string | number>> = [];

  for (const d of detailedObjects) {
    if (d.mapping) {
      for (const fm of d.mapping.fieldMappings) {
        mappingRows.push([
          d.archiveName,
          d.name,
          fm.targetPath,
          fm.expression,
          fm.sources.join('; '),
          fm.constants.join(' | '),
          fm.udfs.join(', '),
          fm.schemaFormat,
        ]);
      }
      for (const u of d.mapping.udfs) {
        udfRows.push([
          d.archiveName,
          d.name,
          u.name,
          u.key,
          u.cacheType,
          u.arguments.map((a) => `${a.javaType} ${a.name}`).join(', '),
          u.lineCount,
          u.javaCode.slice(0, 8000),
        ]);
      }
    }
    if (d.channel) {
      for (const attr of d.channel.attributes) {
        channelRows.push([
          d.archiveName,
          d.name,
          d.channel.service,
          d.channel.direction,
          d.channel.adapterType,
          d.channel.transportProtocol,
          attr.name,
          attr.value,
          attr.isKey ? 'YES' : '',
        ]);
      }
    }
  }

  const sheets: string[] = [
    buildWorksheet(
      'Object Inventory',
      ['Archive', 'Type', 'Object Name', 'Namespace', 'SWCV', 'Field Mappings', 'UDFs', 'Java Classes', 'Adapter', 'Modified By', 'Modified At'],
      inventoryRows
    ),
  ];

  if (mappingRows.length > 0) {
    sheets.push(
      buildWorksheet(
        'Field Mappings Spec',
        ['Archive', 'Message Mapping', 'Target Path', 'Expression / Rule', 'Source Paths', 'Constants', 'UDFs Used', 'Format'],
        mappingRows
      )
    );
  }
  if (udfRows.length > 0) {
    sheets.push(
      buildWorksheet(
        'UDF Catalog',
        ['Archive', 'Message Mapping', 'UDF Name', 'Key', 'Cache Type', 'Signature', 'Lines', 'Java Code'],
        udfRows
      )
    );
  }
  if (channelRows.length > 0) {
    sheets.push(
      buildWorksheet(
        'Channels Config',
        ['Archive', 'Channel Name', 'Business Component', 'Direction', 'Adapter', 'Transport', 'Attribute Name', 'Attribute Value', 'Key Param'],
        channelRows
      )
    );
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="sHeader">
   <Font ss:Bold="1" ss:Color="#FFFFFF" ss:Size="11"/>
   <Interior ss:Color="#1E293B" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="sBody">
   <Alignment ss:Vertical="Top" ss:WrapText="0"/>
   <Font ss:Size="10"/>
  </Style>
 </Styles>
 ${sheets.join('\n')}
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function generateCpiGroovySkeleton(udfName: string, args: Array<{ name: string; javaType: string }>, javaCode: string): string {
  const groovyParams = args.map((a, idx) => `String ${a.name || `arg${idx + 1}`}`).join(', ');
  const indentedLegacy = javaCode
    .split(/\r?\n/)
    .map((l) => `    // ${l}`)
    .join('\n');

  return `import com.sap.it.api.mapping.*

/**
 * SAP Cloud Integration (CPI) Groovy UDF Skeleton
 * Migrated from SAP PI/PO Message Mapping UDF: ${udfName}
 */
def String ${udfName.replace(/[^A-Za-z0-9_]/g, '_')}(${groovyParams}${groovyParams ? ', ' : ''}MappingContext context) {
    // Original SAP PO Java UDF implementation for reference:
${indentedLegacy || '    // (empty)'}

    // TODO: Adapt SAP PO Container / Trace calls to MappingContext if used
    return ${args[0]?.name || '""'}
}
`;
}
