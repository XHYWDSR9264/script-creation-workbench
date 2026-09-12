const $ = id => document.getElementById(id);
const assetDefs = {
  synopsis:{title:'剧情梗概',icon:'✦',hint:'主线、人物目标与阶段性结果'},
  characters:{title:'人物小传',icon:'◎',hint:'身份、性格、动机、弱点与成长'},
  world:{title:'世界观设定',icon:'◇',hint:'时代、空间、规则、限制与代价'},
  beat_matrix:{title:'卡点矩阵',icon:'▤',hint:'每集任务、大事件、代价与钩子'}
};
let projects=[], currentDetail=null, editingAsset=null, viewingVersion=false, toastTimer;
const CONFIG_KEY='scriptWorkbench.llm.session';

const escapeHtml = value => String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function showToast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),2400)}
async function request(url,options={}){const r=await fetch(url,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const data=await r.json();if(!r.ok)throw new Error(data.error||'请求失败');return data}
async function loadHealth(){try{const h=await request('/api/health');$('connectionLabel').textContent=h.storage==='cloudflare-d1'?'云端工作区已连接':'本地工作区已连接'}catch{$('connectionLabel').textContent='工作区连接异常'}}
function currentProject(){return projects.find(p=>p.selected)}
function formatTime(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}
function getModelConfig(){try{return JSON.parse(sessionStorage.getItem(CONFIG_KEY)||'{}')}catch{return{}}}
function setModelConfig(value){sessionStorage.setItem(CONFIG_KEY,JSON.stringify(value));renderModelName()}
function renderModelName(){const c=getModelConfig();$('modelName').textContent=c.model||'未配置模型'}

function renderProjects(){
  $('projectList').innerHTML=projects.map((p,i)=>`<div class="project-item ${p.selected?'selected':''}" data-project="${i}">${escapeHtml(p.name)}<small>${escapeHtml(p.note)}</small></div>`).join('');
  $('projectList').querySelectorAll('.project-item').forEach(x=>x.addEventListener('click',()=>selectProject(Number(x.dataset.project))));
}
async function loadProjects(){
  try{const data=await request('/api/projects');projects=data.projects.map((p,i)=>({...p,selected:i===0}));renderProjects();if(projects.length)await selectProject(0,false)}catch(error){showToast('项目服务连接失败：'+error.message)}
}
async function selectProject(index,notify=true){
  projects.forEach((p,i)=>p.selected=i===index);renderProjects();const p=projects[index];
  try{const data=await request(`/api/projects/${encodeURIComponent(p.id)}`);currentDetail=data.detail;renderDetail();if(notify)showToast(`已切换到「${p.name}」`)}catch(error){showToast(error.message)}
}
function renderDetail(){
  const {project,profile,assets={},versions=[],gates=[],events=[],sources=[],audits=[],detectors=[]}=currentDetail;
  $('projectTitle').textContent=project.name;$('breadcrumbProject').textContent=project.name;$('projectRoute').textContent=project.route;
  $('projectMeta').innerHTML=`<span class="tag">${escapeHtml(profile?.region||'待设定')}</span><span class="tag">${escapeHtml(profile?.medium||'待设定')}</span><span class="tag">${escapeHtml(profile?.genre||'待设定')}</span><span class="muted">总集数 ${profile?.total_episodes||60} · 本次提交 ${profile?.submission_start||1}—${profile?.submission_end||10} 集 · ${escapeHtml(profile?.opening_template||'未设模板')}</span>`;
  $('phaseTitle').textContent=`${profile?.current_stage||'G0 立项与参数'} · ${profile?.status||'待立项'}`;const progress=Number(profile?.progress||10);$('phaseProgress').style.width=`${progress}%`;$('progressText').textContent=`${progress}%`;
  renderSources(sources);renderAssets(assets);renderVersions(versions);renderGates(gates);renderEvents(events);renderThread(events,project);renderQuality(audits,detectors);refreshModuleSelectors();
}
function renderQuality(audits,detectors){const a=audits[0],z=detectors[0];$('auditMetric').textContent=a?`${a.score}分 · ${a.status}`:'未审计';$('auditMetric').className=a?(a.status==='通过'?'green-text':'amber-text'):'muted';$('detectorMetric').textContent=z?`${z.human_score}% · ${z.status}`:'未检测';$('detectorMetric').className=z?(z.status==='通过'?'green-text':'amber-text'):'muted'}
function versionOptions(){const versions=currentDetail?.versions||[];return versions.length?versions.map(v=>`<option value="${escapeHtml(v.id)}">${escapeHtml(v.label)} · 第${v.range_start}—${v.range_end}集 · ${escapeHtml(v.sha256.slice(0,10))}</option>`).join(''):'<option value="">尚无正文版本</option>'}
function refreshModuleSelectors(){const html=versionOptions();['auditVersion','detectorVersion','deliveryVersion'].forEach(id=>{if($(id))$(id).innerHTML=html});renderDetectorReports()}
function renderDetectorReports(){if(!$('detectorReports'))return;const rows=currentDetail?.detectors||[];$('detectorReports').innerHTML=rows.length?rows.slice(0,5).map(x=>`<div class="report-row"><span><strong>人工 ${x.human_score}%</strong><small>${formatTime(x.created_at)} · ${escapeHtml(x.sha256.slice(0,10))}</small></span><span class="source-badge ${x.status==='通过'?'':'pending'}">${escapeHtml(x.status)}</span></div>`).join(''):'<div class="empty-state compact">当前项目尚无朱雀报告</div>'}
function formatBytes(value){const n=Number(value||0);if(n<1024)return`${n} B`;if(n<1048576)return`${(n/1024).toFixed(1)} KB`;return`${(n/1048576).toFixed(1)} MB`}
function renderSources(sources){
  $('sourceList').innerHTML=sources.length?sources.map(s=>`<div class="source-row"><span><strong>${escapeHtml(s.name)}</strong><small>${escapeHtml(s.mime)} · ${escapeHtml(s.sha256.slice(0,12))}</small></span><span>${formatBytes(s.byte_size)}</span><span>${formatTime(s.created_at)}</span><span class="source-badge ${s.extraction_status==='已提取'?'':'pending'}">${escapeHtml(s.extraction_status)}</span></div>`).join(''):'<div class="empty-state">尚无素材。TXT/MD导入后可直接进入后续模型上下文；DOCX/PDF将在解析服务接入后提取正文。</div>';
}
function fileToBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');reader.onerror=()=>reject(reader.error||new Error('读取文件失败'));reader.readAsDataURL(file)})}
async function uploadSources(files){const p=currentProject();if(!p||!files.length)return;let ok=0;for(const file of files){try{showToast(`正在导入 ${file.name}…`);const dataBase64=await fileToBase64(file);await request(`/api/projects/${encodeURIComponent(p.id)}/sources`,{method:'POST',body:JSON.stringify({name:file.name,mime:file.type||'application/octet-stream',dataBase64})});ok++}catch(e){showToast(`${file.name}：${e.message}`)}}await selectProject(projects.findIndex(x=>x.selected),false);if(ok)showToast(`已导入 ${ok} 个素材并完成哈希留档`)}
function renderAssets(assets){
  $('assetGrid').innerHTML=Object.entries(assetDefs).map(([type,d])=>{const a=assets[type]||{content:'',version:1};const text=a.content.trim()?a.content.trim().slice(0,56):d.hint;return `<div class="asset-card" data-asset="${type}"><span class="asset-icon">${d.icon}</span><div><strong>${d.title}</strong><p>${escapeHtml(text)}</p></div><span class="asset-status">${a.content.trim()?`v${a.version}`:'待填写'}</span></div>`}).join('');
  $('assetGrid').querySelectorAll('.asset-card').forEach(x=>x.addEventListener('click',()=>openAsset(x.dataset.asset)));
}
function renderVersions(versions){
  const header='<div class="version-row header"><span>版本</span><span>来源</span><span>范围</span><span>状态</span><span></span></div>';
  $('versionTable').innerHTML=header+(versions.length?versions.map(v=>`<div class="version-row"><span><b>${escapeHtml(v.label)}</b><small>${formatTime(v.created_at)} · <span class="hash">${escapeHtml(v.sha256.slice(0,10))}</span></small></span><span>${escapeHtml(v.source)}</span><span>第${v.range_start}—${v.range_end}集</span><span class="green-text">${escapeHtml(v.status)}</span><button class="text-button view-version" data-id="${escapeHtml(v.id)}">查看</button></div>`).join(''):'<div class="empty-state">尚无正文版本。点击“新建版本”保存第一份正文。</div>');
  $('versionTable').querySelectorAll('.view-version').forEach(x=>x.addEventListener('click',()=>viewVersion(x.dataset.id)));
}
function renderGates(gates){
  const current=gates.find(x=>x.status==='current');$('gateProgress').textContent=`${current?.gate_code||'G0'} / G6`;
  $('gateList').innerHTML=gates.map(g=>{const cls=g.status==='passed'?'done':g.status==='current'?'current':'';const mark=g.status==='passed'?'✓':g.gate_code.slice(1);return `<div class="gate ${cls}"><span>${mark}</span><div><strong>${escapeHtml(g.gate_code)} ${escapeHtml(g.title)}</strong><small>${escapeHtml(g.note||g.status)}</small></div></div>`}).join('');
}
function renderEvents(events){
  $('activityLog').innerHTML=events.length?events.slice(0,6).map((e,i)=>`<div class="log-line"><time>${formatTime(e.created_at).slice(-5)}</time><span class="log-dot ${i%3===0?'green':i%3===1?'blue':'amber'}"></span><p>${escapeHtml(e.message)}</p></div>`).join(''):'<div class="empty-state">还没有运行日志</div>';
}
function renderThread(events,project){
  const base=`<article class="thread-card system-card"><div class="card-top"><div class="actor"><span class="actor-icon system">◌</span><div><strong>剧本创作总控台</strong><span class="actor-role">项目工作区</span></div></div><time>当前</time></div><p>「${escapeHtml(project.name)}」已绑定独立资料、正文版本、SOP闸门和活动日志。生成、审校、检测与交付将分别留痕。</p><div class="card-tags"><span class="mini-tag blue-tag">${escapeHtml(project.route)}</span><span class="mini-tag">数据已持久化</span></div></article>`;
  const cards=events.slice(0,8).map(e=>`<article class="thread-card"><div class="card-top"><div class="actor"><span class="actor-icon ai">${e.kind==='prompt'?'你':'✓'}</span><div><strong>${e.kind==='prompt'?'人工任务':'系统记录'}</strong><span class="actor-role">${escapeHtml(e.kind)}</span></div></div><time>${formatTime(e.created_at)}</time></div><p>${escapeHtml(e.message)}</p></article>`).join('');$('threadFeed').innerHTML=base+cards;
}

function toggleModal(id,show){$(id).classList.toggle('hidden',!show)}
function switchTab(name){document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===name));['thread','sources','assets','versions'].forEach(x=>$(`${x}Panel`).classList.toggle('hidden',x!==name))}
function openAsset(type){editingAsset=type;const d=assetDefs[type],a=currentDetail.assets[type]||{content:''};$('assetModalTitle').textContent=`编辑${d.title}`;$('assetContent').value=a.content;toggleModal('assetModal',true);$('assetContent').focus()}
async function saveAsset(){const p=currentProject();try{await request(`/api/projects/${encodeURIComponent(p.id)}/assets/${editingAsset}`,{method:'PUT',body:JSON.stringify({content:$('assetContent').value})});toggleModal('assetModal',false);await selectProject(projects.findIndex(x=>x.selected),false);showToast('项目资料已保存并记录新版本')}catch(e){showToast(e.message)}}
function openVersion(){viewingVersion=false;$('versionLabel').value=`v0.${currentDetail.versions.length+1} 工作稿`;$('versionSource').value='人工编辑';$('versionStart').value=currentDetail.profile?.submission_start||1;$('versionEnd').value=Math.min(currentDetail.profile?.submission_end||10,3);$('versionContent').value='';$('saveVersionBtn').classList.remove('hidden');toggleModal('versionModal',true)}
async function viewVersion(id){try{const {version}=await request(`/api/versions/${encodeURIComponent(id)}/content`);viewingVersion=true;$('versionLabel').value=version.label;$('versionSource').value=version.source;$('versionStart').value=version.range_start;$('versionEnd').value=version.range_end;$('versionContent').value=version.content;$('saveVersionBtn').classList.add('hidden');toggleModal('versionModal',true)}catch(e){showToast(e.message)}}
async function saveVersion(){const p=currentProject();const body={label:$('versionLabel').value.trim(),source:$('versionSource').value,rangeStart:Number($('versionStart').value),rangeEnd:Number($('versionEnd').value),content:$('versionContent').value};try{await request(`/api/projects/${encodeURIComponent(p.id)}/versions`,{method:'POST',body:JSON.stringify(body)});toggleModal('versionModal',false);await selectProject(projects.findIndex(x=>x.selected),false);showToast('正文已保存为新版本，旧版本未被覆盖')}catch(e){showToast(e.message)}}

