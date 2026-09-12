const ASSET_TYPES = new Set(['synopsis', 'characters', 'world', 'beat_matrix']);
const TEXT_EXTENSIONS = new Set(['txt','md','markdown','json','csv','tsv']);
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
  const sources = (await db.prepare('SELECT id,name,mime,byte_size,sha256,extraction_status,created_at FROM source_documents WHERE project_id=? ORDER BY created_at DESC').bind(id).all()).results;
  const audits = (await db.prepare('SELECT id,version_id,score,status,summary,findings_json,sha256,created_at FROM audit_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
  const detectors = (await db.prepare('SELECT id,version_id,human_score,suspected_score,ai_score,report_name,sha256,status,created_at FROM detector_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
  return {project, profile, assets:Object.fromEntries(assetsRows.map(x=>[x.asset_type,{content:x.content,version:x.version,updatedAt:x.updatedAt}])), versions, gates, events, sources, audits, detectors};
}

function decodeBase64(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes;
}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
}

function auditText(content,start,end) {
  const findings=[], lines=content.split(/\r?\n/), add=(level,code,message)=>findings.push({level,code,message});
  const episodeNumbers=[...content.matchAll(/^\s*第\s*(\d+)\s*集\s*$/gm)].map(x=>Number(x[1]));
  const expected=[];for(let i=start;i<=end;i++)expected.push(i);
  const missing=expected.filter(x=>!episodeNumbers.includes(x));
  if(missing.length)add('error','missing_episode',`缺少集标题：第${missing.join('、')}集`);
  const outside=[...new Set(episodeNumbers.filter(x=>x<start||x>end))];if(outside.length)add('error','range_leak',`正文混入提交范围外集数：第${outside.join('、')}集`);
  if(new Set(episodeNumbers).size!==episodeNumbers.length)add('error','duplicate_episode','存在重复集标题');
  const scenes=[...content.matchAll(/^\s*\d+\s*[-－—]\s*\d+\s+/gm)].length;if(!scenes)add('error','scene_header','未识别到规范场次标题');
  if(/&#x?[0-9a-f]+;/i.test(content))add('error','html_entity','正文含HTML实体乱码');
  if(/\\n/.test(content))add('error','literal_newline','正文含字面量\\n');
  if(/【\s*黑幕\s*】/.test(content))add('warning','black_screen','正文含【黑幕】字样，请确认交付格式是否允许');
  if(/（\s*(本次提交|检测范围)[^）]*）/.test(content))add('warning','delivery_marker','正文含检测或提交范围说明');
  const brackets=[['（','）'],['【','】'],['《','》']];for(const [a,b] of brackets){const x=(content.match(new RegExp(a,'g'))||[]).length,y=(content.match(new RegExp(b,'g'))||[]).length;if(x!==y)add('error','bracket_balance',`${a}${b}数量不平衡：${x}/${y}`)}
  const meaningful=lines.map(x=>x.trim()).filter(x=>x.length>=8), seen=new Map();for(const line of meaningful)seen.set(line,(seen.get(line)||0)+1);const duplicates=[...seen].filter(([,n])=>n>=3);if(duplicates.length)add('warning','repeated_lines',`发现${duplicates.length}条重复三次以上的长句`);
  if(content.trim().length<800)add('warning','short_content','正文过短，无法完成有效结构审计');
  const errors=findings.filter(x=>x.level==='error').length,warnings=findings.length-errors,score=Math.max(0,100-errors*12-warnings*4);
  return {score,status:score>=90&&errors===0?'通过':'需修复',summary:`识别${episodeNumbers.length}个集标题、${scenes}个场次；${errors}项错误、${warnings}项提醒。`,findings};
}

function endpoint(base,wire) {const root=String(base||'').replace(/\/+$/,'');if(!/^https?:\/\//i.test(root))throw new Error('Base URL必须以http://或https://开头');return root.endsWith(wire==='chat'?'/chat/completions':'/responses')?root:`${root}${wire==='chat'?'/chat/completions':'/responses'}`}
async function callModel(config,prompt) {
  const baseUrl=String(config?.baseUrl||'').trim(),apiKey=String(config?.apiKey||'').trim(),model=String(config?.model||'').trim(),wire=config?.wireApi==='chat'?'chat':'responses';
  if(!baseUrl||!apiKey||!model)throw new Error('请先填写Base URL、API Key和模型名');
  const body=wire==='chat'?{model,messages:[{role:'user',content:prompt}],temperature:0.7}:{model,input:prompt,reasoning:{effort:String(config?.reasoning||'high')}};
  const response=await fetch(endpoint(baseUrl,wire),{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},body:JSON.stringify(body)});
  const raw=await response.text();let data;try{data=JSON.parse(raw)}catch{data=null}
  if(!response.ok)throw new Error(`模型接口HTTP ${response.status}：${String(data?.error?.message||raw||'未知错误').slice(0,300)}`);
  const output=wire==='chat'?data?.choices?.[0]?.message?.content:(data?.output_text||data?.output?.flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join('\n'));
  if(!output)throw new Error('接口返回成功，但没有读取到文本内容');return String(output);
}

function modelPrompt(data,taskType,instruction) {
  const assets=data.assets||{}, sourceNote=(data.sources||[]).map(x=>`${x.name}（${x.extraction_status}）`).join('、')||'无';
  const sourceText=(data.sourceTexts||[]).filter(x=>x.extracted_text).map(x=>`【${x.name}】\n${x.extracted_text}`).join('\n\n').slice(0,120000)||'无可用文本素材';
  return `你是短剧生产工作台的内容引擎。当前任务类型：${taskType}。\n项目：${data.project.name}\n路线：${data.project.route}\n参数：${data.profile?.region||''} / ${data.profile?.medium||''} / 总${data.profile?.total_episodes||60}集 / 提交${data.profile?.submission_start||1}-${data.profile?.submission_end||10}集 / ${data.profile?.opening_template||''}\n题材：${data.profile?.genre||''}\n素材清单：${sourceNote}\n\n可用素材正文：\n${sourceText}\n\n现有梗概：${assets.synopsis?.content||'无'}\n现有人物：${assets.characters?.content||'无'}\n现有世界观：${assets.world?.content||'无'}\n现有卡点：${assets.beat_matrix?.content||'无'}\n\n用户指令：${instruction}\n\n必须尊重提交范围，不得把范围外分集写进剧情梗概；生成完成不等于人工审校通过。`;
}

function exportText(data,version) {
  const a=data.assets||{},p=data.project,profile=data.profile||{};
  return `《${p.name}》\n\n生产路线：${p.route}\n地区：${profile.region||''}\n形式：${profile.medium||''}\n总集数：${profile.total_episodes||''}\n开头模板：${profile.opening_template||''}\n\n一、剧情梗概\n${a.synopsis?.content||''}\n\n二、人物小传\n${a.characters?.content||''}\n\n三、世界观设定\n${a.world?.content||''}\n\n四、卡点矩阵\n${a.beat_matrix?.content||''}\n\n五、剧本正文\n${version?.content||'尚未选择正文版本'}\n\n正文SHA-256：${version?.sha256||'无'}\n`;
}

async function api(request, env) {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.pathname === '/api/health') return json({ok:true,service:'剧本创作总控台',storage:'cloudflare-d1',version:'0.4.0'});
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
  if(url.pathname==='/api/model/test'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}
    try{const output=await callModel(body,'仅回复“连接成功”，不要补充其他内容。');return json({ok:true,output})}catch(error){return json({error:String(error?.message||error)},502)}
  }
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='projects'&&request.method==='GET') {
    const data=await detail(env.DB,parts[2]); return data?json({detail:data}):json({error:'项目不存在'},404);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='versions'&&parts[3]==='content'&&request.method==='GET') {
    const version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=?').bind(parts[2]).first(); return version?json({version}):json({error:'版本不存在'},404);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='sources'&&parts[3]==='content'&&request.method==='GET') {
    const source=await env.DB.prepare('SELECT id,name,mime,byte_size,sha256,extracted_text,extraction_status,created_at FROM source_documents WHERE id=?').bind(parts[2]).first();
    return source?json({source}):json({error:'素材不存在'},404);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='export'&&request.method==='GET'){
    const data=await detail(env.DB,parts[2]);if(!data)return json({error:'项目不存在'},404);const versionId=url.searchParams.get('versionId');let version=null;
    if(versionId)version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,parts[2]).first();else version=await env.DB.prepare('SELECT * FROM draft_versions WHERE project_id=? ORDER BY created_at DESC LIMIT 1').bind(parts[2]).first();
    const text=exportText(data,version),format=url.searchParams.get('format')||'txt',safeName=data.project.name.replace(/[\\/:*?"<>|]/g,'_');
    if(format==='json')return new Response(JSON.stringify({detail:data,selectedVersion:version},null,2),{headers:{'content-type':'application/json; charset=utf-8','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(safeName+'.json')}`}});
    return new Response(text,{headers:{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(safeName+'.txt')}`}});
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
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='audits'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||'');const version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);
    const report=auditText(version.content,version.range_start,version.range_end),id=`a-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();
    await env.DB.prepare('INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,projectId,versionId,report.score,report.status,report.summary,JSON.stringify(report.findings),version.sha256,stamp).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'audit',`结构审计：${report.score}分，${report.status}`,stamp).run();return json({report:{id,version_id:versionId,sha256:version.sha256,created_at:stamp,...report}},201);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='detectors'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||''),human=Number(body?.humanScore),suspected=Number(body?.suspectedScore||0),ai=Number(body?.aiScore||0),name=String(body?.reportName||'').trim(),base64=String(body?.dataBase64||'');
    if(!Number.isFinite(human)||human<0||human>100||suspected<0||suspected>100||ai<0||ai>100)return json({error:'检测指标必须在0—100之间'},400);if(!name||!base64)return json({error:'必须上传朱雀报告截图'},400);if(!env.FILES)return json({error:'R2报告存储未配置'},503);
    const version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);let bytes;try{bytes=decodeBase64(base64)}catch{return json({error:'报告截图编码无效'},400)}if(bytes.byteLength>5*1024*1024)return json({error:'报告截图不能超过5MB'},413);
    const id=`z-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),key=`projects/${projectId}/detectors/${id}/${name.replace(/[^\p{L}\p{N}._-]/gu,'_')}`,status=human>=85?'通过':'未通过';await env.FILES.put(key,bytes,{httpMetadata:{contentType:String(body?.mime||'image/png')},customMetadata:{projectId,versionId,sha256:version.sha256}});
    await env.DB.prepare('INSERT INTO detector_reports(id,project_id,version_id,human_score,suspected_score,ai_score,report_object_key,report_name,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,versionId,human,suspected,ai,key,name,version.sha256,status,stamp).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'detector',`朱雀报告：人工特征${human}%，${status}`,stamp).run();return json({report:{id,version_id:versionId,human_score:human,suspected_score:suspected,ai_score:ai,report_name:name,sha256:version.sha256,status,created_at:stamp}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='model'&&parts[4]==='run'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],taskType=String(body?.taskType||'reply'),instruction=String(body?.instruction||'').trim();if(!instruction)return json({error:'任务内容不能为空'},400);const data=await detail(env.DB,projectId);if(!data)return json({error:'项目不存在'},404);data.sourceTexts=(await env.DB.prepare('SELECT name,extracted_text FROM source_documents WHERE project_id=? AND extraction_status=? ORDER BY created_at').bind(projectId,'已提取').all()).results;let output;try{output=await callModel(body?.config||{},modelPrompt(data,taskType,instruction))}catch(error){return json({error:String(error?.message||error)},502)}const stamp=now();
    if(ASSET_TYPES.has(taskType)){await env.DB.prepare(`INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at`).bind(projectId,taskType,output,stamp).run();}
    else if(taskType==='draft'){const vid=`v-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,digest=await sha256(new TextEncoder().encode(output)),start=Number(body?.rangeStart||data.profile?.submission_start||1),end=Number(body?.rangeEnd||data.profile?.submission_end||10);await env.DB.prepare('INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(vid,projectId,String(body?.label||`模型稿 ${stamp.slice(0,16)}`),start,end,output,digest,'模型生成','待人工审校',stamp).run();}
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'model',`模型任务完成：${taskType}${taskType==='reply'?'\n'+output.slice(0,3500):''}`,stamp).run();await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,projectId).run();return json({ok:true,output,taskType});
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='sources'&&request.method==='POST') {
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}
    const projectId=parts[2],name=String(body?.name||'').trim(),mime=String(body?.mime||'application/octet-stream').slice(0,120),base64=String(body?.dataBase64||'');
    if(!name||name.length>180||!base64)return json({error:'文件名和文件内容不能为空'},400);
    if(!env.FILES)return json({error:'R2素材存储未配置'},503);
    if(!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(projectId).first())return json({error:'项目不存在'},404);
    let bytes;try{bytes=decodeBase64(base64)}catch{return json({error:'文件编码无效'},400)}
    if(bytes.byteLength>10*1024*1024)return json({error:'单个素材不能超过10MB'},413);
    const id=`s-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),safeName=name.replace(/[^\p{L}\p{N}._-]/gu,'_'),objectKey=`projects/${projectId}/sources/${id}/${safeName}`;
    const digest=await sha256(bytes),ext=(name.split('.').pop()||'').toLowerCase();
    let extracted='',status='待解析';
    if(TEXT_EXTENSIONS.has(ext)||mime.startsWith('text/')){try{extracted=new TextDecoder('utf-8',{fatal:false}).decode(bytes);status='已提取'}catch{status='提取失败'}}
    await env.FILES.put(objectKey,bytes,{httpMetadata:{contentType:mime},customMetadata:{projectId,sha256:digest,originalName:name}});
    await env.DB.prepare('INSERT INTO source_documents(id,project_id,name,mime,object_key,byte_size,sha256,extracted_text,extraction_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,name,mime,objectKey,bytes.byteLength,digest,extracted,status,stamp).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'source',`导入素材：${name}（${status}）`,stamp).run();
    await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,projectId).run();
    return json({source:{id,name,mime,byte_size:bytes.byteLength,sha256:digest,extraction_status:status,created_at:stamp}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='assets'&&ASSET_TYPES.has(parts[4])&&request.method==='PUT') {
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)} const id=parts[2],type=parts[4],content=String(body?.content||''),stamp=now(); if(!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(id).first())return json({error:'项目不存在'},404);
    await env.DB.prepare(`INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at`).bind(id,type,content,stamp).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(id,'asset',`更新项目资料：${type}`,stamp).run(); await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,id).run(); const asset=await env.DB.prepare('SELECT content,version,updated_at AS updatedAt FROM story_assets WHERE project_id=? AND asset_type=?').bind(id,type).first(); return json({asset});
  }
  return json({error:'接口不存在'},404);
}

export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname.startsWith('/api/')){try{return await api(request,env)}catch(error){return json({error:'服务内部错误',detail:String(error?.message||error)},500)}}return env.ASSETS.fetch(request)}};
