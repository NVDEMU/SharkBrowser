const $ = id => document.getElementById(id);
const viewport = $('viewport'), tabsBar = $('tabs');
const HOME = 'shark://home';
let tabs = [], activeId = null, nextId = 1, historyItems = [], bookmarks = [];
let blockState = { total: 0, ads: 0, trackers: 0, bySite: {}, recent: [], enabled: true, allowlist: [] };
const query = new URLSearchParams(location.search);
const isPrivate = query.has('private');
const browserPartition = query.get('partition') || 'persist:shark';

function normalizeInput(input) {
  const value = input.trim();
  if (!value) return HOME;
  if (/^(shark|https?|file):\/\//i.test(value)) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(value) || /^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(value)) return 'https://' + value;
  return 'https://www.google.com/search?q=' + encodeURIComponent(value);
}
function activeTab() { return tabs.find(t => t.id === activeId); }
function makeTab(url = HOME, activate = true) {
  const tab = { id: nextId++, title: 'New Tab', url, view: null, back: false, forward: false, loading: false };
  tabs.push(tab);
  const button = document.createElement('button'); button.className = 'tab'; button.dataset.id = tab.id;
  button.innerHTML = '<span class="tab-title">New Tab</span><span class="tab-close" title="Close tab">×</span>';
  button.addEventListener('click', e => { if (e.target.classList.contains('tab-close')) closeTab(tab.id); else activateTab(tab.id); });
  tab.button = button; tabsBar.append(button);
  if (url !== HOME) createView(tab, url);
  if (activate) activateTab(tab.id);
  renderTabs();
  return tab;
}
function createView(tab, url) {
  if (tab.view) { try { tab.view.remove(); } catch {} }
  const view = document.createElement('webview');
  view.className = 'webview'; view.setAttribute('partition', browserPartition); view.setAttribute('allowpopups', ''); view.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes');
  view.src = url; view.style.display = 'none';
  view.addEventListener('page-title-updated', e => { tab.title = e.title || 'New Tab'; renderTabs(); });
  view.addEventListener('did-start-loading', () => { tab.loading = true; if (activeId === tab.id) $('reload').textContent = '×'; });
  view.addEventListener('did-stop-loading', () => { tab.loading = false; if (activeId === tab.id) $('reload').textContent = '↻'; syncNavigation(tab); });
  view.addEventListener('did-navigate', e => { tab.url = e.url; if (activeId === tab.id) updateAddress(tab); addHistory(e.url, tab.title); syncNavigation(tab); });
  view.addEventListener('did-navigate-in-page', e => { tab.url = e.url; if (activeId === tab.id) updateAddress(tab); });
  view.addEventListener('page-favicon-updated', () => renderTabs());
  view.addEventListener('new-window', e => { makeTab(e.url); });
  view.addEventListener('will-navigate', e => { if (!/^https?:|^file:|^about:blank/.test(e.url)) { e.preventDefault(); window.shark.openExternal(e.url); } });
  view.addEventListener('did-fail-load', e => {
    if (e.errorCode === -3 || e.validatedURL === 'about:blank') return;
    if (activeId === tab.id) showToast('Could not load this page. Check the address or your connection.');
  });
  viewport.append(view); tab.view = view;
  if (activeId === tab.id) { $('welcome').classList.add('hidden'); view.style.display = 'flex'; }
}
function activateTab(id) {
  activeId = id;
  tabs.forEach(t => { if (t.view) t.view.style.display = t.id === id ? 'flex' : 'none'; });
  const tab = activeTab();
  if (tab && tab.url === HOME && !tab.view) showHome(); else if (tab) { $('welcome').classList.add('hidden'); updateAddress(tab); }
  renderTabs(); syncNavigation(tab);
}
function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id); if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  try { tab.view?.remove(); tab.button.remove(); } catch {}
  if (!tabs.length) makeTab();
  else if (activeId === id) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
  renderTabs();
}
function renderTabs() {
  tabs.forEach(t => { t.button.classList.toggle('active', t.id === activeId); t.button.querySelector('.tab-title').textContent = t.title || 'New Tab'; t.button.title = t.url; });
}
function showHome() {
  const tab = activeTab(); if (!tab) return;
  $('welcome').classList.remove('hidden');
  [...viewport.querySelectorAll('webview')].forEach(v => v.style.display = 'none');
  $('address').value = '';
  $('welcome-protection').textContent = blockState.enabled ? 'on' : 'off';
}
function navigate(value) {
  const tab = activeTab(); if (!tab) return;
  const url = normalizeInput(value);
  tab.url = url;
  if (url === HOME || url === 'about:blank') { if (tab.view) { tab.view.remove(); tab.view = null; } tab.title = 'New Tab'; showHome(); renderTabs(); return; }
  $('welcome').classList.add('hidden');
  if (!tab.view) createView(tab, url); else tab.view.loadURL(url).catch(() => {});
  updateAddress(tab); renderTabs();
}
function updateAddress(tab) {
  if (!tab) return;
  $('address').value = tab.url === HOME ? '' : tab.url;
  $('secure-icon').textContent = tab.url.startsWith('https:') ? '◈' : 'ⓘ';
  $('secure-icon').style.color = tab.url.startsWith('https:') ? 'var(--teal)' : '#e8bd75';
}
function syncNavigation(tab) {
  $('back').disabled = !tab?.view?.canGoBack(); $('forward').disabled = !tab?.view?.canGoForward();
  $('back').style.opacity = $('back').disabled ? '.4' : '1'; $('forward').style.opacity = $('forward').disabled ? '.4' : '1';
}
function addHistory(url, title) {
  if (isPrivate || !/^https?:/.test(url)) return;
  historyItems.unshift({ url, title: title || url, time: Date.now() }); historyItems = historyItems.slice(0, 500);
}
function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.remove('hidden');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2600);
}
function openPanel(title, content) { $('panel-title').textContent = title; $('panel-content').innerHTML = content; $('panel').classList.remove('hidden'); }
function closePanel() { $('panel').classList.add('hidden'); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function protectionPanel() {
  const rows = blockState.recent.slice(0, 12).map(item => '<div class="recent-item"><span class="tag '+(item.category==='ad'?'ad':'')+'">'+escapeHtml(item.category)+'</span><strong>'+escapeHtml(item.domain)+'</strong><small>On '+escapeHtml(item.site)+' · '+new Date(item.time).toLocaleTimeString()+'</small></div>').join('');
  openPanel('Privacy protection',
    '<div class="stat-grid"><div class="stat"><strong>'+blockState.total.toLocaleString()+'</strong><span>Total blocked</span></div><div class="stat"><strong>'+blockState.ads.toLocaleString()+'</strong><span>Ads blocked</span></div><div class="stat"><strong>'+blockState.trackers.toLocaleString()+'</strong><span>Trackers blocked</span></div></div>'+
    '<div class="protection-row"><div><strong>Ad & tracker blocking</strong><div class="empty">Network request protection</div></div><button id="toggle-blocking" class="switch '+(blockState.enabled?'on':'')+'" aria-label="Toggle blocking"></button></div>'+
    '<p class="section-label">Exclude a website</p><div class="site-input"><input id="allow-host" placeholder="example.com"><button id="allow-submit">Add</button></div>'+
    '<div class="empty">Exceptions: '+(blockState.allowlist.map(escapeHtml).join(', ')||'None')+'</div>'+
    '<p class="section-label">Recent blocked requests</p>'+(rows||'<div class="empty">No blocked requests yet. Browse a few sites to see activity.</div>')+
    '<div class="panel-actions"><button id="clear-stats" class="secondary">Reset statistics</button></div>');
  $('toggle-blocking').onclick = async () => { blockState.enabled = await window.shark.setBlocking(!blockState.enabled); protectionPanel(); $('welcome-protection').textContent = blockState.enabled?'on':'off'; };
  $('allow-submit').onclick = async () => { const host = $('allow-host').value.trim(); if (host) { blockState.allowlist = await window.shark.allowSite(host); protectionPanel(); } };
  $('clear-stats').onclick = async () => { blockState = {...blockState, ...(await window.shark.clearStats())}; protectionPanel(); };
}
function showHistory() {
  openPanel('Browsing history', '<div class="site-input"><input id="history-filter" placeholder="Filter history"><button id="clear-history" class="secondary">Clear</button></div><div id="history-list"></div>');
  const draw = q => { $('history-list').innerHTML = historyItems.filter(x => (x.url+' '+x.title).toLowerCase().includes(q.toLowerCase())).slice(0,100).map(x=>'<div class="history-item"><button class="panel-link" data-go="'+escapeHtml(x.url)+'">'+escapeHtml(x.title||x.url)+'</button><small>'+escapeHtml(x.url)+' · '+new Date(x.time).toLocaleString()+'</small></div>').join('') || '<div class="empty">No history yet in this session.</div>'; $('history-list').querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{closePanel();navigate(b.dataset.go);}); };
  draw(''); $('history-filter').oninput=e=>draw(e.target.value); $('clear-history').onclick=()=>{historyItems=[];draw('');};
}
function showBookmarks() {
  openPanel('Bookmarks', '<div class="site-input"><input id="bookmark-title" placeholder="Bookmark title"><button id="save-bookmark">Save current</button></div><div id="bookmark-list"></div>');
  const draw=()=>{ $('bookmark-list').innerHTML=bookmarks.map((b,i)=>'<div class="bookmark-item"><button class="panel-link" data-index="'+i+'">'+escapeHtml(b.title)+'</button><small>'+escapeHtml(b.url)+'</small></div>').join('')||'<div class="empty">No bookmarks saved yet.</div>'; $('bookmark-list').querySelectorAll('[data-index]').forEach(el=>el.onclick=()=>{const b=bookmarks[+el.dataset.index];closePanel();navigate(b.url);}); };
  $('save-bookmark').onclick=()=>{const t=activeTab();if(t&&/^https?:/.test(t.url)){bookmarks.push({title:$('bookmark-title').value||t.title,url:t.url});draw();showToast('Bookmark added');}else showToast('Open a website first');}; draw();
}
function showDownloads() {
  openPanel('Downloads', '<div class="empty">Downloads are handled by Chromium. Choose a download link on a website to start.</div><p class="empty">For this initial build, download history is not yet persisted in the Shark panel.</p>');
}
function showMenu() {
  openPanel('Shark menu', '<div class="menu-grid"><button id="menu-history">◷ &nbsp; History</button><button id="menu-bookmarks">☆ &nbsp; Bookmarks</button><button id="menu-downloads">↓ &nbsp; Downloads</button><button id="menu-privacy">🛡 &nbsp; Privacy stats</button><button id="menu-private">◐ &nbsp; New private window</button><button id="menu-home">⌂ &nbsp; Home</button></div><p class="empty">Shortcuts: Ctrl+T new tab · Ctrl+W close tab · Ctrl+L address bar · Ctrl+R reload</p>');
  $('menu-history').onclick=showHistory; $('menu-bookmarks').onclick=showBookmarks; $('menu-downloads').onclick=showDownloads; $('menu-privacy').onclick=protectionPanel;
  $('menu-private').onclick=()=>window.shark.newPrivateWindow(); $('menu-home').onclick=()=>{closePanel();navigate(HOME);};
}

