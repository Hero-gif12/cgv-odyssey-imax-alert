// Personal schedule notifications only. No booking, login, cookies, or bypass.
export const TARGETS = [
  {date: '2026-09-23', site_no: '0013', theater: 'CGV 용산아이파크몰', movie: '오디세이',
   titles: ['오디세이', 'theodyssey', 'odyssey'], state_key: '2026-09-23'},
  {date: '2026-09-23', site_no: '0074', theater: 'CGV 왕십리', movie: '어벤져스: 엔드게임',
   titles: ['어벤져스엔드게임', '어벤져스엔드게임앙코르', 'avengersendgame'], state_key: '0074|avengers-endgame|2026-09-23'}
];
const API = 'https://cgv.co.kr/api/v1/booking/searchMovScnInfo';
const PAGE = 'https://cgv.co.kr/cnm/movieBook/cinema';
const UA = 'CGVScheduleMonitor/1.0 (+https://github.com/Hero-gif12/cgv-odyssey-imax-alert)';
const MARKERS = ['captcha', 'cloudflare', 'challenge', 'access denied'];
const MINUTE = 60000;
const ADMIN_UNTIL = Date.parse('2026-09-18T10:00:00Z');
export class MonitorError extends Error {}
export const kst = ms => new Date(ms + 9 * 3600000).toISOString().replace('Z', '+09:00');
const log = (text, ms = Date.now()) => console.log(`[${kst(ms).slice(11,19)} KST] ${text}`);
const normalize = value => value.replace(/\([^)]*\)|\[[^\]]*\]/g, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
const matches = (value, target) => target.titles.includes(normalize(value));

export function parseSchedule(payload, target) {
  if (!payload || payload.statusCode !== 0 || !Array.isArray(payload.data))
    throw new MonitorError('CGV API 오류 또는 데이터 구조 변경');
  const movies = new Set(), screens = new Set(), sessions = [];
  let count = 0;
  for (const row of payload.data) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new MonitorError('회차 형식 오류');
    const movie = String(row.movNm || '').trim(), screen = String(row.scnsNm || '').trim();
    if (!movie || !screen || !row.siteNo) throw new MonitorError('영화·상영관·극장 정보 없음');
    if (String(row.scnYmd || '') !== target.date.replaceAll('-', '')) throw new MonitorError('CGV 응답 날짜 불일치');
    if (row.siteNo !== target.site_no) continue;
    count++; movies.add(movie);
    if (matches(movie, target)) screens.add(screen);
    if (!matches(movie, target) || !(/IMAX/i.test(screen) || screen.includes('아이맥스'))) continue;
    const time = String(row.scnsrtTm || '');
    if (!/^\d{4}$/.test(time) || Number(time.slice(0,2)) > 29 || Number(time.slice(2)) > 59)
      throw new MonitorError('CGV 상영시간 형식 오류');
    if (!/^\d+$/.test(String(row.frSeatCnt)) || !['Y','N'].includes(row.cntlYn))
      throw new MonitorError('CGV 예매 가능 상태 형식 오류');
    if (Number(row.frSeatCnt) === 0 || row.cntlYn === 'Y') continue;
    const key = [target.date, String(row.scnsNo || screen), String(row.scnSseq || ''), String(row.prodNo || ''), time].join('|');
    sessions.push({key, time: `${time.slice(0,2)}:${time.slice(2)}`, screen, movie});
  }
  return {target, rows: count, movies: [...movies].sort(), screens: [...screens].sort(), sessions};
}

