const ASSET_TYPES = new Set(['synopsis', 'characters', 'world', 'beat_matrix']);
const TEXT_EXTENSIONS = new Set(['txt','md','markdown','json','csv','tsv']);
const GATES = [['G0','立项与参数'],['G1','方案与卡点'],['G2','第1—3集校准'],['G3','批次创作'],['G4','内容终审'],['G5','朱雀同版检测'],['G6','交付与归档']];
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
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
  const versions = (await db.prepare('SELECT id,label,range_start,range_end,sha256,source,status,created_at FROM draft_versions WHERE project_id=? ORDER BY created_at DESC,rowid DESC').bind(id).all()).results;
  const gates = (await db.prepare('SELECT gate_code,title,status,note,updated_at FROM gates WHERE project_id=? ORDER BY gate_code').bind(id).all()).results;
  const events = (await db.prepare('SELECT kind,message,created_at FROM activity_logs WHERE project_id=? ORDER BY id DESC LIMIT 50').bind(id).all()).results;
  const sources = (await db.prepare('SELECT id,name,mime,byte_size,sha256,extraction_status,created_at FROM source_documents WHERE project_id=? ORDER BY created_at DESC').bind(id).all()).results;
  const audits = (await db.prepare('SELECT id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass FROM audit_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
  const detectors = (await db.prepare('SELECT id,version_id,human_score,suspected_score,ai_score,report_name,sha256,status,created_at FROM detector_reports WHERE project_id=? ORDER BY created_at DESC LIMIT 20').bind(id).all()).results;
  const runs = (await db.prepare('SELECT id,task_type,instruction,status,stage,progress,output_preview,error,version_id,retry_of,created_at,updated_at FROM task_runs WHERE project_id=? ORDER BY created_at DESC LIMIT 30').bind(id).all()).results;
  const approvals = (await db.prepare('SELECT id,gate_code,decision,note,version_id,sha256,actor,created_at FROM approval_records WHERE project_id=? ORDER BY created_at DESC LIMIT 30').bind(id).all()).results;
  const continuity = (await db.prepare('SELECT id,category,subject,state,first_episode,last_episode,source_version_id,status,notes,created_at,updated_at FROM continuity_entries WHERE project_id=? ORDER BY category,subject').bind(id).all()).results;
  const qualityReviews = (await db.prepare('SELECT id,version_id,score,note,actor,created_at FROM quality_reviews WHERE project_id=? ORDER BY created_at DESC LIMIT 30').bind(id).all()).results;
  const latestVersionId=versions[0]?.id||null;
  const result={project, profile, assets:Object.fromEntries(assetsRows.map(x=>[x.asset_type,{content:x.content,version:x.version,updatedAt:x.updatedAt}])), versions, gates, events, sources, audits:audits.map(x=>({...x,is_current:x.version_id===latestVersionId})), detectors:detectors.map(x=>({...x,is_current:x.version_id===latestVersionId})), runs, approvals, continuity:continuity.map(x=>({...x,is_current:!x.source_version_id||x.source_version_id===latestVersionId})), qualityReviews, latestVersionId};
  result.workflow=buildWorkflow(result);
  return result;
}

function hasRealValue(value){const text=String(value??'').trim();return Boolean(text&&text!=='待设定'&&text!=='未设定'&&text!=='无');}
function covers(version,start,end){return Boolean(version&&Number(version.range_start)<=start&&Number(version.range_end)>=end)}
function assetReady(type,value){const text=String(value||'').trim(),minimum={synopsis:100,characters:120,world:80,beat_matrix:150}[type]||80;return text.length>=minimum&&!/(待填写|待补充|TODO|TBD)/i.test(text)}
function buildWorkflow(data){
  const profile=data.profile||{}, gates=data.gates||[], assets=data.assets||{}, versions=data.versions||[], latest=versions[0], latestId=data.latestVersionId;
  const start=Number(profile.submission_start||1), end=Number(profile.submission_end||10), calibrationEnd=Math.min(end,start+2), missingAssets=['synopsis','characters','world','beat_matrix'].filter(x=>!assetReady(x,assets[x]?.content));
  const calibrationVersion=versions.find(x=>covers(x,start,calibrationEnd));
  const calibrationAudit=calibrationVersion&&data.audits?.some(x=>x.is_current&&x.version_id===calibrationVersion.id&&x.audit_type==='structural'&&x.status==='通过');
  const deep=data.audits?.some(x=>x.is_current&&x.version_id===latestId&&x.audit_type==='deep_ai'&&x.status==='通过'&&Number(x.core_floor_pass)===1);
  const threshold=Number(profile.quality_threshold||90), quality=data.qualityReviews?.find(x=>x.version_id===latestId&&Number(x.score)>=threshold);
  const detectorRequired=Number(profile.zhuque_required??1)!==0, zhuqueThreshold=Number(profile.zhuque_threshold||85), detector=data.detectors?.some(x=>x.is_current&&x.version_id===latestId&&x.status==='通过'&&Number(x.human_score)>=zhuqueThreshold);
  const passed=new Set(gates.filter(x=>x.status==='passed').map(x=>x.gate_code));
  const checks=[
    {code:'G0',title:'立项与参数',ready:hasRealValue(data.project?.name)&&hasRealValue(data.project?.route)&&hasRealValue(profile.region)&&hasRealValue(profile.medium)&&hasRealValue(profile.genre)&&Number(profile.total_episodes)>0&&hasRealValue(profile.opening_template),reason:hasRealValue(profile.genre)?'立项参数已齐':'补齐地区、形式、题材、总集数和开头模板等立项参数'},
    {code:'G1',title:'方案与卡点',ready:missingAssets.length===0,reason:missingAssets.length?`项目资料待补：${missingAssets.join('、')}`:'四项项目资料已齐'},
    {code:'G2',title:'第1—3集校准',ready:Boolean(calibrationVersion&&calibrationAudit),reason:calibrationVersion?(calibrationAudit?'校准稿结构审计已通过':'先对校准稿运行结构审计'):'先保存覆盖校准范围的正文版本'},
    {code:'G3',title:'批次创作',ready:Boolean(latest&&covers(latest,start,end)&&passed.has('G2')),reason:passed.has('G2')?(latest&&covers(latest,start,end)?'提交范围正文已齐':'正文版本尚未覆盖本次提交范围'):'先批准G2校准闸门'},
    {code:'G4',title:'内容终审',ready:Boolean(deep&&quality&&passed.has('G3')),reason:!passed.has('G3')?'先批准G3批次创作':(!deep?'先对当前正文运行通过的AI内部深审':(!quality?`先为当前正文录入不低于${threshold}分的人工内容质量评分`:'深审与内容质量评分已齐'))},
    {code:'G5',title:'朱雀同版检测',ready:Boolean((!detectorRequired||detector)&&passed.has('G4')),reason:!passed.has('G4')?'先批准G4内容终审':(!detectorRequired?'项目已关闭朱雀必检':(detector?'当前正文朱雀报告已达标':`先保存当前正文实际朱雀报告，人工特征需达到${zhuqueThreshold}%`))},
    {code:'G6',title:'交付与归档',ready:Boolean(passed.has('G4')&&deep&&quality&&(!detectorRequired||(passed.has('G5')&&detector))&&latest&&covers(latest,start,end)),reason:!passed.has('G4')||!deep||!quality?'先完成当前正文的G4内容终审':(detectorRequired&&(!passed.has('G5')||!detector)?'先完成当前正文的G5朱雀同版检测':(latest&&covers(latest,start,end)?'可提交最终交付':'正文尚未覆盖本次提交范围'))}
  ];
  const current=gates.find(x=>x.status==='current')||gates.find(x=>x.status!=='passed')||gates[gates.length-1];
  const currentCheck=checks.find(x=>x.code===current?.gate_code)||checks[0];
  const passedCount=gates.filter(x=>x.status==='passed').length, complete=passedCount===GATES.length;
  return {currentGate:current?.gate_code||'G0',currentStage:complete?'G6 已归档':`${current?.gate_code||'G0'} ${current?.title||'立项与参数'}`,progress:complete?100:Math.round((passedCount/GATES.length)*100),checks,complete,nextAction:{gate:currentCheck.code,title:currentCheck.title,ready:complete||currentCheck.ready,message:complete?'G0—G6已全部通过，当前项目已归档':(currentCheck.ready?`可以处理${currentCheck.code}：${currentCheck.title}`:`${currentCheck.code}暂不能批准：${currentCheck.reason}`)},missingAssets,latestVersionCoversSubmission:Boolean(latest&&covers(latest,start,end)),calibrationEnd};
}

async function invalidateReviewGates(db,projectId,stamp){
  const g3=await db.prepare("SELECT status FROM gates WHERE project_id=? AND gate_code='G3'").bind(projectId).first();
  await db.prepare("UPDATE gates SET status='pending',note='正文已更新，旧终审证据失效',updated_at=? WHERE project_id=? AND gate_code IN ('G4','G5','G6')").bind(stamp,projectId).run();
  if(g3?.status==='passed'){
    await db.prepare("UPDATE gates SET status='current',note='等待当前正文重新终审',updated_at=? WHERE project_id=? AND gate_code='G4'").bind(stamp,projectId).run();
    await db.prepare("UPDATE project_profiles SET current_stage='G4 内容终审',progress=50,status='等待重新终审',updated_at=? WHERE project_id=?").bind(stamp,projectId).run();
  }
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
function parseJsonObject(text){const clean=String(text||'').replace(/^```(?:json)?\s*/i,'').replace(/```\s*$/,'').trim(),start=clean.indexOf('{'),end=clean.lastIndexOf('}');if(start<0||end<=start)throw new Error('模型未返回可解析的JSON对象');return JSON.parse(clean.slice(start,end+1))}
function researchPrompt({title,brief,referenceTitles,marketNotes,count}){
  return `你是短剧选题研发主编。请根据用户提供的创作方向、近期剧名信号和可核验备注，提出${count}个彼此显著不同、可进入正式立项的原创短剧方案。

调研主题：${title}
用户思路：${brief||'未提供'}
近期剧名/参考标题（只代表标题与题材信号，不代表你知道其剧情、热度或收益）：
${referenceTitles||'未提供'}
可核验市场数据或用户备注：
${marketNotes||'未提供'}

硬性规则：
1. 不得从剧名臆造原作剧情、签约状态、播放量、收益或排名；没有数据就明确按“标题信号”分析。
2. 推荐必须是新项目，不复刻参考标题，不只换人名、职业或时代；人物关系、核心机制、冲突场域和结局至少三项不同。
3. 各方案题材、职业、情绪引擎、视觉奇观要拉开差异；剧名不要全部使用“两段式反转标题”。
4. 建议体量限定30—60集，并结合事件容量判断，不机械统一为60集。
5. score是内部立项推荐分，不是平台通过率；按题眼15、冲突20、人物15、持续性20、差异化15、可视化15合计100分保守评分。
6. 只输出一个JSON对象，不要Markdown，不要解释性前后缀。

JSON结构：{"analysis_summary":"说明本轮仅用了哪些信号、哪些事实不能判断","candidates":[{"title":"","genre":"","hook":"","core_conflict":"","innovation":"","episode_recommendation":50,"score":90,"risks":""}]}`;
}
function normalizeResearch(raw,count,referenceTitles){
  const refs=new Set(String(referenceTitles||'').split(/\r?\n|[；;]/).map(x=>x.replace(/^\s*\d+[.、）)]?\s*/,'').replace(/[《》]/g,'').trim()).filter(Boolean));
  const rows=Array.isArray(raw?.candidates)?raw.candidates:[],seen=new Set(),candidates=[];
  for(const src of rows){
    const title=String(src?.title||'').replace(/[《》]/g,'').trim(),key=title.toLowerCase();if(!title||title.length>80||seen.has(key)||refs.has(title))continue;
    const genre=String(src?.genre||'').trim(),hook=String(src?.hook||'').trim(),core=String(src?.core_conflict||'').trim(),innovation=String(src?.innovation||'').trim(),risks=String(src?.risks||'').trim();
    if(!genre||hook.length<18||core.length<18||innovation.length<12)continue;
    seen.add(key);candidates.push({title,genre,hook,core_conflict:core,innovation,episode_recommendation:Math.max(30,Math.min(60,Math.round(Number(src?.episode_recommendation)||50))),score:Math.max(0,Math.min(100,Number(src?.score)||0)),risks:risks||'需在G1阶段继续核查同质化、专业常识与长线容量'});if(candidates.length>=count)break;
  }
  if(candidates.length<Math.min(3,count))throw new Error(`有效推荐不足3个（仅解析到${candidates.length}个），请重试或补充更明确的思路`);
  return{analysisSummary:String(raw?.analysis_summary||'本轮只依据用户提供的创作方向与标题信号形成推荐；未提供的数据不作事实判断。').trim(),candidates};
}
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
  if (url.pathname === '/api/health') return json({ok:true,service:'剧本创作总控台',storage:'cloudflare-d1',version:'0.8.0'});
  if (!env.DB) return json({error:'数据库绑定未配置'},503);

  if(url.pathname==='/api/research'&&request.method==='GET'){
    const {results}=await env.DB.prepare(`SELECT r.*,COUNT(c.id) AS candidate_count FROM research_sessions r LEFT JOIN research_candidates c ON c.session_id=r.id GROUP BY r.id ORDER BY r.updated_at DESC LIMIT 50`).all();return json({sessions:results});
  }
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='research'&&request.method==='GET'){
    const session=await env.DB.prepare('SELECT * FROM research_sessions WHERE id=?').bind(parts[2]).first();if(!session)return json({error:'调研记录不存在'},404);const candidates=(await env.DB.prepare('SELECT id,session_id,title,genre,hook,core_conflict,innovation,episode_recommendation,score,risks,created_at FROM research_candidates WHERE session_id=? ORDER BY score DESC,created_at').bind(parts[2]).all()).results;return json({session,candidates});
  }
  if(url.pathname==='/api/research/generate'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const title=String(body?.title||'').trim(),brief=String(body?.brief||'').trim(),referenceTitles=String(body?.referenceTitles||'').trim(),marketNotes=String(body?.marketNotes||'').trim(),count=Number(body?.count||5);if(!title||title.length>120)return json({error:'调研主题不能为空且不超过120字'},400);if(!Number.isInteger(count)||count<3||count>10)return json({error:'推荐数量必须是3—10之间的整数'},400);if(!brief&&!referenceTitles&&!marketNotes)return json({error:'请至少提供创作思路、近期剧名或市场备注中的一项'},400);
    const id=`rs-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();await env.DB.prepare('INSERT INTO research_sessions(id,title,brief,reference_titles,market_notes,requested_count,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,title,brief,referenceTitles,marketNotes,count,'running',stamp,stamp).run();let output;
    try{output=await callModel(body?.config||{},researchPrompt({title,brief,referenceTitles,marketNotes,count}))}catch(error){const message=String(error?.message||error);await env.DB.prepare('UPDATE research_sessions SET status=?,error=?,updated_at=? WHERE id=?').bind('failed',message,now(),id).run();return json({error:message,sessionId:id},502)}
    let normalized;try{normalized=normalizeResearch(parseJsonObject(output),count,referenceTitles)}catch(error){const message=String(error?.message||error);await env.DB.prepare('UPDATE research_sessions SET status=?,error=?,updated_at=? WHERE id=?').bind('failed',message,now(),id).run();return json({error:message,sessionId:id},422)}const done=now();await env.DB.prepare('UPDATE research_sessions SET analysis_summary=?,status=?,error=?,updated_at=? WHERE id=?').bind(normalized.analysisSummary,'ready','',done,id).run();for(const candidate of normalized.candidates){const candidateId=`rc-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;await env.DB.prepare('INSERT INTO research_candidates(id,session_id,title,genre,hook,core_conflict,innovation,episode_recommendation,score,risks,raw_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(candidateId,id,candidate.title,candidate.genre,candidate.hook,candidate.core_conflict,candidate.innovation,candidate.episode_recommendation,candidate.score,candidate.risks,JSON.stringify(candidate),done).run()}const candidates=(await env.DB.prepare('SELECT id,session_id,title,genre,hook,core_conflict,innovation,episode_recommendation,score,risks,created_at FROM research_candidates WHERE session_id=? ORDER BY score DESC,created_at').bind(id).all()).results;return json({session:{id,title,brief,reference_titles:referenceTitles,market_notes:marketNotes,requested_count:count,analysis_summary:normalized.analysisSummary,status:'ready',created_at:stamp,updated_at:done},candidates},201);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='research'&&parts[3]==='project'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const candidate=await env.DB.prepare('SELECT c.*,r.id AS research_id,r.title AS research_title FROM research_candidates c JOIN research_sessions r ON r.id=c.session_id WHERE c.id=?').bind(parts[2]).first();if(!candidate)return json({error:'推荐方案不存在'},404);const name=String(body?.name||candidate.title).trim(),total=Number(body?.totalEpisodes||candidate.episode_recommendation||50),submissionEnd=Number(body?.submissionEnd||10),minDuration=Number(body?.durationMin||120),maxDuration=Number(body?.durationMax||180),quality=Number(body?.qualityThreshold||90),zhuque=Number(body?.zhuqueThreshold||85);if(!name||name.length>120)return json({error:'项目名称不能为空且不超过120字'},400);if(!Number.isInteger(total)||total<10||total>200||!Number.isInteger(submissionEnd)||submissionEnd<1||submissionEnd>total)return json({error:'总集数或提交范围无效'},400);if(minDuration<30||maxDuration<minDuration||maxDuration>600||quality<0||quality>100||zhuque<0||zhuque>100)return json({error:'立项门槛或单集时长无效'},400);const projectId=`p-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),projectBody={...body,totalEpisodes:total,submissionStart:1,submissionEnd,durationMin:minDuration,durationMax:maxDuration,qualityThreshold:quality,zhuqueThreshold:zhuque,route:body?.route||'完全原创 / 市场参考',genre:body?.genre||candidate.genre,openingTemplate:body?.openingTemplate||'老王模板'};await env.DB.prepare('INSERT INTO projects(id,name,route,note,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(projectId,name,projectBody.route,'调研推荐立项 · 待G0确认',stamp,stamp).run();await seedWorkspace(env.DB,projectId,stamp,projectBody);await env.DB.prepare('UPDATE project_profiles SET origin_research_id=?,origin_candidate_id=? WHERE project_id=?').bind(candidate.research_id,candidate.id,projectId).run();const seed=`选题种子（需在G1扩写并人工确认）\n一句话钩子：${candidate.hook}\n核心冲突：${candidate.core_conflict}\n创新点：${candidate.innovation}\n风险提示：${candidate.risks}`;await env.DB.prepare("UPDATE story_assets SET content=?,version=version+1,updated_at=? WHERE project_id=? AND asset_type='synopsis'").bind(seed,stamp,projectId).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'research',`从调研「${candidate.research_title}」推荐方案建立项目；仍需完成G0参数确认与G1完整方案`,stamp).run();return json({project:{id:projectId,name,route:projectBody.route,note:'调研推荐立项 · 待G0确认',updatedAt:stamp}},201);
  }

  if (url.pathname === '/api/projects' && request.method === 'GET') {
    const {results}=await env.DB.prepare('SELECT id,name,route,note,updated_at AS updatedAt FROM projects ORDER BY updated_at DESC').all(); return json({projects:results});
  }
  if (url.pathname === '/api/projects' && request.method === 'POST') {
    let body; try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}
    const name=String(body?.name||'').trim(), route=String(body?.route||'完全原创 / 市场参考').trim();
    if(!name||name.length>120)return json({error:'项目名称不能为空且不超过120字'},400);
    const minDuration=Number(body?.durationMin||120),maxDuration=Number(body?.durationMax||180),quality=Number(body?.qualityThreshold||90),zhuque=Number(body?.zhuqueThreshold||85),total=Number(body?.totalEpisodes||60),submissionStart=Number(body?.submissionStart||1),submissionEnd=Number(body?.submissionEnd||10);if(!Number.isInteger(total)||total<1||!Number.isInteger(submissionStart)||!Number.isInteger(submissionEnd)||submissionStart<1||submissionEnd<submissionStart||submissionEnd>total)return json({error:'总集数和本次提交范围必须有效，且提交范围不能超过总集数'},400);if(minDuration<30||maxDuration<minDuration||maxDuration>600)return json({error:'单集时长范围无效'},400);if(quality<0||quality>100||zhuque<0||zhuque>100)return json({error:'质量和朱雀门槛必须在0—100之间'},400);
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
    if(versionId)version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,parts[2]).first();else version=await env.DB.prepare('SELECT * FROM draft_versions WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').bind(parts[2]).first();
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
    const id=parts[2],profile=await env.DB.prepare('SELECT total_episodes FROM project_profiles WHERE project_id=?').bind(id).first();if(!profile)return json({error:'项目不存在'},404);if(end>Number(profile.total_episodes||60))return json({error:`正文范围不能超过项目总集数（${profile.total_episodes}集）`},400);
    const versionId=`v-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),source=String(body?.source||'人工编辑'); const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    await env.DB.prepare('INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(versionId,id,label,start,end,content,digest,source,'已保存',stamp).run();
    await invalidateReviewGates(env.DB,id,stamp);
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(id,'version',`保存正文版本 ${label}（第${start}—${end}集）`,stamp).run(); await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,id).run();
    return json({version:{id:versionId,label,range_start:start,range_end:end,sha256:digest,source,status:'已保存',created_at:stamp}},201);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='audits'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||'');const version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);
    const report=auditText(version.content,version.range_start,version.range_end),id=`a-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();
    await env.DB.prepare('INSERT INTO audit_reports(id,project_id,version_id,score,status,summary,findings_json,sha256,created_at,audit_type,dimensions_json,reverse_checks_json,hard_errors_json,core_floor_pass) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,versionId,report.score,report.status,report.summary,JSON.stringify(report.findings),version.sha256,stamp,'structural','{}','{}','[]',report.status==='通过'?1:0).run();
    await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'audit',`结构审计：${report.score}分，${report.status}`,stamp).run();return json({report:{id,version_id:versionId,sha256:version.sha256,created_at:stamp,...report}},201);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='quality'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||''),score=Number(body?.score),note=String(body?.note||'').trim();if(!Number.isFinite(score)||score<0||score>100)return json({error:'内容质量评分必须在0—100之间'},400);const project=await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(projectId).first(),version=await env.DB.prepare('SELECT id,sha256 FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!project)return json({error:'项目不存在'},404);if(!version)return json({error:'请选择当前项目的正文版本'},400);const latest=await env.DB.prepare('SELECT id FROM draft_versions WHERE project_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').bind(projectId).first();if(!latest||latest.id!==versionId)return json({error:'内容质量评分只能绑定当前最新正文'},409);const id=`q-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();await env.DB.prepare('INSERT INTO quality_reviews(id,project_id,version_id,score,note,actor,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,projectId,versionId,score,note,'operator',stamp).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'quality',`人工内容质量评分：${score}分`,stamp).run();return json({review:{id,project_id:projectId,version_id:versionId,score,note,actor:'operator',created_at:stamp,sha256:version.sha256}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='audits'&&parts[4]==='deep'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||''),version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);const data=await detail(env.DB,projectId);const runId=`r-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();await env.DB.prepare('INSERT INTO task_runs(id,project_id,task_type,instruction,status,stage,progress,version_id,retry_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(runId,projectId,'deep_audit',`深审版本 ${version.label}`,'running','八维评分与五表反查',35,versionId,String(body?.retryOf||'')||null,stamp,stamp).run();let output;
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
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],taskType=String(body?.taskType||'reply'),instruction=String(body?.instruction||'').trim();if(!instruction)return json({error:'任务内容不能为空'},400);if(![...ASSET_TYPES,'draft','reply'].includes(taskType))return json({error:'模型任务类型无效'},400);const data=await detail(env.DB,projectId);if(!data)return json({error:'项目不存在'},404);data.sourceTexts=(await env.DB.prepare('SELECT name,extracted_text FROM source_documents WHERE project_id=? AND extraction_status=? ORDER BY created_at').bind(projectId,'已提取').all()).results;const runId=`r-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,started=now();await env.DB.prepare('INSERT INTO task_runs(id,project_id,task_type,instruction,status,stage,progress,retry_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(runId,projectId,taskType,instruction,'running','模型生成',35,String(body?.retryOf||'')||null,started,started).run();let output;try{output=await callModel(body?.config||{},modelPrompt(data,taskType,instruction))}catch(error){const message=String(error?.message||error);await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,error=?,updated_at=? WHERE id=?').bind('failed','模型调用失败',100,message,now(),runId).run();return json({error:message,runId},502)}const stamp=now();let versionId=null;
    if(ASSET_TYPES.has(taskType)){await env.DB.prepare(`INSERT INTO story_assets(project_id,asset_type,content,version,updated_at) VALUES(?,?,?,1,?) ON CONFLICT(project_id,asset_type) DO UPDATE SET content=excluded.content,version=story_assets.version+1,updated_at=excluded.updated_at`).bind(projectId,taskType,output,stamp).run();}
    else if(taskType==='draft'){versionId=`v-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;const digest=await sha256(new TextEncoder().encode(output)),start=Number(body?.rangeStart||data.profile?.submission_start||1),end=Number(body?.rangeEnd||data.profile?.submission_end||10);if(start<1||end<start||end>Number(data.profile?.total_episodes||60)){const message=`模型正文范围无效，不能超过项目总集数（${data.profile?.total_episodes||60}集）`;await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,error=?,output_preview=?,updated_at=? WHERE id=?').bind('failed','范围校验失败',100,message,output.slice(0,3500),stamp,runId).run();return json({error:message,runId},400)}await env.DB.prepare('INSERT INTO draft_versions(id,project_id,label,range_start,range_end,content,sha256,source,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(versionId,projectId,String(body?.label||`模型稿 ${stamp.slice(0,16)}`),start,end,output,digest,'模型生成','待人工审校',stamp).run();}
    if(taskType==='draft')await invalidateReviewGates(env.DB,projectId,stamp);await env.DB.prepare('UPDATE task_runs SET status=?,stage=?,progress=?,output_preview=?,version_id=?,updated_at=? WHERE id=?').bind('succeeded',taskType==='draft'?'等待人工审校':'已保存',100,output.slice(0,3500),versionId,stamp,runId).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'model',`模型任务完成：${taskType}${taskType==='reply'?'\n'+output.slice(0,3500):''}`,stamp).run();await env.DB.prepare('UPDATE projects SET updated_at=? WHERE id=?').bind(stamp,projectId).run();return json({ok:true,output,taskType,runId,versionId});
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='gates'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],gateCode=parts[4],decision=String(body?.decision||''),note=String(body?.note||'').trim(),versionId=String(body?.versionId||'');if(!GATES.some(x=>x[0]===gateCode)||!['approve','reject'].includes(decision))return json({error:'闸门或决定无效'},400);const data=await detail(env.DB,projectId);if(!data)return json({error:'项目不存在'},404);const version=versionId?await env.DB.prepare('SELECT id,sha256 FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first():null;
    const gateIndex=GATES.findIndex(x=>x[0]===gateCode),currentGate=data.gates.find(x=>x.status==='current');if(currentGate&&currentGate.gate_code!==gateCode)return json({error:`当前只能处理${currentGate.gate_code} ${currentGate.title}`},409);if(decision==='approve'&&data.gates.find(x=>x.gate_code===gateCode)?.status==='passed')return json({error:'该闸门已经批准，不能重复提交'},409);if(decision==='approve'&&gateIndex>0){const prior=data.gates.slice(0,gateIndex).find(x=>x.status!=='passed');if(prior)return json({error:`必须先通过${prior.gate_code} ${prior.title}`},409)}
    if(decision==='approve'&&['G2','G3','G4','G5','G6'].includes(gateCode)&&!version)return json({error:'该阶段批准必须绑定正文版本'},400);if(decision==='approve'&&version&&version.id!==data.latestVersionId)return json({error:'只能批准当前最新正文版本'},409);
    if(decision==='approve'&&gateCode==='G0'&&!data.workflow.checks.find(x=>x.code==='G0')?.ready)return json({error:data.workflow.checks.find(x=>x.code==='G0')?.reason||'立项参数尚未齐全'},409);
    if(decision==='approve'&&gateCode==='G1'&&!data.workflow.checks.find(x=>x.code==='G1')?.ready)return json({error:data.workflow.checks.find(x=>x.code==='G1')?.reason||'项目资料尚未齐全'},409);
    if(decision==='approve'&&gateCode==='G2'&&!data.workflow.checks.find(x=>x.code==='G2')?.ready)return json({error:data.workflow.checks.find(x=>x.code==='G2')?.reason||'校准稿尚未完成结构审计'},409);
    if(decision==='approve'&&gateCode==='G3'&&!data.workflow.checks.find(x=>x.code==='G3')?.ready)return json({error:data.workflow.checks.find(x=>x.code==='G3')?.reason||'批次正文尚未覆盖提交范围'},409);
    if(decision==='approve'&&gateCode==='G4'){const ok=data.audits.some(x=>x.audit_type==='deep_ai'&&x.version_id===versionId&&x.status==='通过'&&Number(x.core_floor_pass)===1);if(!ok)return json({error:'G4需要当前版本AI内部深审达到门槛、核心底线通过且硬错误为0'},409);const threshold=Number(data.profile?.quality_threshold||90),qualityOk=data.qualityReviews?.some(x=>x.version_id===versionId&&Number(x.score)>=threshold);if(!qualityOk)return json({error:`G4还需要当前正文人工内容质量评分达到${threshold}分`},409)}
    if(decision==='approve'&&gateCode==='G5'&&Number(data.profile?.zhuque_required)!==0){const threshold=Number(data.profile?.zhuque_threshold||85),ok=data.detectors.some(x=>x.version_id===versionId&&x.status==='通过'&&Number(x.human_score)>=threshold);if(!ok)return json({error:`G5需要当前版本朱雀人工特征达到${threshold}%并保存真实报告`},409)}
    if(decision==='approve'&&gateCode==='G6'&&!data.workflow.checks.find(x=>x.code==='G6')?.ready)return json({error:data.workflow.checks.find(x=>x.code==='G6')?.reason||'G6需要当前正文通过内容终审和适用的朱雀门禁'},409);
    const id=`ap-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now(),status=decision==='approve'?'passed':'blocked',sha=version?.sha256||'';await env.DB.prepare('INSERT INTO approval_records(id,project_id,gate_code,decision,note,version_id,sha256,actor,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id,projectId,gateCode,decision,note,versionId||null,sha,'operator',stamp).run();await env.DB.prepare('UPDATE gates SET status=?,note=?,updated_at=? WHERE project_id=? AND gate_code=?').bind(status,note||status,stamp,projectId,gateCode).run();const index=GATES.findIndex(x=>x[0]===gateCode);if(decision==='approve'){if(index>=0&&index<GATES.length-1)await env.DB.prepare('UPDATE gates SET status=?,note=?,updated_at=? WHERE project_id=? AND gate_code=? AND status<>?').bind('current','等待处理',stamp,projectId,GATES[index+1][0],'passed').run();const next=GATES[Math.min(index+1,GATES.length-1)];await env.DB.prepare('UPDATE project_profiles SET current_stage=?,progress=?,status=?,updated_at=? WHERE project_id=?').bind(`${next[0]} ${next[1]}`,gateCode==='G6'?100:Math.round(((index+1)/GATES.length)*100),gateCode==='G6'?'已归档':'等待人工处理',stamp,projectId).run()}else await env.DB.prepare('UPDATE project_profiles SET current_stage=?,status=?,updated_at=? WHERE project_id=?').bind(`${gateCode} ${GATES[index]?.[1]||''}`,'已阻塞',stamp,projectId).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'approval',`${gateCode}${decision==='approve'?'批准':'驳回'}：${note||'无备注'}`,stamp).run();return json({approval:{id,gate_code:gateCode,decision,note,version_id:versionId||null,sha256:sha,created_at:stamp}},201);
  }
  if(parts.length===4&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='continuity'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],category=String(body?.category||'').trim(),subject=String(body?.subject||'').trim(),state=String(body?.state||'').trim(),notes=String(body?.notes||'').trim();if(!['character','prop','timeline','permission','location'].includes(category)||!subject)return json({error:'连续性类别或主体无效'},400);const first=String(body?.firstEpisode??'').trim()===''?null:Number(body.firstEpisode),last=String(body?.lastEpisode??'').trim()===''?null:Number(body.lastEpisode);if((first!==null&&!Number.isInteger(first))||(last!==null&&!Number.isInteger(last))||(first!==null&&last!==null&&last<first))return json({error:'连续性集数范围无效'},400);if(!await env.DB.prepare('SELECT id FROM projects WHERE id=?').bind(projectId).first())return json({error:'项目不存在'},404);const id=`c-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`,stamp=now();await env.DB.prepare('INSERT INTO continuity_entries(id,project_id,category,subject,state,first_episode,last_episode,source_version_id,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,category,subject,state,first,last,null,'active',notes,stamp,stamp).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'continuity',`新增连续性条目：${subject}`,stamp).run();return json({entry:{id,category,subject,state,first_episode:first,last_episode:last,source_version_id:null,status:'active',notes,created_at:stamp,updated_at:stamp}},201);
  }
  if(parts.length===5&&parts[0]==='api'&&parts[1]==='projects'&&parts[3]==='continuity'&&parts[4]==='extract'&&request.method==='POST'){
    let body;try{body=await request.json()}catch{return json({error:'JSON格式错误'},400)}const projectId=parts[2],versionId=String(body?.versionId||''),version=await env.DB.prepare('SELECT * FROM draft_versions WHERE id=? AND project_id=?').bind(versionId,projectId).first();if(!version)return json({error:'请选择当前项目的正文版本'},400);const analysis=analyzeScript(version.content),charEps=new Map(),locationEps=new Map();for(const episode of analysis.episodes){for(const scene of episode.scenes){for(const name of scene.characters){if(!charEps.has(name))charEps.set(name,new Set());charEps.get(name).add(episode.number)}const match=scene.heading.match(/^\d+\s*[-－—]\s*\d+\s+\S+\s+\S+\s+(.+)$/),location=match?.[1]||scene.heading;if(!locationEps.has(location))locationEps.set(location,new Set());locationEps.get(location).add(episode.number)}}await env.DB.prepare("DELETE FROM continuity_entries WHERE project_id=? AND source_version_id=? AND category IN ('character','location')").bind(projectId,versionId).run();const stamp=now();let count=0;for(const [category,mapping] of [['character',charEps],['location',locationEps]])for(const [subject,eps] of mapping){const values=[...eps],id=`c-${crypto.randomUUID().replaceAll('-','').slice(0,12)}`;await env.DB.prepare('INSERT INTO continuity_entries(id,project_id,category,subject,state,first_episode,last_episode,source_version_id,status,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,projectId,category,subject,`正文识别：出现于${values.length}集`,Math.min(...values),Math.max(...values),versionId,'auto','由场景标题与人物行自动提取，需人工补充状态变化',stamp,stamp).run();count++}await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(projectId,'continuity',`从${version.label}提取连续性账本：${count}条`,stamp).run();return json({ok:true,count,versionId},201);
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
  if(parts.length===3&&parts[0]==='api'&&parts[1]==='continuity'&&request.method==='DELETE'){
    const row=await env.DB.prepare('SELECT project_id,subject FROM continuity_entries WHERE id=?').bind(parts[2]).first();if(!row)return json({error:'连续性条目不存在'},404);await env.DB.prepare('DELETE FROM continuity_entries WHERE id=?').bind(parts[2]).run();await env.DB.prepare('INSERT INTO activity_logs(project_id,kind,message,created_at) VALUES(?,?,?,?)').bind(row.project_id,'continuity',`删除连续性条目：${row.subject}`,now()).run();return json({ok:true});
  }
  return json({error:'接口不存在'},404);
}

export default {async fetch(request,env){const url=new URL(request.url);if(url.pathname.startsWith('/api/')){try{return await api(request,env)}catch(error){return json({error:'服务内部错误',detail:String(error?.message||error)},500)}}return env.ASSETS.fetch(request)}};