$('address-form').addEventListener('submit', e => { e.preventDefault(); navigate($('address').value); });
$('search-form').addEventListener('submit', e => { e.preventDefault(); navigate($('welcome-search').value); });
$('new-tab').onclick=()=>makeTab(); $('private-window').onclick=()=>window.shark.newPrivateWindow();
$('back').onclick=()=>activeTab()?.view?.goBack(); $('forward').onclick=()=>activeTab()?.view?.goForward();
$('reload').onclick=()=>{const t=activeTab();if(t?.view)t.view.reload();else navigate(HOME);};
$('home').onclick=()=>navigate(HOME); $('bookmark').onclick=showBookmarks; $('downloads').onclick=showDownloads; $('history').onclick=showHistory; $('privacy').onclick=protectionPanel; $('menu').onclick=showMenu; $('close-panel').onclick=closePanel;
document.querySelectorAll('[data-url]').forEach(b=>b.onclick=()=>navigate(b.dataset.url));
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase()==='t') { e.preventDefault(); makeTab(); }
  if (mod && e.key.toLowerCase()==='w') { e.preventDefault(); closeTab(activeId); }
  if (mod && e.key.toLowerCase()==='l') { e.preventDefault(); $('address').focus(); $('address').select(); }
  if (mod && e.key.toLowerCase()==='r') { e.preventDefault(); $('reload').click(); }
  if (mod && e.key.toLowerCase()==='h') { e.preventDefault(); showHistory(); }
  if (e.altKey && e.key==='ArrowLeft') $('back').click();
  if (e.altKey && e.key==='ArrowRight') $('forward').click();
  if (e.key==='Escape') closePanel();
});
window.shark.onStats(data => { blockState = data; $('blocked-badge').textContent = data.total > 999 ? '999+' : data.total; $('welcome-protection').textContent = data.enabled?'on':'off'; if (!$('panel').classList.contains('hidden') && $('panel-title').textContent==='Privacy protection') protectionPanel(); });
window.shark.getState().then(data=>{blockState=data;$('blocked-badge').textContent=data.total>999?'999+':data.total;$('welcome-protection').textContent=data.enabled?'on':'off';});
if (isPrivate) document.title='Shark Browser — Private';
makeTab();
