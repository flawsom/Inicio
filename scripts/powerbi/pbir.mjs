/**
 * Compose a PBIR report from the study model.
 *
 * The report is deliberately an editorial design dossier, not a wall of default
 * visuals: a dark cover, a warm paper canvas, a narrow measure/field grammar and
 * pages that answer different questions (what is in the instrument, how it routes,
 * how it will be analysed, and what fieldwork data is still absent). Every field
 * reference is emitted from the declared semantic model, so a visual cannot quietly
 * point at a measure that does not exist.
 */
import { createHash } from 'node:crypto';

const VISUAL_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.9.0/schema.json';
const PAGE_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json';
const PAGES_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json';
const REPORT_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json';
const VERSION_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json';
const DEFINITION_PBIR_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json';
const PLATFORM_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json';
const PBISM_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json';

export const REPORT_DEFINITION_VERSION = '2.0.0';
export const THEME_NAME = 'Inicio Research Intelligence';
export const BASE_THEME_NAME = 'Fluent2-CY26SU10';

const C = {
  paper: '#F6F0E6',
  card: '#FFFDF9',
  ink: '#1C1917',
  muted: '#756A5E',
  faint: '#A79B8D',
  hairline: '#DED1C0',
  accent: '#B4431D',
  accentSoft: '#D97A4B',
  dark: '#151210',
  darkPanel: '#201B17',
  darkLine: '#40352C',
  cream: '#F5EADB',
  teal: '#0E6B63',
  ochre: '#B27A1E',
  slate: '#395B70',
  plum: '#70465F',
  olive: '#66704A',
};

const FONT = {
  display: 'Georgia',
  body: 'Segoe UI',
  semibold: 'Segoe UI Semibold',
};

function stableId(label) {
  return createHash('sha1').update(String(label)).digest('hex').slice(0, 20);
}

function literal(value) {
  return { expr: { Literal: { Value: String(value) } } };
}

function textLiteral(value) {
  return literal(`'${String(value ?? '').replace(/'/g, "''")}'`);
}

function bool(value) {
  return literal(value ? 'true' : 'false');
}

function numberLiteral(value) {
  return literal(`${value}D`);
}

function colorValue(value) {
  return { solid: { color: textLiteral(value) } };
}

function fieldColumn(entity, property) {
  return {
    Column: {
      Expression: { SourceRef: { Entity: entity } },
      Property: property,
    },
  };
}

function fieldMeasure(entity, property) {
  return {
    Measure: {
      Expression: { SourceRef: { Entity: entity } },
      Property: property,
    },
  };
}

function columnProjection(entity, property) {
  return {
    field: fieldColumn(entity, property),
    queryRef: `${entity}.${property}`,
    nativeQueryRef: property,
  };
}

function measureProjection(entity, property) {
  return {
    field: fieldMeasure(entity, property),
    queryRef: `${entity}.${property}`,
    nativeQueryRef: property,
  };
}

function container({
  fill = null,
  border = null,
  radius = 8,
  showTitle = false,
  title = '',
  titleColor = C.ink,
  titleSize = 10,
  padding = null,
  shadow = false,
} = {}) {
  const output = {
    title: [{
      properties: {
        show: bool(showTitle),
        ...(showTitle ? { text: textLiteral(title), fontColor: colorValue(titleColor), fontSize: numberLiteral(titleSize) } : {}),
      },
    }],
    background: [{
      properties: fill
        ? { show: bool(true), color: colorValue(fill), transparency: numberLiteral(0) }
        : { show: bool(false) },
    }],
    border: [{
      properties: border
        ? { show: bool(true), color: colorValue(border), radius: numberLiteral(radius), width: numberLiteral(1) }
        : { show: bool(false) },
    }],
    dropShadow: [{
      properties: shadow
        ? {
          show: bool(true),
          color: colorValue('#1C1917'),
          transparency: numberLiteral(86),
          shadowBlur: numberLiteral(18),
          shadowDistance: numberLiteral(5),
          shadowAngle: numberLiteral(45),
        }
        : { show: bool(false) },
    }],
    visualHeader: [{ properties: { show: bool(false) } }],
  };
  if (padding !== null) {
    output.padding = [{
      properties: {
        top: numberLiteral(padding),
        bottom: numberLiteral(padding),
        left: numberLiteral(padding),
        right: numberLiteral(padding),
      },
    }];
  }
  return output;
}

function position(x, y, width, height, z, tabOrder = z) {
  return { x, y, z, height, width, tabOrder };
}

function textRunStyle({ font = FONT.body, size = 10, color = C.ink, weight = 'normal', italic = false } = {}) {
  return {
    fontFamily: font,
    fontSize: `${size}pt`,
    color,
    fontWeight: weight,
    ...(italic ? { fontStyle: 'italic' } : {}),
  };
}

function paragraphs(text, style) {
  const lines = String(text ?? '').split('\n');
  return lines.map((line) => ({
    textRuns: [{ value: line || ' ', textStyle: style }],
  }));
}

