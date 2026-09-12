const ASSET_TYPES = new Set(['synopsis', 'characters', 'world', 'beat_matrix']);
const TEXT_EXTENSIONS = new Set(['txt','md','markdown','json','csv','tsv']);
const GATES = [['G0','立项与参数'],['G1','方案与卡点'],['G2','第1—3集校准'],['G3','批次创作'],['G4','内容终审'],['G5','朱雀同版检测'],['G6','交付与归档']];
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const now = () => new Date().toISOString();

async function seedWorkspace(db, id, stamp, p = {}) {
  await db.prepare(`INSERT OR IGNORE INTO project_profiles
    (project_id,region,medium,genre,total_episodes,submission_start,submission_end,opening_template,current_stage,progress,status,updated_at,duration_min_seconds,duration_max_seconds,calibration_threshold,quality_threshold,zhuque_threshold,one_scene_each,zhuque_required)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,p.region||'国内',p.medium||'AI漫剧',p.genre||'待设定',Number(p.totalEpisodes||60),Number(p.submissionStart||1),Number(p.submissionEnd||10),p.openingTemplate||'老王模板','G0 立项与参数',10,'待立项',stamp,Number(p.durationMin||120),Number(p.durationMax||180),Number(p.calibrationThreshold||85),Number(p.qualityThreshold||90),Number(p.zhuqueThreshold||85),p.oneSceneEach===false?0:1,p.zhuqueRequired===false?0:1).run();
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
  const audits = (await db.prepare('SELECT id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass FROM audit_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
  const detectors = (await db.prepare('SELECT id,version_id,human_score,suspected_score,ai_score,report_name,sha256,status,created_at FROM detector_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
  const runs = (await db.prepare('SELECT id,task_type,instruction,status,stage,progress,output_preview,error,version_id,created_at,updated_at FROM task_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 30').bind(id).all()).results;
  const approvals = (await db.prepare('SELECT id,gate_code,decision,note,version_id,sha256,actor,created_at FROM approval_records WHERE project_id=? ORDER BY created_at DESC LIMIT 30').bind(id).all()).results;
  const latestVersionId=versions[0]?.id||null;
  return {project, profile, assets:Object.fromEntries(assetsRows.map(x=>[x.asset_type,{content:x.content,version:x.version,updatedAt:x.updatedAt}])), versions, gates, events, sources, audits:audits.map(x=>({...x,is_current:x.version_id===latestVersionId})), detectors:detectors.map(x=>({...x,is_current:x.version_id===latestVersionId})), runs, approvals, latestVersionId};
}

function decodeBase64(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes;
}
async function sha256(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
}

function parseEpisodeNumber(token){if(/^\d+$/.test(token))return Number(token);const map={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};if(token==='十')return 10;if(token.includes('百')){const [a,b='']=token.split('百');return (map[a]||1)*100+parseEpisodeNumber(b||'0')}if(token.includes('十')){const [a,b='']=token.split('十');return (a?map[a]:1)*10+(b?map[b]:0)}return [...token].reduce((n,x)=>n*10+(map[x]??0),0)}
function auditText(content,start,end) {
  const findings=[], lines=content.split(/\r?\n/), add=(level,code,message)=>findings.push({level,code,message});
  const episodeNumbers=[...content.matchAll(/^\s*第\s*([0-9一二三四五六七八九十百〇零两]+)\s*集\s*$/gm)].map(x=>parseEpisodeNumber(x[1]));
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

const DIMENSIONS={premise:15,causality:15,characters:20,dialogue:15,pacing:10,emotion:10,performance:10,continuity:5};
function parseJsonObject(text){const clean=String(text||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim(),start=clean.indexOf('{'),end=clean.lastIndexOf('}');if(start<0||end<=start)throw new Error('深审模型未返回JSON对象');return JSON.parse(clean.slice(start,end+1))}
function normalizeDeepAudit(raw,threshold){
  const dimensions={};let total=0;for(const [key,max] of Object.entries(DIMENSIONS)){const src=raw?.dimensions?.[key]||{},score=Math.max(0,Math.min(max,Number(src.score)||0));dimensions[key]={score,max,evidence:Array.isArray(src.evidence)?src.evidence.slice(0,6):[],deduction:String(src.deduction||'')};total+=score}
  const hardErrors=Array.isArray(raw?.hard_errors)?raw.hard_errors.slice(0,50):[],reverseChecks={},reverseSource=raw?.reverse_checks&&typeof raw.reverse_checks==='object'?raw.reverse_checks:{};for(const key of ['prop_chain','permission_license','adjacent_transition','presence_speaker','packaging_identity']){const src=reverseSource[key]||{},status=['pass','fail','not_applicable'].includes(src.status)?src.status:'fail';reverseChecks[key]={status,evidence:Array.isArray(src.evidence)?src.evidence.slice(0,8):[],problem:String(src.problem||(!reverseSource[key]?'模型漏交该反查表':''))}}
  const coreFloorPass=dimensions.causality.score>=12&&dimensions.characters.score>=16&&dimensions.dialogue.score>=12,reversePass=Object.values(reverseChecks).every(x=>x.status==='pass'||x.status==='not_applicable'),status=total>=threshold&&coreFloorPass&&reversePass&&hardErrors.length===0?'通过':'需修复';
  const findings=[...hardErrors.map(x=>({level:'error',code:String(x.type||'hard_error'),message:`${x.episode||''}${x.scene?'/'+x.scene:''} ${x.evidence||x.problem||'硬错误'}`.trim()})),...Object.entries(reverseChecks).filter(([,x])=>x.status==='fail').map(([key,x])=>({level:'error',code:`reverse_${key}`,message:x.problem||`${key}反查未通过`}))];
  return{score:total,status,summary:String(raw?.summary||`AI内部八维深审${total}分；硬错误${hardErrors.length}项。`),findings,dimensions,reverseChecks,hardErrors,coreFloorPass};
}
function deepAuditPrompt(data,version){return `你是严格的中文短剧SOP内部审读员。只审读给定版本，不改稿，不因目标分倒填。必须输出单个JSON对象，不要Markdown。\n项目：${data.project.name}\n路线：${data.project.route}\n总集数：${data.profile?.total_episodes||60}\n本次正文：第${version.range_start}—${version.range_end}集\n门槛：${data.profile?.quality_threshold||90}\n\n按八维评分：premise满15；causality满15且底线12；characters满20且底线16；dialogue满15且底线12；pacing满10；emotion满10；performance满10；continuity满5。每维返回score、evidence数组（必须含集号/场次/短原文锚点）、deduction。\n按五张反查表返回reverse_checks：prop_chain、permission_license、adjacent_transition、presence_speaker、packaging_identity；每项返回status(pass/fail/not_applicable)、evidence数组、problem。另查人物所知、时间空间、伤势、金额期限、重生/异能边界、反派利益、专业常识。\n硬错误放hard_errors数组，每项含episode、scene、type、evidence、minimal_fix、affected_later。summary必须说明最大优点和首要缺陷。\nJSON结构：{"dimensions":{"premise":{"score":0,"evidence":[],"deduction":""}},"reverse_checks":{},"hard_errors":[],"summary":""}\n\n项目资料：\n梗概：${data.assets?.synopsis?.content||'无'}\n人物：${data.assets?.characters?.content||'无'}\n世界观：${data.assets?.world?.content||'无'}\n卡点：${data.assets?.beat_matrix?.content||'无'}\n\n正文：\n${version.content}`}
function analyzeScript(content){
  const lines=content.split(/\r?\n/),episodes=[],characters=new Map(),locations=new Map();let currentEpisode=null,currentScene=null;
  for(let i=0;i<lines.length;i++){const line=lines[i].trim(),ep=line.match(/^第\s*([0-9一二三四五六七八九十百〇零两]+)\s*集$/);if(ep){currentEpisode={number:parseEpisodeNumber(ep[1]),line:i+1,scenes:[]};episodes.push(currentEpisode);currentScene=null;continue}const scene=line.match(/^(\d+)\s*[-－—]\s*(\d+)\s+(.+)$/);if(scene){currentScene={episode:currentEpisode?.number||Number(scene[1]),number:Number(scene[2]),heading:line,line:i+1,characters:[]};if(!currentEpisode){currentEpisode={number:Number(scene[1]),line:i+1,scenes:[]};episodes.push(currentEpisode)}currentEpisode.scenes.push(currentScene);const loc=scene[3].split(/\s+/).slice(2).join(' ')||scene[3];locations.set(loc,(locations.get(loc)||0)+1);continue}const cast=line.match(/^人物[：:]\s*(.+)$/);if(cast&&currentScene){const names=cast[1].split(/[、，,\/]/).map(x=>x.trim()).filter(Boolean);currentScene.characters=names;for(const n of names)characters.set(n,(characters.get(n)||0)+1)}}
  return{episodes,episodeCount:episodes.length,sceneCount:episodes.reduce((n,e)=>n+e.scenes.length,0),characters:[...characters].sort((a,b)=>b[1]-a[1]).map(([name,scenes])=>({name,scenes})),locations:[...locations].sort((a,b)=>b[1]-a[1]).map(([name,scenes])=>({name,scenes}))};
}

async function api(request, env) {
  const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.pathname === '/api/health') return json({ok:true,service:'剧本创作总控台',storage:'cloudflare-d1',version:'0.5.0'});
  if (!env.DB) return json({error:'数据库绑定未配置'},503);

  if (url.pathname === '/api/projects' && request.method === 'GET') {
    const {results}=await env.DB.prepare('SELECT id,name,route,note,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all(); return json({projects:results});
  }
  if (url.pathname === '/api/projects' && request.method === 'POST') {
    let body; try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}
    const name=String(body?.name||'').trim(), route=String(body?.route||'完全原创 / 市场参考').trim();
    if(!name||name.length>120)return json({error:'项目名称不能为空且不超过120字'},400);
    const minDuration=Number(body?.durationMin||120),maxDuration=Number(body?.durationMax||180),quality=Number(body?.qualityThreshold||90),zhuque=Number(body?.zhuqueThreshold||85);if(minDuration<30||maxDuration<minDuration||maxDuration>600)return json({error:'单集时长范围无效'},400);if(quality<0||quality>100||zhuque<0||zhuque>100)return json({error:'质量和朱雀门槛必须在0—100之间'},400);
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
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='versions'&&parts[3]==='analysis'&&request.method==='GET'){
    const version=await env.DB.prepare('SELECT id,label,content,sha256 FROM draft_versions WHERE id=?').bind(parts[2]).first();return version?json({version:{id:version.id,label:version.label,sha256:version.sha256},analysis:analyzeScript(version.content)}):json({error:'版本不存在'},404);
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
    await env.DB.prepare('INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,versionId,report.score,report.status,report.summary,JSON.stringify(report.findings),version.sha256,stamp,'structural','{}','{}','[]',report.status==='通过'?1:0).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'audit',`结构审计：${report.score}分，${report.status}`,stamp).run();return json({report:{id,version_id:versionId,sha256:version.sha256,created_at:stamp,...report}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='audits'&&parts[4]==='deep'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||''),version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);const data=await detail(env.DB,projectId);const runId=`r-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();await env.DB.prepare('INSERT INTO task_runs(id,project_id,task_type,instruction,status,stage,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(runId,projectId,'deep_audit',`深审版本 ${version.label}`,'running','八维评分与五表反查',35,stamp,stamp).run();let output;
    try{output=await callModel(body?.config||{},deepAuditPrompt(data,version))}catch(error){const message=String(error?.message||error);await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,error=?,updated_at=? WHERE id=?').bind('failed','模型调用失败',100,message,now(),runId).run();return json({error:message,runId},502)}
    let report;try{report=normalizeDeepAudit(parseJsonObject(output),Number(data.profile?.quality_threshold||90))}catch(error){const message=String(error?.message||error);await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,error=?,output_preview=?,updated_at=? WHERE id=?').bind('failed','结果解析失败',100,message,output.slice(0,3500),now(),runId).run();return json({error:message,runId},422)}
    const id=`a-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,done=now();await env.DB.prepare('INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,versionId,report.score,report.status,report.summary,JSON.stringify(report.findings),version.sha256,done,'deep_ai',JSON.stringify(report.dimensions),JSON.stringify(report.reverseChecks),JSON.stringify(report.hardErrors),report.coreFloorPass?1:0).run();await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,output_preview=?,updated_at=? WHERE id=?').bind('succeeded','等待人工确认',100,report.summary.slice(0,3500),done,runId).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'audit',`AI内部深审：${report.score}分，${report.status}；硬错误${report.hardErrors.length}项`,done).run();return json({report:{id,version_id:versionId,sha256:version.sha256,created_at:done,audit_type:'deep_ai',...report},runId},201);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='detectors'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||''),human=Number(body?.humanScore),suspected=Number(body?.suspectedScore||0),ai=Number(body?.aiScore||0),name=String(body?.reportName||'').trim(),base64=String(body?.dataBase64||'');
    if(!Number.isFinite(human)||human<0||human>100||suspected<0||suspected>100||ai<0||ai>100)return json({error:'检测指标必须在0—100之间'},400);if(!name||!base64)return json({error:'必须上传朱雀报告截图'},400);if(!env.FILES)return json({error:'R2报告存储未配置'},503);
    const version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);let bytes;try{bytes=decodeBase64(base64)}catch{return json({error:'报告截图编码无效'},400)}if(bytes.byteLength>5*1024*1024)return json({error:'报告截图不能超过5MB'},413);const isPng=bytes.length>=8&&bytes[0]===0x89&&bytes[1]===0x50&&bytes[2]===0x4e&&bytes[3]===0x47,isJpeg=bytes.length>=3&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;if(!isPng&&!isJpeg)return json({error:'报告文件必须是真实PNG或JPEG图片'},400);
    const profile=await env.DB.prepare('SELECT zhuque_threshold FROM project_profiles WHERE project_id=?').bind(projectId).first(),threshold=Number(profile?.zhuque_threshold||85);
    const id=`z-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),key=`projects/${projectId}/detectors/${id}/${name.replace(/[^\p{L}\p{N}._-]/gu,'_')}`,status=human>=threshold?'通过':'未通过';await env.FILES.put(key,bytes,{httpMetadata:{contentType:String(body?.mime||'image/png')},customMetadata:{projectId,versionId,sha256:version.sha256}});
    await env.DB.prepare('INSERT INTO detector_reports(id,project_id,version_id,human_score,suspected_score,ai_score,report_object_key,report_name,sha256,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,versionId,human,suspected,ai,key,name,version.sha256,status,stamp).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'detector',`朱雀报告：人工特征${human}%，${status}`,stamp).run();return json({report:{id,version_id:versionId,human_score:human,suspected_score:suspected,ai_score:ai,report_name:name,sha256:version.sha256,status,created_at:stamp}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='model'&&parts[4]==='run'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],taskType=String(body?.taskType||'reply'),instruction=String(body?.instruction||'').trim();if(!instruction)return json({error:'任务内容不能为空'},400);const data=await detail(env.DB,projectId);if(!data)return json({error:'项目不存在'},404);data.sourceTexts=(await env.DB.prepare('SELECT name,extracted_text FROM source_documents WHERE project_id=? AND extraction_status=? ORDER BY created_at').bind(projectId,'已提取').all()).results;const runId=`r-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,started=now();await env.DB.prepare('INSERT INTO task_runs(id,project_id,task_type,instruction,status,stage,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(runId,projectId,taskType,instruction,'running','模型生成',35,started,started).run();let output;try{output=await callModel(body?.config||{},modelPrompt(data,taskType,instruction))}catch(error){const message=String(error?.message||error);await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,error=?,updated_at=? WHERE id=?').bind('failed','模型调用失败',100,message,now(),runId).run();return json({error:message,runId},502)}const stamp=now();let versionId=null;
    if(ASSET_TYPES.has(taskType)){await env.DB.prepare(`INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at`).bind(projectId,taskType,output,stamp).run();}
    else if(taskType==='draft'){versionId=`v-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;const digest=await sha256(new TextEncoder().encode(output)),start=Number(body?.rangeStart||data.profile?.submission_start||1),end=Number(body?.rangeEnd||data.profile?.submission_end||10);await env.DB.prepare('INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(versionId,projectId,String(body?.label||`模型稿 ${stamp.slice(0,16)}`),start,end,output,digest,'模型生成','待人工审校',stamp).run();}
    await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,output_preview=?,version_id=?,updated_at=? WHERE id=?').bind('succeeded',taskType==='draft'?'等待人工审校':'已保存',100,output.slice(0,3500),versionId,stamp,runId).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'model',`模型任务完成：${taskType}${taskType==='reply'?'\n'+output.slice(0,3500):''}`,stamp).run();await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,projectId).run();return json({ok:true,output,taskType,runId,versionId});
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='gates'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],gateCode=parts[4],decision=String(body?.decision||''),note=String(body?.note||'').trim(),versionId=String(body?.versionId||'');if(!GATES.some(x=>x[0]===gateCode)||!['approve','reject'].includes(decision))return json({error:'闸门或决定无效'},400);const data=await detail(env.DB,projectId);if(!data)return json({error:'项目不存在'},404);const version=versionId?await env.DB.prepare('SELECT id,sha256 FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first():null;
    if(decision==='approve'&&['G2','G3','G4','G5','G6'].includes(gateCode)&&!version)return json({error:'该阶段批准必须绑定正文版本'},400);if(decision==='approve'&&version&&version.id!==data.latestVersionId)return json({error:'只能批准当前最新正文版本'},409);
    if(decision==='approve'&&gateCode==='G4'){const ok=data.audits.some(x=>x.audit_type==='deep_ai'&&x.version_id===versionId&&x.status==='通过'&&Number(x.core_floor_pass)===1);if(!ok)return json({error:'G4需要当前版本AI内部深审达到项目门槛、核心底线通过且硬错误为0'},409)}
    if(decision==='approve'&&gateCode==='G5'&&Number(data.profile?.zhuque_required)!==0){const threshold=Number(data.profile?.zhuque_threshold||85),ok=data.detectors.some(x=>x.version_id===versionId&&x.status==='通过'&&Number(x.human_score)>=threshold);if(!ok)return json({error:`G5需要当前版本朱雀人工特征达到${threshold}%并保存真实报告`},409)}
    if(decision==='approve'&&gateCode==='G6'){const passed=new Set(data.gates.filter(x=>x.status==='passed').map(x=>x.gate_code));if(!passed.has('G4')||(Number(data.profile?.zhuque_required)!==0&&!passed.has('G5')))return json({error:'G6需要先通过内容终审和适用的朱雀门禁'},409)}
    const id=`ap-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),status=decision==='approve'?'passed':'blocked',sha=version?.sha256||'';await env.DB.prepare('INSERT INTO approval_records(id,project_id,gate_code,decision,note,version_id,sha256,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,projectId,gateCode,decision,note,versionId||null,sha,'operator',stamp).run();await env.DB.prepare('UPDATE gates SET status=?,note=?,updated_at=? WHERE project_id=? AND gate_code=?').bind(status,note||status,stamp,projectId,gateCode).run();const index=GATES.findIndex(x=>x[0]===gateCode);if(decision==='approve'){if(index>=0&&index<GATES.length-1)await env.DB.prepare('UPDATE gates SET status=?,note=?,updated_at=? WHERE project_id=? AND gate_code=? AND status<>?').bind('current','等待处理',stamp,projectId,GATES[index+1][0],'passed').run();const next=GATES[Math.min(index+1,GATES.length-1)];await env.DB.prepare('UPDATE project_profiles SET current_stage=?,progress=?,status=?,updated_at=? WHERE project_id=?').bind(`${next[0]} ${next[1]}`,gateCode==='G6'?100:Math.round(((index+1)/6)*100),gateCode==='G6'?'已归档':'等待人工处理',stamp,projectId).run()}else await env.DB.prepare('UPDATE project_profiles SET current_stage=?,status=?,updated_at=? WHERE project_id=?').bind(`${gateCode} ${GATES[index]?.[1]||''}`,'已阻塞',stamp,projectId).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'approval',`${gateCode}${decision==='approve'?'批准':'驳回'}：${note||'无备注'}`,stamp).run();return json({approval:{id,gate_code:gateCode,decision,note,version_id:versionId||null,sha256:sha,created_at:stamp}},201);
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