function openSettings(){const c=getModelConfig();$('llmBaseUrl').value=c.baseUrl||'';$('llmModel').value=c.model||'';$('llmWire').value=c.wireApi||'responses';$('llmReasoning').value=c.reasoning||'high';$('llmKey').value=c.apiKey||'';$('modelTestResult').textContent='尚未测试接口';toggleModal('settingsModal',true)}
function readSettings(){return{baseUrl:$('llmBaseUrl').value.trim(),apiKey:$('llmKey').value.trim(),model:$('llmModel').value.trim(),wireApi:$('llmWire').value,reasoning:$('llmReasoning').value}}
async function testModel(){const btn=$('testModelBtn');btn.disabled=true;$('modelTestResult').textContent='正在连接接口…';try{const data=await request('/api/model/test',{method:'POST',body:JSON.stringify(readSettings())});$('modelTestResult').textContent=`测试成功：${data.output}`;}catch(e){$('modelTestResult').textContent=`测试失败：${e.message}`}finally{btn.disabled=false}}
async function runModelTask(){const instruction=$('promptInput').value.trim(),taskType=$('taskType').value,p=currentProject(),config=getModelConfig();if(!instruction){showToast('请先输入任务内容');return}if(!config.apiKey){openSettings();showToast('请先配置并测试模型接口');return}const btn=$('sendBtn');btn.disabled=true;btn.innerHTML='运行中…';try{const profile=currentDetail.profile||{};const data=await request(`/api/projects/${encodeURIComponent(p.id)}/model/run`,{method:'POST',body:JSON.stringify({instruction,taskType,config,rangeStart:profile.submission_start||1,rangeEnd:profile.submission_end||10,label:`模型稿 ${new Date().toLocaleString('zh-CN')}`})});$('promptInput').value='';await selectProject(projects.findIndex(x=>x.selected),false);if(taskType==='reply')showToast(`模型已回答：${data.output.slice(0,80)}`);else{showToast('模型任务完成并已保存新版本');switchTab(taskType==='draft'?'versions':'assets')}}catch(e){showToast(e.message)}finally{btn.disabled=false;btn.innerHTML='运行 <span>↗</span>'}}
async function runAudit(){const versionId=$('auditVersion').value;if(!versionId){showToast('请先保存正文版本');return}const btn=$('runAuditBtn');btn.disabled=true;$('auditResult').textContent='正在检查正文结构…';try{const {report}=await request(`/api/projects/${encodeURIComponent(currentProject().id)}/audits`,{method:'POST',body:JSON.stringify({versionId})});const list=report.findings.length?report.findings.map(x=>`<li class="${x.level}">${escapeHtml(x.message)}</li>`).join(''):'<li class="pass">未发现结构问题</li>';$('auditResult').innerHTML=`<strong>${report.score}分 · ${escapeHtml(report.status)}</strong><p>${escapeHtml(report.summary)}</p><ul>${list}</ul>`;await selectProject(projects.findIndex(x=>x.selected),false)}catch(e){$('auditResult').textContent=e.message}finally{btn.disabled=false}}
async function saveDetector(){const versionId=$('detectorVersion').value,file=$('detectorFile').files[0];if(!versionId||!file){showToast('请选择正文版本并上传朱雀报告截图');return}const btn=$('saveDetectorBtn');btn.disabled=true;try{const dataBase64=await fileToBase64(file);await request(`/api/projects/${encodeURIComponent(currentProject().id)}/detectors`,{method:'POST',body:JSON.stringify({versionId,humanScore:Number($('humanScore').value),suspectedScore:Number($('suspectedScore').value||0),aiScore:Number($('aiScore').value||0),reportName:file.name,mime:file.type,dataBase64})});await selectProject(projects.findIndex(x=>x.selected),false);showToast('真实检测指标、截图和正文哈希已绑定保存')}catch(e){showToast(e.message)}finally{btn.disabled=false}}
function downloadExport(format){const versionId=$('deliveryVersion').value;if(!versionId){showToast('请先选择正文版本');return}const url=`/api/projects/${encodeURIComponent(currentProject().id)}/export?format=${format}&versionId=${encodeURIComponent(versionId)}`;const a=document.createElement('a');a.href=url;a.click();showToast(format==='json'?'正在下载项目快照':'正在下载TXT合并稿')}

