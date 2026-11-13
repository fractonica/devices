// BENCH, route `/bench`. STUB of the stage 4 foundation, for the Bench page builder (HARDWARE-REVIEW §4 "Screens"
// 7): fold web/bench (wiring guides, parts, shopping) in; other instruments are linked from here. Until then the
// bench app the hub serves at /apps/bench/ is linked.

import { Button, EmptyState, Page } from '../ui/index.ts';

export function BenchPage() {
  return (
    <Page title="Bench">
      <EmptyState
        title="The bench app"
        action={
          <Button variant="primary" onClick={() => location.assign('/apps/bench/')}>
            Open the bench
          </Button>
        }
      >
        Wiring guides, parts and shopping lists are in the bench app the hub serves beside this dashboard; they move onto this page next.
      </EmptyState>
    </Page>
  );
}
