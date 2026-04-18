// ─── Source types ────────────────────────────────────────────────────────────

export type SourcePath = { type: 'path'; path: string };
export type SourceGit  = { type: 'git';  url: string; ref?: string };
export type SourceZip  = { type: 'zip';  url: string };
export type SourceGlob = { type: 'glob'; pattern: string; detect_woo?: boolean };
export type ThemeSource = SourcePath | SourceGit | SourceZip | SourceGlob;

// ─── Config schema ────────────────────────────────────────────────────────────

export interface MatrixConfig {
  wp:  string[];
  wc:  string[];
  php: string[];
}

export interface PrConfig {
  create:              boolean;
  auto_merge_cosmetic: boolean;
}

export interface BudgetConfig {
  max_cost_usd_per_run: number;
}

export interface Defaults {
  branch?:    string;
  viewports?: number[];
  matrix?:    Partial<MatrixConfig>;
  sandbox?:   'playground' | 'wp-env' | 'auto';
  pr?:        Partial<PrConfig>;
  budget?:    Partial<BudgetConfig>;
}

export interface ThemeEntry {
  id:          string;
  source:      ThemeSource;
  repo?:       string;
  owner?:      string;
  branch?:     string;
  viewports?:  number[];
  matrix?:     Partial<MatrixConfig>;
  sandbox?:    'playground' | 'wp-env' | 'auto';
}

export interface IntegrationSlack    { webhook_url_env: string }
export interface IntegrationDashboard { publish?: string; repo?: string }

export interface Integrations {
  slack?:     IntegrationSlack;
  dashboard?: IntegrationDashboard;
}

export interface ThemeDoctorConfig {
  version:       number;
  defaults?:     Defaults;
  themes:        ThemeEntry[];
  integrations?: Integrations;
}

// ─── Resolved theme (after registry expansion) ───────────────────────────────

export interface ResolvedTheme {
  id:         string;
  localPath:  string;
  source:     ThemeSource;
  repo?:      string;
  owner?:     string;
  branch:     string;
  viewports:  number[];
  matrix:     MatrixConfig;
  sandbox:    'playground' | 'wp-env' | 'auto';
}

// ─── Theme classifier ─────────────────────────────────────────────────────────

export type ThemeType = 'classic' | 'hybrid' | 'fse';

export interface ThemeClassification {
  type:                ThemeType;
  hposAware:           boolean;
  checkoutType:        'shortcode' | 'block' | 'unknown';
  hasCustomProductTpl: boolean;
  blockTemplates:      string[];
  blockParts:          string[];
  name:                string;
  version:             string;
  textDomain:          string;
}

// ─── Evidence packet ──────────────────────────────────────────────────────────

export type Viewport = 375 | 768 | 1440 | number;

export interface ConsoleMessage {
  type:  'error' | 'warning' | 'info' | 'log';
  text:  string;
  url?:  string;
}

export interface NetworkFailure {
  url:    string;
  status: number;
  method: string;
}

export interface AxeViolation {
  id:          string;
  impact:      string;
  description: string;
  nodes:       number;
}

export interface SelectorResult {
  selector:  string;
  found:     boolean;
  count:     number;
  required:  boolean;
}

export interface EvidenceCapture {
  templateId:      string;
  viewport:        Viewport;
  url:             string;
  screenshotPath:  string;
  layoutSignature: string;
  domSnapshot:     SelectorResult[];
  consoleMessages: ConsoleMessage[];
  networkFailures: NetworkFailure[];
  phpLogDelta:     string;
  axeViolations:   AxeViolation[];
  tracePath?:      string;
  capturedAt:      string;
  durationMs:      number;
}

export interface EvidencePacket {
  runId:     string;
  themeId:   string;
  matrix:    { wp: string; wc: string; php: string };
  captures:  EvidenceCapture[];
  createdAt: string;
}

// ─── Judgement ────────────────────────────────────────────────────────────────

export type Verdict = 'pass' | 'cosmetic' | 'layout' | 'functional';

export type JudgeTier = 'rubric' | 'signature' | 'pixel' | 'llm';

export interface JudgementResult {
  templateId:      string;
  viewport:        Viewport;
  verdict:         Verdict;
  tier:            JudgeTier;
  confidence:      number;
  evidence:        string[];
  suggestedFixHint?: string;
  pixelDiffPath?:  string;
  pixelDiffPct?:   number;
}

export interface RunJudgement {
  runId:      string;
  themeId:    string;
  verdicts:   JudgementResult[];
  overallVerdict: Verdict;
  passCount:  number;
  failCount:  number;
  judgedAt:   string;
}

// ─── Fix plan ─────────────────────────────────────────────────────────────────

export type RiskClass = 'cosmetic' | 'layout' | 'functional';

export interface FileToTouch {
  relativePath: string;
  reason:       string;
  expectedLines?: number;
}

export interface TriagePlan {
  runId:         string;
  themeId:       string;
  hypothesis:    string;
  filesToTouch:  FileToTouch[];
  riskClass:     RiskClass;
  estimatedDiffSize: 'tiny' | 'small' | 'medium' | 'large';
  humanModifiedFiles: string[];
  createdAt:     string;
}

export interface PatchResult {
  success:       boolean;
  filesChanged:  string[];
  patchPath:     string;
  iterations:    number;
  tokenCount:    number;
  provenanceTag: string;
}

// ─── Safety / circuit breaker ─────────────────────────────────────────────────

export interface CircuitBreakerState {
  themeId:         string;
  consecutiveFails: number;
  tripped:         boolean;
  trippedAt?:      string;
  lastResetAt?:    string;
}

// ─── Run context ──────────────────────────────────────────────────────────────

export interface RunContext {
  runId:      string;
  themeId:    string;
  theme:      ResolvedTheme;
  matrix:     { wp: string; wc: string; php: string };
  sandbox:    'playground' | 'wp-env';
  configDir:  string;
  workDir:    string;
  dryRun:     boolean;
  shadowMode: boolean;
  startedAt:  string;
}

// ─── Rubric types ─────────────────────────────────────────────────────────────

export interface RubricSelector {
  selector:   string;
  required:   boolean;
  description?: string;
}

export interface RubricTemplate {
  id:          string;
  name:        string;
  urlPattern:  string;
  urlParams?:  Record<string, string>;
  selectors:   RubricSelector[];
  requiresClassification?: string[];
  skipForTypes?: ThemeType[];
}

export interface RubricStep {
  action:    'navigate' | 'click' | 'fill' | 'select' | 'assert' | 'wait' | 'screenshot';
  selector?: string;
  value?:    string;
  url?:      string;
  description?: string;
}

export interface RubricFlow {
  id:          string;
  name:        string;
  steps:       RubricStep[];
  requiresClassification?: string[];
}

export interface Rubric {
  templates: RubricTemplate[];
  flows:     RubricFlow[];
}

// ─── Report / PR ──────────────────────────────────────────────────────────────

export interface ThemeRunReport {
  runId:       string;
  themeId:     string;
  matrix:      { wp: string; wc: string; php: string };
  verdict:     Verdict;
  judgements:  JudgementResult[];
  patchResult?: PatchResult;
  prUrl?:      string;
  durationMs:  number;
  costUsd:     number;
  createdAt:   string;
}
