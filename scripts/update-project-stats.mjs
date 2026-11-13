import { collectStats, renderStats, validateRepository, writeStats } from './lib/project-stats.mjs';

const args = process.argv.slice(2);
let repository = process.env.GITHUB_REPOSITORY;
let output = 'PROJECT_STATS.md';
try {
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === '--help') {
      console.log('Usage: node scripts/update-project-stats.mjs [--repo owner/repo] [--output path]');
      process.exit(0);
    }
    if (!['--repo', '--output'].includes(argument) || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw new Error('Expected --repo owner/repo or --output path; use --help');
    }
    if (argument === '--repo') repository = args[++i];
    else output = args[++i];
  }
  validateRepository(repository);
  const stats = await collectStats(repository, { token: process.env.GITHUB_TOKEN });
  const changed = await writeStats(output, renderStats(stats));
  console.log(changed ? `Updated ${output}` : 'Project statistics are unchanged');
} catch (error) {
  console.error(`Stats update failed: ${error.message}`);
  process.exitCode = 1;
}