function visualShell(engine, visual) {
  return {
    $schema: VISUAL_SCHEMA,
    name: engine.name,
    position: engine.position,
    visual,
  };
}

class PageBuilder {
  constructor(study, displayName) {
    this.study = study;
    this.displayName = displayName;
    this.id = stableId(`page:${study.code}:${displayName}`);
    this.visuals = [];
    this.counter = 0;
  }

  add(label, visual) {
    this.counter += 1;
    const name = stableId(`visual:${this.study.code}:${this.displayName}:${label}:${this.counter}`);
    this.visuals.push({ name, json: visualShell({ name, position: visual.position }, visual.visual) });
  }

  text(label, x, y, width, height, text, options = {}) {
    const {
      font = FONT.body,
      size = 10,
      color = C.ink,
      weight = 'normal',
      italic = false,
      fill = null,
      border = null,
      radius = 8,
      padding = 0,
      z = 20,
      tabOrder = z,
      lineHeight = null,
    } = options;
    // The PBIR validator measures a textbox against its type size. Grow only
    // real text boxes: the one-pixel panels below are painted rules, not text.
    if (height > 1) {
      const floor = size >= 60
        ? Math.ceil(size * 1.78)
        : size >= 15
          ? Math.ceil(size * 1.6)
          : size >= 7
            ? 18
            : height;
      height = Math.max(height, floor);
    }
    const style = textRunStyle({ font, size, color, weight, italic });
    const paragraphsValue = paragraphs(text, style);
    this.add(label, {
      position: position(x, y, width, height, z, tabOrder),
      visual: {
        visualType: 'textbox',
        objects: {
          general: [{ properties: { paragraphs: paragraphsValue } }],
        },
        visualContainerObjects: container({ fill, border, radius, showTitle: false, padding }),
        drillFilterOtherVisuals: false,
      },
    });
    if (lineHeight !== null) {
      // Kept as a deliberate no-op hook: Power BI textboxes do not expose line
      // spacing in this schema, so page layouts use font size and height instead.
    }
  }

  line(label, x, y, width, height, options = {}) {
    const { fill = C.hairline, z = 0 } = options;
    this.add(label, {
      position: position(x, y, width, height, z, -1),
      visual: {
        visualType: 'shape',
        objects: {
          fill: [{ properties: { show: bool(true), fillColor: colorValue(fill) } }],
          outline: [{ properties: { show: bool(false) } }],
          shape: [{ properties: { tileShape: literal("'rectangle'") } }],
        },
        visualContainerObjects: container({ showTitle: false }),
        drillFilterOtherVisuals: false,
      },
    });
  }

  panel(label, x, y, width, height, options = {}) {
    const { fill = C.card, border = C.hairline, radius = 8, z = 0, padding = null, shadow = false } = options;
    this.add(label, {
      position: position(x, y, width, height, z, -1),
      visual: {
        visualType: 'textbox',
        objects: { general: [{ properties: { paragraphs: [{ textRuns: [{ value: ' ', textStyle: textRunStyle({ size: 1, color: fill }) }] }] } }] },
        visualContainerObjects: container({ fill, border, radius, showTitle: false, padding, shadow }),
        drillFilterOtherVisuals: false,
      },
    });
  }

  card(label, x, y, width, height, measure, options = {}) {
    const { valueSize = 24, labelSize = 9, z = 20, fill = C.card, border = C.hairline } = options;
    this.add(label, {
      position: position(x, y, width, height, z),
      visual: {
        visualType: 'cardVisual',
        query: { queryState: { Data: { projections: [measureProjection('_Measures', measure)] } } },
        objects: {
          value: [{
            properties: {
              fontSize: numberLiteral(valueSize),
              fontFamily: literal(FONT.display),
              fontColor: colorValue(C.ink),
            },
            selector: { id: 'default' },
          }],
          label: [{
            properties: {
              fontSize: numberLiteral(labelSize),
              fontFamily: literal(FONT.body),
              fontColor: colorValue(C.muted),
              show: bool(true),
            },
            selector: { id: 'default' },
          }],
          padding: [{
            properties: {
              paddingSelection: literal("'Custom'"),
              leftMargin: numberLiteral(8),
              topMargin: numberLiteral(8),
              bottomMargin: numberLiteral(8),
              rightMargin: numberLiteral(8),
            },
            selector: { id: 'default' },
          }],
          layout: [{
            properties: {
              cellPadding: numberLiteral(0),
              alignment: literal("'top'"),
              orientation: numberLiteral(0),
              columnCount: numberLiteral(1),
              rowCount: numberLiteral(1),
            },
            selector: { id: 'default' },
          }],
          spacing: [{
            properties: { verticalSpacing: numberLiteral(2) },
            selector: { id: 'default' },
          }],
        },
        visualContainerObjects: {
          ...container({ fill, border, radius: 9, showTitle: false }),
          padding: [{
            properties: {
              top: numberLiteral(8),
              bottom: numberLiteral(8),
              left: numberLiteral(8),
              right: numberLiteral(8),
            },
          }],
        },
        drillFilterOtherVisuals: true,
      },
    });
  }

