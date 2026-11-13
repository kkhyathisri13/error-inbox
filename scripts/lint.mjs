import { lintRepository } from './lib/lint.mjs';

const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--root')) {
  console.error('Usage: node scripts/lint.mjs [--root directory]');
  process.exitCode = 1;
} else {
  try {
    const result = await lintRepository(args[1] ?? process.cwd());
    if (result.errors.length) {
      console.error(result.errors.join('\n'));
      process.exitCode = 1;
    } else console.log(`Lint passed: ${result.checkedFiles} files (syntax, style, docs, JSON, action pins)`);
  } catch (error) {
    console.error(`Lint failed: ${error.message}`);
    process.exitCode = 1;
  }
}
