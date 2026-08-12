import { searchTerm, statusCommand, connectionCommand } from '../utils/planner.js';
import { resolvePerson } from '../utils/people.js';
let fail = 0;
const is = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + label + (ok ? '' : '  got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)));
  if (!ok) fail++;
};

console.log('=== searchTerm: Vietnamese survives as words ===');
is(searchTerm('ngày mai có gì'), 'ngay mai co gi', 'vietnamese not shredded');
is(searchTerm('lịch ngày mai'), 'lich ngay mai', 'lich kept (not a stopword), words intact');   // lich may or may not be a stopword
is(searchTerm('when does my flight start'), 'flight', 'english regression: flight');
is(searchTerm("what's on my calendar today"), '', 'english regression: agenda -> empty');

console.log('=== statusCommand: anchored, no mid-sentence false positive ===');
is(statusCommand('kavi tell me about my accounts payable meeting'), false, 'accounts payable NOT status');
is(statusCommand('kavi status'), true, 'bare status still works');
is(statusCommand('kavi connections'), true, 'connections still works');
is(statusCommand('kavi sign in'), true, 'sign in still works');
is(statusCommand('kavi accounts'), true, 'bare accounts still works');

console.log('=== connectionCommand: thu no longer hijacks Monday ===');
is(connectionCommand('kavi thứ hai có gì'), null, 'Monday question NOT routed to gmail');
is(connectionCommand('kavi gmail from tracy'), { slug: 'gmail', action: 'from tracy' }, 'gmail still routes');
is(connectionCommand('kavi mail'), { slug: 'gmail', action: '' }, 'mail alias still routes');

console.log('=== resolvePerson: exact-or-ask ===');
const dir = [
  { name: 'Kevin Tran', email: 'kevin.tran@x.com', seen: 9 },
  { name: 'Tracy Lam',  email: 'tracy.lam@x.com',  seen: 2 },
];
is(resolvePerson('tra', dir), null, 'tra is ambiguous (Tran vs Tracy) -> null (ask) [was: silently Kevin Tran]');
is(resolvePerson('trac', dir) && resolvePerson('trac', dir).name, 'Tracy Lam', 'trac -> Tracy (unambiguous name-prefix)');
is(resolvePerson('kevin', dir) && resolvePerson('kevin', dir).name, 'Kevin Tran', 'kevin -> Kevin (single name hit)');
is(resolvePerson('tracy.lam@x.com', dir).name, 'Tracy Lam', 'exact email');
// ambiguous: two people whose name-token starts with "k"
const dir2 = [{name:'Kevin Tran',email:'a@x.com'},{name:'Karen Ng',email:'b@x.com'}];
is(resolvePerson('k', dir2), null, 'ambiguous name-prefix -> null (ask)');

console.log(fail ? '\n' + fail + ' FAILED' : '\nall passed');
process.exit(fail ? 1 : 0);
