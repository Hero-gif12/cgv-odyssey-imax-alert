import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {TARGETS, MonitorError, D1Store, parseSchedule, fetchSchedule, sendDiscord, poll as runPoll, resetState, parseMovies, parseDates, discoverTargets} from './worker.mjs';

// Synthetic data, not a claim that these showtimes are available at CGV.
const row = {movNm:'어벤져스-둠스데이',scnsNm:'IMAX관',scnYmd:'20261216',
  scnsrtTm:'1330',siteNo:'0074',frSeatCnt:'1',cntlYn:'N'};
const start = Date.parse('2026-10-08T00:00:00Z');
const initial = () => ({version:1, initialized:true, seen:{}, failures:0, next_retry:null, unhealthy:false,registration:TARGETS[0].state_key});
function setup(state=initial()) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(new URL('./schema.sql',import.meta.url),'utf8'));
  sql.prepare('INSERT INTO monitor_state(id,body) VALUES (1,?)').run(JSON.stringify(state));
  const db = {prepare(query) { let args=[]; return {
    bind(...values) { args=values; return this; },
    async first() { return sql.prepare(query).get(...args) || null; },
    async run() { const result=sql.prepare(query).run(...args); return {meta:{changes:Number(result.changes)}}; }
  }; }};
  let now=start;
  return {db, env:{DB:db, MONITOR_ENABLED:'true'}, clock:()=>now,
    advance:ms=>{now+=ms;}, state:()=>JSON.parse(sql.prepare('SELECT body FROM monitor_state').get().body)};
}
const dated = {...TARGETS[0],date:'2026-12-16'};
const inventory = {count:1,matched:[{id:'123',title:'어벤져스: 둠스데이'}],dates:[dated.date]};
const poll = (env,options={})=>runPoll(env,{discover:async()=>inventory,...options});
const result = target => parseSchedule({statusCode:0,data:[{...row,scnYmd:target.date.replaceAll('-','')}]},target,start);

test('the only target is Doomsday Wangsimni IMAX with December 16 screening start and immediate monitoring', () => {
  assert.equal(TARGETS.length,1); assert.equal(TARGETS[0].site_no,'0074');
  assert.equal(TARGETS[0].screening_from,'2026-12-16'); assert.equal(TARGETS[0].date,undefined); assert.equal(TARGETS[0].format,'IMAX');
  assert.match(TARGETS[0].state_key,/doomsday.*all-dates$/);
  assert.equal(result(dated).sessions.length,1);
});

test('exact title, site, IMAX, bookability and date checks exclude other shows', () => {
  const parse=r=>parseSchedule({statusCode:0,data:[r]},dated,start);
  assert.equal(parse(row).sessions.length,1);
  assert.equal(parse({...row,movNm:'어벤져스: 둠스데이',scnsNm:'IMAX관 (Laser)'}).sessions.length,1);
  assert.equal(parse({...row,movNm:'Avengers: Doomsday',scnsNm:'IMAX'}).sessions.length,1);
  for(const change of [{movNm:'어벤져스: 엔드게임'},{movNm:'어벤져스: 둠스데이 특별 인터뷰'},
    {scnsNm:'SCREENX관'},{scnsNm:'2D관'},{scnsNm:'4DX관'},{siteNo:'0013'},{frSeatCnt:'0'},{cntlYn:'Y'}])
    assert.equal(parse({...row,...change}).sessions.length,0);
  assert.throws(()=>parse({...row,scnYmd:'20261217'}),MonitorError);
  assert.throws(()=>parse({...row,frSeatCnt:'unknown'}),MonitorError);
  const past=Date.parse('2026-12-16T14:00:00+09:00');
  assert.equal(parseSchedule({statusCode:0,data:[row]},dated,past).sessions.length,0);
  assert.equal(parseSchedule({statusCode:0,data:[{...row,scnsrtTm:'2500'}]},dated,past).sessions.length,1);
});

test('separate executions preserve history in SQLite and only notify newly added shows', async () => {
  const x=setup(), messages=[];
  const notify=async p=>{messages.push(p);return true;};
  assert.equal((await poll(x.env,{clock:x.clock,lookup:result,notify})).status,'ok');
  assert.equal(messages.length,1);
  assert.equal(x.state().seen[TARGETS[0].state_key].length,1);
  assert.equal(messages[0].embeds[0].fields.find(f=>f.name==='상영관').value,'IMAX');
  x.advance(59800);
  await poll(x.env,{clock:x.clock,lookup:result,notify});
  assert.equal(messages.length,1);
  x.advance(60000);
  await poll(x.env,{clock:x.clock,notify,lookup:async target=>{
    const r=result(target); r.sessions.push({key:'new-show',time:'16:10',movie:target.movie,screen:'IMAX관'}); return r;
  }});
  assert.equal(messages.length,2);
  assert.equal(messages[1].embeds[0].fields.find(f=>f.name==='새로 발견된 회차').value,'16:10');
});

