'use strict';

// Offline Stage 7b evaluation CLI wrapper for router-journal/v1.
// Strictly read-only (reads NDJSON directory passed as CLI arg, zero writes, zero network, zero Electron).
const { DEFAULT_BOOTSTRAP, evaluateRouterJournal, formatMarkdownReport } = require('../src/main/brain/router-eval');

function parseArgs(argv) {
  let dir = null;
  let md = false;
  let seed = DEFAULT_BOOTSTRAP.seed;

  for (const arg of argv) {
    if (arg === '--md') {
      md = true;
    } else if (arg.startsWith('--seed=')) {
      const parsed = Number(arg.slice('--seed='.length));
      if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid --seed value: ${arg}`);
      seed = parsed;
    } else if (arg === '-h' || arg === '--help') {
      return { help: true };
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else if (!dir) {
      dir = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  return { help: false, dir, md, seed };
}

function usage() {
  return 'Usage: node scripts/router-eval-bench.js <router-journal-dir> [--md] [--seed=20261118]';
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (!opts.dir) {
    throw new Error(`Missing required <router-journal-dir>.\n${usage()}`);
  }
  const report = evaluateRouterJournal(opts.dir, { seed: opts.seed });
  if (opts.md) {
    process.stdout.write(formatMarkdownReport(report));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, main };