async function readLimited(response) {
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2000000) { await reader.cancel(); throw new MonitorError('CGV 응답 크기 제한 초과'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(all);
}

export async function fetchSchedule(target, request = fetch) {
  let response, body;
  try {
    const query = new URLSearchParams({coCd: 'A420', siteNo: target.site_no,
      scnYmd: target.date.replaceAll('-', ''), rtctlScopCd: '08'});
    response = await request(`${API}?${query}`, {headers: {Accept: 'application/json', Referer: PAGE, 'User-Agent': UA},
      redirect: 'manual', signal: AbortSignal.timeout(20000)});
    body = await readLimited(response);
  } catch (error) {
    if (error instanceof MonitorError) throw error;
    throw new MonitorError('네트워크 오류'); // Never print raw exceptions.
  }
  const type = response.headers.get('content-type') || '';
  const markers = MARKERS.filter(word => body.slice(0,20000).toLowerCase().includes(word));
  if (response.status !== 200 || markers.length) {
    log(`CGV HTTP 진단: 상태=${response.status}, 유형=${type.includes('json')?'JSON':type.includes('html')?'HTML':'기타'}, 차단표식=${markers.join(',')||'없음'}`);
    throw new MonitorError(response.status !== 200 ? `HTTP ${response.status}` : 'CAPTCHA 또는 Challenge 의심');
  }
  if (!type.includes('json')) throw new MonitorError('응답 파싱 실패: JSON 아님');
  let payload;
  try { payload = JSON.parse(body); } catch { throw new MonitorError('응답 파싱 실패: JSON 형식 오류'); }
  return parseSchedule(payload, target);
}

export async function sendDiscord(env, payload, request = fetch) {
  try {
    const url = new URL(env.DISCORD_WEBHOOK_URL || '');
    if (url.protocol !== 'https:' || !['discord.com','discordapp.com'].includes(url.hostname) ||
        url.username || url.password || url.port || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      log('Discord Secret 형식 오류'); return false;
    }
    url.searchParams.set('wait', 'true');
    const response = await request(url.toString(), {method: 'POST', redirect: 'manual',
      signal: AbortSignal.timeout(15000), headers: {'Content-Type': 'application/json', 'User-Agent': UA},
      body: JSON.stringify({allowed_mentions: {parse: []}, ...payload})});
    await response.body?.cancel();
    if (![200,204].includes(response.status)) { log(`Discord 전송 실패: HTTP ${response.status}`); return false; }
    log('Discord 알림 전송 성공'); return true;
  } catch { log('Discord 전송 실패: 네트워크 또는 설정 오류'); return false; }
}

function embed(target, sessions, ms) {
  return {title: 'CGV 예매 오픈 감지', color: 0xE74C3C,
    fields: [{name: '영화', value: target.movie, inline: true}, {name: '극장', value: target.theater, inline: true},
      {name: '상영관', value: 'IMAX', inline: true}, {name: '날짜', value: target.date, inline: true},
      {name: '새로 발견된 회차', value: [...new Set(sessions.map(s=>s.time))].sort().join('\n')}],
    description: 'CGV에서 직접 예매 가능 여부를 확인하세요.',
    footer: {text: `감지 시간(KST): ${kst(ms).slice(0,19).replace('T',' ')} KST`}};
}

export class D1Store {
  constructor(db, clock = Date.now) { this.db = db; this.clock = clock; this.owner = crypto.randomUUID(); }
  async acquire() {
    const ms = this.clock();
    const row = await this.db.prepare('UPDATE monitor_state SET owner=?, lease_until=? WHERE id=1 AND lease_until<=? RETURNING body')
      .bind(this.owner, ms+180000, ms).first();
    if (!row) return null;
    let state;
    try { state = JSON.parse(row.body); } catch { throw new MonitorError('상태 JSON 읽기 실패'); }
    if (state.version !== 1 || typeof state.initialized !== 'boolean' || !state.seen || typeof state.seen !== 'object')
      throw new MonitorError('상태 구조 오류');
    return state;
  }
  async save(state) {
    const result = await this.db.prepare('UPDATE monitor_state SET body=? WHERE id=1 AND owner=? AND lease_until>?')
      .bind(JSON.stringify(state), this.owner, this.clock()).run();
    if (result.meta.changes !== 1) throw new MonitorError('상태 저장 잠금 만료');
  }
  async release() { await this.db.prepare('UPDATE monitor_state SET owner=NULL, lease_until=0 WHERE id=1 AND owner=?').bind(this.owner).run(); }
}

export async function poll(env, options = {}) {
  const clock = options.clock || Date.now, current = clock();
  if (kst(current).slice(0,10) > '2026-09-23') return {status:'expired'};
  if (env.MONITOR_ENABLED !== 'true') return {status:'disabled'};
  const store = options.store || new D1Store(env.DB, clock);
  const lookup = options.lookup || fetchSchedule;
  const notify = options.notify || (payload => sendDiscord(env, payload));
  const state = await store.acquire();
  if (!state) { log('다른 실행이 감시 중이거나 상태 초기화가 필요합니다', current); return {status:'locked_or_uninitialized'}; }
  async function notifyError() {
    if (state.error_notified_at && current - Date.parse(state.error_notified_at) < 6*3600000) return;
    if (await notify({content: `**CGV 감시 오류**\n상영정보를 읽지 못해 예매 오픈을 놓칠 수 있습니다.\n상태: ${state.last_error}\n감시: ${state.failed_target}\n재확인 가능 시각: ${state.next_retry}\n조치: 요청을 중단하고 대기 간격을 늘렸습니다.`})) {
      state.error_notified_at = kst(current); await store.save(state);
    }
  }
  try {
    if (state.next_retry && current < Date.parse(state.next_retry)) {
      if (state.unhealthy) await notifyError();
      return {status:'backoff', next_retry:state.next_retry};
    }
    if (current < (state.next_poll_at || 0)) return {status:'interval_wait'};
    // A small tolerance avoids skipping a cron tick due to sub-second scheduler jitter.
    state.next_poll_at = current + 55000;
    state.last_check = kst(current);
    state.last_results = [];
    await store.save(state);
    log('CGV 조회 시작', current);
    for (const target of TARGETS) {
      let result;
      try { result = await lookup(target); }
      catch (error) {
        state.failures = (state.failures || 0) + 1;
        state.next_retry = kst(clock() + [5,15,30,60,120][Math.min(state.failures-1,4)]*MINUTE);
        state.unhealthy = true;
        state.last_error = error instanceof MonitorError ? error.message : 'CGV 처리 오류';
        state.failed_target = `${target.movie} / ${target.theater} / IMAX / ${target.date}`;
        await store.save(state); await notifyError();
        return {status:'error', error:state.last_error, next_retry:state.next_retry};
      }
      state.last_results.push({movie:target.movie, theater:target.theater, date:target.date, rows:result.rows,
        screens:result.screens, times:result.sessions.map(s=>s.time)});
      const seen = new Set(state.seen[target.state_key] || []);
      const fresh = result.sessions.filter(s=>!seen.has(s.key));
      if (state.initialized && fresh.length) {
        log(`신규 IMAX 회차 발견: ${target.movie} / ${target.theater} / ${fresh.map(s=>s.time).join(', ')}`, clock());
        if (await notify({embeds:[embed(target,fresh,clock())]})) {
          for (const session of fresh) seen.add(session.key);
          state.seen[target.state_key] = [...seen].sort();
          await store.save(state);
        }
      } else if (!state.initialized) {
        state.seen[target.state_key] = result.sessions.map(s=>s.key).sort();
      }
      if (!result.sessions.length) log(`${target.movie} / ${target.theater} / ${target.date} IMAX 회차 없음`, clock());
    }
    if (state.unhealthy && await notify({content:'CGV 감시가 정상 상태로 복구되었습니다.'})) state.unhealthy = false;
    state.initialized = true; state.failures = 0; state.next_retry = null;
    state.last_ok = kst(clock());
    if (!state.unhealthy) { state.error_notified_at = null; delete state.last_error; delete state.failed_target; }
    await store.save(state);
    log('CGV 정상 조회 완료', clock());
    return {status:'ok', checked_at:state.last_ok, results:state.last_results};
  } finally { await store.release(); }
}

async function authorized(request, env) {
  if (Date.now() >= ADMIN_UNTIL || !env.PREFLIGHT_TOKEN) return false;
  const encoder = new TextEncoder();
  const [a,b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(request.headers.get('Authorization') || '')),
    crypto.subtle.digest('SHA-256', encoder.encode('Bearer '+env.PREFLIGHT_TOKEN))]);
  return crypto.subtle.timingSafeEqual(a,b);
}

