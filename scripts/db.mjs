// Database changes through the Supabase command-line tool, which records in the database
// which migrations have been applied (so nobody has to remember, and none is run twice).
//   npm run db:status     which migrations the database has, and which are waiting
//   npm run db:plan       what db:push would apply, without applying anything
//   npm run db:push       apply the waiting migrations, in order
//   npm run db:baseline   one-off: record every migration file as already applied, for a
//                         database that was set up by pasting SQL before this tool was used
//
// Needs SUPABASE_DB_URL: the "Session pooler" connection string from Supabase → Connect, with
// the database password filled in (percent-encode any special characters in the password).
// Put it in .env for the development database. For any other database, pass it for that one
// command and add --production, e.g.  SUPABASE_DB_URL=... npm run db:push -- --production
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const developmentProject = 'ihndsjxwnogyxcixujwv'; // the same project scripts/dev-guard.ts allows
const cli = 'supabase@2.122.1';
const [command, ...flags] = process.argv.slice(2);
const fromFile = existsSync('.env') ? /^SUPABASE_DB_URL=(.*)$/m.exec(readFileSync('.env', 'utf8'))?.[1] : '';
const url = (process.env.SUPABASE_DB_URL || fromFile || '').trim().replace(/^["']|["']$/g, '');
const fail = text => {
  console.error(text);
  process.exit(1);
};
if (!['status', 'plan', 'push', 'baseline'].includes(command))
  fail('Use: npm run db:status | db:plan | db:push | db:baseline');
if (!/^postgres(ql)?:\/\/.+@.+/.test(url))
  fail('Set SUPABASE_DB_URL (Supabase → Connect → Session pooler connection string). See the top of scripts/db.mjs.');
const development = url.includes(developmentProject);
if (!development && !flags.includes('--production'))
  fail('This connection string is not the development database. Add --production if that is intended.');

const versions = readdirSync('supabase/migrations')
  .filter(name => /^\d+_.*\.sql$/.test(name))
  .sort()
  .map(name => name.split('_')[0]);
const args = {
  status: ['migration', 'list'],
  plan: ['db', 'push', '--dry-run'],
  push: ['db', 'push'],
  baseline: ['migration', 'repair', '--status', 'applied', ...versions],
}[command];
console.log(
  `${command} on the ${development ? 'development' : 'PRODUCTION'} database (${versions.length} migration files)`,
);
const result = spawnSync('npx', ['-y', cli, ...args, '--db-url', url], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
