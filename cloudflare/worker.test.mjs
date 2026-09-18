import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {TARGETS, MonitorError, D1Store, parseSchedule, fetchSchedule, sendDiscord, poll, resetState} from './worker.mjs';

// Synthetic data, not a claim that these showtimes are available at CGV.
const row = {movNm:'어벤져스-엔드게임 앙코르',scnsNm:'SCREENX관 (리클라이너)',scnYmd:'20260925',
  scnsrtTm:'1330',siteNo:'0074',frSeatCnt:'1',cntlYn:'N'};
const start = Date.parse('2026-09-18T08:00:00Z');
const initial = () => ({version:1, initialized:true, seen:{}, failures:0, next_retry:null, unhealthy:false});
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
const result = target => parseSchedule({statusCode:0,data:[row]},target);

test('the only registered target is Wangsimni SCREENX Encore on September 25', () => {
  assert.equal(TARGETS.length,1);
  assert.equal(TARGETS[0].site_no,'0074');
  assert.equal(TARGETS[0].date,'2026-09-25');
  assert.equal(TARGETS[0].format,'SCREENX');
  assert.match(TARGETS[0].state_key,/SCREENX\|2026-09-25$/);
  assert.equal(result(TARGETS[0]).sessions.length,1);
});

test('Encore SCREENX is exact; wrong title, date, site, IMAX, 4DX and general halls are excluded', () => {
  const parse=r=>parseSchedule({statusCode:0,data:[r]},TARGETS[0]);
  assert.equal(parse(row).sessions.length,1);
  assert.equal(parse({...row,movNm:'어벤져스: 엔드게임 앙코르',scnsNm:'Screen X관'}).sessions.length,1);
  for (const change of [{movNm:'어벤져스: 엔드게임'},{movNm:'어벤져스: 인피니티 워'},
    {scnsNm:'IMAX관'},{scnsNm:'2D관'},{scnsNm:'4DX관'},{scnsNm:'4DX SCREEN관'},
    {siteNo:'0013'},{frSeatCnt:'0'},{cntlYn:'Y'}])
    assert.equal(parse({...row,...change}).sessions.length,0);
  assert.throws(()=>parse({...row,scnYmd:'20260924'}),MonitorError);
  assert.throws(()=>parse({...row,frSeatCnt:'unknown'}),MonitorError);
});

test('separate executions preserve history in SQLite and only notify newly added shows', async () => {
  const x=setup(), messages=[];
  const notify=async p=>{messages.push(p);return true;};
  assert.equal((await poll(x.env,{clock:x.clock,lookup:result,notify})).status,'ok');
  assert.equal(messages.length,1);
  assert.equal(x.state().seen[TARGETS[0].state_key].length,1);
  assert.equal(messages[0].embeds[0].fields.find(f=>f.name==='상영관').value,'SCREENX');
  x.advance(59800);
  await poll(x.env,{clock:x.clock,lookup:result,notify});
  assert.equal(messages.length,1);
  x.advance(60000);
  await poll(x.env,{clock:x.clock,notify,lookup:async target=>{
    const r=result(target); r.sessions.push({key:'new-show',time:'16:10',movie:target.movie,screen:'SCREENX관'}); return r;
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

test('first baseline is silent, empty valid data remains healthy, expired targets never query', async () => {
  const state=initial(); state.initialized=false;
  const x=setup(state); let notices=0;
  await poll(x.env,{clock:x.clock,lookup:result,notify:async()=>{notices++;return true;}});
  assert.equal(notices,0); assert.equal(x.state().seen[TARGETS[0].state_key].length,1);
  x.advance(60000);
  await poll(x.env,{clock:x.clock,lookup:t=>({...result(t),sessions:[]}),notify:async()=>true});
  assert.equal(x.state().failures,0);
  x.advance(Date.parse('2026-09-25T14:59:00Z')-x.clock());
  assert.equal((await poll(x.env,{clock:x.clock,lookup:t=>({...result(t),sessions:[]})})).status,'ok');
  x.advance(60000);
  assert.equal((await poll(x.env,{clock:x.clock,lookup:()=>{throw Error('must not query');}})).status,'expired');
});

test('HTTP transport detects 403, 429, challenge and malformed JSON without retry', async () => {
  for(const [status,body,type] of [[403,'blocked','text/html'],[429,'slow down','text/plain'],[200,'cloudflare challenge','text/html'],[200,'{','application/json']]) {
    let requests=0;
    await assert.rejects(fetchSchedule(TARGETS[0],async()=>{requests++;return new Response(body,{status,headers:{'content-type':type}});}),MonitorError);
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
      {id:'1',channel_id:'2',content:'test',timestamp:'2026-09-18T08:00:00Z'}:
      {guild_id:'3',name:'personal',token:'must-never-be-returned',url:'must-never-be-returned'}),true);
  assert.equal(receipt.message_id,'1'); assert.equal(receipt.channel_id,'2'); assert.equal(receipt.guild_id,'3');
  assert.equal(JSON.stringify(receipt).includes('must-never-be-returned'),false);
});
