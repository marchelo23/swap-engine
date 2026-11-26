import { prepareForwardConsolidation } from '../src/persistence/PrepareForwardConsolidation.js';

async function main() {
  const [adminDirectory, otherDirectory, outputDirectory, evidenceFile, ...extra] = process.argv.slice(2);
  if (!adminDirectory || !otherDirectory || !outputDirectory || !evidenceFile || extra.length)
    throw new Error('Expected: <admin-directory> <other-directory> <empty-output-directory> <evidence-file>');
  const { entries } = await prepareForwardConsolidation({ adminDirectory, otherDirectory, outputDirectory, evidenceFile });
  console.log(`Private review bundle prepared (${entries} entries); no journal activated.`);
}

main().catch(() => {
  // Paths, JSON parser diagnostics and Zod data may contain private material.
  console.error('Offline preparation failed; no activation attempted. Inspect private inputs, locks and output locally.');
  process.exitCode = 1;
});
