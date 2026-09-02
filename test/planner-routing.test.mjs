import { searchTerm, statusCommand, connectionCommand, faceCommand, signinCommand, namedPerson, rulePlanner } from '../utils/planner.js';
import { resolveDay, findDayIn, addDays } from '../utils/clock.js';
import { dayRange, todayKey } from '../utils/calendar.js';
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


console.log('=== the ASR spells "Kavi" several ways (heard on real glasses) ===');
// Kavie and Carvi were transcribed on-device and matched nothing, which left the
// wake word unstripped and silently disabled every front-anchored command.
for (const name of ['Kavi', 'Kavie', 'Cavi', 'Cavy', 'Kavy', 'Carvi', 'Karvie', 'Ka vi']) {
  is(faceCommand(name + ' halo'), { action: 'identify' }, name + ' halo -> identify');
  is(signinCommand(name + ' start'), true, name + ' start -> sign in');
}
is(faceCommand('Kavie halo Tracy Lam'), { action: 'remember', name: 'Tracy Lam' }, 'mis-heard name still enrols');

console.log('=== greeting vocabulary: halo / hello / hi ===');
for (const greet of ['halo', 'hallo', 'hullo', 'hello', 'hey', 'hi', 'xin chao', 'chao']) {
  is(faceCommand('kavi ' + greet), { action: 'identify' }, 'kavi ' + greet + ' -> identify');
}
is(faceCommand('kavi hello, Tracy'), { action: 'remember', name: 'Tracy' }, 'comma after greeting still enrols');
is(faceCommand('kavi hi.'), { action: 'identify' }, 'trailing full stop still identifies');

console.log('=== the widened name must not swallow ordinary words ===');
// Each of these reaches the vowel and then fails the trailing \b.
for (const phrase of ['cavity check', 'car video', 'carvings on the door', 'cabinet']) {
  is(signinCommand(phrase + ' start'), false, phrase + ' is not the wake word');
}
is(faceCommand('hide the card'), null, '"hide" does not read as the greeting "hi"');
is(faceCommand('what is on my calendar'), null, 'calendar question is not a face command');


console.log('=== resolveDay: the whole day vocabulary, against a fixed Wednesday ===');
const T = '2026-09-02';                       // a Wednesday
const day = (w) => resolveDay(w, T).date;
is(day('2026-09-10'), '2026-09-10', 'ISO passes through');
is(day('today'), '2026-09-02', 'today');
is(day('tonight'), '2026-09-02', 'tonight');
is(day('tomorrow'), '2026-09-03', 'tomorrow');
is(day('yesterday'), '2026-09-01', 'yesterday');
is(day('day after tomorrow'), '2026-09-04', 'day after tomorrow');
is(day('friday'), '2026-09-04', 'bare weekday -> next upcoming');
is(day('wednesday'), '2026-09-02', 'the weekday it already is -> today, not +7');
is(day('next wednesday'), '2026-09-09', "next <the weekday it already is> -> +7");
is(day('next friday'), '2026-09-11', 'next friday = bare friday + 7');
is(day('last friday'), '2026-08-28', 'last friday -> the most recent one');
is(day('+2'), '2026-09-04', 'signed offset');
is(day('in 3 days'), '2026-09-05', 'in N days');
is(day('ngay mai'), '2026-09-03', 'vietnamese tomorrow');
is(day('hom qua'), '2026-09-01', 'vietnamese yesterday');
is(resolveDay('banana', T).matched, false, 'a non-day word does not match');
is(resolveDay('', T).matched, false, 'empty does not match');
is(day('next week'), null, 'ranges are deliberately out of scope');

console.log('=== findDayIn: a day named inside a sentence ===');
is(findDayIn('what do i have on friday', T), '2026-09-04', 'weekday mid-sentence');
is(findDayIn('google calendar tomorrow', T), '2026-09-03', 'the reported utterance');
is(findDayIn('am i free next friday', T), '2026-09-11', 'modifier beats the bare weekday');
is(findDayIn('when does my flight start', T), null, 'no day named');
// The short forms are whole-input only; unanchored they would re-create the
// "thu"/"thứ hai" collision the test below guards.
is(findDayIn('sat down at the table', T), null, '"sat" inside prose is not Saturday');
is(findDayIn('i thu it was fine', T), null, '"thu" inside prose is not Thursday');

console.log('=== dayRange: no longer silently degrades to today ===');
is(dayRange('tomorrow').date, addDays(todayKey(), 1), 'day word resolves');
is(dayRange('tomorrow').fallback, false, 'a day it understood is not a fallback');
is(dayRange('').date, todayKey(), 'empty means today');
is(dayRange('').fallback, false, 'empty is a legitimate today, not a failure');
is(dayRange('2026-09-03').date, '2026-09-03', 'ISO still works');
// Prints one "[people-memory] unrecognised day" line — that is the fix.
is(dayRange('banana').fallback, true, 'unreadable input is flagged, not hidden');
is(dayRange('banana').date, todayKey(), 'and still falls back to today');

console.log('=== "Google Calendar tomorrow" — the reported bug ===');
is(connectionCommand('google calendar tomorrow'), { slug: 'googlecalendar', action: 'tomorrow' }, 'routes (was null)');
is(connectionCommand('kavi google calendar tomorrow'), { slug: 'googlecalendar', action: 'tomorrow' }, 'with the wake word');
is(connectionCommand('google calendar'), { slug: 'googlecalendar', action: '' }, 'bare "google calendar"');
is(connectionCommand('kavi gcal friday'), { slug: 'googlecalendar', action: 'friday' }, 'gcal alias');
is(connectionCommand('kavi calendar tomorrow'), { slug: 'googlecalendar', action: 'tomorrow' }, 'longest-first did not break the short alias');

console.log('=== namedPerson no longer claims the service name ===');
is(namedPerson('google calendar tomorrow'), null, '"google" is not a person (was: "google")');
is(namedPerson('gmail calendar'), null, 'nor is "gmail"');
is(namedPerson('is tracy busy'), 'tracy', 'a real name still resolves');
is(namedPerson('my calendar today'), null, 'a determiner still suppresses');

console.log('=== rulePlanner: weekdays reach the agenda window ===');
const tools = [{ name: 'GOOGLECALENDAR_EVENTS_LIST' }];
const friday = resolveDay('friday', todayKey()).date;
const p1 = await rulePlanner.plan('what do i have on friday', tools, {});
is(p1.intent, 'agenda', 'a weekday question is an agenda question');
is(p1.day, friday, 'and its day is Friday, not today');
is((await rulePlanner.plan('tomorrow', tools, {})).day, addDays(todayKey(), 1), 'the rewritten "tomorrow" tail');
is((await rulePlanner.plan('', tools, {})).intent, 'agenda', 'the empty tail from a bare "Kavi google calendar"');
is((await rulePlanner.plan('when does my flight start', tools, {})).intent, 'search', 'the !day search guard still fires');

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