$('newProjectBtn').addEventListener('click',()=>toggleModal('projectModal',true));$('closeModal').addEventListener('click',()=>toggleModal('projectModal',false));$('cancelModal').addEventListener('click',()=>toggleModal('projectModal',false));
$('createProject').addEventListener('click',async()=>{const body={name:$('newProjectName').value.trim(),route:$('newProjectRoute').value,region:$('newProjectRegion').value,medium:$('newProjectMedium').value,totalEpisodes:Number($('newTotalEpisodes').value),submissionStart:1,submissionEnd:Number($('newSubmissionEnd').value),openingTemplate:$('newOpeningTemplate').value,genre:$('newGenre').value.trim()||'待设定'};try{const {project}=await request('/api/projects',{method:'POST',body:JSON.stringify(body)});projects.forEach(x=>x.selected=false);projects.unshift({...project,selected:true});renderProjects();toggleModal('projectModal',false);$('newProjectName').value='';await selectProject(0,false);showToast('项目已创建并建立独立工作空间')}catch(e){showToast(e.message)}});
$('closeAssetModal').addEventListener('click',()=>toggleModal('assetModal',false));$('cancelAssetModal').addEventListener('click',()=>toggleModal('assetModal',false));$('saveAssetBtn').addEventListener('click',saveAsset);
$('newVersionBtn').addEventListener('click',openVersion);$('closeVersionModal').addEventListener('click',()=>toggleModal('versionModal',false));$('cancelVersionModal').addEventListener('click',()=>toggleModal('versionModal',false));$('saveVersionBtn').addEventListener('click',saveVersion);
['projectModal','assetModal','versionModal'].forEach(id=>$(id).addEventListener('click',e=>{if(e.target.id===id)toggleModal(id,false)}));
document.querySelectorAll('.tab').forEach(tab=>tab.addEventListener('click',()=>switchTab(tab.dataset.tab)));
$('uploadSourceBtn').addEventListener('click',()=>$('sourceFileInput').click());$('sourceFileInput').addEventListener('change',async e=>{await uploadSources([...e.target.files]);e.target.value=''});
document.querySelectorAll('.nav-item,.settings-link').forEach(item=>item.addEventListener('click',()=>{document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));if(item.classList.contains('nav-item'))item.classList.add('active');const view=item.dataset.view;if(view==='overview'||view==='tasks'){switchTab('thread');if(view==='tasks')$('promptInput').focus()}else if(view==='drafts')switchTab('versions');else if(view==='audit')toggleModal('auditModal',true);else if(view==='detector')toggleModal('detectorModal',true);else if(view==='delivery')toggleModal('deliveryModal',true);else if(view==='settings')openSettings()}));
$('sendBtn').addEventListener('click',runModelTask);
$('promptInput').addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='Enter')$('sendBtn').click()});
$('runTaskBtn').addEventListener('click',()=>{$('promptInput').focus();showToast('请在下方选择任务类型并输入指令')});
$('composerAttachment').addEventListener('click',()=>{$('sourceFileInput').click();switchTab('sources')});
$('openSettingsBtn').addEventListener('click',openSettings);$('closeSettingsModal').addEventListener('click',()=>toggleModal('settingsModal',false));$('saveSettingsBtn').addEventListener('click',()=>{const c=readSettings();setModelConfig(c);toggleModal('settingsModal',false);showToast('模型设置仅保存于当前浏览器会话')});$('testModelBtn').addEventListener('click',testModel);
$('closeAuditModal').addEventListener('click',()=>toggleModal('auditModal',false));$('runAuditBtn').addEventListener('click',runAudit);$('qualityDetailBtn').addEventListener('click',()=>toggleModal('auditModal',true));
$('closeDetectorModal').addEventListener('click',()=>toggleModal('detectorModal',false));$('saveDetectorBtn').addEventListener('click',saveDetector);
$('closeDeliveryModal').addEventListener('click',()=>toggleModal('deliveryModal',false));$('downloadTxtBtn').addEventListener('click',()=>downloadExport('txt'));$('downloadJsonBtn').addEventListener('click',()=>downloadExport('json'));
$('reviewBtn')?.addEventListener('click',()=>showToast('请在正文版本中打开校准稿'));$('nextActionBtn').addEventListener('click',()=>showToast('请先完善项目资料并保存第一份正文版本'));
['settingsModal','auditModal','detectorModal','deliveryModal'].forEach(id=>$(id).addEventListener('click',e=>{if(e.target.id===id)toggleModal(id,false)}));renderModelName();loadHealth();loadProjects();
