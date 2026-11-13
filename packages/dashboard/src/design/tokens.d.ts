// Types of the vendored token table (tokens.js, from the web repository's public/app/design/tokens.js; never edited
// here: `fr gen` refreshes it and tokens.lock). This declaration is the dashboard's own.

export type ThemeColor = Readonly<{
  void: string;
  plate: string;
  etch1: string;
  etch2: string;
  etch3: string;
  ash: string;
  bone: string;
  lumen: string;
  lumenMid: string;
  lumenDim: string;
  lumenEtch: string;
  lumenRing: string;
  now: string;
  nowCore: string;
  sol: string;
  solDim: string;
  solLabel: string;
  solEmpty: string;
  hAlpha: string;
  earth: string;
  limbBetween: string;
  majorLabel: string;
  majorName: string;
  seal: string;
}>;

export interface Theme {
  readonly name: string;
  readonly color: ThemeColor;
  readonly font: Readonly<{
    reading: string;
    caps: string;
    readingWeight: number;
    valueWeight: number;
    earthWeight: number;
    capsWeight: number;
    titleWeight: number;
    capsTracking: number;
    dateTracking: number;
    bezelTracking: number;
    earthStyle: string;
  }>;
  readonly line: Readonly<Record<string, number>>;
  readonly glow: Readonly<Record<string, number>>;
  readonly alpha: Readonly<Record<string, number>>;
  readonly ground: Readonly<{ markSpacing: readonly number[]; vignette: number }>;
}

export declare const THEMES: Readonly<Record<'astrolabe' | 'basalt', Theme>>;
export declare const DEFAULT_THEME: 'astrolabe';
export declare function theme(): Theme;
export declare function withAlpha(hex: string, opacity: number): string;
export declare function applyTheme(root: HTMLElement, name: string): Theme;
export declare function canvasFont(face: 'reading' | 'caps', size: number, weight?: number): string;
