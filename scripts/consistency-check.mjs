import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// 1. Get current asset_accounts balances
const [accounts] = await conn.execute('SELECT userId, asset, available, locked FROM asset_accounts ORDER BY userId, asset');
console.log('=== Current Asset Accounts ===');
accounts.forEach(r => {
  const total = parseFloat(r.available) + parseFloat(r.locked);
  console.log(`  UID:${r.userId} ${r.asset}: available=${parseFloat(r.available).toFixed(8)}, locked=${parseFloat(r.locked).toFixed(8)}, total=${total.toFixed(8)}`);
});

// 2. Get ledger sum per user per asset
const [ledger] = await conn.execute(`
  SELECT userId, asset, 
         SUM(delta) as total_delta, 
         SUM(lockedDelta) as total_locked_delta,
         COUNT(*) as entry_count
  FROM ledger_entries 
  GROUP BY userId, asset 
  ORDER BY userId, asset
`);
console.log('\n=== Ledger Sums ===');
ledger.forEach(r => {
  const ledAvailable = parseFloat(r.total_delta) - parseFloat(r.total_locked_delta);
  const ledLocked = parseFloat(r.total_locked_delta);
  const ledTotal = parseFloat(r.total_delta);
  console.log(`  UID:${r.userId} ${r.asset}: available=${ledAvailable.toFixed(8)}, locked=${ledLocked.toFixed(8)}, total=${ledTotal.toFixed(8)}, entries=${r.entry_count}`);
});

// 3. Cross-check using correct formula:
//    account.available = sum(delta) - sum(lockedDelta)
//    account.locked = sum(lockedDelta)
console.log('\n=== Consistency Check (correct formula) ===');
let allOk = true;
for (const acc of accounts) {
  const led = ledger.find(l => l.userId === acc.userId && l.asset === acc.asset);
  if (!led) {
    console.log(`  NO_LEDGER UID:${acc.userId} ${acc.asset}`);
    allOk = false;
    continue;
  }
  const accAvailable = parseFloat(acc.available);
  const accLocked = parseFloat(acc.locked);
  const ledAvailable = parseFloat(led.total_delta) - parseFloat(led.total_locked_delta);
  const ledLocked = parseFloat(led.total_locked_delta);
  
  const availDiff = Math.abs(accAvailable - ledAvailable);
  const lockedDiff = Math.abs(accLocked - ledLocked);
  const ok = availDiff < 0.0001 && lockedDiff < 0.0001;
  if (!ok) allOk = false;
  
  const status = ok ? 'OK' : 'MISMATCH';
  console.log(`  ${status} UID:${acc.userId} ${acc.asset}:`);
  console.log(`    available: account=${accAvailable.toFixed(8)}, ledger=${ledAvailable.toFixed(8)}, diff=${availDiff.toFixed(8)}`);
  console.log(`    locked:    account=${accLocked.toFixed(8)}, ledger=${ledLocked.toFixed(8)}, diff=${lockedDiff.toFixed(8)}`);
}

// 4. Check order_freeze entries - should have refId
console.log('\n=== Ledger Entries Without refId (order_freeze) ===');
const [noRef] = await conn.execute(`
  SELECT id, userId, asset, delta, lockedDelta, reason, refTable, refId
  FROM ledger_entries 
  WHERE refId IS NULL AND reason != 'deposit' AND reason != 'admin_adjust' AND reason != 'withdraw_freeze'
  ORDER BY id
`);
if (noRef.length === 0) {
  console.log('  (none - all freeze entries have refId)');
} else {
  noRef.forEach(r => console.log(`  #${r.id} ${r.reason}/${r.refTable}#${r.refId}: delta=${r.delta}, lockedDelta=${r.lockedDelta}`));
  console.log(`  ⚠️  ${noRef.length} entries missing refId`);
}

// 5. Check trades table columns
console.log('\n=== Trades Table ===');
const [tradeCols] = await conn.execute('DESCRIBE trades');
console.log('  Columns:', tradeCols.map(c => c.Field).join(', '));
const [trades] = await conn.execute('SELECT * FROM trades ORDER BY id LIMIT 5');
if (trades.length === 0) {
  console.log('  (no trades)');
} else {
  trades.forEach(r => console.log(`  trade#${r.id}:`, JSON.stringify(r)));
}

if (allOk) console.log('\n✅ All balances consistent with ledger!');
else console.log('\n❌ Inconsistencies found!');

await conn.end();
