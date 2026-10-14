// Personal schedule notifications only. No booking, login, cookies, or bypass.
export const TARGETS = [
  {site_no: '0074', theater: 'CGV 왕십리', movie: '어벤져스: 둠스데이', format: 'IMAX',
   screening_from: '2026-12-16',
   titles: ['어벤져스둠스데이', 'avengersdoomsday'], state_key: '0074|avengers-doomsday|IMAX|all-dates'}
];
const API = 'https://cgv.co.kr/api/v1/booking/';
const PAGE = 'https://cgv.co.kr/cnm/movieBook/cinema';
const UA = 'CGVScheduleMonitor/1.0 (+https://github.com/Hero-gif12/cgv-odyssey-imax-alert)';
const MARKERS = ['captcha', 'cloudflare', 'challenge', 'access denied'];
const MINUTE = 60000;
export class MonitorError extends Error {}
export const kst = ms => new Date(ms + 9 * 3600000).toISOString().replace('Z', '+09:00');
const log = (text, ms = Date.now()) => console.log(`[${kst(ms).slice(11,19)} KST] ${text}`);
const normalize = value => value.replace(/\([^)]*\)|\[[^\]]*\]/g, '').toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '');
const matches = (value, target) => target.titles.includes(normalize(value));

export function parseSchedule(payload, target, now = Date.now()) {
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
    if (!matches(movie, target) || !/^(?:IMAX|아이맥스)(?:관|\s|\(|$)/i.test(screen)) continue;
    const time = String(row.scnsrtTm || '');
    if (!/^\d{4}$/.test(time) || Number(time.slice(0,2)) > 29 || Number(time.slice(2)) > 59)
      throw new MonitorError('CGV 상영시간 형식 오류');
    if (!/^\d+$/.test(String(row.frSeatCnt)) || !['Y','N'].includes(row.cntlYn))
      throw new MonitorError('CGV 예매 가능 상태 형식 오류');
    if (Number(row.frSeatCnt) === 0 || row.cntlYn === 'Y') continue;
    const starts = Date.parse(target.date + 'T00:00:00+09:00') +
      (Number(time.slice(0,2))*60 + Number(time.slice(2)))*MINUTE;
    if (starts <= now) continue;
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

export async function fetchJSON(endpoint, params, request = fetch) {
  let response, body;
  try {
    const query = new URLSearchParams({coCd: 'A420', ...params});
    response = await request(`${API}${endpoint}?${query}`, {headers: {Accept: 'application/json', Referer: PAGE, 'User-Agent': UA},
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
  return payload;
}

export async function fetchSchedule(target, request = fetch, now = Date.now()) {
  const payload = await fetchJSON('searchMovScnInfo', {siteNo:target.site_no,
    scnYmd:target.date.replaceAll('-', ''), rtctlScopCd:'08'}, request);
  return parseSchedule(payload, target, now);
}

export function parseMovies(payload, target) {
  if (!payload || payload.statusCode !== 0 || !Array.isArray(payload.data))
    throw new MonitorError('CGV 영화 목록 구조 변경');
  for (const row of payload.data)
    if (!row || typeof row.movNm !== 'string' || !row.movNm.trim() || !/^\d+$/.test(String(row.movNo)))
      throw new MonitorError('CGV 영화 목록 필드 오류');
  return {count:payload.data.length, matched:payload.data.filter(row=>matches(row.movNm,target)).map(row=>({id:String(row.movNo),title:row.movNm}))};
}

export function parseDates(payload, now = Date.now()) {
  if (!payload || payload.statusCode !== 0 || !Array.isArray(payload.data))
    throw new MonitorError('CGV 상영 날짜 목록 구조 변경');
  const dates = new Set(), yesterday = kst(now-86400000).slice(0,10);
  for (const row of payload.data) {
    const raw = String(row?.scnYmd || '');
    if (!/^\d{8}$/.test(raw)) throw new MonitorError('CGV 상영 날짜 형식 오류');
    const date = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6)}`;
    const parsed = new Date(date+'T00:00:00Z');
    if (!Number.isFinite(+parsed) || parsed.toISOString().slice(0,10)!==date)
      throw new MonitorError('CGV 상영 날짜 형식 오류');
    // CGV can list yesterday's 24:00-29:59 shows; parseSchedule checks actual start time.
    if (date >= yesterday) dates.add(date);
  }
  if (dates.size > 90) throw new MonitorError('CGV 날짜 목록 범위 변경');
  return [...dates].sort();
}

export async function discoverTargets(target, request = fetch, now = Date.now()) {
  // Use the complete public booking catalog, including English titles, without a guessed release date.
  const movies = parseMovies(await fetchJSON('searchAtktTopPostrList', {movNm:'',div:'',attrCd:''},request),target);
  if (!movies.matched.length) return {...movies,dates:[]};
  const dates = parseDates(await fetchJSON('searchSiteScnscYmdListBySite',{siteNo:target.site_no},request),now);
  return {...movies,dates};
}

export async function sendDiscord(env, payload, request = fetch, includeReceipt = false) {
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
    if (![200,204].includes(response.status)) { await response.body?.cancel(); log(`Discord 전송 실패: HTTP ${response.status}`); return false; }
    if (includeReceipt && response.status === 200) {
      const message = JSON.parse(await readLimited(response));
      const targetResponse = await request(url.origin + url.pathname, {redirect:'manual', signal:AbortSignal.timeout(10000)});
      const target = targetResponse.ok ? JSON.parse(await readLimited(targetResponse)) : {};
      if (!targetResponse.ok) await targetResponse.body?.cancel();
      return {message_id:message.id, channel_id:message.channel_id, guild_id:target.guild_id,
        webhook_name:target.name, timestamp:message.timestamp, content:message.content};
    }
    await response.body?.cancel();
    log('Discord 알림 전송 성공'); return true;
  } catch { log('Discord 전송 실패: 네트워크 또는 설정 오류'); return false; }
}

function embed(target, sessions, ms) {
  return {title: 'CGV 예매 오픈 감지', color: 0xE74C3C,
    fields: [{name: '영화', value: target.movie, inline: true}, {name: '극장', value: target.theater, inline: true},
      {name: '상영관', value: target.format, inline: true}, {name: '날짜', value: target.date, inline: true},
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
  if (env.MONITOR_ENABLED !== 'true') return {status:'disabled'};
  const store = options.store || new D1Store(env.DB, clock);
  const lookup = options.lookup || (target=>fetchSchedule(target,fetch,clock()));
  const discover = options.discover || (target=>discoverTargets(target,fetch,clock()));
  const send = options.notify || (payload => sendDiscord(env, payload));
  const notify = async payload => { try { return await send(payload); } catch { log('Discord 전송 실패',clock()); return false; } };
  const state = await store.acquire();
  if (!state) { log('다른 실행이 감시 중이거나 상태 초기화가 필요합니다', current); return {status:'locked_or_uninitialized'}; }
  async function notifyError() {
    if (state.error_notified_at && current - Date.parse(state.error_notified_at) < 6*3600000) return;
    if (await notify({content: `**CGV 감시 오류**\n상영정보를 읽지 못해 예매 오픈을 놓칠 수 있습니다.\n상태: ${state.last_error}\n감시: ${state.failed_target}\n재확인 가능 시각: ${state.next_retry}\n조치: 요청을 중단하고 대기 간격을 늘렸습니다.`})) {
      state.error_notified_at = kst(current); await store.save(state);
    }
  }
  async function failed(error, target) {
    state.failures = (state.failures || 0) + 1;
    state.next_retry = kst(clock() + [5,15,30,60,120][Math.min(state.failures-1,4)]*MINUTE);
    state.unhealthy = true;
    state.last_error = error instanceof MonitorError ? error.message : 'CGV 처리 오류';
    state.failed_target = `${target.movie} / ${target.theater} / ${target.format} / ${target.date || '공개 상영 날짜 자동 확인'}`;
    await store.save(state); await notifyError();
    return {status:'error', error:state.last_error, next_retry:state.next_retry};
  }
  try {
    const registration = TARGETS.map(t=>t.state_key).join(';');
    if (state.registration !== registration) {
      // A new user registration starts fresh; old seen history remains stored but inactive.
      Object.assign(state,{registration,registered_at:kst(current),initialized:true,failures:0,
        next_retry:null,next_poll_at:0,unhealthy:false,error_notified_at:null,date_cursor:0,date_inventory:''});
      delete state.last_error; delete state.failed_target;
      await store.save(state);
    }
    if (state.next_retry && current < Date.parse(state.next_retry)) {
      if (state.unhealthy) await notifyError();
      return {status:'backoff', next_retry:state.next_retry};
    }
    if (current < (state.next_poll_at || 0)) return {status:'interval_wait'};
    state.next_poll_at = current + 55000;
    state.last_check = kst(current); state.last_results = []; state.discovery = [];
    await store.save(state);
    log(`CGV 조회 시작: 상영일 ${TARGETS[0].screening_from || '전체'} 이후 / 예매 오픈은 지금부터 감시`, current);
    let pending = false;
    for (const base of TARGETS) {
      let inventory;
      try { inventory = await discover(base); } catch (error) { return await failed(error,base); }
      // Filter screening dates, never the date on which booking opens.
      inventory = {...inventory, dates:inventory.dates.filter(date=>!base.screening_from || date>=base.screening_from)};
      state.discovery.push({movie:base.movie,theater:base.theater,format:base.format,
        screening_from:base.screening_from || null,catalog_count:inventory.count,matched:inventory.matched,dates:inventory.dates});
      if (!inventory.matched.length) log(`${base.movie}: CGV 예매 영화 목록에 아직 없음`,clock());
      else if (!inventory.dates.length) log(`${base.theater}: 공개 상영 날짜 없음`,clock());
      const fingerprint = inventory.dates.join(',');
      if (state.date_inventory !== fingerprint) { state.date_cursor = 0; state.date_inventory = fingerprint; }
      const start = Math.min(state.date_cursor || 0,inventory.dates.length);
      let checked = 0;
      for (let index=start; index<inventory.dates.length; index++) {
        // Keep a rotating cursor if many dates open at once; never silently discard dates.
        if (checked>=10 || clock()-current>=120000) { pending=true; break; }
        const target = {...base,date:inventory.dates[index]};
        let result;
        try { result = await lookup(target); } catch (error) { return await failed(error,target); }
        state.last_results.push({movie:target.movie,theater:target.theater,format:target.format,date:target.date,
          rows:result.rows,screens:result.screens,times:result.sessions.map(s=>s.time)});
        const seen = new Set(state.seen[target.state_key] || []);
        const fresh = result.sessions.filter(s=>!seen.has(s.key));
        if (state.initialized && fresh.length) {
          log(`신규 ${target.format} 회차 발견: ${target.movie} / ${target.theater} / ${target.date} / ${fresh.map(s=>s.time).join(', ')}`,clock());
          if (await notify({embeds:[embed(target,fresh,clock())]})) {
            for (const session of fresh) seen.add(session.key);
            state.seen[target.state_key] = [...seen].sort();
            await store.save(state);
          }
        } else if (!state.initialized) {
          for (const session of result.sessions) seen.add(session.key);
          state.seen[target.state_key] = [...seen].sort();
        }
        state.date_cursor = index+1; checked++;
        if (!result.sessions.length) log(`${target.movie} / ${target.theater} / ${target.date} IMAX 회차 없음`,clock());
      }
      if (!pending) state.date_cursor = 0;
    }
    if (state.unhealthy && await notify({content:'CGV 감시가 정상 상태로 복구되었습니다.'})) state.unhealthy = false;
    state.initialized = true; state.failures = 0; state.next_retry = null;
    state.last_ok = kst(clock());
    if (!state.unhealthy) { state.error_notified_at=null; delete state.last_error; delete state.failed_target; }
    await store.save(state);
    log(pending?'CGV 정상 조회: 남은 날짜는 다음 실행에서 확인':'CGV 정상 조회 완료',clock());
    return {status:'ok',pending_dates:pending,checked_at:state.last_ok,discovery:state.discovery,results:state.last_results};
  } finally { await store.release(); }
}

export async function resetState(env, now = Date.now()) {
  if (env.MONITOR_ENABLED === 'true') return false;
  // A fresh registration reports already-open sessions once on the next poll.
  const state = {version:1, initialized:true, seen:Object.fromEntries(TARGETS.map(t=>[t.state_key,[]])),
    failures:0, next_retry:null, unhealthy:false, registered_at:kst(now)};
  const result = await env.DB.prepare('UPDATE monitor_state SET body=?, owner=NULL, lease_until=0 WHERE id=1 AND lease_until<=?')
    .bind(JSON.stringify(state),now).run();
  return result.meta.changes === 1;
}

export default {
  async scheduled(controller, env) {
    controller.noRetry();
    try { await poll(env); } catch { log('Worker 실행 또는 상태 저장 오류: Cloudflare 상태를 확인하세요'); throw new Error('Monitor execution or storage failed'); }
  },
  // Setup is performed in the authenticated Cloudflare preview. No public admin routes.
  async fetch() { return new Response('Not found',{status:404}); }
};