test('SQLite lease prevents overlapping invocations and rejects writes after expiry', async () => {
  const x=setup(), first=new D1Store(x.db,x.clock), second=new D1Store(x.db,x.clock);
  await first.acquire();
  let queries=0;
  assert.equal((await poll(x.env,{clock:x.clock,lookup:async()=>{queries++;}})).status,'locked_or_uninitialized');
  assert.equal(queries,0);
  x.advance(180001);
  await second.acquire();
  await assert.rejects(first.save(initial()),/잠금 만료/);
  await first.release();
  assert.equal(await new D1Store(x.db,x.clock).acquire(),null);
  await second.release();
});

for(const error of ['HTTP 403','HTTP 429','CAPTCHA 또는 Challenge 의심','응답 파싱 실패']) {
  test(`${error} stops further requests and persists backoff with one error/recovery notice`, async () => {
    const x=setup(), messages=[]; let queries=0;
    const notify=async p=>{messages.push(p);return true;};
    const lookup=async()=>{queries++;throw new MonitorError(error);};
    assert.equal((await poll(x.env,{clock:x.clock,notify,lookup})).status,'error');
    assert.equal(queries,1); assert.equal(messages.length,1);
    x.advance(60000);
    assert.equal((await poll(x.env,{clock:x.clock,notify,lookup})).status,'backoff');
    assert.equal(queries,1); assert.equal(messages.length,1);
    x.advance(240000);
    await poll(x.env,{clock:x.clock,notify,lookup});
    assert.equal(queries,2); assert.equal(messages.length,1);
    x.advance(900000);
    const empty=t=>({...result(t),sessions:[]});
    await poll(x.env,{clock:x.clock,notify,lookup:empty});
    assert.equal(messages.length,2); assert.match(messages[1].content,/복구/);
    x.advance(60000);
    await poll(x.env,{clock:x.clock,notify,lookup:empty});
    assert.equal(messages.length,2);
  });
}

test('Discord failure keeps monitoring healthy; undelivered shows retry on next execution', async () => {
  const x=setup(); let queries=0,attempts=0;
  const lookup=t=>{queries++;return result(t);};
  await poll(x.env,{clock:x.clock,lookup,notify:async()=>{attempts++;return false;}});
  assert.equal(queries,1); assert.equal(attempts,1);
  assert.equal(x.state().failures,0);
  assert.equal(x.state().seen[TARGETS[0].state_key],undefined);
  x.advance(60000);
  await poll(x.env,{clock:x.clock,lookup,notify:async()=>true});
  assert.equal(x.state().seen[TARGETS[0].state_key].length,1);
});

test('reset deletes every previous target and error record, but requires disabled and unlocked state', async () => {
  const x=setup({...initial(),seen:{'cancelled-target':['old-session']},last_results:[{movie:'cancelled'}],last_error:'old-error'});
  assert.equal(await resetState(x.env,start),false);
  const lock=new D1Store(x.db,x.clock); await lock.acquire();
  x.env.MONITOR_ENABLED='false';
  assert.equal(await resetState(x.env,start),false);
  await lock.release();
  assert.equal(await resetState(x.env,start),true);
  assert.deepEqual(x.state().seen,{[TARGETS[0].state_key]:[]});
  assert.equal(x.state().last_results,undefined);
  assert.equal(x.state().last_error,undefined);
  assert.equal(x.state().initialized,true);
});

test('same registration baseline is silent and an unlisted movie remains healthy beyond guessed release date', async () => {
  const state=initial(); state.initialized=false;
  const x=setup(state); let notices=0;
  await poll(x.env,{clock:x.clock,lookup:result,notify:async()=>{notices++;return true;}});
  assert.equal(notices,0); assert.equal(x.state().seen[TARGETS[0].state_key].length,1);
  x.advance(Date.parse('2027-01-20T00:00:00Z')-x.clock());
  const absent=async()=>({count:50,matched:[],dates:[]});
  const outcome=await poll(x.env,{clock:x.clock,discover:absent,lookup:()=>{throw Error('must not query');}});
  assert.equal(outcome.status,'ok'); assert.equal(x.state().failures,0);
});

test('HTTP transport detects 403, 429, challenge and malformed JSON without retry', async () => {
  for(const [status,body,type] of [[403,'blocked','text/html'],[429,'slow down','text/plain'],[200,'cloudflare challenge','text/html'],[200,'{','application/json']]) {
    let requests=0;
    await assert.rejects(fetchSchedule(dated,async()=>{requests++;return new Response(body,{status,headers:{'content-type':type}});}),MonitorError);
    assert.equal(requests,1);
  }
});

test('Discord safe handling never logs the webhook or thrown network detail', async () => {
  const secret='https://discord.com/api/webhooks/123/test_only_not_a_real_token';
  const lines=[], original=console.log; console.log=(...s)=>lines.push(s.join(' '));
  try {
    assert.equal(await sendDiscord({DISCORD_WEBHOOK_URL:secret},{content:'test'},async()=>{throw Error(secret);}),false);
    assert.equal(await sendDiscord({DISCORD_WEBHOOK_URL:secret},{content:'test'},async()=>new Response('',{status:429})),false);
    assert.equal(lines.join('\n').includes(secret),false);
  } finally { console.log=original; }
});