  chart(label, x, y, width, height, {
    categoryEntity,
    categoryProperty,
    valueEntity,
    valueProperty,
    valueKind = 'column',
    sortEntity = valueEntity,
    sortProperty = valueProperty,
    sortKind = valueKind,
    fill = C.accent,
  }, options = {}) {
    const { z = 20 } = options;
    const sortField = sortKind === 'column'
      ? fieldColumn(sortEntity, sortProperty)
      : fieldMeasure(sortEntity, sortProperty);
    const valueProjection = valueKind === 'measure'
      ? measureProjection(valueEntity, valueProperty)
      : columnProjection(valueEntity, valueProperty);
    this.add(label, {
      position: position(x, y, width, height, z),
      visual: {
        visualType: 'clusteredBarChart',
        query: {
          sortDefinition: {
            sort: [{ field: sortField, direction: 'Descending' }],
            isDefaultSort: false,
          },
          queryState: {
            Category: { projections: [columnProjection(categoryEntity, categoryProperty)] },
            Y: { projections: [valueProjection] },
          },
        },
        objects: {
          dataPoint: [{ properties: { fill: colorValue(fill) } }],
          labels: [{
            properties: {
              show: bool(true),
              fontSize: numberLiteral(9),
              fontFamily: literal(FONT.body),
              color: colorValue(C.ink),
              labelOverflow: bool(false),
            },
          }],
          legend: [{ properties: { show: bool(false) } }],
          categoryAxis: [{
            properties: {
              show: bool(true),
              showAxisTitle: bool(false),
              fontFamily: literal(FONT.body),
              fontSize: numberLiteral(9),
              labelColor: colorValue(C.ink),
              maxMarginFactor: numberLiteral(35),
            },
          }],
          valueAxis: [{
            properties: {
              show: bool(false),
              showAxisTitle: bool(false),
              gridlineShow: bool(false),
            },
          }],
          general: [{ properties: { responsive: bool(false) } }],
        },
        visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8, showTitle: false }),
        drillFilterOtherVisuals: true,
      },
    });
  }

  table(label, x, y, width, height, projections, options = {}) {
    const { z = 20, sort = null } = options;
    const queryState = {
      Values: { projections },
    };
    const query = { queryState };
    if (sort) {
      query.sortDefinition = {
        sort: [{ field: sort.kind === 'column' ? fieldColumn(sort.entity, sort.property) : fieldMeasure(sort.entity, sort.property), direction: sort.direction ?? 'Ascending' }],
        isDefaultSort: false,
      };
    }
    this.add(label, {
      position: position(x, y, width, height, z),
      visual: {
        visualType: 'tableEx',
        query,
        objects: {
          grid: [{
            properties: {
              gridHorizontal: bool(true),
              gridHorizontalColor: colorValue(C.hairline),
              rowPadding: numberLiteral(7),
              outlineStyle: numberLiteral(1),
              outlineColor: colorValue(C.hairline),
            },
          }],
          columnHeaders: [{
            properties: {
              fontFamily: literal(FONT.semibold),
              fontSize: numberLiteral(8.5),
              fontColor: colorValue(C.muted),
              backColor: colorValue('#F1E7DA'),
              alignment: literal("'Left'"),
            },
          }],
          values: [{
            properties: {
              fontFamily: literal(FONT.body),
              fontSize: numberLiteral(8.5),
              fontColor: colorValue(C.ink),
              backColor: colorValue(C.card),
              backColorSecondary: colorValue('#FBF6EE'),
            },
          }],
        },
        visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8, showTitle: false }),
        drillFilterOtherVisuals: true,
      },
    });
  }

  slicer(label, x, y, width, height, entity, property, options = {}) {
    const { z = 20 } = options;
    this.add(label, {
      position: position(x, y, width, height, z),
      visual: {
        visualType: 'slicer',
        query: { queryState: { Values: { projections: [columnProjection(entity, property)] } } },
        objects: {
          data: [{ properties: { mode: literal("'Dropdown'") } }],
          selection: [{ properties: { singleSelect: bool(false) } }],
          header: [{ properties: { show: bool(false) } }],
        },
        visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8, showTitle: false }),
        drillFilterOtherVisuals: true,
      },
    });
  }

  json() {
    return {
      $schema: PAGE_SCHEMA,
      name: this.id,
      displayName: this.displayName,
      displayOption: 'FitToPage',
      width: 1280,
      height: 720,
      objects: {
        background: [{
          properties: {
            color: colorValue(this.displayName.startsWith('00') ? C.dark : C.paper),
            transparency: numberLiteral(0),
          },
        }],
      },
    };
  }
}

