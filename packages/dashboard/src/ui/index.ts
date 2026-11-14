// The dashboard's shared primitives (README.md beside this file: each with an example). Pages import from here.

import './ui.css';

export { Bead, type BeadProps, type BeadState, presenceBead } from './bead.tsx';
export { Button, type ButtonProps, ButtonRow, type ButtonVariant } from './button.tsx';
export { Disclosure, type DisclosureProps } from './disclosure.tsx';
export { EmptyState, type EmptyStateProps } from './empty-state.tsx';
export { type ErrorFix, ErrorLine, type ErrorLineProps } from './error-line.tsx';
export { Select, type SelectOption, type SelectProps, Slider, type SliderProps, SpanField, type SpanFieldProps, type SpanRung, TextField, type TextFieldProps, Toggle, type ToggleProps } from './fields.tsx';
export { Chip, ChipRow, Code, CopyButton, Line, Span, spanText, useHeldText, useHubText, useSpanOf } from './kit.tsx';
export { FTime, type FTimeEarth, type FTimeForm, type FTimeProps, fTimeText } from './ftime.tsx';
export { Page, type PageProps, Section, type SectionProps } from './page.tsx';
export { Pending, Row, type RowProps } from './row.tsx';
export { Sparkline, type SparklineProps } from './sparkline.tsx';
export { SubNav, type SubNavItem } from './sub-nav.tsx';
export { type ArcState, PROVISION_STAGES, StageRing, type StageRingCentre, type StageRingProps } from './stage-ring.tsx';
export { openTerminal, Term, type TermHandle, type TermLevel, termLevel, type TermProps, termTheme } from './term.tsx';
export { Caps, Earth, engrave, Reading } from './text.tsx';
export { type Mode, useMode } from '../shell/mode.ts';
export { useCoreError, useFractonica, useNowFor, useReading } from '../time/hooks.ts';
export { type InstantLike, instantOf } from '../time/instant.ts';