test('Discord receipt contains only message and destination fields, never webhook token', async () => {
  let calls=0;
  const receipt=await sendDiscord({DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123/test_only_not_a_real_token'},
    {content:'test'},async()=>Response.json(++calls===1?
      {id:'1',channel_id:'2',content:'test',timestamp:'2026-10-08T00:00:00Z'}:
      {guild_id:'3',name:'personal',token:'must-never-be-returned',url:'must-never-be-returned'}),true);
  assert.equal(receipt.message_id,'1'); assert.equal(receipt.channel_id,'2'); assert.equal(receipt.guild_id,'3');
  assert.equal(JSON.stringify(receipt).includes('must-never-be-returned'),false);
});


test('catalog search validates structure; absent movie makes only one HTTP request', async () => {
  assert.deepEqual(parseMovies({statusCode:0,data:[{movNm:'어벤져스-엔드게임 앙코르',movNo:'12'}]},TARGETS[0]).matched,[]);
  assert.equal(parseMovies({statusCode:0,data:[{movNm:'Avengers: Doomsday',movNo:'13'}]},TARGETS[0]).matched.length,1);
  assert.throws(()=>parseMovies({statusCode:0,data:[{movNo:'12'}]},TARGETS[0]),MonitorError);
  let calls=0;
  const absent=await discoverTargets(TARGETS[0],async url=>{
    calls++; assert.match(url,/searchAtktTopPostrList/);
    assert.equal(new URL(url).searchParams.get('movNm'),'');
    return Response.json({statusCode:0,data:[]});
  },start);
  assert.equal(calls,1); assert.deepEqual(absent.dates,[]);
});

test('public date list drives checks, filters pre-release screenings but monitors December 16 and later now', async () => {
  assert.deepEqual(parseDates({statusCode:0,data:[{scnYmd:'20261225'},{scnYmd:'20261215'},{scnYmd:'20261225'}]},start),['2026-12-15','2026-12-25']);
  assert.throws(()=>parseDates({statusCode:0,data:[{scnYmd:'20260230'}]},start),MonitorError);
  const x=setup(),messages=[],dates=['2026-12-15','2026-12-16','2026-12-25'];
  const options={clock:x.clock,discover:async()=>({...inventory,dates}),lookup:result,notify:async p=>{messages.push(p);return true;}};
  await poll(x.env,options); assert.equal(messages.length,2);
  assert.deepEqual(messages.map(p=>p.embeds[0].fields.find(f=>f.name==='날짜').value),dates.slice(1));
  x.advance(60000); await poll(x.env,options); assert.equal(messages.length,2);
  assert.equal(x.state().seen[TARGETS[0].state_key].length,2);
});

test('blocked discovery stops before any schedule request and persists backoff', async () => {
  const x=setup(); let calls=0;
  const options={clock:x.clock,discover:async()=>{calls++;throw new MonitorError('HTTP 403');},
    lookup:()=>{throw Error('must not query');},notify:async()=>true};
  assert.equal((await poll(x.env,options)).status,'error');
  x.advance(60000); assert.equal((await poll(x.env,options)).status,'backoff'); assert.equal(calls,1);
});

test('an error on the first date prevents all later date requests', async () => {
  const x=setup(); let calls=0;
  const out=await poll(x.env,{clock:x.clock,discover:async()=>({...inventory,dates:['2026-12-15','2026-12-16']}),
    lookup:async()=>{calls++;throw new MonitorError('HTTP 429');},notify:async()=>true});
  assert.equal(out.status,'error'); assert.equal(calls,1);
});

test('many public dates continue next invocation without dropping or duplicating any date', async () => {
  const x=setup(),dates=Array.from({length:12},(_,i)=>`2026-12-${String(i+16).padStart(2,'0')}`),checked=[];
  const options={clock:x.clock,discover:async()=>({...inventory,dates}),lookup:t=>{checked.push(t.date);return result(t);},notify:async()=>true};
  assert.equal((await poll(x.env,options)).pending_dates,true); assert.equal(checked.length,10);
  x.advance(60000); assert.equal((await poll(x.env,options)).pending_dates,false);
  assert.deepEqual(checked,dates); assert.equal(x.state().date_cursor,0);
});

test('new registration clears old backoff, preserves old history, and immediately reports already-open shows once', async () => {
  const x=setup({...initial(),registration:'previous-monitor',seen:{old:['old-show']},unhealthy:true,next_retry:'2030-01-01T00:00:00Z'});
  const messages=[]; const options={clock:x.clock,lookup:result,notify:async p=>{messages.push(p);return true;}};
  await poll(x.env,options); assert.equal(messages.length,1); assert.deepEqual(x.state().seen.old,['old-show']);
  x.advance(60000); await poll(x.env,options); assert.equal(messages.length,1);
  assert.equal(x.state().registration,TARGETS[0].state_key);
});