function addHeader(page, number, eyebrow, title, subtitle) {
  page.text('header-brand', 48, 24, 400, 18, 'INICIO / RESEARCH INTELLIGENCE', {
    size: 8,
    color: C.accent,
    weight: '600',
    z: 200,
  });
  page.text('header-page', 1170, 24, 62, 18, String(number).padStart(2, '0'), {
    size: 9,
    color: C.muted,
    weight: '600',
    z: 200,
  });
  page.text('header-title', 48, 46, 1040, 42, title, {
    font: FONT.display,
    size: title.length > 52 ? 23 : 26,
    color: C.ink,
    z: 200,
  });
  if (subtitle) {
    page.text('header-subtitle', 48, 90, 1080, 22, subtitle, {
      size: 9.5,
      color: C.muted,
      z: 200,
    });
  }
  page.line('header-rule', 48, 122, 1184, 1, { fill: C.hairline, z: 190 });
  page.text('footer', 48, 692, 940, 15, `INICIO RESEARCH INTELLIGENCE  ·  ${page.study.code}  ·  ${page.study.generatedAt.slice(0, 10)}  ·  ${page.study.counts.responses > 0 ? 'RESPONSE ROWS LOADED · DESIGN DOSSIER' : 'NO RESPONDENT DATA IN THIS BUILD'}`, {
    size: 7,
    color: C.faint,
    z: 200,
  });
  page.text('footer-page', 1110, 692, 122, 15, `${String(number).padStart(2, '0')} / 06`, {
    size: 7,
    color: C.faint,
    z: 200,
  });
}

function addChartHeading(page, x, y, title, subtitle = '', width = 540) {
  page.text('chart-heading', x, y, width, 18, title.toUpperCase(), {
    size: 8.5,
    color: C.muted,
    weight: '600',
    z: 200,
  });
  if (subtitle) {
    page.text('chart-subheading', x, y + 17, width, 16, subtitle, {
      size: 8,
      color: C.faint,
      z: 200,
    });
  }
}

function addNarrative(page, x, y, width, height, title, body, options = {}) {
  const { fill = '#EFE4D5', color = C.ink } = options;
  page.panel('narrative-panel', x, y, width, height, { fill, border: null, radius: 6, z: 10 });
  page.text('narrative-title', x + 14, y + 10, width - 28, 14, title.toUpperCase(), {
    size: 8,
    color: C.accent,
    weight: '600',
    z: 100,
  });
  page.text('narrative-body', x + 14, y + 30, width - 28, height - 38, body, {
    size: 8.8,
    color,
    z: 100,
  });
}

function coverPage(study) {
  const page = new PageBuilder(study, '00 Cover');
  page.panel('cover-bg', 0, 0, 1280, 720, { fill: C.dark, border: null, radius: 0, z: 0 });
  page.panel('cover-accent', 0, 0, 13, 720, { fill: C.accent, border: null, radius: 0, z: 5 });

  page.text('cover-label', 64, 54, 500, 18, 'POWER BI  /  RESEARCH INTELLIGENCE  /  DESIGN DOSSIER', {
    size: 8.5,
    color: C.accentSoft,
    weight: '600',
    z: 100,
  });
  page.text('cover-code', 64, 144, 760, 124, study.code, {
    font: FONT.display,
    size: study.code.length > 22 ? 44 : study.code.length > 13 ? 58 : 78,
    color: C.cream,
    z: 100,
  });
  page.text('cover-deck', 64, 288, 700, 58, 'Questionnaire design & fieldwork blueprint', {
    font: FONT.display,
    size: 22,
    color: C.cream,
    z: 100,
  });
  page.text('cover-deck-sub', 64, 348, 700, 50, `A forensic read of ${study.counts.questions} instrument rows, their routing, quality controls and analysis contract.`, {
    size: 11,
    color: '#B9A897',
    z: 100,
  });
  page.line('cover-rule', 64, 420, 620, 1, { fill: C.darkLine, z: 100 });

  page.text('cover-meta-label', 850, 132, 330, 16, 'AT A GLANCE', {
    size: 8,
    color: C.accentSoft,
    weight: '600',
    z: 150,
  });
  const metaRows = [
    ['STUDY', study.code],
    ['INSTRUMENT', `${study.counts.questions} rows · ${study.counts.sections} sections`],
    ['ANALYSIS', `${study.counts.families} method families`],
    ['BUILT', study.generatedAt.slice(0, 10)],
  ];
  page.panel('cover-meta-panel', 850, 154, 366, 286, { fill: C.darkPanel, border: C.darkLine, radius: 6, z: 120 });
  metaRows.forEach(([label, value], index) => {
    const y = 178 + index * 60;
    page.text('cover-meta-key', 878, y, 300, 14, label, {
      size: 7.5,
      color: '#988675',
      weight: '600',
      z: 160,
    });
    page.text('cover-meta-value', 878, y + 19, 310, 22, value, {
      font: FONT.display,
      size: 15,
      color: C.cream,
      z: 160,
    });
  });

  const strip = [
    ['QUESTIONS', String(study.counts.questions)],
    ['ROUTING RULES', String(study.counts.routed)],
    ['PLANNING BURDEN', `${study.counts.estimatedMinutes.toFixed(1)} min`],
  ];
  strip.forEach(([label, value], index) => {
    const x = 64 + index * 286;
    page.panel(`cover-kpi-${index}`, x, 474, 260, 92, { fill: C.darkPanel, border: C.darkLine, radius: 6, z: 120 });
    page.text('cover-kpi-value', x + 18, 490, 220, 36, value, {
      font: FONT.display,
      size: 27,
      color: C.cream,
      z: 160,
    });
    page.text('cover-kpi-label', x + 18, 534, 220, 16, label, {
      size: 7.5,
      color: C.accentSoft,
      weight: '600',
      z: 160,
    });
  });

  page.text('cover-bottom', 64, 628, 1120, 38, study.counts.responses > 0
    ? `Questionnaire-level evidence only. ${study.counts.responses} response rows are present, but this dossier does not present respondent findings.`
    : 'Questionnaire-level evidence only. Response tables are intentionally empty until fieldwork data is supplied; no respondent was invented for this design.', {
    size: 8.8,
    color: '#B9A897',
    z: 100,
  });
  page.text('cover-stamp', 1068, 628, 150, 38, 'DESIGN\n00 / 06', {
    size: 8,
    color: C.accentSoft,
    weight: '600',
    z: 100,
  });
  return page;
}

