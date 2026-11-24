// The words a person reads for a capability's members (DEVICE-SPEC §2.2 G1, G5): the catalog names fields and
// properties as code (`fps_x10`, `sd_free_mb`, `interval_ms`), its enums by their wire names (`sd`, `both`), its
// commands by their verbs (`sd_delete`). This table overrides fieldWords/unitOf where the name is a code, and says what
// a press of each command does, in words safe for pure mode (no Earth unit, no clock time). DOM-free, tested in node.
//
// Keys are `<cap>.<member>` for fields and properties (one namespace per capability: `frame_size` is the same words in
// `set` and in `stream_start`), `<cap>.<Type>` for an enum's member words, and `<cap>.<command>` in COMMANDS.
//
// A suffix rule covers what the table does not name: `_x10` is the value times 0.1 (`_x100` times 0.01) and `_ms`,
// `_us`, `_s`, `_hz`, `_mb`, `_mv`, `_mg` imply their unit; the suffix is dropped from the words.

import type { Core } from '@fractonica/time/browser';

import { fieldWords, unitOf, type ValueText, valueText } from './device-units.ts';

export interface MemberWords {
  /** The words in place of the member's name ("frame rate"). */
  words: string;
  /** Its unit (the catalog's, the table's, or one its name implies). */
  unit?: string;
  /** The raw value times this is the value in `unit` (fps_x10: 0.1). */
  scale?: number;
  /** The Earth words after the number ("frames a second") instead of the unit's symbol. */
  earthUnit?: string;
  /** A value with nothing to say in pure mode: shown "—" there, its Earth value after ⊕. */
  earthOnly?: boolean;
}

/** Fields and properties whose catalog name is a code. */
const MEMBERS: Readonly<Record<string, Partial<MemberWords>>> = {
  'fr.camera.fps_x10': { words: 'frame rate', unit: 'Hz', scale: 0.1, earthUnit: 'frames a second' },
  'fr.camera.last_bytes': { words: 'last frame', unit: 'B' },
  'fr.camera.frames': { words: 'frames taken' },
  'fr.camera.sd': { words: 'card' },
  'fr.camera.sd_free_mb': { words: 'free on the card', unit: 'MB', earthOnly: true },
  'fr.camera.interval_ms': { words: 'time between frames' },
  'fr.camera.max_frames': { words: 'frames to take' },
  'fr.camera.to': { words: 'where' },
  'fr.camera.frame_size': { words: 'frame' },
  'fr.camera.quality': { words: 'detail' },
  'fr.camera.vflip': { words: 'flip' },
  'fr.camera.hmirror': { words: 'mirror' },
  'fr.camera.from_frame': { words: 'from frame' },
  'fr.camera.from': { words: 'from recording' },
  'fr.led.on': { words: 'state' },
  'fr.led.on_ms': { words: 'lit for' },
  'fr.led.off_ms': { words: 'dark for' },
  'fr.led.count': { words: 'times' },
  'fr.audio_out.ms': { words: 'for' },
  'fr.audio_out.freq_hz': { words: 'pitch' },
  'fr.audio_out.sample_hz': { words: 'sample rate' },
  'fr.audio_in.sample_hz': { words: 'sample rate' },
  'fr.audio_in.to_port': { words: 'to port' },
  'fr.csi.rate': { words: 'records' },
  'fr.radio_tx.rate_hz': { words: 'pace' },
  'fr.radio_tx.len': { words: 'size' },
  'fr.scale.weight_mg': { words: 'weight' },
  'fr.scale.rate_hz': { words: 'readings' },
  'fr.scale.report_hz': { words: 'reports' },
  'fr.scale.known_mg': { words: 'known weight' },
  'fr.haptic.ms': { words: 'for' },
  'fr.haptic.supply_mv': { words: 'supply' },
  'fr.haptic.level': { words: 'strength' },
  'fr.haptic.period_ms': { words: 'every' },
  'fr.haptic.count': { words: 'taps' },
  'fr.haptic.accent': { words: 'accent every' },
  'fr.haptic.accent_level': { words: 'accent strength' },
  'fr.haptic.active': { words: 'running' },
  'fr.haptic.program': { words: 'what ran' },
  'fr.haptic.reason': { words: 'how it ended' },
  'fr.storage.total_mb': { words: 'size', unit: 'MB' },
  'fr.storage.free_mb': { words: 'free', unit: 'MB' },
  'fr.clock.temp_c10': { words: 'temperature' },
  'fr.clock.offset_ms': { words: 'offset' },
  'fr.clock.at_us': { words: 'at' },
  'fr.node.ms': { words: 'for' },
  'fr.stepper.position': { words: 'position' },
  'fr.stepper.target': { words: 'going to' },
  'fr.stepper.steps': { words: 'steps' },
  'fr.stepper.speed_hz': { words: 'speed', earthUnit: 'steps a second' },
  'fr.stepper.max_speed_hz': { words: 'top speed', earthUnit: 'steps a second' },
  'fr.stepper.start_hz': { words: 'stop-at-once speed', earthUnit: 'steps a second' },
  'fr.stepper.accel': { words: 'acceleration', earthUnit: 'steps a second, each second' },
  'fr.stepper.coil_ohm': { words: 'coil resistance', unit: 'Ω', earthOnly: true },
  'fr.stepper.run_ma': { words: 'run current', unit: 'mA', earthOnly: true },
  'fr.stepper.supply_mv': { words: 'motor supply', earthOnly: true },
  'fr.stepper.hold_pct': { words: 'hold power', unit: '%' },
  'fr.stepper.run_duty_pct': { words: 'drive', unit: '%' },
  'fr.stepper.release_ms': { words: 'lets go after' },
  'fr.stepper.position_known': { words: 'position known' },
  'fr.stepper.steps_per_rev': { words: 'full steps a turn' },
  'fr.stepper.slips': { words: 'timing slips' },
  'fr.stepper.recent': { words: 'faults lately' },
  // the catalog gives jog's `seconds` no unit (fr.stepper D2); the other capabilities' `seconds` are `s`, a span
  'fr.stepper.seconds': { words: 'for', unit: 's' },
  'fr.buzzer.freq_hz': { words: 'pitch' },
  'fr.buzzer.ms': { words: 'for' },
  'fr.buzzer.on_ms': { words: 'sounds for' },
  'fr.buzzer.off_ms': { words: 'quiet for' },
  'fr.buzzer.gap_ms': { words: 'gap between notes' },
  'fr.buzzer.count': { words: 'times' },
  'fr.buzzer.repeat': { words: 'times' },
  'fr.buzzer.beep_hz': { words: 'beep pitch' },
  'fr.buzzer.min_hz': { words: 'lowest pitch' },
  'fr.buzzer.max_hz': { words: 'highest pitch' },
  'fr.buzzer.pitched': { words: 'plays pitches' },
  'fr.buzzer.playing': { words: 'playing' },
  'fr.buzzer.sound': { words: 'sound' },
  'fr.buzzer.reason': { words: 'how it ended' },
};

