const ASSET_TYPES = new Set(['synopsis', 'characters', 'world', 'beat_matrix']);
const GATES = [['G0','立项与参数'],['G1','方案与卡点'],['G2','第1—3集校准'],['G3','批次创作'],['G4','内容终审'],['G5','朱雀同版检测'],['G6','交付与归档']];
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const now = () => new Date().toISOString();

async function seedWorkspace(db, id, stamp, p = {}) {
  await db.prepare(`INSERT OR IGNORE INTO project_profiles
    (project_id,region,medium,genre,total_episodes,submission_start,submission_end,opening_template,current_stage,progress,status,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,p.region||'国内',p.medium||'AI漫剧',p.genre||'待设定',Number(p.totalEpisodes||60),Number(p.submissionStart||1),Number(p.submissionEnd||10),p.openingTemplate||'老王模板','G0 立项与参数',10,'待立项',stamp).run();
  for (let i=0;i<GATES.length;i++) {
    await db.prepare('INSERT OR IGNORE INTO gates(project_id,gate_code,title,status,note,updated_at) VALUES(?,?,?,?,?,?)').bind(id,GATES[i][0],GATES[i][1],i===0?'current':'pending',i===0?'等待参数确认':'未开始',stamp).run();
  }
  for (const type of ASSET_TYPES) await db.prepare('INSERT OR IGNORE INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?)').bind(id,type,'',stamp).run();
}

async function detail(db, id) {
  const project = await db.prepare('SELECT id,name,route,note,updated_at AS updatedAt FROM projects WHERE id=?').bind(id).first();
  if (!project) return null;
  const profile = await db.prepare('SELECT * FROM project_profiles WHERE project_id=?').bind(id).first();
  const assetsRows = (await db.prepare('SELECT asset_type,content,version,updated_at AS updatedAt FROM story_assets WHERE project_id=?').bind(id).all()).results;
  const versions = (await db.prepare('SELECT id,label,range_start,range_end,sha256,source,status,created_at FROM draft_versions WHERE project_id=? ORDER BY created_at DESC').bind(id).all()).results;
  const gates = (await db.prepare('SELECT gate_code,title,status,note,updated_at FROM gates WHERE project_id=? ORDER BY gate_code').bind(id).all()).results;
  const events = (await db.prepare('SELECT kind,message,created_at FROM activity_logs WHERE project_id=? ORDER BY id DESC LIMIT 50').bind(id).all()).results;
  return {project, profile, assets:Object.fromEntries(assetsRows.map(x=>[x.asset_type,{content:x.content,version:x.version,updatedAt:x.updatedAt}])), versions, gates, events};
}

async function api(request, env) {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.pathname === '/api/health') return json({ok:true,service:'剧本创作总控台',storage:'cloudflare-d1',version:'0.2.0'});
  if (!env.DB) return json({error:'数据库绑定未配置'},503);

  if (url.pathname === '/api/projects' && request.method === 'GET') {
    const {results}=await env.DB.prepare('SELECT id,name,route,note,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all(); return json({projects:results});
  }
  if (url.pathname === '/api/projects' && request.method === 'POST') {
    let body; try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}
    const name=String(body?.name||'').trim(), route=String(body?.route||'完全原创 / 市场参考').trim();
    if(!name||name.length>120)return json({error:'项目名称不能为空且不超过120字'},400);
    const id=`p-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`, stamp=now(), note='新项目 · 待立项';
    await env.DB.prepare('INSERT INTO projects(id,name,route,note,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id,name,route,note,stamp,stamp).run();
    await seedWorkspace(env.DB,id,stamp,body); await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(id,'project',`创建项目：${name}`,stamp).run();
    return json({project:{id,name,route,note,updatedAt:stamp}},201);
  }
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='projects'&&request.method==='GET') {
    const data=await detail(env.DB,parts[2]); return data?json({detail:data}):json({error:'项目不存在'},404);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='versions'&&parts[3]==='content'&&request.method==='GET') {
    const version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=?').bind(parts[2]).first(); return version?json({version}):json({error:'版本不存在'},404);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='events'&&request.method==='POST') {
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)} const message=String(body?.message||'').trim(),kind=String(body?.kind||'task').slice(0,30); if(!message)return json({error:'事件内容不能为空'},400);
    const id=parts[2],stamp=now(),exists=await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(id).first(); if(!exists)return json({error:'项目不存在'},404);
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(id,kind,message,stamp).run(); await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,id).run(); return json({ok:true,createdAt:stamp});
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='versions'&&request.method==='POST') {
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)} const content=String(body?.content||''),label=String(body?.label||'').trim(),start=Number(body?.rangeStart||1),end=Number(body?.rangeEnd||3); if(!label||!content.trim()||start<1||end<start)return json({error:'版本名称、正文和集数范围必须有效'},400);
    const id=parts[2],versionId=`v-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),source=String(body?.source||'人工编辑'); const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    if(!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(id).first())return json({error:'项目不存在'},404);
    await env.DB.prepare('INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(versionId,id,label,start,end,content,digest,source,'已保存',stamp).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(id,'version',`保存正文版本 ${label}（第${start}—${end}集）`,stamp).run(); await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,id).run();
    return json({version:{id:versionId,label,range_start:start,range_end:end,sha256:digest,source,status:'已保存',created_at:stamp}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='assets'&&ASSET_TYPES.has(parts[4])&&request.method==='PUT') {
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)} const id=parts[2],type=parts[4],content=String(body?.content||''),stamp=now(); if(!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(id).first())return json({error:'项目不存在'},404);
    await env.DB.prepare(`INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at`).bind(id,type,content,stamp).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(id,'asset',`更新项目资料：${type}`,stamp).run(); await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,id).run(); const asset=await env.DB.prepare('SELECT content,version,updated_at AS updatedAt FROM story_assets WHERE project_id=? AND asset_type=?').bind(id,type).first(); return json({asset});
  }
  return json({error:'接口不存在'},404);
}

export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname.startsWith('/api/')){try{return await api(request,env)}catch(error){return json({error:'服务内部错误',detail:String(error?.message||error)},500)}}return env.ASSETS.fetch(request)}};
