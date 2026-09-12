let projects = [
  {id:'p-退婚药', name:'退婚当天，我押十箱救命药闯雪关', route:'定制卡点扩写', note:'第1—10集 · 待人工确认', selected:true},
  {id:'p-绑手车祸', name:'绑手砸车造车祸，转头我包下整条货运线', route:'定制卡点扩写', note:'一卡规划 · 已保存'},
  {id:'p-倒计时', name:'倒计时爱人', route:'海外原创', note:'第1—10集 · 待朱雀'}
];
const fallbackProjects = [
  {name:'退婚当天，我押十箱救命药闯雪关', route:'定制卡点扩写', note:'第1—10集 · 待人工确认', selected:true},
  {name:'绑手砸车造车祸，转头我包下整条货运线', route:'定制卡点扩写', note:'一卡规划 · 已保存'},
  {name:'倒计时爱人', route:'海外原创', note:'第1—10集 · 待朱雀'}
];

const $ = (id) => document.getElementById(id);
const projectList = $('projectList');
const toast = $('toast');
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2400);
}

function renderProjects() {
  projectList.innerHTML = projects.map((p, i) => `<div class="project-item ${p.selected?'selected':''}" data-project="${i}">${p.name}<small>${p.note}</small></div>`).join('');
  projectList.querySelectorAll('.project-item').forEach(el => el.addEventListener('click', () => selectProject(Number(el.dataset.project))));
}

function selectProject(index, notify = true) {
  projects.forEach((p, i) => p.selected = i === index);
  const p = projects[index];
  $('projectTitle').textContent = p.name;
  $('breadcrumbProject').textContent = p.name;
  $('projectRoute').textContent = p.route;
  renderProjects();
  if (notify) showToast(`已切换到「${p.name}」`);
}

function openModal() { $('projectModal').classList.remove('hidden'); $('newProjectName').focus(); }
function closeModal() { $('projectModal').classList.add('hidden'); }

$('newProjectBtn').addEventListener('click', openModal);
$('closeModal').addEventListener('click', closeModal);
$('cancelModal').addEventListener('click', closeModal);
$('projectModal').addEventListener('click', (e) => { if(e.target.id === 'projectModal') closeModal(); });
$('createProject').addEventListener('click', () => {
  const name = $('newProjectName').value.trim();
  if (!name) { showToast('请先填写项目名称'); return; }
  const route = $('newProjectRoute').value;
  fetch('/api/projects', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, route})})
    .then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(new Error(e.error || '创建失败'))))
    .then(({project}) => { projects.forEach(p => p.selected = false); projects.unshift({...project, selected:true}); renderProjects(); selectProject(0); closeModal(); $('newProjectName').value = ''; })
    .catch(() => { projects.forEach(p => p.selected = false); projects.unshift({id:'local-'+Date.now(), name, route, note:'新项目 · 待立项', selected:true}); renderProjects(); selectProject(0); closeModal(); $('newProjectName').value = ''; showToast('服务未连接，已暂存到本页'); });
});

document.querySelectorAll('.nav-item,.settings-link').forEach(item => item.addEventListener('click', () => {
  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  if (item.classList.contains('nav-item')) item.classList.add('active');
  showToast(item.textContent.trim() + '模块已就绪');
}));

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  tab.classList.add('active');
  ['thread','assets','versions'].forEach(name => $(`${name}Panel`).classList.toggle('hidden', tab.dataset.tab !== name));
}));

function runTask() {
  const button = $('runTaskBtn');
  button.disabled = true; button.textContent = '运行中…';
  $('phaseTitle').textContent = '正在检查第1—3集 · 建立问题清单';
  $('phaseProgress').style.width = '82%'; $('progressText').textContent = '82%';
  setTimeout(() => {
    button.disabled = false; button.textContent = '▶ 继续任务';
    $('phaseTitle').textContent = '第1—3集校准 · 待人工确认';
    const card = document.createElement('article'); card.className = 'thread-card system-card';
    card.innerHTML = '<div class="card-top"><div class="actor"><span class="actor-icon system">◌</span><div><strong>结构与连续性审计</strong><span class="actor-role">刚刚完成</span></div></div><time>刚刚</time></div><p>已完成第1—3集的结构检查，未发现旧标题、异常集数或报告占位词。发现2处需要人工确认的因果节点，已加入问题清单。</p><div class="card-tags"><span class="mini-tag green-tag">结构通过</span><span class="mini-tag blue-tag">2处待确认</span></div>';
    $('threadFeed').prepend(card); const current = projects.find(p => p.selected); if(current?.id) fetch(`/api/projects/${encodeURIComponent(current.id)}/events`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:'audit', message:'完成第1—3集结构与连续性检查，发现2处待人工确认'})}).catch(()=>{}); showToast('任务完成：已新增2项人工确认');
  }, 1250);
}
$('runTaskBtn').addEventListener('click', runTask);
$('reviewBtn').addEventListener('click', () => showToast('已定位到第1—3集校准稿'));
$('nextActionBtn').addEventListener('click', () => showToast('请先打开任务线程中的校准稿'));

$('sendBtn').addEventListener('click', () => {
  const input = $('promptInput'); const value = input.value.trim();
  if (!value) { showToast('请先输入任务内容'); input.focus(); return; }
  const card = document.createElement('article'); card.className = 'thread-card';
  card.innerHTML = `<div class="card-top"><div class="actor"><span class="actor-icon review">G</span><div><strong>你</strong><span class="actor-role">新任务</span></div></div><time>刚刚</time></div><p>${value.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</p><div class="card-tags"><span class="mini-tag blue-tag">排队中</span></div>`;
  $('threadFeed').prepend(card); const current = projects.find(p => p.selected); if(current?.id) fetch(`/api/projects/${encodeURIComponent(current.id)}/events`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({kind:'prompt', message:value})}).catch(()=>{}); input.value = ''; showToast('任务已加入队列');
});
$('promptInput').addEventListener('keydown', e => { if(e.ctrlKey && e.key === 'Enter') $('sendBtn').click(); });

async function loadProjects() {
  try {
    const response = await fetch('/api/projects');
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    if (Array.isArray(data.projects) && data.projects.length) projects = data.projects.map((p, i) => ({...p, selected:i === 0}));
  } catch (_) {
    projects = fallbackProjects.map((p, i) => ({...p, id:`fallback-${i}`, selected:i === 0}));
  }
  renderProjects(); selectProject(0, false);
}
loadProjects();
