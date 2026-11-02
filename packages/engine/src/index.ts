export * from './types.js';
export {
  ExpressionError, tokenize, parse, evaluate, runExpression, collectRefs, collectBareNames, truthy,
  type Expr, type BinaryOp, type EvalContext,
} from './expression.js';
export { evaluateForm, effectiveValue, dependencies, filterChoices, type QuestionState, type FormEvaluation, type EvaluateOptions } from './evaluate.js';
export {
  datasetContext, lookupDataset, findCase, findEnumerator,
  type DatasetRow, type DatasetTable, type DatasetContext,
} from './datasets.js';
export { validateForm, isPublishable, type ValidationReport } from './validate.js';
export {
  importXlsForm, exportXlsForm, xlsFormSheets, xlsFormWorkbook,
  type AdapterNote, type XlsFormImport, type XlsFormExport, type XlsFormSheets,
  type XlsFormBook, type XlsFormBookOptions,
} from './adapters/xlsform.js';
export {
  validateXlsFormSheets, checkUpload, compareVersions, CUSTOM_APPEARANCE_ALLOWLIST,
  type Diagnostic, type DiagnosticSeverity, type WorkbookValidationReport,
  type UploadGuardInput, type UploadGuardResult,
} from './adapters/xlsform-validate.js';
export {
  parseAuditSpec, parseSpeedSpec, hashSeed, random01, auditSeed, isAudited, audioWindow,
  evaluateSpeed, SPEED_THRESHOLDS, DEFAULT_SPEED_THRESHOLD_SECONDS,
  type AuditPlan, type AuditCadenceKind, type AuditSpecError, type AudioWindow,
  type FieldTiming, type FieldSpeedFinding, type SpeedReport, type SpeedOptions,
} from './audit.js';
export { readWorkbook, writeWorkbook, colName, colIndex, escapeXml, decodeXml, type CellValue, type OutSheet, type Sheet, type Workbook } from './adapters/xlsx.js';
export { diffDefinitions, type DefinitionDiff } from './diff.js';
export {
  detectOutliers, frequencyReport, tTestMean, twoSampleTTest, chiSquareTest, formatP, normalCdf,
  type OutlierReport, type FrequencyFinding, type MeanTestReport, type ChiSquareReport,
} from './qc.js';
export * from './export/index.js';
