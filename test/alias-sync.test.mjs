import { connectionCommand, setUserAliases } from '../utils/planner.js';
let fail=0; const is=(g,w,l)=>{const ok=JSON.stringify(g)===JSON.stringify(w);console.log((ok?'  ok   ':'  FAIL ')+l+(ok?'':'  got '+JSON.stringify(g)));if(!ok)fail++;};

// before any sync: only built-ins
is(connectionCommand('kavi mail'), {slug:'gmail',action:''}, 'built-in mail still works');
is(connectionCommand('kavi zzz'), null, 'unknown -> null');

// wearer defines app alias "post" -> slack, and shortcut "inbox" -> gmail newer_than:2d
setUserAliases([
  { phrase:'post', kind:'app', slug:'slack', action:'' },
  { phrase:'inbox', kind:'shortcut', slug:'gmail', action:'newer_than:2d' },
]);
is(connectionCommand('kavi post hello team'), {slug:'slack',action:'hello team'}, 'user app-alias routes');
is(connectionCommand('kavi inbox'), {slug:'gmail',action:'newer_than:2d'}, 'shortcut supplies canned action');
is(connectionCommand('kavi inbox from tracy'), {slug:'gmail',action:'newer_than:2d from tracy'}, 'shortcut action merges with spoken tail');
is(connectionCommand('kavi mail'), {slug:'gmail',action:''}, 'built-ins still present after sync');

// re-sync with empty clears user aliases
setUserAliases([]);
is(connectionCommand('kavi post hi'), null, 'cleared user alias no longer routes');
console.log(fail?('\n'+fail+' FAILED'):'\nall passed'); process.exit(fail?1:0);