export default {
  async scheduled(controller, env) {
    controller.noRetry();
    try { await poll(env); } catch { log('Worker 실행 또는 상태 저장 오류: Cloudflare 상태를 확인하세요'); throw new Error('Monitor execution or storage failed'); }
  },
  async fetch(request, env) {
    if (!await authorized(request,env)) return new Response('Not found',{status:404});
    const route = new URL(request.url).pathname;
    try {
      if (request.method === 'POST' && route === '/admin/import-state' && env.MONITOR_ENABLED !== 'true') {
        const raw = await readLimited(request);
        const state = JSON.parse(raw);
        if (raw.length > 100000 || state.version !== 1 || typeof state.initialized !== 'boolean' ||
            !state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen) ||
            !Object.values(state.seen).every(v=>Array.isArray(v)&&v.every(k=>typeof k==='string')))
          return Response.json({error:'Invalid migration state'},{status:400});
        await env.DB.prepare('CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL CHECK(json_valid(body)), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)').run();
        const result = await env.DB.prepare('INSERT OR IGNORE INTO monitor_state (id,body,lease_until) VALUES (1,?,0)').bind(JSON.stringify(state)).run();
        return Response.json({imported:result.meta.changes===1});
      }
      if (request.method === 'POST' && route === '/admin/test-discord') {
        const ok = await sendDiscord(env,{content:'CGV 감시 프로그램 Discord 알림 테스트 성공'});
        return Response.json({ok},{status:ok?200:502});
      }
      if (request.method === 'POST' && route === '/admin/run') return Response.json(await poll(env));
      if (request.method === 'GET' && route === '/admin/status') {
        const row = await env.DB.prepare('SELECT body, lease_until FROM monitor_state WHERE id=1').first();
        return Response.json(row ? {state:JSON.parse(row.body), lease_until:row.lease_until} : {state:null});
      }
      return new Response('Not found',{status:404});
    } catch { return Response.json({error:'Worker execution or storage failed'},{status:503}); }
  }
};
