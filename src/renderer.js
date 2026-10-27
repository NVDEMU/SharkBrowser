const $ = id => document.getElementById(id);
const viewport = $('viewport'), tabsBar = $('tabs');
const HOME = 'shark://home';
const query = new URLSearchParams(location.search);
const isPrivate = query.has('private');
const browserPartition = query.get('partition') || 'persist:shark';
const defaultSettings = { searchEngine: 'duckduckgo', homePage: HOME, restoreSession: true, blockAds: true };
let tabs = [], activeId = null, nextId = 1, closedTabs = [];
let historyItems = [], bookmarks = [], downloads = [];
let settings = { ...defaultSettings };
let blockState = { total: 0, ads: 0, trackers: 0, bySite: {}, recent: [], enabled: true, allowlist: [], blockerReady: false };

function searchUrl(value) {
  const providers = {
    duckduckgo: 'https://duckduckgo.com/?q=',
    google: 'https://www.google.com/search?q=',
    bing: 'https://www.bing.com/search?q=',
    brave: 'https://search.brave.com/search?q='
  };
  return (providers[settings.searchEngine] || providers.duckduckgo) + encodeURIComponent(value);
}
function normalizeInput(input) {
  const value = String(input || '').trim();
  if (!value) return settings.homePage || HOME;
  if (/^(shark|https?|file|about):\/\//i.test(value) || value === HOME) return value;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#]|$)/i.test(value) || /^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(value)) return 'https://' + value;
  return searchUrl(value);
}
function isWebUrl(value) { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }
function activeTab() { return tabs.find(t => t.id === activeId); }
function pageUrl() { return activeTab()?.url || ''; }
function saveSession() {
  if (isPrivate) return;
  window.shark.saveSession(tabs.map(t => t.url).filter(url => /^https?:\/\//i.test(url))).catch?.(() => {});
}
function persistBookmarks() { if (!isPrivate) window.shark.saveBookmarks(bookmarks); else window.shark.saveBookmarks(bookmarks); }
function persistHistory() { if (!isPrivate) window.shark.saveHistory(historyItems); }
function makeTab(url = settings.homePage || HOME, activate = true) {
  const tab = { id: nextId++, title: url === HOME ? 'New Tab' : 'Loading…', url, view: null, loading: false, zoomLevel: 0 };
  tabs.push(tab);
  const button = document.createElement('button'); button.className = 'tab'; button.dataset.id = tab.id; button.draggable = true;
  button.innerHTML = '<span class="tab-title">New Tab</span><span class="tab-close" title="Close tab" aria-label="Close tab">×</span>';
  button.addEventListener('click', e => {
    if (e.target.classList.contains('tab-close')) closeTab(tab.id);
    else activateTab(tab.id);
  });
  button.addEventListener('contextmenu', e => { e.preventDefault(); showTabMenu(tab.id); });
  button.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(tab.id)); e.dataTransfer.effectAllowed = 'move'; });
  button.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
  button.addEventListener('drop', e => {
    e.preventDefault();
    const fromId = Number(e.dataTransfer.getData('text/plain'));
    if (fromId === tab.id) return;
    const from = tabs.findIndex(t => t.id === fromId), to = tabs.findIndex(t => t.id === tab.id);
    if (from < 0 || to < 0) return;
    const [moved] = tabs.splice(from, 1); tabs.splice(to, 0, moved);
    renderTabs(); saveSession();
  });
  tab.button = button; tabsBar.append(button);
  if (url !== HOME && url !== 'about:blank') createView(tab, url);
  if (activate) activateTab(tab.id);
  renderTabs(); saveSession();
  return tab;
}
function createView(tab, url) {
  if (tab.view) { try { tab.view.remove(); } catch {} }
  const view = document.createElement('webview');
  view.className = 'webview';
  view.setAttribute('partition', browserPartition);
  view.setAttribute('allowpopups', '');
  view.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes');
  view.src = url;
  view.style.display = 'none';
  view.addEventListener('page-title-updated', e => {
    tab.title = e.title || tab.url || 'New Tab';
    document.title = (tab.title === 'New Tab' ? 'Shark Browser' : tab.title + ' — Shark Browser');
    const recent = historyItems.find(x => x.url === tab.url);
    if (recent && !isPrivate) { recent.title = tab.title; persistHistory(); }
    renderTabs();
  });
  view.addEventListener('page-favicon-updated', renderTabs);
  view.addEventListener('did-start-loading', () => {
    tab.loading = true;
    if (activeId === tab.id) $('reload').textContent = '×';
  });
  view.addEventListener('did-stop-loading', () => {
    tab.loading = false;
    if (activeId === tab.id) $('reload').textContent = '↻';
    syncNavigation(tab);
  });
  view.addEventListener('did-navigate', e => {
    tab.url = e.url;
    if (activeId === tab.id) updateAddress(tab);
    addHistory(e.url, tab.title);
    saveSession();
    syncNavigation(tab);
    renderTabs();
  });
  view.addEventListener('did-navigate-in-page', e => {
    tab.url = e.url;
    if (activeId === tab.id) updateAddress(tab);
  });
  view.addEventListener('found-in-page', e => {
    if (activeId !== tab.id) return;
    const result = e.result || {};
    $('find-count').textContent = result.matches ? (result.activeMatchOrdinal + ' of ' + result.matches) : 'No matches';
  });
  view.addEventListener('new-window', e => { if (isWebUrl(e.url)) makeTab(e.url); });
  view.addEventListener('will-navigate', e => {
    if (/^(https?:|file:|about:blank)/i.test(e.url)) return;
    e.preventDefault();
    if (/^mailto:/i.test(e.url)) window.shark.openExternal(e.url);
    else showToast('This link type is not supported for direct navigation.');
  });
  view.addEventListener('did-fail-load', e => {
    if (!e.isMainFrame || e.errorCode === -3 || e.validatedURL === 'about:blank') return;
    if (activeId === tab.id) showToast('Could not load this page. Check the address or your connection.');
  });
  viewport.append(view);
  tab.view = view;
  if (activeId === tab.id) { $('welcome').classList.add('hidden'); view.style.display = 'flex'; }
}
function activateTab(id) {
  activeId = id;
  tabs.forEach(t => { if (t.view) t.view.style.display = t.id === id ? 'flex' : 'none'; });
  const tab = activeTab();
  if (tab && !tab.view) showHome();
  else if (tab) { $('welcome').classList.add('hidden'); updateAddress(tab); }
  renderTabs(); syncNavigation(tab); updateBookmarkButton(); saveSession();
}
function closeTab(id) {
  const index = tabs.findIndex(t => t.id === id); if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  if (!isPrivate && tab.url && tab.url !== HOME) closedTabs.push({ url: tab.url, title: tab.title });
  closedTabs = closedTabs.slice(-20);
  try { tab.view?.remove(); tab.button.remove(); } catch {}
  if (!tabs.length) makeTab(settings.homePage || HOME);
  else if (activeId === id) activateTab(tabs[Math.min(index, tabs.length - 1)].id);
  renderTabs(); saveSession();
}
function renderTabs() {
  tabs.forEach(t => {
    t.button.classList.toggle('active', t.id === activeId);
    t.button.querySelector('.tab-title').textContent = t.title || 'New Tab';
    t.button.title = t.url || 'New Tab';
    t.button.setAttribute('aria-selected', String(t.id === activeId));
  });
}
function showHome() {
  $('welcome').classList.remove('hidden');
  [...viewport.querySelectorAll('webview')].forEach(v => v.style.display = 'none');
  $('address').value = '';
  $('welcome-protection').textContent = blockState.enabled ? 'on' : 'off';
}
function navigate(value) {
  const tab = activeTab(); if (!tab) return;
  const url = normalizeInput(value);
  tab.url = url;
  if (url === HOME || url === 'about:blank') {
    if (tab.view) { tab.view.remove(); tab.view = null; }
    tab.title = 'New Tab'; showHome(); renderTabs(); updateAddress(tab); saveSession(); return;
  }
  $('welcome').classList.add('hidden');
  if (!tab.view) createView(tab, url);
  else tab.view.loadURL(url).catch(() => showToast('Could not navigate to that address.'));
  updateAddress(tab); renderTabs(); saveSession();
}
function updateAddress(tab) {
  if (!tab) return;
  $('address').value = tab.url === HOME ? '' : tab.url;
  $('secure-icon').textContent = tab.url.startsWith('https:') ? '◈' : 'ⓘ';
  $('secure-icon').style.color = tab.url.startsWith('https:') ? 'var(--teal)' : '#e8bd75';
}
function syncNavigation(tab) {
  $('back').disabled = !tab?.view?.canGoBack();
  $('forward').disabled = !tab?.view?.canGoForward();
  $('back').style.opacity = $('back').disabled ? '.4' : '1';
  $('forward').style.opacity = $('forward').disabled ? '.4' : '1';
}
function addHistory(url, title) {
  if (isPrivate || !isWebUrl(url)) return;
  if (historyItems[0]?.url === url && Date.now() - historyItems[0].time < 5000) {
    historyItems[0].title = title || url;
    return persistHistory();
  }
  historyItems.unshift({ url, title: title || url, time: Date.now() });
  historyItems = historyItems.slice(0, 1000);
  persistHistory();
}
function showToast(message) {
  const toast = $('toast'); toast.textContent = message; toast.classList.remove('hidden');
  clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.add('hidden'), 2800);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function openPanel(title, content) {
  $('panel-title').textContent = title;
  $('panel-content').innerHTML = content;
  $('panel').classList.remove('hidden');
}
function closePanel() { $('panel').classList.add('hidden'); }
function currentHostname() { try { return new URL(pageUrl()).hostname.replace(/^www\./, ''); } catch { return ''; } }
function updateBookmarkButton() {
  const url = pageUrl();
  const saved = bookmarks.some(b => b.url === url);
  $('bookmark').textContent = saved ? '★' : '☆';
  $('bookmark').style.color = saved ? 'var(--teal)' : '';
}
function toggleBookmark() {
  const tab = activeTab(); if (!tab || !isWebUrl(tab.url)) return showToast('Open a website before bookmarking.');
  const existing = bookmarks.findIndex(b => b.url === tab.url);
  if (existing >= 0) { bookmarks.splice(existing, 1); showToast('Bookmark removed'); }
  else { bookmarks.unshift({ title: tab.title || tab.url, url: tab.url, addedAt: Date.now() }); showToast('Bookmark saved'); }
  persistBookmarks(); updateBookmarkButton();
}
function showProtectionPanel() {
  const rows = blockState.recent.slice(0, 12).map(item =>
    '<div class="recent-item"><span class="tag '+(item.category==='ad'?'ad':'')+'">'+escapeHtml(item.category)+'</span><strong>'+escapeHtml(item.domain)+'</strong><small>On '+escapeHtml(item.site)+' · '+new Date(item.time).toLocaleTimeString()+'</small></div>'
  ).join('');
  const exceptions = blockState.allowlist.map(host => '<div class="site-detail">'+escapeHtml(host)+'<button class="site-remove" data-unallow="'+escapeHtml(host)+'" title="Remove exception">×</button></div>').join('');
  openPanel('Privacy protection',
    '<div class="stat-grid"><div class="stat"><strong>'+Number(blockState.total||0).toLocaleString()+'</strong><span>Total blocked</span></div><div class="stat"><strong>'+Number(blockState.ads||0).toLocaleString()+'</strong><span>Ads blocked</span></div><div class="stat"><strong>'+Number(blockState.trackers||0).toLocaleString()+'</strong><span>Trackers blocked</span></div></div>'+
    '<div class="protection-row"><div><strong>Ad & tracker blocking</strong><div class="protection-state">'+(blockState.blockerReady?'Filter lists loaded':'Using built-in fallback rules')+'</div></div><button id="toggle-blocking" class="switch '+(blockState.enabled?'on':'')+'" role="switch" aria-checked="'+blockState.enabled+'" aria-label="Toggle ad and tracker blocking"></button></div>'+
    '<p class="section-label">Exclude a website</p><div class="site-input"><input id="allow-host" placeholder="example.com"><button id="allow-submit">Add</button></div>'+
    (exceptions||'<div class="empty">No website exceptions yet.</div>')+
    '<p class="section-label">Blocked by site</p>'+(Object.entries(blockState.bySite||{}).sort((a,b)=>b[1].total-a[1].total).slice(0,6).map(([site,v])=>'<div class="recent-item"><strong>'+escapeHtml(site)+'</strong><small>'+v.total+' blocked · '+v.ads+' ads · '+v.trackers+' trackers</small></div>').join('')||'<div class="empty">Site breakdown appears after requests are blocked.</div>')+
    '<p class="section-label">Recently blocked requests</p>'+(rows||'<div class="empty">No blocked requests yet. Browse some sites to see activity.</div>')+
    '<div class="panel-actions"><button id="clear-stats" class="secondary">Reset statistics</button></div>'+
    '<div class="empty">Blocking uses EasyList-compatible network filters. Some ads, first-party tracking, and sponsored content may still appear.</div>');
  $('toggle-blocking').onclick = async () => { blockState.enabled = await window.shark.setBlocking(!blockState.enabled); $('welcome-protection').textContent = blockState.enabled?'on':'off'; showProtectionPanel(); };
  $('allow-submit').onclick = async () => {
    const host = $('allow-host').value.trim().toLowerCase().replace(/^https?:\/\//,'').split(/[/?#]/)[0];
    if (!host) return;
    blockState.allowlist = await window.shark.allowSite(host); showProtectionPanel();
  };
  $('panel-content').querySelectorAll('[data-unallow]').forEach(button => button.onclick = async () => {
    blockState.allowlist = await window.shark.removeAllowSite(button.dataset.unallow); showProtectionPanel();
  });
  $('clear-stats').onclick = async () => { blockState = { ...blockState, ...(await window.shark.clearStats()) }; showProtectionPanel(); };
}
function showHistory() {
  openPanel('Browsing history', '<div class="site-input"><input id="history-filter" placeholder="Filter history"><button id="clear-history" class="secondary">Clear all</button></div><div id="history-list"></div>');
  const draw = q => {
    const entries = historyItems.filter(x => (x.url+' '+x.title).toLowerCase().includes(q.toLowerCase())).slice(0,150);
    $('history-list').innerHTML = entries.map(x =>
      '<div class="history-item"><button class="panel-link" data-go="'+escapeHtml(x.url)+'">'+escapeHtml(x.title||x.url)+'</button><small>'+escapeHtml(x.url)+' · '+new Date(x.time).toLocaleString()+'</small></div>'
    ).join('') || '<div class="empty">'+(isPrivate?'History is not saved in private windows.':'No matching history.')+'</div>';
    $('history-list').querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{closePanel();navigate(b.dataset.go);});
  };
  draw(''); $('history-filter').oninput=e=>draw(e.target.value);
  $('clear-history').onclick=async()=>{historyItems=[];persistHistory();await window.shark.clearHistory();draw('');showToast('Browsing history cleared');};
}
function showBookmarks() {
  openPanel('Bookmarks', '<div class="site-input"><input id="bookmark-title" placeholder="Bookmark title"><button id="save-bookmark">Save current</button></div><div id="bookmark-list"></div>');
  const draw = () => {
    $('bookmark-list').innerHTML = bookmarks.map((b,i)=>
      '<div class="bookmark-item"><button class="panel-link" data-index="'+i+'">'+escapeHtml(b.title)+'</button><button class="site-remove" data-remove="'+i+'" title="Remove bookmark">×</button><small>'+escapeHtml(b.url)+'</small></div>'
    ).join('')||'<div class="empty">No bookmarks saved yet.</div>';
    $('bookmark-list').querySelectorAll('[data-index]').forEach(el=>el.onclick=()=>{const b=bookmarks[+el.dataset.index];closePanel();navigate(b.url);});
    $('bookmark-list').querySelectorAll('[data-remove]').forEach(el=>el.onclick=()=>{bookmarks.splice(+el.dataset.remove,1);persistBookmarks();draw();updateBookmarkButton();});
  };
  $('save-bookmark').onclick=()=>{
    const t=activeTab();if(t&&isWebUrl(t.url)){
      const old=bookmarks.find(b=>b.url===t.url);
      if(old)old.title=$('bookmark-title').value||t.title;
      else bookmarks.unshift({title:$('bookmark-title').value||t.title,url:t.url,addedAt:Date.now()});
      persistBookmarks();draw();updateBookmarkButton();showToast('Bookmark saved');
    } else showToast('Open a website first');
  };
  draw();
}
function showDownloads() {
  openPanel('Downloads', '<div class="panel-actions"><button id="clear-downloads" class="secondary">Clear finished downloads</button></div><div id="downloads-list"></div>');
  const render = () => {
    $('downloads-list').innerHTML = downloads.map(item => {
      const total=Number(item.totalBytes||0), got=Number(item.receivedBytes||0);
      const progress=total>0?Math.min(100,Math.round(got/total*100)):0;
      const detail=item.state==='in-progress'?(total?progress+'% · '+formatBytes(got)+' of '+formatBytes(total):formatBytes(got)+' downloaded'):item.state+' · '+new Date(item.finishedAt||item.startedAt).toLocaleString();
      return '<div class="download-item"><strong>'+escapeHtml(item.filename)+'</strong><div class="site-detail">'+escapeHtml(detail)+'</div>'+(item.state==='in-progress'?'<div class="download-progress"><span style="width:'+progress+'%"></span></div>':'')+
        '<div class="mini-actions"><button data-open-download="'+escapeHtml(item.id)+'" '+(item.state!=='completed'?'disabled':'')+'>Open</button><button data-reveal-download="'+escapeHtml(item.id)+'" '+(item.state!=='completed'?'disabled':'')+'>Show in folder</button><button data-remove-download="'+escapeHtml(item.id)+'">Remove</button></div></div>';
    }).join('')||'<div class="empty">No downloads yet. Downloads prompt for a save location and appear here.</div>';
    $('downloads-list').querySelectorAll('[data-open-download]').forEach(b=>b.onclick=async()=>{const r=await window.shark.openDownload(b.dataset.openDownload);if(!r.ok)showToast(r.error);});
    $('downloads-list').querySelectorAll('[data-reveal-download]').forEach(b=>b.onclick=()=>window.shark.revealDownload(b.dataset.revealDownload));
    $('downloads-list').querySelectorAll('[data-remove-download]').forEach(b=>b.onclick=async()=>{downloads=await window.shark.removeDownload(b.dataset.removeDownload);render();});
  };
  $('clear-downloads').onclick=async()=>{downloads=await window.shark.clearDownloads();render();};
  render();
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)||bytes<1)return '0 B';
  const units=['B','KB','MB','GB'];const i=Math.min(units.length-1,Math.floor(Math.log(bytes)/Math.log(1024)));
  return (bytes/Math.pow(1024,i)).toFixed(i?1:0)+' '+units[i];
}
function showSettings() {
  openPanel('Settings',
    '<form id="settings-form">'+
    '<div class="field"><label for="settings-search">Default search engine</label><select id="settings-search"><option value="duckduckgo">DuckDuckGo</option><option value="google">Google</option><option value="bing">Bing</option><option value="brave">Brave Search</option></select></div>'+
    '<div class="field"><label for="settings-home">Home button page</label><input id="settings-home" placeholder="shark://home or https://example.com"></div>'+
    '<label class="check-row"><input type="checkbox" id="settings-restore"> Restore tabs from last session on launch</label>'+
    '<label class="check-row"><input type="checkbox" id="settings-block"> Enable ad and tracker blocking</label>'+
    '<button class="primary" type="submit">Save settings</button></form>'+
    '<hr><p class="section-label">Privacy and site data</p>'+
    '<button class="wide-button" id="clear-history-data">Clear browsing history</button>'+
    '<button class="wide-button" id="clear-cache-data">Clear cached files</button>'+
    '<button class="wide-button" id="clear-cookies-data">Clear cookies and sign out of websites</button>'+
    '<button class="wide-button" id="clear-all-site-data">Clear all website data and permissions</button>'+
    '<hr><p class="section-label">Page controls</p>'+
    '<div class="panel-actions"><button id="settings-find" class="secondary">Find in page</button><button id="settings-print" class="secondary">Print page</button><button id="settings-translate" class="secondary">Translate page</button></div>'+
    '<div class="empty">Shark is experimental. Some site permissions, password saving, extensions, and sync still need further development.</div>');
  $('settings-search').value=settings.searchEngine;
  $('settings-home').value=settings.homePage;
  $('settings-restore').checked=!!settings.restoreSession;
  $('settings-block').checked=!!blockState.enabled;
  $('settings-form').onsubmit=async e=>{
    e.preventDefault();
    const home=$('settings-home').value.trim()||HOME;
    if(home!==HOME&&!isWebUrl(home))return showToast('Home page must be shark://home or an HTTP(S) URL.');
    settings={...settings,searchEngine:$('settings-search').value,homePage:home,restoreSession:$('settings-restore').checked,blockAds:$('settings-block').checked};
    settings=await window.shark.saveSettings(settings);
    blockState.enabled=await window.shark.setBlocking($('settings-block').checked);
    $('welcome-protection').textContent=blockState.enabled?'on':'off';
    showToast('Settings saved');
    closePanel();saveSession();
  };
  $('clear-history-data').onclick=async()=>{historyItems=[];persistHistory();await window.shark.clearData({history:true});showToast('Browsing history cleared');};
  $('clear-cache-data').onclick=async()=>{await window.shark.clearData({cache:true});showToast('Cached files cleared');};
  $('clear-cookies-data').onclick=async()=>{await window.shark.clearData({cookies:true});showToast('Cookies cleared; you may be signed out');};
  $('clear-all-site-data').onclick=async()=>{await window.shark.clearData({siteData:true,permissions:true,cache:true});showToast('Website data and permissions cleared');};
  $('settings-find').onclick=()=>{closePanel();openFind();};
  $('settings-print').onclick=()=>{closePanel();activeTab()?.view?.print();};
  $('settings-translate').onclick=()=>{const url=pageUrl();if(isWebUrl(url))navigate('https://translate.google.com/translate?sl=auto&tl=en&u='+encodeURIComponent(url));else showToast('Open a website first.');};
}
function showMenu() {
  openPanel('Shark menu',
    '<div class="menu-grid"><button id="menu-history">◷ &nbsp; History</button><button id="menu-bookmarks">☆ &nbsp; Bookmarks</button><button id="menu-downloads">↓ &nbsp; Downloads</button><button id="menu-privacy">🛡 &nbsp; Privacy stats</button><button id="menu-settings">⚙ &nbsp; Settings</button><button id="menu-private">◐ &nbsp; New private window</button><button id="menu-home">⌂ &nbsp; Home</button><button id="menu-print">▤ &nbsp; Print page</button><button id="menu-find">⌕ &nbsp; Find in page</button><button id="menu-translate">文 &nbsp; Translate page</button></div>'+
    '<p class="empty">Shortcuts: Ctrl+T new tab · Ctrl+Shift+T reopen tab · Ctrl+W close tab · Ctrl+L address bar · Ctrl+F find · Ctrl+J downloads</p>');
  $('menu-history').onclick=showHistory; $('menu-bookmarks').onclick=showBookmarks; $('menu-downloads').onclick=showDownloads;
  $('menu-privacy').onclick=showProtectionPanel; $('menu-settings').onclick=showSettings; $('menu-private').onclick=()=>window.shark.newPrivateWindow();
  $('menu-home').onclick=()=>{closePanel();navigate(settings.homePage||HOME);};
  $('menu-print').onclick=()=>{closePanel();activeTab()?.view?.print();};
  $('menu-find').onclick=()=>{closePanel();openFind();};
  $('menu-translate').onclick=()=>{const url=pageUrl();closePanel();if(isWebUrl(url))navigate('https://translate.google.com/translate?sl=auto&tl=en&u='+encodeURIComponent(url));};
}
function showTabMenu(id) {
  const tab=tabs.find(t=>t.id===id);if(!tab)return;
  openPanel('Tab options',
    '<button id="tab-duplicate" class="wide-button">Duplicate tab</button>'+
    '<button id="tab-close-others" class="wide-button">Close other tabs</button>'+
    '<button id="tab-close-right" class="wide-button">Close tabs to the right</button>'+
    '<button id="tab-reload" class="wide-button">Reload tab</button>');
  $('tab-duplicate').onclick=()=>{makeTab(tab.url);closePanel();};
  $('tab-close-others').onclick=()=>{tabs.filter(t=>t.id!==id).map(t=>t.id).forEach(closeTab);activateTab(id);closePanel();};
  $('tab-close-right').onclick=()=>{const i=tabs.findIndex(t=>t.id===id);tabs.slice(i+1).map(t=>t.id).forEach(closeTab);activateTab(id);closePanel();};
  $('tab-reload').onclick=()=>{tab.view?.reload();closePanel();};
}
function openFind() {
  $('findbar').classList.remove('hidden');
  $('find-input').focus();$('find-input').select();
  runFind(false);
}
function runFind(forward=true) {
  const tab=activeTab(),term=$('find-input').value;
  if(!tab?.view||!term){$('find-count').textContent='';return;}
  tab.view.findInPage(term,{forward,findNext:forward,matchCase:false});
}
function closeFind() {
  const tab=activeTab();if(tab?.view)tab.view.stopFindInPage('clearSelection');
  $('findbar').classList.add('hidden');$('find-count').textContent='';
}

