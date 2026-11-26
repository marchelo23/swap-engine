import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareForwardConsolidation, ReviewOutcomeUncertainError } from '../src/persistence/PrepareForwardConsolidation.js';

export async function runConsolidationCLI(args: string[], io = {
  log: (line: string) => console.log(line),
  error: (line: string) => console.error(line),
}) {
  const [adminDirectory, historicalADirectory, historicalBDirectory, outputDirectory, evidenceFile, ...extra] = args;
  if (!adminDirectory || !historicalADirectory || !historicalBDirectory || !outputDirectory || !evidenceFile || extra.length) {
    io.error('Expected: <admin-directory> <historical-a> <historical-b> <empty-output-directory> <evidence-file>');
    return 1;
  }
  try {
    const { entries } = await prepareForwardConsolidation({
      adminDirectory, historicalADirectory, historicalBDirectory, outputDirectory, evidenceFile,
    });
    io.log(`Private review bundle prepared (${entries} entries); no journal activated.`);
    return 0;
  } catch (error) {
    // Paths, JSON parser diagnostics and Zod data may contain private material.
    if (error instanceof ReviewOutcomeUncertainError) {
      io.error('Offline preparation outcome uncertain after bundle publication; inspect locks and output locally without activating or re-running.');
    } else {
      io.error('Offline preparation failed; no activation attempted. Inspect private inputs, locks and output locally.');
    }
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runConsolidationCLI(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
