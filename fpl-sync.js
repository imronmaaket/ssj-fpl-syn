/**
 * fpl-sync.js — SSJ-Fantacy GitHub Actions Script
 * ─────────────────────────────────────────────────
 * รันโดย GitHub Actions ทุกชั่วโมง
 * ดึงข้อมูลจาก FPL API แล้วบันทึกลง GitHub Gist
 *
 * Secrets ที่ต้องตั้งใน GitHub Repository:
 *   FPL_LEAGUE_ID  — League ID จาก fantasy.premierleague.com
 *   GIST_TOKEN     — Personal Access Token (scope: gist)
 *   GIST_ID        — Gist ID ที่สร้างไว้
 */

const LEAGUE_ID = process.env.FPL_LEAGUE_ID;
const GIST_ID   = process.env.GIST_ID;
const TOKEN     = process.env.GIST_TOKEN;
const FPL_BASE  = 'https://fantasy.premierleague.com/api';

// ── headers ที่ FPL ยอมรับ
const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Referer':         'https://fantasy.premierleague.com/',
  'Origin':          'https://fantasy.premierleague.com',
};

async function fetchFPL(path, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${FPL_BASE}${path}`, { headers: HEADERS });
      if (res.status === 429) {
        console.log(`⏳ Rate limited — รอ ${(i+1)*3} วินาที...`);
        await new Promise(r => setTimeout(r, (i+1) * 3000));
        continue;
      }
      if (!res.ok) throw new Error(`FPL ${res.status}: ${path}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function main() {
  console.log('🚀 SSJ-Fantacy FPL Sync เริ่มต้น...');

  // ── ตรวจสอบ env vars
  if (!LEAGUE_ID || !GIST_ID || !TOKEN) {
    throw new Error('ขาด secrets: FPL_LEAGUE_ID, GIST_ID, หรือ GIST_TOKEN');
  }

  // ── ดึงข้อมูลลีกและ bootstrap พร้อมกัน
  console.log(`📋 ดึงข้อมูล League ID: ${LEAGUE_ID}...`);
  const [league, bootstrap] = await Promise.all([
    fetchFPL(`/leagues-classic/${LEAGUE_ID}/standings/`),
    fetchFPL('/bootstrap-static/'),
  ]);

  const leagueName = league.league?.name || 'SSJ-Fantacy';
  const members    = league.standings?.results || [];

  if (!members.length) throw new Error(`League ${LEAGUE_ID}: ไม่พบสมาชิก`);
  console.log(`✅ พบ ${members.length} สมาชิกใน ${leagueName}`);

  // ── หา GW ปัจจุบัน
  const events  = bootstrap.events || [];
  const curEvent = events.find(e => e.is_current) || events.findLast(e => e.finished) || events[0];
  const nextEvent = events.find(e => e.is_next);
  console.log(`📅 GW ปัจจุบัน: ${curEvent?.id} | Deadline: ${curEvent?.deadline_time}`);

  // ── ดึงประวัติคะแนนทุกคน (parallel, 4 คนต่อ batch เพื่อไม่ spam)
  console.log('📊 ดึงประวัติคะแนนทุกคน...');
  const batchSize = 4;
  const histMap   = {};

  for (let i = 0; i < members.length; i += batchSize) {
    const batch = members.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map(m => fetchFPL(`/entry/${m.entry}/history/`).then(h => [m.entry, h]))
    );
    results.forEach(r => {
      if (r.status === 'fulfilled') histMap[r.value[0]] = r.value[1];
      else console.warn(`  ⚠️ entry ${batch[results.indexOf(r)].entry} ดึงไม่ได้`);
    });
    if (i + batchSize < members.length) await new Promise(r => setTimeout(r, 500));
  }

  // ── ดึง picks GW ปัจจุบันของทุกคน (สำหรับแสดงในหน้า Transfers)
  console.log(`⚽ ดึง picks GW${curEvent?.id}...`);
  const picksMap = {};
  if (curEvent?.id) {
    const elemMap = Object.fromEntries((bootstrap.elements||[]).map(e=>[e.id,e]));
    const teamMap = Object.fromEntries((bootstrap.teams||[]).map(t=>[t.id,t]));

    for (let i = 0; i < members.length; i += batchSize) {
      const batch = members.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(m => fetchFPL(`/entry/${m.entry}/event/${curEvent.id}/picks/`).then(d => [m.entry, d]))
      );
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          const [entryId, d] = r.value;
          picksMap[entryId] = {
            chip: d.active_chip || null,
            picks: (d.picks||[]).map(p => {
              const el = elemMap[p.element]||{};
              const tm = teamMap[el.team]||{};
              return {
                pos:        p.position,
                is_cap:     p.is_captain,
                is_vc:      p.is_vice_captain,
                mult:       p.multiplier,
                web_name:   el.web_name||'?',
                team:       tm.short_name||'',
                pos_type:   ['','GKP','DEF','MID','FWD'][el.element_type]||'',
                gw_pts:     (el.event_points||0)*p.multiplier,
                total_pts:  el.total_points||0,
                cost:       el.now_cost ? (el.now_cost/10).toFixed(1) : '0.0',
                form:       el.form||'0',
              };
            })
          };
        }
      });
      if (i + batchSize < members.length) await new Promise(r => setTimeout(r, 500));
    }
  }

  // ── สร้าง output data
  const output = {
    updated_at:    new Date().toISOString(),
    league_id:     LEAGUE_ID,
    league_name:   leagueName,
    current_gw:    curEvent?.id || null,
    deadline:      curEvent?.deadline_time || null,
    next_gw:       nextEvent?.id || null,
    next_deadline: nextEvent?.deadline_time || null,
    members: members.map(m => {
      const hist = histMap[m.entry];
      return {
        entry_id:  m.entry,
        rank:      m.rank,
        last_rank: m.last_rank,
        name:      m.entry_name,
        player:    m.player_name,
        total:     m.total,
        gw_points: m.event_total,
        history: (hist?.current || []).map(g => ({
          gw:     g.event,
          points: g.points,
          total:  g.total_points,
          rank:   g.rank,
          chip:   g.active_chip || null,
        })),
        picks: picksMap[m.entry] || null,
      };
    }),
  };

  console.log('💾 บันทึกลง GitHub Gist...');
  const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method:  'PATCH',
    headers: {
      Authorization:  `token ${TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent':   'ssj-fantacy-sync/1.0',
    },
    body: JSON.stringify({
      description: `SSJ-Fantacy FPL Data — GW${output.current_gw} — ${new Date().toLocaleString('th-TH')}`,
      files: {
        'ssj-fpl-data.json': { content: JSON.stringify(output, null, 2) },
      },
    }),
  });

  if (!gistRes.ok) {
    const err = await gistRes.text();
    throw new Error(`Gist update ล้มเหลว: ${gistRes.status} — ${err}`);
  }

  const gistData = await gistRes.json();
  const rawUrl = gistData.files?.['ssj-fpl-data.json']?.raw_url || '';

  console.log('\n✅ ═══════════════════════════════════════════');
  console.log(`✅ Sync สำเร็จ!`);
  console.log(`   League:   ${leagueName}`);
  console.log(`   GW:       ${output.current_gw}`);
  console.log(`   สมาชิก:   ${output.members.length} คน`);
  console.log(`   Gist URL: ${rawUrl.split('/raw/')[0]}/raw/ssj-fpl-data.json`);
  console.log('✅ ═══════════════════════════════════════════\n');

  // ── พิมพ์ Raw URL สำหรับ copy ไปใส่ใน UI
  console.log('📋 Raw URL สำหรับใส่ใน SSJ-Fantacy UI:');
  console.log(`https://gist.githubusercontent.com/${gistData.owner?.login}/${GIST_ID}/raw/ssj-fpl-data.json`);
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