$('address-form').addEventListener('submit', e => { e.preventDefault(); navigate($('address').value); });
$('search-form').addEventListener('submit', e => { e.preventDefault(); navigate($('welcome-search').value); });
$('new-tab').onclick=()=>makeTab(settings.homePage||HOME);
$('private-window').onclick=()=>window.shark.newPrivateWindow();
$('back').onclick=()=>activeTab()?.view?.goBack(); $('forward').onclick=()=>activeTab()?.view?.goForward();
$('reload').onclick=()=>{const t=activeTab();if(t?.view){if(t.loading)t.view.stop();else t.view.reload();}else navigate(HOME);};
$('home').onclick=()=>navigate(settings.homePage||HOME);
$('bookmark').onclick=toggleBookmark; $('downloads').onclick=showDownloads; $('history').onclick=showHistory; $('privacy').onclick=showProtectionPanel; $('menu').onclick=showMenu; $('close-panel').onclick=closePanel;
$('find-prev').onclick=()=>runFind(false); $('find-next').onclick=()=>runFind(true); $('find-close').onclick=closeFind;
$('find-input').addEventListener('input',()=>runFind(false));
$('find-input').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();runFind(!e.shiftKey);}if(e.key==='Escape')closeFind();});
document.querySelectorAll('[data-url]').forEach(b=>b.onclick=()=>navigate(b.dataset.url));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closePanel(); if (!$('findbar').classList.contains('hidden')) closeFind(); }
});
function zoomPage(direction,reset=false) {
  const tab=activeTab();if(!tab?.view)return;
  tab.zoomLevel=reset?0:Math.max(-5,Math.min(5,tab.zoomLevel+direction));
  tab.view.setZoomLevel(tab.zoomLevel);
}
function cycleTab(direction) {
  if(tabs.length<2)return;
  let index=tabs.findIndex(t=>t.id===activeId);index=(index+direction+tabs.length)%tabs.length;activateTab(tabs[index].id);
}
function handleShortcut(command) {
  switch (command) {
    case 'new-tab': makeTab(settings.homePage||HOME); break;
    case 'close-tab': closeTab(activeId); break;
    case 'reload': { const t=activeTab(); if(t?.view){if(t.loading)t.view.stop();else t.view.reload();} break; }
    case 'force-reload': activeTab()?.view?.reloadIgnoringCache(); break;
    case 'back': activeTab()?.view?.goBack(); break;
    case 'forward': activeTab()?.view?.goForward(); break;
    case 'next-tab': cycleTab(1); break;
    case 'previous-tab': cycleTab(-1); break;
    case 'zoom-in': zoomPage(1); break;
    case 'zoom-out': zoomPage(-1); break;
    case 'zoom-reset': zoomPage(0,true); break;
    case 'find': openFind(); break;
    case 'history': showHistory(); break;
    case 'downloads': showDownloads(); break;
    case 'bookmark': toggleBookmark(); break;
    case 'print': activeTab()?.view?.print(); break;
    case 'reopen-tab': { const old=closedTabs.pop(); if(old)makeTab(old.url); else showToast('No recently closed tab.'); break; }
    case 'bookmarks': showBookmarks(); break;
    case 'privacy': showProtectionPanel(); break;
    case 'settings': case 'clear-data': showSettings(); break;
    case 'focus-address': $('address').focus(); $('address').select(); break;
    case 'home': navigate(settings.homePage||HOME); break;
  }
}
window.shark.onStats(data=>{
  blockState=data;
  $('blocked-badge').textContent=data.total>999?'999+':String(data.total||0);
  $('welcome-protection').textContent=data.enabled?'on':'off';
  if(!$('panel').classList.contains('hidden')&&$('panel-title').textContent==='Privacy protection'&&!$('panel').contains(document.activeElement))showProtectionPanel();
});
window.shark.onDownloads(data=>{downloads=data;if(!$('panel').classList.contains('hidden')&&$('panel-title').textContent==='Downloads')showDownloads();});
window.shark.onNewTab(url=>{if(isWebUrl(url))makeTab(url);});
window.shark.onToast(showToast);
window.shark.onShortcut(handleShortcut);
window.shark.getState().then(data=>{
  blockState=data;
  $('blocked-badge').textContent=data.total>999?'999+':String(data.total||0);
  $('welcome-protection').textContent=data.enabled?'on':'off';
});
window.shark.getBrowserData().then(data=>{
  browserData=data;
  settings={...defaultSettings,...(data.settings||{})};
  bookmarks=Array.isArray(data.bookmarks)?data.bookmarks:[];
  historyItems=isPrivate?[]:(Array.isArray(data.history)?data.history:[]);
  $('welcome-protection').textContent=blockState.enabled?'on':'off';
  if(!isPrivate&&settings.restoreSession&&Array.isArray(data.sessionTabs)&&data.sessionTabs.length) {
    const restored=data.sessionTabs.filter(isWebUrl).slice(0,40);
    restored.forEach((url,i)=>makeTab(url,i===restored.length-1));
  } else makeTab(settings.homePage||HOME);
  window.shark.getDownloads().then(data=>{downloads=isPrivate?[]:data;});
}).catch(error=>{console.error('Could not load Shark browser data',error);makeTab();});
if(isPrivate)document.title='Shark Browser — Private';