function executivePage(study) {
  const page = new PageBuilder(study, '01 Executive read');
  page.panel('page-bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  addHeader(page, 1, 'EXECUTIVE READ', 'The instrument at a glance', 'What the questionnaire contains, how much field time it implies, and where the analytical weight sits.');

  const cards = [
    ['Question count', 'Question count'],
    ['Answerable questions', 'Answerable questions'],
    ['Routing rules', 'Routing rules'],
    ['Estimated minutes', 'Estimated minutes'],
  ];
  cards.forEach(([measure], index) => {
    page.card(`kpi-${index}`, 48 + index * 300, 140, 282, 94, measure, { labelSize: 9 });
  });

  addChartHeading(page, 48, 252, 'Question volume by section', 'Compiled instrument rows · all sections');
  page.chart('section-volume', 48, 286, 580, 228, {
    categoryEntity: 'Sections',
    categoryProperty: 'Section',
    valueEntity: 'Sections',
    valueProperty: 'Plotted section questions',
    valueKind: 'measure',
    sortEntity: 'Sections',
    sortProperty: 'Plotted section questions',
    sortKind: 'measure',
    fill: C.accent,
  });

  addChartHeading(page, 650, 252, 'Question mix', 'Rendered type after compilation');
  page.chart('type-mix', 650, 286, 580, 228, {
    categoryEntity: 'QuestionTypes',
    categoryProperty: 'Type',
    valueEntity: 'QuestionTypes',
    valueProperty: 'Plotted type questions',
    valueKind: 'measure',
    sortEntity: 'QuestionTypes',
    sortProperty: 'Plotted type questions',
    sortKind: 'measure',
    fill: C.teal,
  });

  addNarrative(page, 48, 526, 1182, 122, 'Analyst read', study.narrative.executive.join('\n'), { fill: '#EFE4D5' });
  return page;
}

function architecturePage(study) {
  const page = new PageBuilder(study, '02 Instrument architecture');
  page.panel('page-bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  addHeader(page, 2, 'INSTRUMENT ARCHITECTURE', 'Sections, burden and control density', 'Where the questionnaire spends respondent attention — and which sections carry the most routing and validation.');

  addChartHeading(page, 48, 140, 'Section architecture', 'Volume, required state and planning burden');
  page.table('section-table', 48, 176, 742, 352, [
    columnProjection('Sections', 'Section'),
    columnProjection('Sections', 'Questions'),
    columnProjection('Sections', 'Required'),
    columnProjection('Sections', 'Routed'),
    columnProjection('Sections', 'Constraints'),
    columnProjection('Sections', 'Est. minutes'),
  ], {
    sort: { entity: 'Sections', property: 'Questions', kind: 'column', direction: 'Descending' },
  });

  addChartHeading(page, 820, 140, 'Question volume', 'Rows by section', 412);
  page.chart('architecture-volume', 820, 174, 412, 198, {
    categoryEntity: 'Sections',
    categoryProperty: 'Section',
    valueEntity: 'Sections',
    valueProperty: 'Plotted section questions',
    valueKind: 'measure',
    sortEntity: 'Sections',
    sortProperty: 'Plotted section questions',
    sortKind: 'measure',
    fill: C.accent,
  });

  addChartHeading(page, 820, 392, 'Planning burden', 'Estimated minutes by section', 412);
  page.chart('architecture-burden', 820, 426, 412, 198, {
    categoryEntity: 'Sections',
    categoryProperty: 'Section',
    valueEntity: 'Sections',
    valueProperty: 'Plotted section minutes',
    valueKind: 'measure',
    sortEntity: 'Sections',
    sortProperty: 'Plotted section minutes',
    sortKind: 'measure',
    fill: C.ochre,
  });

  addNarrative(page, 48, 540, 742, 116, 'Reading the architecture', study.narrative.architecture.join('\n'), { fill: '#EFE4D5' });
  page.text('burden-note', 820, 634, 412, 36, 'Burden is a planning heuristic derived from question type, choice load and routing — not a measured interview length.', {
    size: 7.5,
    color: C.muted,
    z: 200,
  });
  return page;
}

function routingPage(study) {
  const page = new PageBuilder(study, '03 Routing & quality');
  page.panel('page-bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  addHeader(page, 3, 'ROUTING & QUALITY', 'The control surface', 'Visibility logic, constraints and the anchors that other questions depend on.');

  const cards = [
    ['Logic references', 'Logic references'],
    ['Conditionally required', 'Conditionally required'],
    ['Constraints', 'Constraints'],
    ['Choice filters', 'Choice filters'],
  ];
  cards.forEach(([measure], index) => {
    page.card(`routing-kpi-${index}`, 48 + index * 300, 140, 282, 90, measure, { valueSize: 23, labelSize: 9 });
  });

  addChartHeading(page, 48, 250, 'Routing anchors', 'Questions most often referenced inside another rule');
  page.chart('anchors', 48, 284, 580, 198, {
    categoryEntity: 'RoutingAnchors',
    categoryProperty: 'Question',
    valueEntity: 'RoutingAnchors',
    valueProperty: 'Plotted inbound references',
    valueKind: 'measure',
    sortEntity: 'RoutingAnchors',
    sortProperty: 'Plotted inbound references',
    sortKind: 'measure',
    fill: C.plum,
  });

  addChartHeading(page, 650, 250, 'Highest rule-load questions', 'Outgoing references across routing and validation');
  page.table('hotspot-table', 650, 284, 580, 198, [
    columnProjection('RoutingHotspots', 'Question'),
    columnProjection('RoutingHotspots', 'Logic refs'),
    columnProjection('RoutingHotspots', 'Rule kinds'),
  ], {
    sort: { entity: 'RoutingHotspots', property: 'Logic refs', kind: 'column', direction: 'Descending' },
  });

  addNarrative(page, 48, 500, 1182, 144, 'Routing read', study.narrative.routing.join('\n'), { fill: '#EFE4D5' });
  return page;
}

function analysisPage(study) {
  const page = new PageBuilder(study, '04 Analysis blueprint');
  page.panel('page-bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  addHeader(page, 4, 'ANALYSIS BLUEPRINT', 'What each question will ask of the analyst', 'Method families are assigned before fieldwork; no inferential test is pre-committed.');

  addChartHeading(page, 48, 140, 'Analysis families', 'Questions by required method');
  page.chart('family-chart', 48, 174, 356, 354, {
    categoryEntity: 'AnalysisFamilies',
    categoryProperty: 'Analysis family',
    valueEntity: 'AnalysisFamilies',
    valueProperty: 'Plotted family questions',
    valueKind: 'measure',
    sortEntity: 'AnalysisFamilies',
    sortProperty: 'Plotted family questions',
    sortKind: 'measure',
    fill: C.teal,
  });

  addChartHeading(page, 430, 140, 'Question-level analysis plan', 'Every question, its type and its analytical contract');
  page.table('analysis-table', 430, 174, 802, 354, [
    columnProjection('Questions', '#'),
    columnProjection('Questions', 'Question'),
    columnProjection('Questions', 'Type'),
    columnProjection('Questions', 'Analysis'),
  ], {
    sort: { entity: 'Questions', property: '#', kind: 'column', direction: 'Ascending' },
  });

  addNarrative(page, 48, 536, 1184, 112, 'Analysis read', study.narrative.analysis.join('\n'), { fill: '#EFE4D5' });
  return page;
}

function atlasPage(study) {
  const page = new PageBuilder(study, '05 Question atlas');
  page.panel('page-bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  addHeader(page, 5, 'QUESTION ATLAS', 'The complete instrument, one row at a time', 'Filter by section to inspect the exact questions, required state, routing and analysis contract.');

  page.text('slicer-label', 48, 140, 310, 16, 'FILTER BY SECTION', {
    size: 8,
    color: C.muted,
    weight: '600',
    z: 200,
  });
  page.slicer('section-slicer', 48, 160, 310, 72, 'Sections', 'Section');
  page.text('atlas-note', 382, 146, 848, 64, `${study.counts.questions} instrument rows are in this atlas. Use the section filter to narrow the table; every row remains in the semantic model. Long labels are deliberately preserved for audit.`, {
    size: 9,
    color: C.muted,
    z: 100,
  });

  addChartHeading(page, 48, 250, 'Instrument inventory', 'Question order · section · type · required · routing · constraint · analysis');
  page.table('atlas-table', 48, 286, 1182, 346, [
    columnProjection('Questions', '#'),
    columnProjection('Questions', 'Section'),
    columnProjection('Questions', 'Question'),
    columnProjection('Questions', 'Type'),
    columnProjection('Questions', 'Required'),
    columnProjection('Questions', 'Logic'),
    columnProjection('Questions', 'Constraint'),
    columnProjection('Questions', 'Analysis'),
  ], {
    sort: { entity: 'Questions', property: '#', kind: 'column', direction: 'Ascending' },
  });

  page.text('atlas-footnote', 48, 646, 1182, 30, 'Answers remain empty in this build. The atlas is a design record, not a claim about respondent behaviour.', {
    size: 8,
    color: C.muted,
    z: 200,
  });
  return page;
}

function readinessPage(study) {
  const page = new PageBuilder(study, '06 Fieldwork readiness');
  page.panel('page-bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  const hasResponses = page.study.counts.responses > 0;
  addHeader(
    page,
    6,
    'FIELDWORK READINESS',
    hasResponses ? 'Response rows are present. The instrument is still the story.' : 'No respondent data. No invented respondent.',
    hasResponses
      ? 'The response tables are loaded, but this design dossier does not manufacture respondent findings from them.'
      : 'The questionnaire pages are populated. The response layer is a contract, deliberately held empty.',
  );

  page.panel('readiness-panel', 48, 140, 566, 214, { fill: C.dark, border: null, radius: 8, z: 10 });
  page.text('readiness-title', 72, 164, 500, 70, hasResponses ? 'Response layer\nloaded.' : 'No respondent\ndata in this build.', {
    font: FONT.display,
    size: 29,
    color: C.cream,
    z: 100,
  });
  page.text('readiness-body', 72, 244, 510, 92, hasResponses
    ? `The model contains ${page.study.counts.responses} response rows and ${page.study.counts.answers} answer rows. This dossier still reads the instrument; response findings belong in a dedicated fieldwork report.`
    : 'The design is complete; the results are absent by design. No synthetic answers, benchmarks or significance claims were created to fill the canvas.', {
    size: 9.2,
    color: '#C9B9A7',
    z: 100,
  });

  const cards = [
    ['Fieldwork status', 'Fieldwork status'],
    ['Responses loaded', 'Responses loaded'],
    ['Completion', 'Completion'],
    ['Quality flags', 'Quality flags'],
  ];
  cards.forEach(([measure], index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    page.card(`readiness-card-${index}`, 638 + column * 298, 140 + row * 114, 286, 96, measure, { valueSize: 21, labelSize: 8.5 });
  });

  addChartHeading(page, 48, 380, 'Data contract', 'Grain, stable keys and current state of every analytical table');
  page.table('contract-table', 48, 414, 1182, 214, [
    columnProjection('DataContract', 'Artifact'),
    columnProjection('DataContract', 'Grain'),
    columnProjection('DataContract', 'Key fields'),
    columnProjection('DataContract', 'Status'),
    columnProjection('DataContract', 'Note'),
  ], {
    sort: { entity: 'DataContract', property: 'SortOrder', kind: 'column', direction: 'Ascending' },
  });

  page.text('readiness-footnote', 48, 642, 1182, 32, hasResponses
    ? 'Response rows are embedded for audit and future fieldwork pages. This dossier does not present them as questionnaire design evidence.'
    : 'The model is ready for a response append, but the report does not pretend that fieldwork happened. An empty base is never presented as a finding.', {
    size: 8,
    color: C.muted,
    z: 200,
  });
  return page;
}

export function buildReportPackage(study) {
  const pages = [
    coverPage(study),
    executivePage(study),
    architecturePage(study),
    routingPage(study),
    analysisPage(study),
    atlasPage(study),
    readinessPage(study),
  ];

  const reportJson = {
    $schema: REPORT_SCHEMA,
    themeCollection: {
      baseTheme: {
        name: BASE_THEME_NAME,
        reportVersionAtImport: {
          visual: '2.11.0',
          report: '3.4.0',
          page: '2.3.1',
        },
        type: 'SharedResources',
      },
      customTheme: {
        name: `${THEME_NAME}.json`,
        reportVersionAtImport: {
          visual: '2.9.0',
          report: '3.3.0',
          page: '2.1.0',
        },
        type: 'RegisteredResources',
      },
    },
    resourcePackages: [
      {
        name: 'SharedResources',
        type: 'SharedResources',
        items: [{
          name: BASE_THEME_NAME,
          path: `BaseThemes/${BASE_THEME_NAME}.json`,
          type: 'BaseTheme',
        }],
      },
      {
        name: 'RegisteredResources',
        type: 'RegisteredResources',
        items: [{
          name: `${THEME_NAME}.json`,
          path: `${THEME_NAME}.json`,
          type: 'CustomTheme',
        }],
      },
    ],
    settings: {
      useStylableVisualContainerHeader: true,
      exportDataMode: 'AllowSummarized',
      defaultDrillFilterOtherVisuals: true,
      allowChangeFilterTypes: true,
      useEnhancedTooltips: true,
      useDefaultAggregateDisplayName: true,
    },
  };

  const pagesJson = {
    $schema: PAGES_SCHEMA,
    pageOrder: pages.map((page) => page.id),
    activePageName: pages[0].id,
  };

  return {
    pages: pages.map((page) => ({ id: page.id, displayName: page.displayName, json: page.json(), visuals: page.visuals })),
    reportJson,
    pagesJson,
    versionJson: { $schema: VERSION_SCHEMA, version: REPORT_DEFINITION_VERSION },
    definitionPbir: {
      $schema: DEFINITION_PBIR_SCHEMA,
      version: '4.0',
      datasetReference: { byPath: { path: `../${study.code}.SemanticModel` } },
    },
    pbip: {
      $schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
      version: '1.0',
      artifacts: [{ report: { path: `${study.code}.Report` } }],
      settings: { enableAutoRecovery: true },
    },
    reportPlatform: {
      $schema: PLATFORM_SCHEMA,
      metadata: { type: 'Report', displayName: study.code },
      config: { version: '2.0', logicalId: stableUuid(`report:${study.code}`) },
    },
    modelPlatform: {
      $schema: PLATFORM_SCHEMA,
      metadata: { type: 'SemanticModel', displayName: study.code },
      config: { version: '2.0', logicalId: stableUuid(`model:${study.code}`) },
    },
    pbism: {
      $schema: PBISM_SCHEMA,
      version: '4.2',
      settings: { qnaEnabled: true },
    },
    themeJson: buildTheme(),
  };
}

function stableUuid(label) {
  const hex = createHash('sha1').update(String(label)).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

export function buildTheme() {
  return {
    name: `${THEME_NAME}.json`,
    dataColors: [C.accent, C.teal, C.ochre, C.slate, C.plum, C.olive, '#8C5A3C', '#4F5D66'],
    background: C.paper,
    foreground: C.ink,
    tableAccent: C.accent,
    good: '#2F6B4F',
    neutral: C.ochre,
    bad: '#A33A2B',
    textClasses: {
      title: { fontFace: FONT.display, fontSize: 26, color: C.ink },
      header: { fontFace: FONT.semibold, fontSize: 13, color: C.ink },
      label: { fontFace: FONT.body, fontSize: 10, color: C.muted },
      callout: { fontFace: FONT.display, fontSize: 26, color: C.ink },
    },
    visualStyles: {
      '*': {
        '*': {
          background: [{ show: false }],
          border: [{ show: false }],
          dropShadow: [{ show: false }],
          visualHeader: [{ show: false }],
        },
      },
      cardVisual: {
        '*': {
          value: [{ fontFamily: FONT.display, fontSize: 24, fontColor: C.ink }],
          label: [{ fontFamily: FONT.body, fontSize: 9, fontColor: C.muted }],
        },
      },
    },
  };
}

/**
 * Resolve every field reference in the package against the generated model.
 * This is intentionally stricter than a JSON parse: a valid JSON visual that
 * points at a missing measure produces a broken report, which is not acceptable.
 */
export function validateReportPackage(pkg, model) {
  const errors = [];
  const tables = new Map(model.tables.map((table) => [table.name, table]));
  const pageIds = new Set();
  const visualIds = new Set();
  const fields = new Map();
  for (const table of model.tables) {
    const columns = new Set(table.columns.map((column) => column.name));
    const measures = new Set((table.measures ?? []).map((measure) => measure.name));
    fields.set(table.name, { columns, measures });
  }

  for (const page of pkg.pages) {
    if (!/^[0-9a-f]{20}$/.test(page.id)) errors.push(`page id is not 20 lowercase hex: ${page.id}`);
    if (pageIds.has(page.id)) errors.push(`duplicate page id ${page.id}`);
    pageIds.add(page.id);
    for (const visual of page.visuals) {
      if (!/^[0-9a-f]{20}$/.test(visual.name)) errors.push(`visual id is not 20 lowercase hex: ${visual.name}`);
      if (visualIds.has(visual.name)) errors.push(`duplicate visual id ${visual.name}`);
      visualIds.add(visual.name);
      const positionValue = visual.json.position;
      if (positionValue.x < 0 || positionValue.y < 0 || positionValue.width <= 0 || positionValue.height <= 0) {
        errors.push(`invalid position on ${visual.name}`);
      }
      if (positionValue.x + positionValue.width > 1280.01 || positionValue.y + positionValue.height > 720.01) {
        errors.push(`visual ${visual.name} escapes the 1280x720 canvas`);
      }
      const queryState = visual.json.visual?.query?.queryState;
      if (!queryState) continue;
      for (const [role, state] of Object.entries(queryState)) {
        for (const projection of state.projections ?? []) {
          const field = projection.field;
          const kind = field.Measure ? 'measure' : 'column';
          const expression = field.Measure ?? field.Column;
          const entity = expression?.Expression?.SourceRef?.Entity;
          const property = expression?.Property;
          if (!tables.has(entity)) {
            errors.push(`visual ${visual.name} ${role} references missing table ${entity}`);
            continue;
          }
          const known = fields.get(entity);
          if (kind === 'measure' && !known.measures.has(property)) {
            errors.push(`visual ${visual.name} ${role} references missing measure ${entity}[${property}]`);
          }
          if (kind === 'column' && !known.columns.has(property)) {
            errors.push(`visual ${visual.name} ${role} references missing column ${entity}[${property}]`);
          }
        }
      }
    }
  }

  if (!pkg.pagesJson.pageOrder.every((id) => pageIds.has(id))) errors.push('pages.json references an unknown page');
  if (!pkg.pagesJson.pageOrder.includes(pkg.pagesJson.activePageName)) errors.push('active page is not in pageOrder');
  return errors;
}
