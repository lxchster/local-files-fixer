'use strict';
// Command line (no window):  node src/cli.js <folder> [--fix] [--no-backup] [--minor]
const core = require('./core');
(async () => {
  const args = process.argv.slice(2);
  const folder = args.find((a) => !a.startsWith('--'));
  if (!folder) { console.log('usage: node src/cli.js <folder> [--fix] [--no-backup] [--minor]'); process.exit(1); }
  const res = await core.scanFolder(folder);
  console.log(`Scanned ${res.nAudio} audio files (${res.nMp3} MP3, ${res.nM4a} M4A)`);
  for (const x of res.issues) console.log(`  [${core.CATEGORY_LABELS[x.cat]}] ${x.rel} - ${x.problem}`);
  for (const e of res.errors) console.log('  could not read', e);
  console.log(`${res.issues.length} issue(s)`);
  if (args.includes('--fix')) {
    const bk = args.includes('--no-backup') ? null : core.defaultBackupRoot(folder);
    let ok = 0, bad = 0;
    for (const x of res.issues) {
      if (!(core.CATEGORY_DEFAULT_ON[x.cat] || (args.includes('--minor') && x.cat === core.CAT_MINOR))) continue;
      try { console.log('  FIXED  ', x.rel, '-', core.fixIssue(x, folder, bk)); ok++; }
      catch (e) { console.log('  SKIPPED', x.rel, '-', e.message); bad++; }
    }
    console.log(`fixed ${ok}, skipped ${bad}${bk && ok ? '; backup in ' + bk : ''}`);
  }
})();