/** Enum member words, by `<cap>.<Type>`: a member the table leaves out is its name with spaces. */
const ENUMS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'fr.camera.Target': { hub: 'hub', sd: 'card', both: 'hub and card' },
  'fr.camera.FrameSize': {
    qvga: 'qvga · 320 × 240',
    vga: 'vga · 640 × 480',
    svga: 'svga · 800 × 600',
    xga: 'xga · 1024 × 768',
    sxga: 'sxga · 1280 × 1024',
    uxga: 'uxga · 1600 × 1200',
  },
  'fr.camera.CardState': { none: 'no card', mounted: 'in', error: 'failed' },
  'fr.storage.StoreState': { none: 'no card', mounted: 'in', error: 'failed' },
  'fr.clock.SetBy': { command: 'by hand', sync: 'by a sync' },
  'fr.stepper.StepMode': {
    full: 'full steps',
    half: 'half steps',
    micro4: 'quarter steps',
    micro8: 'eighth steps',
    micro16: 'sixteenth steps',
    micro32: 'thirty-second steps',
  },
  'fr.stepper.Motion': { released: 'let go', holding: 'holding', moving: 'moving', stopping: 'stopping', fault: 'fault' },
  'fr.stepper.DoneReason': {
    reached: 'reached',
    stopped: 'stopped',
    halted: 'halted',
    released: 'let go',
    limit: 'at a limit',
    fault: 'fault',
    hub_lost: 'hub went quiet',
    elapsed: 'time up',
  },
  'fr.stepper.FaultCause': { driver: 'driver', injected: 'injected' },
  'fr.buzzer.Sound': { tone: 'tone', beep: 'beep', melody: 'melody' },
  'fr.buzzer.DoneReason': { done: 'played out', stopped: 'stopped', replaced: 'replaced', hub_lost: 'hub went quiet', error: 'failed' },
  'fr.haptic.Kind': { erm: 'vibration motor', solenoid: 'solenoid' },
  'fr.haptic.Program': { pulse: 'pulse', play: 'pattern', tap: 'taps' },
  'fr.haptic.DoneReason': { done: 'ran out', stopped: 'stopped', replaced: 'replaced', hub_lost: 'hub went quiet', cut: 'cut' },
  'fr.haptic.CutReason': { low_supply: 'supply low', floor: 'supply at its floor', max_on: 'on too long' },
};

