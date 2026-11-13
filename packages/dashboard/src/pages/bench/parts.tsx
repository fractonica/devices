// Bench › Parts (part_list, part_show, part_stock): the catalogue by category with a search; a part with its specs
// (an inferred value marked as such), pins, notes, datasheets, what is on hand with a form to set it, and the guides
// that use it. Bench › Shopping (wiring_shopping): what the unfinished guides need, minus what is on hand.

import { useState } from 'react';

import { useAct, useOp } from '../../hooks.ts';
import { parseQty, partMatches } from '../../state/bench-view.ts';
import { Button, ButtonRow, Caps, Code, EmptyState, engrave, ErrorLine, Line, Pending, Row, Section, Select, TextField, useHubText, useMode } from '../../ui/index.ts';
import { Refused } from './guides.tsx';
import { BenchLink } from './link.tsx';
import { Said } from './said.tsx';

/** Remembered per viewer: the parts search (a convenience; nothing breaks without storage). */
const QUERY_KEY = 'fractonica.bench.q';
function stored(): string {
  try {
    return localStorage.getItem(QUERY_KEY) ?? '';
  } catch {
    return '';
  }
}
function store(q: string): void {
  try {
    localStorage.setItem(QUERY_KEY, q);
  } catch {
    // private window, blocked storage
  }
}

function useSay(): (t: string) => string {
  return useHubText();
}

export function PartsView() {
  const q = useOp('part_list', {});
  const [query, setQuery] = useState(stored);
  const parts = q.data?.parts ?? [];
  const shown = parts.filter((p) => partMatches(p, query));
  const cats = [...new Set(shown.map((p) => p.category))];
  return (
    <>
      <div className="bench-search">
        <TextField
          label="Search parts"
          type="search"
          value={query}
          onChange={(v) => {
            setQuery(v);
            store(v);
          }}
          placeholder="name, id or what it does"
          note={q.data ? `${shown.length} of ${parts.length}` : undefined}
        />
      </div>
      {q.error ? <ErrorLine error={q.error} what="Parts" fix={{ label: 'Try again', onClick: () => void q.refetch() }} /> : null}
      {!q.data && !q.error ? <Pending what="the parts" /> : null}
      {q.data && !shown.length ? (
        parts.length ? (
          <EmptyState title="No part matches" action={<Button onClick={() => {
                  setQuery('');
                  store('');
                }}>Show every part</Button>}>
            Nothing in the catalogue has those words in its name, id or summary.
          </EmptyState>
        ) : (
          <EmptyState title="No parts yet">
            A part lives in <Code>hardware/parts/&lt;id&gt;.part.yaml</Code>.
          </EmptyState>
        )
      ) : null}
      {cats.map((c) => {
        const inCat = shown.filter((p) => p.category === c);
        return (
          <Section key={c} title={c} aside={<Caps>{String(inCat.length)}</Caps>}>
            {inCat.map((p) => (
              <BenchLink key={p.id} to={{ view: 'part', id: p.id }} className="bench-rowlink">
                <Line
                  bead={p.have > 0 ? 'online' : 'idle'}
                  beadLabel={p.have > 0 ? `${p.have} on hand` : 'none on hand'}
                  name={<Said text={p.name} />}
                  value={p.have > 0 ? `${p.have} on hand` : <span className="ash">none on hand</span>}
                  detail={<Said text={`${p.summary}${p.values.length ? ` · ${p.values.join(', ')}` : ''}`} />}
                />
              </BenchLink>
            ))}
          </Section>
        );
      })}
      <Refused refused={q.data?.refused ?? []} />
    </>
  );
}

function Stock({ part }: { part: { id: string; values: string[]; stock: { value: string | null; qty: number; location: string | null; note: string | null }[] } }) {
  const [value, setValue] = useState(part.values[0] ?? '');
  const row = part.stock.find((s) => (s.value ?? '') === (part.values.length ? value : ''));
  const [qty, setQty] = useState(String(row?.qty ?? 0));
  const [loc, setLoc] = useState(row?.location ?? '');
  const save = useAct('part_stock', { done: (r) => `${r.part}: ${r.qty} on hand`, refresh: ['part_show', 'part_list', 'wiring_show', 'wiring_shopping'] });
  const n = parseQty(qty);
  const pick = (v: string) => {
    setValue(v);
    const r = part.stock.find((s) => (s.value ?? '') === v);
    setQty(String(r?.qty ?? 0));
    setLoc(r?.location ?? '');
  };
  return (
    <Section title="On hand" body="loose">
      {part.stock.length ? (
        <div>
          {part.stock.map((s) => (
            <Row key={s.value ?? ''} name={s.value ? <Said text={s.value} /> : undefined} label={s.value ? undefined : 'count'} value={`${s.qty}`} extra={[s.location ? `in ${s.location}` : null, s.note].filter(Boolean).join(' · ') || undefined} />
          ))}
        </div>
      ) : (
        <p className="bench-say">None recorded yet.</p>
      )}
      <form
        className="bench-stock-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (n === null) {
            return;
          }
          save.mutate({ part: part.id, qty: n, ...(part.values.length ? { value } : {}), ...(loc.trim() ? { location: loc.trim() } : {}) });
        }}
      >
        {part.values.length ? <Select label="Value" value={value} onChange={pick} options={part.values.map((v) => ({ value: v, label: v }))} /> : null}
        <TextField label="How many" value={qty} onChange={setQty} inputMode="numeric" error={n === null ? 'a whole number, 0 or more' : undefined} />
        <TextField label="Where" value={loc} onChange={setLoc} maxLength={100} placeholder="drawer, box" />
        <ErrorLine error={save.error} what="Save" />
        <ButtonRow>
          <Button type="submit" variant="primary" busy={save.isPending} disabled={n === null} data-action="save-stock">
            Save
          </Button>
        </ButtonRow>
      </form>
    </Section>
  );
}

