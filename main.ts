// The harness runs `node /bot/main.ts` (node22). It reads every case from
// /input/cases.json, answers each one alone with run() from solve.js, and
// writes /output/answers.json: a JSON array of the answers, one per case and
// in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8 flags, set before solve.js is imported so all of its work runs under them
// (the rules let an entry tune V8's flags this way; the house baseline does
// the same with --no-incremental-marking):
//   --no-incremental-marking: as the house baseline.
//   --no-turbofan: the entry runs each case once, cold. TurboFan's optimizing
//     compiler costs more CPU (background compile threads) than its faster code
//     repays over 3 cold cases; Maglev + Sparkplug carry the execution instead.
//     Measured: cold run() CPU ~420 ms -> ~276 ms, whole process ~-26%.
//   --no-lazy: compile every function eagerly at import instead of lazily on
//     first call (import +~2 ms, cold run() a further ~-20 ms). Measured
//     whole-process ~-3% on top of --no-turbofan (15 paired rounds).
setFlagsFromString('--no-incremental-marking --no-turbofan --no-lazy');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