/** Suffixes that say a unit or a scale; the longest first. */
const SUFFIXES: readonly [string, { unit?: string; scale?: number }][] = [
  ['_x100', { scale: 0.01 }],
  ['_x10', { scale: 0.1 }],
  ['_ms', { unit: 'ms' }],
  ['_us', { unit: 'us' }],
  ['_hz', { unit: 'Hz' }],
  ['_mb', { unit: 'MB' }],
  ['_mv', { unit: 'mV' }],
  ['_mg', { unit: 'mg' }],
  ['_s', { unit: 's' }],
];

/** The suffix rule a member name matches, if any. */
export function suffixRule(name: string): { suffix: string; unit?: string; scale?: number } | null {
  const n = name.toLowerCase();
  for (const [suffix, rule] of SUFFIXES) {
    if (n.length > suffix.length && n.endsWith(suffix)) {
      return { suffix, ...rule };
    }
  }
  return null;
}

/** True when the table names this member itself. */
export function hasMemberEntry(cap: string, member: string): boolean {
  return MEMBERS[`${cap}.${member}`] !== undefined;
}

/** A field's or property's words, unit and scale: the table, then the catalog's unit, then the suffix rule. */
export function memberWords(cap: string, member: { name: string; unit?: string }): MemberWords {
  const t = MEMBERS[`${cap}.${member.name}`] ?? {};
  const rule = suffixRule(member.name);
  const unit = t.unit ?? member.unit ?? rule?.unit ?? unitOf(member);
  const scale = t.scale ?? rule?.scale;
  return {
    words: t.words ?? fieldWords(member.name),
    ...(unit ? { unit } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(t.earthUnit ? { earthUnit: t.earthUnit } : {}),
    ...(t.earthOnly ? { earthOnly: true } : {}),
  };
}

/** A member's number in both modes, through its unit and scale (fps_x10 97: a per-Blink rate, ⊕ 9.7 frames a second). */
export function memberValueText(core: Core | null, cap: string, member: { name: string; unit?: string }, value: number): ValueText {
  const w = memberWords(cap, member);
  const v = valueText(core, value, w.unit, { ...(w.scale !== undefined ? { scale: w.scale } : {}), ...(w.earthUnit ? { symbol: w.earthUnit } : {}) });
  return w.earthOnly ? { text: '—', earth: v.earth ?? v.text } : v;
}

/** An enum member's words ("sd" in fr.camera's Target is "card"). */
export function enumWords(cap: string, type: string, name: string): string {
  return ENUMS[`${cap}.${type}`]?.[name] ?? name.replace(/_/g, ' ');
}

export interface CommandWords {
  /** The verb and its object, lower case ("start a stream"); the button reads it in caps with the instance. */
  verb: string;
  /** What a press does, one sentence; `{inst}` is the instance's name. Pure-safe (test/cap-words.test.ts). */
  does?: string;
}

/** Commands whose name is a code, and what pressing each does. */
const COMMANDS: Readonly<Record<string, CommandWords>> = {
  'fr.led.set': { verb: 'set', does: 'Turns {inst} on or off, at the brightness and colour chosen.' },
  'fr.led.toggle': { verb: 'toggle', does: 'Turns {inst} on if it is off, off if it is on.' },
  'fr.led.blink': { verb: 'blink', does: 'Blinks {inst} the number of times chosen, then returns it to its state.' },
  'fr.led.stop': { verb: 'stop', does: 'Stops a blink on {inst} and returns it to its state.' },
  'fr.camera.stream_start': { verb: 'start a stream', does: 'The hub opens a stream for the camera; the camera page starts one.' },
  'fr.camera.stream_stop': { verb: 'stop the stream', does: 'Ends the stream the camera runs now.' },
  'fr.camera.set': { verb: 'change the sensor', does: 'Changes the picture of {inst} now; it keeps the settings until it restarts.' },
  'fr.camera.sd_list': { verb: 'list the card', does: 'Asks {inst} which recordings its card holds.' },
  'fr.camera.sd_fetch': { verb: 'bring a recording', does: 'Brings a recording from the card to the hub.' },
  'fr.camera.sd_delete': { verb: 'delete a recording', does: 'Removes one recording from the card. It cannot be undone.' },
  'fr.button.inject': { verb: 'simulate', does: 'Plays a gesture on {inst} as if a finger made it (a test build only).' },
  'fr.analog_in.read': { verb: 'read', does: 'Asks {inst} for a fresh reading.' },
  'fr.analog_in.inject': { verb: 'simulate a value', does: 'Holds {inst} at the value chosen, as if the input read it (a test build only).' },
  'fr.display.clear': { verb: 'clear', does: 'Fills {inst} with one colour.' },
  'fr.display.text': { verb: 'write text', does: 'Writes the text on {inst} at the place chosen.' },
  'fr.display.fill_rect': { verb: 'fill a box', does: 'Fills a box on {inst} with one colour.' },
  'fr.display.set_brightness': { verb: 'set brightness', does: 'Changes how bright {inst} is.' },
  'fr.display.ui_load': { verb: 'load a layout', does: 'Replaces what {inst} shows with the layout given.' },
  'fr.display.ui_set': { verb: 'change a widget', does: 'Changes one widget of the layout {inst} shows.' },
  'fr.display.snapshot': { verb: 'snapshot', does: 'Keeps what {inst} shows now so it can be read back (a test build only).' },
  'fr.display.snapshot_read': { verb: 'read the snapshot', does: 'Reads part of the kept picture back (a test build only).' },
  'fr.audio_out.tone': { verb: 'play a tone', does: 'Plays a tone on {inst} at the pitch and length chosen.' },
  'fr.audio_out.play': { verb: 'play a file', does: 'The hub plays a file or a tone on {inst}.' },
  'fr.audio_out.stop': { verb: 'stop', does: 'Stops what {inst} plays.' },
  'fr.audio_out.set_volume': { verb: 'set volume', does: 'Changes how loud {inst} plays.' },
  'fr.audio_in.stream_start': { verb: 'start a stream', does: 'The hub records from {inst} to a file.' },
  'fr.audio_in.stream_stop': { verb: 'stop the stream', does: 'Ends the stream {inst} sends now.' },
  'fr.audio_in.level_get': { verb: 'read the level', does: 'Asks {inst} how loud it hears now.' },
  'fr.audio_in.monitor_start': { verb: 'listen through', does: 'Plays what {inst} hears on the speaker chosen.' },
  'fr.audio_in.monitor_stop': { verb: 'stop listening', does: 'Stops playing what {inst} hears.' },
  'fr.csi.stream_start': { verb: 'start a stream', does: 'The hub streams what {inst} senses.' },
  'fr.csi.stream_stop': { verb: 'stop the stream', does: 'Ends the stream {inst} sends now.' },
  'fr.csi.baseline_reset': { verb: 'learn the room again', does: 'Makes {inst} take the room as it is now as still.' },
  'fr.radio_tx.start': { verb: 'start sending', does: 'Sends packets to the peer chosen, at the pace chosen.' },
  'fr.radio_tx.stop': { verb: 'stop sending', does: 'Stops the packets {inst} sends.' },
  'fr.scale.tare': { verb: 'tare', does: 'Takes what lies on {inst} now as zero.' },
  'fr.scale.calibrate': { verb: 'calibrate', does: 'Teaches {inst} a known weight lying on it now.' },
  'fr.scale.read': { verb: 'read', does: 'Asks {inst} for a fresh reading.' },
  'fr.scale.reset_calibration': { verb: 'reset calibration', does: 'Forgets what {inst} was taught. It cannot be undone.' },
  'fr.scale.watch_start': { verb: 'watch', does: 'Makes {inst} report its weight often for a while.' },
  'fr.scale.watch_stop': { verb: 'stop watching', does: 'Ends the frequent reports of {inst}.' },
  'fr.battery.read': { verb: 'read', does: 'Asks {inst} for a fresh reading.' },
  'fr.battery.calibrate': { verb: 'calibrate', does: 'Teaches {inst} the reading of a meter held on the cell now.' },
  'fr.battery.reset_calibration': { verb: 'reset calibration', does: 'Forgets what {inst} was taught. It cannot be undone.' },
  'fr.battery.load': { verb: 'switch the load', does: 'Switches the test load on {inst} on or off.' },
  'fr.battery.gate': { verb: 'switch the gate', does: 'Opens or closes the gate that feeds the board.' },
  'fr.haptic.pulse': { verb: 'pulse', does: 'Buzzes {inst} once.' },
  'fr.haptic.play': { verb: 'play a pattern', does: 'Buzzes {inst} in the pattern given.' },
  'fr.haptic.stop': { verb: 'stop', does: 'Stops {inst}.' },
  'fr.haptic.tap': { verb: 'tap', does: 'Taps {inst} the times chosen at the rate chosen, or until it is stopped; while it taps, new settings change it in place and keep the beat.' },
  'fr.storage.info': { verb: 'read the card', does: 'Asks {inst} how full its card is.' },
  'fr.storage.list': { verb: 'list a folder', does: 'Lists a folder on the card.' },
  'fr.storage.remove': { verb: 'remove a file', does: 'Removes a file from the card. It cannot be undone.' },
  'fr.storage.remount': { verb: 'mount again', does: 'Mounts the card again.' },
  'fr.clock.read': { verb: 'read', does: 'Asks {inst} for its time now.' },
  'fr.clock.set': { verb: 'set the time', does: 'Sets the time {inst} keeps.' },
  'fr.clock.set_aging': { verb: 'trim', does: 'Trims how fast {inst} runs.' },
  'fr.stepper.move_to': { verb: 'go to', does: 'Turns {inst} to the position given, speeding up and slowing down smoothly.' },
  'fr.stepper.move_by': { verb: 'turn by', does: 'Turns {inst} by the steps given.' },
  'fr.stepper.jog': { verb: 'spin', does: 'Spins {inst} at the speed given until it is stopped.' },
  'fr.stepper.stop': { verb: 'stop', does: 'Slows {inst} down to a stop.' },
  'fr.stepper.halt': { verb: 'halt', does: 'Stops {inst} at once; a fast motor may lose its place.' },
  'fr.stepper.hold': { verb: 'hold', does: 'Turns the coils of {inst} on to hold it where it is.' },
  'fr.stepper.release': { verb: 'let go', does: 'Turns the coils of {inst} off.' },
  'fr.stepper.zero': { verb: 'set position', does: 'Calls where {inst} is now its position, without moving it.' },
  'fr.stepper.configure': { verb: 'configure', does: 'Changes how {inst} moves and how hard it drives its coils, and keeps it.' },
  'fr.stepper.reset_settings': { verb: 'reset settings', does: 'Forgets what {inst} was configured with. It cannot be undone.' },
  'fr.buzzer.tone': { verb: 'play a tone', does: 'Plays a tone on {inst} at the pitch and length chosen.' },
  'fr.buzzer.beep': { verb: 'beep', does: 'Beeps {inst} the times chosen, or until it is stopped.' },
  'fr.buzzer.melody': { verb: 'play a melody', does: 'Plays the notes given on {inst}, one after another.' },
  'fr.buzzer.stop': { verb: 'stop', does: 'Stops what {inst} plays.' },
  'fr.buzzer.set_volume': { verb: 'set volume', does: 'Changes how loud {inst} plays, now and later.' },
  'fr.node.identify': { verb: 'identify', does: 'Lights the first LED of the board for a while, so you can find it.' },
  'fr.node.describe': { verb: 'describe', does: 'Asks the board what it has.' },
  'fr.node.reboot': { verb: 'restart', does: 'Restarts the board. Its streams and blinks end.' },
  'fr.node.set_alias': { verb: 'rename', does: 'Tells the board its new name. Rename at the top of the page does this for you.' },
  'fr.node.get_state': { verb: 'read its state', does: 'Asks the board for its state.' },
  'fr.node.bind_list': { verb: 'list bindings', does: 'Asks the board for its own table of bindings.' },
  'fr.node.bind_clear': { verb: 'clear a binding', does: 'Removes one binding from the board.' },
  'fr.node.net_set': { verb: 'set its network', does: 'Gives the board a network to join. A wrong one takes it off the hub.' },
  'fr.diag.exec': { verb: 'run', does: 'Runs a diagnostic line on the board.' },
};

/** A command's words: the table's, else its name with spaces. */
export function commandWords(cap: string, cmd: string): CommandWords {
  return COMMANDS[`${cap}.${cmd}`] ?? { verb: fieldWords(cmd) };
}

/** The table's sentence for a command with its instance put in, or null. */
export function commandDoes(cap: string, cmd: string, inst: string): string | null {
  const d = COMMANDS[`${cap}.${cmd}`]?.does;
  return d ? d.replace(/\{inst\}/g, inst) : null;
}

/** Every sentence the table says (the test checks each is pure-safe). */
export function allCommandSentences(): string[] {
  return Object.values(COMMANDS)
    .map((c) => c.does)
    .filter((d): d is string => !!d);
}

/** A command whose effect cannot be undone: its button is destructive and asks first. */
export function isDestructive(cmd: string): boolean {
  return /_delete$|^erase|^reset|^forget/.test(cmd);
}

/** The first sentence of a catalog doc ("Ends stream `stream_id` …"), backticks dropped. */
export function firstSentence(doc: string): string {
  const text = doc.trim().replace(/\s+/g, ' ').replace(/`/g, '');
  const m = /^(.*?[.!?])(\s|$)/.exec(text);
  return (m ? m[1]! : text).trim();
}