export function PartView({ id }: { id: string }) {
  const q = useOp('part_show', { part: id });
  const say = useSay();
  const p = q.data;
  const back = (
    <BenchLink to={{ view: 'parts' }} className="bench-back caps">
      {engrave('← all parts')}
    </BenchLink>
  );
  if (q.error) {
    return (
      <>
        {back}
        <ErrorLine error={q.error} what={`Part ${id}`} />
      </>
    );
  }
  if (!p) {
    return (
      <>
        {back}
        <Pending what="the part" />
      </>
    );
  }
  const inferred = new Set(p.inferred);
  const specs = Object.entries(p.specs);
  return (
    <>
      {back}
      <header className="bench-part-head">
        <h2 className="bench-guide-name">
          <Said text={p.name} />
        </h2>
        <p className="bench-part-cat caps">{engrave(`${p.category} · ${p.id}`)}</p>
        <p className="bench-guide-about"><Said text={p.summary} /></p>
        {p.image ? <img className="bench-part-image" src={p.image} alt={say(p.name)} /> : null}
      </header>
      {specs.length ? (
        <Section title="Specs">
          {specs.map(([k, v]) => (
            <Row key={k} bead={inferred.has(k) ? 'waiting' : undefined} beadLabel={inferred.has(k) ? 'inferred' : undefined} label={k.replace(/_/g, ' ')} value={<Said text={v} />} extra={inferred.has(k) ? 'inferred: not read in a datasheet or on the bench' : undefined} />
          ))}
        </Section>
      ) : null}
      {p.pins.length || p.pinout ? (
        <Section title="Pins">
          {p.pinout ? <p className="bench-say"><Said text={p.pinout} /></p> : null}
          {p.pins.map((x) => (
            <Row key={x.name} name={<Code>{x.name}</Code>} value={x.desc ? <Said text={x.desc} /> : ''} />
          ))}
        </Section>
      ) : null}
      {p.notes.length ? (
        <Section title="Notes">
          {p.notes.map((n) => (
            <Line key={n} name={<span className="bench-line-text"><Said text={n} /></span>} />
          ))}
        </Section>
      ) : null}
      {p.datasheets.length ? (
        <Section title="Datasheets">
          {p.datasheets.map((d) => (
            <Row
              key={d}
              name={
                <a className="bench-ext" href={d} target="_blank" rel="noopener noreferrer">
                  {d.replace(/^https?:\/\//, '')}
                </a>
              }
            />
          ))}
        </Section>
      ) : null}
      <Stock key={p.id} part={p} />
      {p.used_by.length ? (
        <Section title="Used by">
          {p.used_by.map((u) => (
            <BenchLink key={`${u.guide}:${u.value ?? ''}`} to={{ view: 'guide', id: u.guide }} className="bench-rowlink">
              <Line name={<Said text={u.title} />} value={<Said text={`${u.qty}${u.value ? ` × ${u.value}` : ''}`} />} />
            </BenchLink>
          ))}
        </Section>
      ) : null}
    </>
  );
}

export function ShoppingView() {
  const q = useOp('wiring_shopping', {});
  const lines = q.data?.lines ?? [];
  const buy = lines.filter((l) => l.missing > 0);
  return (
    <Section title="To buy" aside={<Caps>{q.data ? (q.data.guides.length ? `for ${q.data.guides.join(', ')}` : 'every guide is finished') : ''}</Caps>}>
      {q.error ? <ErrorLine error={q.error} what="Shopping" /> : null}
      {!q.data && !q.error ? <Row bead="idle" label="Adding it up" value="—" /> : null}
      {q.data && !buy.length ? (
        <EmptyState title={q.data.guides.length ? 'Nothing to buy' : 'Every guide is finished'}>
          {q.data.guides.length ? 'What the unfinished guides need is on hand, as recorded under Parts.' : 'No unfinished guide needs a part.'}
        </EmptyState>
      ) : null}
      {lines.map((l) => (
        <BenchLink key={`${l.part}:${l.value ?? ''}`} to={{ view: 'part', id: l.part }} className="bench-rowlink">
          <Line
            bead={l.missing > 0 ? 'waiting' : 'online'}
            beadLabel={l.missing > 0 ? 'to buy' : 'on hand'}
            name={<Said text={`${l.name}${l.value ? ` ${l.value}` : ''}`} />}
            value={l.missing > 0 ? <span className="bench-buy">buy {l.missing}</span> : <span className="ash">on hand</span>}
            detail={`needs ${l.need} · ${l.have} on hand · for ${l.guides.join(', ')}`}
          />
        </BenchLink>
      ))}
    </Section>
  );
}

