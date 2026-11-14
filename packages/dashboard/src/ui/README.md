# Dashboard primitives (`src/ui`)

The shared building blocks of every page, in the hub's Astrolabe language (design README "Hub" rulings; the site's
visual system digested in the stage 4 notes). Import them from `src/ui/index.ts`:

```tsx
import { Page, Section, Row, Bead, Button, FTime } from '../ui/index.ts';
```

Rules every page keeps (test/design-rules.test.ts checks the first four):

- Colours only from tokens: `var(--c-*)` in CSS (`--c-void --c-plate --c-etch1 --c-etch2 --c-etch3 --c-ash --c-bone
  --c-lumen --c-lumen-mid --c-lumen-dim --c-earth --c-fault`); in code `hubColors()` (`src/design/hub-tokens.ts`).
  Never a hex, `rgb()` or a colour name. `sol`, `h-alpha` are the clock's: never in the hub.
- Faces: `var(--font-reading)` (SF Pro, light, tabular figures) and `var(--font-caps)` (Futura caps tracked
  `var(--track-caps)`) and `var(--mono)` for ids, paths and logs. No bold, no semibold.
- Sizes from the scale in `styles/base.css`: `--fs-reading --fs-title --fs-value --fs-data --fs-earth --fs-label
  --fs-micro`; spacing `--sp-1 … --sp-6`, `--gutter`.
- Nothing pulses, blinks or spins; transitions are fades of 120–600 ms and vanish under reduced motion.
- No cards or cells around what is read, no filled bars, no percentages: a fill marks only what can be pressed
  (design README, Hub ruling 7). Lists are `Row`s; progress is a `StageRing`.
- Pure mode shows only Fractonica units: no clock time, date, zone, second, Hz, metre or per cent, not even in a
  `title` or `aria-label`. Anything Earth goes through `<Earth>`, `Row earth=`, `Page earth=`, `FTime` or `Span`,
  which render it only in Earth mode, led by ⊕. A text the hub wrote goes through `useHubText()` (ErrorLine does it
  itself); catalog prose is shown in pure mode only when `pureSafe` (src/state/pure-text.ts) passes it.
- One vocabulary for states: a device's presence in words is `presenceWord` (src/state/words.ts: online, suspect,
  offline, not heard yet), its bead `presenceBead`; something being read is `<Pending what="the registry" />`; the
  hub's checks are src/state/checks.ts, the ports src/state/ports.ts. A section's aside is a `<Caps>` word.
- Everything works at 390 px: rows wrap, buttons wrap (`ButtonRow`), no wide tables.
- A page's own CSS goes in `src/pages/<page>.css`, classes prefixed with the page's name (`hub-…`, `prov-…`).
  Components two pages share that call the hub (a port's actions, the network form) are in `src/pages/shared/`.

## Page

The frame of a page: the engraved title (also the document title), a caps sub line, an Earth line, the actions.

| Prop | Type | |
|---|---|---|
| `title` | `string` | engraved; document title `Fractonica hub · <title>` |
| `sub` | `ReactNode` | caps line under the title (a string is engraved) |
| `earth` | `ReactNode` | Earth mode only, led by ⊕ |
| `actions` | `ReactNode` | buttons, right; one `primary` at most |
| `documentTitle` | `string` | the document title when it says more than the title (`cam-esp32 · cam`) |

```tsx
<Page title="Devices" sub="5 of 6 online" actions={<Button variant="primary" onClick={add}>Provision</Button>}>
  …sections…
</Page>
```

## Section

A block: a caps title over an `etch-2` rule, rows under it.

| Prop | Type | |
|---|---|---|
| `title` | `string` | engraved, ash |
| `aside` | `ReactNode` | right of the title (a count, a quiet button) |
| `body` | `'rows' \| 'loose'` | `loose` spaces forms and blocks |

```tsx
<Section title="Links" aside={<Caps>2 up</Caps>}>
  <Row label="TCP" value="up" />
</Section>
```

## Row

The LENS row: label (caps) or name (bone) left, value right, a hairline under it; wraps at phone width. A row that
opens something (`to` or `onClick`) is a row-tone plate with a › at its end, lighter under the hand.

| Prop | Type | |
|---|---|---|
| `label` | `string` | caps label, ash |
| `name` | `ReactNode` | a thing's name in bone (`label` or `name`) |
| `bead`, `beadLabel` | `BeadState`, `string` | a status bead before it |
| `value` / `children` | `ReactNode` | right-aligned |
| `extra` | `ReactNode` | a smaller ash line under the value |
| `sub` | `ReactNode` | a smaller ash line under the label or name (a path, a profile) |
| `lead` | `ReactNode` | a mark before the bead or name (a 22 px `StageRing bare`) |
| `actions` | `ReactNode` | the row's own quiet buttons at its end (under it at phone width) |
| `earth` | `ReactNode` | Earth mode only, ⊕-led, under the value |
| `to`, `params` | route | the row is a link |
| `onClick` | `() => void` | the row is a button |
| `flash` | `boolean` | lights the hairline lumen; fades out over 600 ms when unset |
| `id` | `string` | `data-row` for tests |

`Pending({ what, word? })` is the row of something still being read: an idle bead and "READING THE REGISTRY".

```tsx
<Row bead={presenceBead(d.presence)} name={d.alias} to="/devices/$id" params={{ id: d.alias }} value={d.profile} />
<Row name={p.profile} sub={`${p.board} · ${p.chip}`} value={<FTime at={built} form="relative" />} actions={<Button variant="quiet">Build</Button>} />
<Pending what="the registry" />
<Row label="RSSI" value={<Reading text={…} />} extra="tcp · udp" />
```

## Bead

A status: `online` filled lumen, `waiting` hollow bone (suspect, connecting, pending), `offline` etch-3, `fault`
filled fault (errors only), `idle` hollow etch-3 (unknown, nothing yet). `presenceBead(presence)` maps a device's.

| Prop | Type | |
|---|---|---|
| `state` | `BeadState` | |
| `label` | `string` | for assistive technology (default the state's word) |
| `showLabel` | `boolean` | the word engraved beside it |
| `size` | `number` | px, default 7 |

```tsx
<Bead state="waiting" label="listening" showLabel />
```

## Button, ButtonRow

Caps words on raised plates: what can be pressed is told by its fill. `primary` is a lumen plate with void letters
(one per page); `destructive` is a fault-tinted plate and with `confirm` asks in place (a second press confirms, on a
solid fault plate; Escape, a click away or CANCEL disarms); `quiet` is a smaller, fainter plate in the row tone for row
actions and for Cancel; `quiet` with `data-tone="fault"` is a quiet plate in fault, for an irreversible row action
beside a louder one (DELETE beside PLAY). Disabled, the plate is taken away (a dashed etch-2 hairline, a dim word);
busy, it sinks, a lumen-mid line under it and an ellipsis after its word.

| Prop | Type | |
|---|---|---|
| `variant` | `'default' \| 'primary' \| 'destructive' \| 'quiet'` | |
| `children` | `ReactNode` | a string is engraved |
| `confirm` | `string` | the question asked in place before `onClick` |
| `confirmLabel` | `string` | default "Confirm" |
| `cancelLabel` | `string` | the word that keeps things as they are, default "Cancel" ("Keep going" for a Stop); focus returns to the button |
| `busy` | `boolean` | disabled, `aria-busy` (nothing spins) |
| …button attributes | | `onClick`, `disabled`, `type`, `data-*` |

```tsx
<ButtonRow>
  <Button variant="primary" onClick={start}>Flash</Button>
  <Button variant="destructive" confirm="Forget desk-pad?" confirmLabel="Forget" onClick={forget}>Forget</Button>
</ButtonRow>
```

## TextField, Select, Toggle, Slider

A caps label over a recessed well (etch-1, a darker top edge), a note (ash) or an error (fault) under it. A Toggle
is a raised plate around the ring, lit when on; a Slider a groove lit lumen-mid to the value, with a bead to take hold
of.

| Component | Props |
|---|---|
| `TextField` | `label`, `value`, `onChange(value)`, `note?`, `error?`, `mono?`, input attributes (`placeholder`, `maxLength`, `type`, …) |
| `Select` | `label`, `value`, `onChange(value)`, `options: {value, label, disabled?}[]`, `note?`, `error?`, `disabled?` |
| `Toggle` | `label`, `checked`, `onChange(checked)`, `states?: [off, on]`, `disabled?` (role switch; the mode toggle's ring, lit with a dot when on; nothing slides) |
| `Slider` | `label`, `value`, `min`, `max`, `step?`, `onChange(n)`, `format?(n)` (never a percentage), `valueText?(n)` (read aloud as `aria-valuetext`, for a scale whose number means nothing to a person), `note?`, `disabled?` |

```tsx
<TextField label="Name" value={alias} onChange={setAlias} maxLength={31} error={aliasProblem(alias)} note="31 characters at most" />
<Select label="Network" value={net} onChange={setNet} options={nets.map((n) => ({ value: n.id, label: n.ssid }))} />
<Toggle label="LED" checked={on} onChange={setOn} states={['off', 'on']} />
<Slider label="Brightness" value={b} min={0} max={255} onChange={setB} />
```

## SpanField

A span typed as a count and a rung of the core (ν blinks, λ flavons, ι preons), or a word that takes no count
("until stopped"). The caller turns it into its own unit with the core (`state/device-units.ts` `spanToUs`,
`spanToField`) and states a clamp as a span in the note ("at most 7ι"); never a second or a minute in pure mode.

| Prop | Type | |
|---|---|---|
| `label`, `note?`, `error?` | | as TextField |
| `count`, `rung` | `string` | the count as typed; the chosen rung's or word's value |
| `rungs` | `SpanRung[]` | `{value, label}` of each rung, from the core |
| `words?` | `SpanRung[]` | choices without a count; choosing one hides the count |
| `onChange` | `(count, rung) => void` | |
| `earth?` | `ReactNode` | under the field (an `<Earth>`: ⊕ 31 s) |

```tsx
<SpanField label="Lit for" count="0.64" rung="8" rungs={[{ value: '8', label: 'ν blinks' }, { value: '7', label: 'λ flavons' }]} onChange={set} note="up to 32ν" />
```

## StageRing

Progress as light, the one ring of every progress in the hub: N arcs from 12 o'clock; done lumen with the glow, the
running one engraved and lit to its elapsed fraction with the point of now and the alidade at its edge, to come
engraved; each stage's word along the bezel, a bead per stage on the carrier (bone when done), the stage and "n of N"
in the middle. `PROVISION_STAGES` is the nine of provisioning (lease · probe · select · registry · render · flash ·
reset · hello · join); builds and OTA pass their own (state/provision.ts), a wiring guide its steps.

| Prop | Type | |
|---|---|---|
| `stages` | `readonly string[]` | words, in order (or each arc's name: an update's devices) |
| `current` | `number` | index of the running stage; `stages.length` when done (with `arcs`: the count done) |
| `fraction` | `number?` | 0..1 of the running stage (flash bytes); undefined = unknown (stays engraved) |
| `failed` | `boolean` | the running stage in fault |
| `word` | `string` | replaces the middle word ("cancelled", "updated") |
| `arcs` | `ArcState[]` | arcs that each go their own way (`{status, fraction?}`), in any order |
| `size` | `number` | px, default 168 |
| `centre` | `{ word, sub?, reading?, bead? }` | what the middle says instead (a span, "listening") |
| `bare` | `boolean` | only the arcs: a 22 px mark in a row |
| `bezel` | `boolean` | the bezel words (default on; off for many small steps) |
| `idle` | `boolean` | before a job: every arc engraved |
| `stageWord` | `(s) => string` | a stage's word for people |
| `label` | `string` | what it is of, for assistive technology |

```tsx
<StageRing stages={PROVISION_STAGES} current={stageIndex} fraction={flash ? sent / total : undefined} label={`Provisioning ${alias}`} />
<StageRing stages={steps.map(String)} current={done} arcs={steps.map((d) => ({ status: d ? 'done' : 'todo' }))} bezel={false} label={title} />
```

## Disclosure

A fold on a row-tone plate, raised to a plate under the hand and while open: `+` when closed, `−` open; an `aside`
goes under the title. Props: `title`, `aside?`, `sub?` (an ash line under the plate, shown open or closed: what the
fold's action does), `defaultOpen?`, or controlled `open` and `onOpenChange`.

```tsx
<Disclosure title="Engineering"><Row label="Bindings" value="3" /></Disclosure>
<Disclosure title="blink" sub="Blinks status the number of times chosen, then returns it to its state.">…form…</Disclosure>
```

## EmptyState

Nothing yet: a hollow ring, a caps title, what to do, and the action. Props: `title`, `children?`, `action?`.

```tsx
<EmptyState title="No devices yet" action={<Button variant="primary" onClick={go}>Provision a board</Button>}>
  Plug a board in with a USB cable.
</EmptyState>
```

## ErrorLine

An error on one line: fault bead, code in caps, message, the hub's remedies under it, a fix button at the end. An op
the hub lacks reads as a notice.

| Prop | Type | |
|---|---|---|
| `error` | `unknown` | an `OpError` (code, message, hint, remediation) or anything thrown |
| `message` | `ReactNode` | or a message of the page's own |
| `what` | `string` | prefix ("Rename: …") |
| `code` | `string` | the caps code for a message of the page's own (`PORT_LEASED`) |
| `fix` | `{ label, onClick, busy? }` | the inline fix |

```tsx
<ErrorLine error={probe.error} what="Probe" fix={{ label: 'Release port', onClick: release }} />
```

## Term, openTerminal, termLevel

xterm.js on the plate, themed from the tokens (text bone, errors fault, warnings ash, debug etch-3, stage lines
lumen; the 16 ANSI colours mapped onto tokens). Loads on first use.

| Prop | Type | |
|---|---|---|
| `onOpen` | `(t: TermHandle) => void \| (() => void)` | once open; return a cleanup |
| `height` | `string` | CSS, default 320px |
| `label` | `string` | for assistive technology |

`TermHandle`: `line(text, level?)` (made safe: only colour sequences pass), `clear()`, `term` (the xterm).
`termLevel(levelLetter, stream)` maps a log line's `E W I D V` or a job line's `err`/`event`. Re-open with a React key.

```tsx
<Term key={deviceId} label={`${alias} log`} onOpen={(t) => live.listen({ logs: (ls) => ls.forEach((l) => t.line(l.text, termLevel(l.level))) })} />
```

## Sparkline

A property's recent values as one lumen hairline ending in a bead; no fill, no axis. Props: `values: number[]`,
`width?` (120), `height?` (24), `label?`.

```tsx
<Sparkline values={history.map((p) => p.v)} label="rssi" />
```

## FTime, fTimeText

An instant in Fractonica notation from the core; in Earth mode its civil translation in ash led by ⊕.

| Prop | Type | |
|---|---|---|
| `at` | `bigint \| number \| string \| Date` | Unix µs (an event's `t_hub_us`), an ISO time (an op's `created_at`) |
| `form` | `'terms' \| 'short' \| 'stamp' \| 'relative'` | `29ι 21λ 3ν` (default) · `δ#3 ε#5 34η 29ι 21λ 3ν` · the whole date · `3λ 2ν ago` / `in 6ι 43λ` |
| `from`, `finest` | `Unit` | terms' range (default Preon … Blink) |
| `parts` | `number` | parts of a relative span (2) |
| `earth` | `'clock' \| 'date-time' \| 'duration' \| 'none'` | the Earth form (default by `form`: `HH:MM:SS.mmm`, the date line, `4 min 1 s ago`) |
| `stack` | `boolean` | Earth line under the notation |

A relative time redraws when its text next changes (the core's `spanNextChange`), never on a poll.
`fTimeText(core, t, now, { form, earthMode, … })` gives the same texts as strings.

```tsx
<Row label="Last seen" value={<FTime at={d.last_seen} form="relative" />} />
```

## Reading, Earth, Caps, engrave

- `<Reading text="ε#5 34η 29ι" className?>`: numerals bone, unit letters and `#` ash. Class `ui-reading` sets the
  big Ultralight reading size.
- `<Earth sign? block?>…</Earth>`: Earth mode only, ⊕-led (`sign={false}` under a ⊕ column heading).
- `<Caps tone="ash" | "bone" | "lumen">TEXT</Caps>` and `engrave(text)`: capitals with Greek left lowercase.

## SubNav

A page's sections as a segmented strip: caps words on plates in a recessed well, the current one lit lumen with a
lumen line under it; at phone width the strip wraps rather than scrolling. Props: `items: { to, params?, label,
current? }[]`, `label?`.

```tsx
<SubNav label="Settings" items={SECTIONS.map((s) => ({ to: '/settings/$section', params: { section: s }, label: s, current: s === current }))} />
```

## Time and mode hooks

- `useMode()` → `{ mode: 'pure' | 'earth', earth: boolean, setMode, toggle }` (remembered as `fractonica.mode`,
  default pure, `?mode=` wins; `<html data-mode>` follows it).
- `useFractonica()` → the core (`{ frc, cat }`) or null while it loads; `useCoreError()`.
- `useReading(mode, { grain? })` → the core's NOW reading (`stamp`, `terms`, `words`, `short`, `pentad`, `majors`,
  `countdowns`, `sun`, `upcoming`, `earth` in Earth mode), recomputed at its `next_change_us` (or at the end of the
  `grain` unit's cycle), never on a poll. Keep the component that calls it small: it redraws at every Blink.
- `useNowFor(core, origin, parts)` → now, redrawn when a span from `origin` next changes.
- `instantOf(value)` → BigInt Unix µs from the hub's numbers, ISO strings or Dates.
- `useGroundAnchor(ref)` (`src/shell/ground.tsx`): centre the plate's machining marks on an element (an instrument).

## Span, useHubText, CopyButton, Chip, Code, Line

- `<Span us={…} sign? parts?>`: a duration as the core's span ("0.048ν"), ⊕ its Earth duration in Earth mode.
  `spanText(core, us)` and `useSpanOf()` give the same as strings.
- `useHubText()` → `(text) => string`: a text the hub wrote in the mode's units (durations as spans, other Earth
  measures left out in pure mode; in Earth mode the spans kept and each Earth value added after ⊕).
- `useHeldText()` → `(text) => string`: a text someone wires or buys from (a Bench guide, a part, a drawing's labels):
  pure mode replaces each Earth value in place by ⊕ (`heldText`), so the sentence keeps its shape; Earth mode as
  `useHubText()`. `pages/bench/said.tsx` draws the ⊕ as the held mark. Identifiers (a MAC, a USB serial) are kept as
  written by both.
- `<CopyButton text label? what?>`: a quiet button that copies; its word says "Copied" (nothing moves).
- `<ChipRow label>` of `<Chip pressed onToggle bead? count?>`: toggles on a line that wraps (Live's filters): engraved
  words, no box; bone over a lumen hairline when pressed. A row that scrolls sideways fades at its cut edge (`useMoreRight`
  in `overflow.ts`, SubNav too).
- `useInPlace(key, close)` (`in-place.ts`): an in-place form or picker takes focus when it opens, closes on Escape, and
  gives focus back to the control marked `data-opens="<key>"` (Lend, Add network, Rename).
- `<Code>`: a command or id in the monospace face, selectable.
- `<Line bead? label|name value detail actions>`: a row with a detail line across it and its buttons under it (a
  check with its fix, a port with its policy actions).
