// Shark Browser — native CEF browser controller.
// Copyright (c) 2026 NVDEMU. BSD-3-Clause.
#include "tests/cefsimple/simple_handler.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <utility>

#include "include/base/cef_callback.h"
#include "include/cef_path_util.h"
#include "include/cef_parser.h"
#include "include/cef_request_context.h"
#include "include/wrapper/cef_closure_task.h"
#include "include/wrapper/cef_helpers.h"
#include "tests/cefsimple/simple_app.h"

namespace {
SimpleHandler* g_instance = nullptr;

std::string Trim(std::string value) {
  auto not_space = [](unsigned char c) { return !std::isspace(c); };
  value.erase(value.begin(), std::find_if(value.begin(), value.end(), not_space));
  value.erase(std::find_if(value.rbegin(), value.rend(), not_space).base(), value.end());
  if (!value.empty() && value[0] == '\xEF') value.erase(0, std::min<size_t>(3, value.size()));
  return value;
}

bool StartsWith(const std::string& value, const std::string& prefix) {
  return value.size() >= prefix.size() && value.compare(0, prefix.size(), prefix) == 0;
}

std::string Lower(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return value;
}

std::string StripQuery(const std::string& url) {
  const size_t query = url.find_first_of("?#");
  return query == std::string::npos ? url : url.substr(0, query);
}

std::string ReadableCount(int count) {
  return std::to_string(std::max(0, count));
}

std::string MakeButtonText(const std::string& value) {
  // Native CEF buttons don't support the browser's CSS, so keep labels short.
  return value;
}

std::string ExtractDomainRule(std::string rule) {
  if (StartsWith(rule, "@@")) rule.erase(0, 2);
  if (!StartsWith(rule, "||")) return {};
  rule.erase(0, 2);
  const size_t stop = rule.find_first_of("^/*$|");
  if (stop != std::string::npos) rule.resize(stop);
  rule = Lower(Trim(rule));
  if (rule.size() < 4 || rule.find('.') == std::string::npos ||
      rule.find_first_of(" \t\r\n_*") != std::string::npos) return {};
  if (rule.front() == '.' || rule.back() == '.') return {};
  return rule;
}

std::string GetRoute(const std::string& url, const std::string& scheme) {
  std::string route = url.substr(scheme.size());
  while (!route.empty() && route.front() == '/') route.erase(route.begin());
  return route;
}

class SharkButtonDelegate final : public CefButtonDelegate {
 public:
  SharkButtonDelegate(CefRefPtr<SimpleHandler> handler, std::string action)
      : handler_(handler), action_(std::move(action)) {}
  void OnButtonPressed(CefRefPtr<CefButton> button) override {
    handler_->HandleButton(action_, button);
  }
 private:
  CefRefPtr<SimpleHandler> handler_;
  const std::string action_;
  IMPLEMENT_REFCOUNTING(SharkButtonDelegate);
};

class SharkTextfieldDelegate final : public CefTextfieldDelegate {
 public:
  explicit SharkTextfieldDelegate(CefRefPtr<SimpleHandler> handler) : handler_(handler) {}
  bool OnKeyEvent(CefRefPtr<CefTextfield> textfield, const CefKeyEvent& event) override {
    return handler_->HandleAddressKey(event);
  }
 private:
  CefRefPtr<SimpleHandler> handler_;
  IMPLEMENT_REFCOUNTING(SharkTextfieldDelegate);
};

class SharkBrowserViewDelegate final : public CefBrowserViewDelegate {
 public:
  explicit SharkBrowserViewDelegate(CefRefPtr<SimpleHandler> handler) : handler_(handler) {}
  cef_runtime_style_t GetBrowserRuntimeStyle() override {
    return handler_->GetBrowserRuntimeStyle();
  }
  bool OnPopupBrowserViewCreated(CefRefPtr<CefBrowserView> browser_view,
                                 CefRefPtr<CefBrowserView> popup_browser_view,
                                 bool is_devtools) override {
    return handler_->AdoptPopupView(popup_browser_view);
  }
 private:
  CefRefPtr<SimpleHandler> handler_;
  IMPLEMENT_REFCOUNTING(SharkBrowserViewDelegate);
};

}  // namespace

std::string InternalStyle();

SimpleHandler::SimpleHandler(bool is_alloy_style) : is_alloy_style_(is_alloy_style) {
  DCHECK(!g_instance);
  g_instance = this;
  LoadProfile();
}

SimpleHandler::~SimpleHandler() {
  SaveBookmarks();
  SaveHistory();
  SaveStats();
  g_instance = nullptr;
}

SimpleHandler* SimpleHandler::GetInstance() {
  return g_instance;
}

CefSize SimpleHandler::PreferredWindowSize() {
  return CefSize(1360, 900);
}

cef_runtime_style_t SimpleHandler::GetBrowserRuntimeStyle() {
  return CEF_RUNTIME_STYLE_DEFAULT;
}

void SimpleHandler::BuildWindow(CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  window_ = window;
  window_->SetTitle("Shark Browser");
  window_->SetToFillLayout();

  CefBoxLayoutSettings root_settings;
  root_settings.horizontal = 0;
  root_settings.inside_border_horizontal_spacing = 7;
  root_settings.inside_border_vertical_spacing = 6;
  root_settings.between_child_spacing = 5;
  root_settings.default_flex = 0;

  root_panel_ = CefPanel::CreatePanel(nullptr);
  root_layout_ = root_panel_->SetToBoxLayout(root_settings);

  CefBoxLayoutSettings tabs_settings;
  tabs_settings.horizontal = 1;
  tabs_settings.inside_border_horizontal_spacing = 4;
  tabs_settings.inside_border_vertical_spacing = 3;
  tabs_settings.between_child_spacing = 4;
  tabs_settings.default_flex = 0;
  tab_panel_ = CefPanel::CreatePanel(nullptr);
  tab_layout_ = tab_panel_->SetToBoxLayout(tabs_settings);

  CefBoxLayoutSettings toolbar_settings;
  toolbar_settings.horizontal = 1;
  toolbar_settings.inside_border_horizontal_spacing = 4;
  toolbar_settings.inside_border_vertical_spacing = 4;
  toolbar_settings.between_child_spacing = 4;
  toolbar_settings.default_flex = 0;
  toolbar_panel_ = CefPanel::CreatePanel(nullptr);
  toolbar_layout_ = toolbar_panel_->SetToBoxLayout(toolbar_settings);

  content_panel_ = CefPanel::CreatePanel(nullptr);
  content_panel_->SetToFillLayout();

  CefBoxLayoutSettings status_settings;
  status_settings.horizontal = 1;
  status_settings.inside_border_horizontal_spacing = 7;
  status_settings.inside_border_vertical_spacing = 2;
  status_settings.between_child_spacing = 4;
  status_panel_ = CefPanel::CreatePanel(nullptr);
  status_panel_->SetToBoxLayout(status_settings);

  auto add_button = [this](CefRefPtr<CefPanel> panel, const std::string& label,
                           const std::string& action, int minimum_width) {
    CefRefPtr<CefLabelButton> button = CefLabelButton::CreateLabelButton(
        new SharkButtonDelegate(CefRefPtr<SimpleHandler>(this), action), label);
    button->SetTooltipText(label);
    button->SetMinimumSize(CefSize(minimum_width, 29));
    panel->AddChildView(button);
    if (!action.empty() && action.find("tab:") != 0 && action.find("close:") != 0) {
      action_buttons_[action] = button;
    }
    return button;
  };

  add_button(tab_panel_, "◆ Shark", "home", 94);
  add_button(tab_panel_, "New tab +", "new-tab", 76);
  add_button(tab_panel_, "Private", "private", 62);

  add_button(toolbar_panel_, "←", "back", 34);
  add_button(toolbar_panel_, "→", "forward", 34);
  add_button(toolbar_panel_, "↻", "reload", 34);
  add_button(toolbar_panel_, "⌂", "home", 34);

  address_field_ = CefTextfield::CreateTextfield(
      new SharkTextfieldDelegate(CefRefPtr<SimpleHandler>(this)));
  address_field_->SetPlaceholderText("Search or enter address");
  toolbar_panel_->AddChildView(address_field_);
  toolbar_layout_->SetFlexForView(address_field_, 1);
  add_button(toolbar_panel_, "Go", "go", 40);
  add_button(toolbar_panel_, "☆", "bookmark", 34);
  add_button(toolbar_panel_, "History", "history", 58);
  add_button(toolbar_panel_, "Downloads", "downloads", 72);
  add_button(toolbar_panel_, "Shield", "privacy", 56);
  add_button(toolbar_panel_, "Settings", "settings", 63);

  status_button_ = add_button(status_panel_, "Blocking is on", "privacy", 180);
  status_panel_->AddChildView(CefLabelButton::CreateLabelButton(
      new SharkButtonDelegate(CefRefPtr<SimpleHandler>(this), "privacy"),
      "View protection statistics"));

  root_panel_->AddChildView(tab_panel_);
  root_panel_->AddChildView(toolbar_panel_);
  root_panel_->AddChildView(content_panel_);
  root_panel_->AddChildView(status_panel_);
  root_layout_->SetFlexForView(content_panel_, 1);
  window_->AddChildView(root_panel_);
  window_->Show();

  CreateTab(initial_url_, false);
  RefreshTabButtons();
  RefreshToolbarState();
  RefreshPrivacyStatus();
}

bool SimpleHandler::CanCloseWindow(CefRefPtr<CefWindow> window) {
  CEF_REQUIRE_UI_THREAD();
  if (browser_list_.empty()) return true;
  if (!is_closing_) {
    is_closing_ = true;
    CloseAllBrowsers(false);
  }
  return browser_list_.empty();
}

void SimpleHandler::WindowDestroyed() {
  window_ = nullptr;
  root_panel_ = nullptr;
  tab_panel_ = nullptr;
  toolbar_panel_ = nullptr;
  content_panel_ = nullptr;
  status_panel_ = nullptr;
  root_layout_ = nullptr;
  tab_layout_ = nullptr;
  toolbar_layout_ = nullptr;
  address_field_ = nullptr;
  status_button_ = nullptr;
  action_buttons_.clear();
  if (is_closing_ && browser_list_.empty()) CefQuitMessageLoop();
}

void SimpleHandler::ShowMainWindow() {
  CEF_REQUIRE_UI_THREAD();
  if (window_) window_->Show();
}

void SimpleHandler::CloseAllBrowsers(bool force_close) {
  CEF_REQUIRE_UI_THREAD();
  for (const auto& browser : browser_list_) {
    if (browser && browser->IsValid()) browser->GetHost()->CloseBrowser(force_close);
  }
}

void SimpleHandler::HandleButton(const std::string& action, CefRefPtr<CefButton> button) {
  CEF_REQUIRE_UI_THREAD();
  if (StartsWith(action, "tab:")) {
    SelectTab(std::atoi(action.substr(4).c_str()));
    return;
  }
  if (StartsWith(action, "close:")) {
    CloseTab(std::atoi(action.substr(6).c_str()));
    return;
  }
  if (action == "new-tab") {
    CreateTab("shark://home", false);
  } else if (action == "close-active") {
    if (active_tab_id_ != 0) CloseTab(active_tab_id_);
  } else if (action == "focus-address") {
    if (address_field_) { address_field_->RequestFocus(); address_field_->SelectAll(false); }
  } else if (action == "find") {
    OpenRoute("find");
  } else if (action == "find-submit") {
    OpenRoute("find");
  } else if (action == "print") {
    if (ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser()) ActiveTab()->view->GetBrowser()->GetHost()->Print();
  } else if (action == "private") {
    CreateTab("shark://home", true);
  } else if (action == "back") {
    if (ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser())
      ActiveTab()->view->GetBrowser()->GoBack();
  } else if (action == "forward") {
    if (ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser())
      ActiveTab()->view->GetBrowser()->GoForward();
  } else if (action == "reload") {
    if (ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser())
      ActiveTab()->view->GetBrowser()->Reload();
  } else if (action == "home") {
    NavigateAddress(home_page_);
  } else if (action == "go") {
    if (address_field_) NavigateAddress(address_field_->GetText().ToString());
  } else if (action == "bookmark") {
    const std::string url = GetCurrentURL();
    if (url.empty() || !StartsWith(url, "http")) {
      if (status_button_) status_button_->SetText("Open a website to bookmark it");
    } else {
      bool removed = false;
      for (auto it = bookmarks_.begin(); it != bookmarks_.end(); ++it) {
        if (it->second == url) { bookmarks_.erase(it); removed = true; break; }
      }
      if (!removed) {
        std::string title = ActiveTab() ? ActiveTab()->title : url;
        bookmarks_.insert(bookmarks_.begin(), {title.empty() ? url : title, url});
      }
      if (bookmarks_.size() > 1000) bookmarks_.resize(1000);
      SaveBookmarks();
      if (status_button_) status_button_->SetText(removed ? "Bookmark removed" : "Bookmark saved");
    }
    RefreshToolbarState();
  } else if (action == "history") {
    OpenRoute("history");
  } else if (action == "downloads") {
    OpenRoute("downloads");
  } else if (action == "privacy") {
    OpenRoute("privacy");
  } else if (action == "settings") {
    OpenRoute("settings");
  }
}

bool SimpleHandler::HandleAddressKey(const CefKeyEvent& event) {
  if ((event.type == KEYEVENT_RAWKEYDOWN || event.type == KEYEVENT_KEYUP) &&
      event.windows_key_code == 13) {
    if (event.type == KEYEVENT_KEYUP && address_field_) {
      NavigateAddress(address_field_->GetText().ToString());
      return true;
    }
    return event.type == KEYEVENT_RAWKEYDOWN;
  }
  return false;
}

bool SimpleHandler::AdoptPopupView(CefRefPtr<CefBrowserView> popup_view) {
  CEF_REQUIRE_UI_THREAD();
  if (!popup_view) return false;
  const std::string url = popup_view->GetBrowser() ? popup_view->GetBrowser()->GetMainFrame()->GetURL().ToString() : "shark://home";
  CreateTabForView(url, false, popup_view, nullptr);
  return true;
}

void SimpleHandler::CreateTab(const std::string& url, bool is_private) {
  CEF_REQUIRE_UI_THREAD();
  const std::string normalized = NormalizeAddress(url);
  const std::string actual_url = StartsWith(normalized, "shark://")
                                     ? DataURL(normalized == "shark://home" ? BuildHomePage()
                                               : normalized == "shark://privacy" ? BuildPrivacyPage()
                                               : normalized == "shark://bookmarks" ? BuildBookmarksPage()
                                               : normalized == "shark://history" ? BuildHistoryPage()
                                               : normalized == "shark://downloads" ? BuildDownloadsPage()
                                               : normalized == "shark://find" ? BuildFindPage()
                                               : BuildSettingsPage())
                                     : normalized;

  CefBrowserSettings browser_settings;
  CefRefPtr<CefRequestContext> request_context = nullptr;
  if (is_private) {
    CefRequestContextSettings context_settings;
    context_settings.cache_path = "";
    context_settings.persist_session_cookies = 0;
    context_settings.persist_user_preferences = 0;
    request_context = CefRequestContext::CreateContext(context_settings, nullptr);
  }

  CefRefPtr<CefBrowserView> browser_view = CefBrowserView::CreateBrowserView(
      this, actual_url, browser_settings, nullptr, request_context,
      new SharkBrowserViewDelegate(CefRefPtr<SimpleHandler>(this)));
  CreateTabForView(normalized, is_private, browser_view, request_context);
}

void SimpleHandler::CreateTabForView(const std::string& url,
                                     bool is_private,
                                     CefRefPtr<CefBrowserView> view,
                                     CefRefPtr<CefRequestContext> request_context) {
  CEF_REQUIRE_UI_THREAD();
  if (!view || !content_panel_ || !tab_panel_) return;
  Tab tab;
  tab.id = next_tab_id_++;
  tab.title = StartsWith(url, "shark://") ? "New Tab" : url;
  tab.url = url;
  tab.last_site_url = StartsWith(url, "http") ? url : "";
  tab.is_private = is_private;
  tab.internal_page = StartsWith(url, "shark://");
  tab.view = view;
  if (is_private) {
    // Keep the ephemeral profile alive for the lifetime of this private tab.
    tab.request_context = request_context;
  }
  const int tab_id = tab.id;
  tab.tab_button = CefLabelButton::CreateLabelButton(
      new SharkButtonDelegate(CefRefPtr<SimpleHandler>(this), "tab:" + std::to_string(tab_id)),
      MakeButtonText(tab.title));
  tab.close_button = CefLabelButton::CreateLabelButton(
      new SharkButtonDelegate(CefRefPtr<SimpleHandler>(this), "close:" + std::to_string(tab_id)),
      "×");
  tab.tab_button->SetTooltipText(tab.title);
  tab.close_button->SetTooltipText("Close tab");
  tab.tab_button->SetMinimumSize(CefSize(80, 30));
  tab.close_button->SetMinimumSize(CefSize(25, 30));

  tab_panel_->AddChildView(tab.tab_button);
  tab_panel_->AddChildView(tab.close_button);
  tab_layout_->SetFlexForView(tab.tab_button, 1);
  content_panel_->AddChildView(view);
  view->SetVisible(false);
  tabs_.push_back(tab);
  SelectTab(tab_id);
}

void SimpleHandler::CloseTab(int tab_id) {
  CEF_REQUIRE_UI_THREAD();
  auto it = std::find_if(tabs_.begin(), tabs_.end(), [tab_id](const Tab& tab) { return tab.id == tab_id; });
  if (it == tabs_.end()) return;
  const bool was_active = (active_tab_id_ == tab_id);
  CefRefPtr<CefBrowserView> view = it->view;
  CefRefPtr<CefBrowser> browser = view ? view->GetBrowser() : nullptr;
  if (tab_panel_) {
    if (it->tab_button) tab_panel_->RemoveChildView(it->tab_button);
    if (it->close_button) tab_panel_->RemoveChildView(it->close_button);
  }
  if (content_panel_ && view) content_panel_->RemoveChildView(view);
  tabs_.erase(it);
  if (browser && browser->IsValid()) browser->GetHost()->CloseBrowser(true);
  if (tabs_.empty() && !is_closing_) {
    active_tab_id_ = 0;
    CreateTab("shark://home", false);
  } else if (was_active && !tabs_.empty()) {
    SelectTab(tabs_.back().id);
  }
  RefreshTabButtons();
}

void SimpleHandler::SelectTab(int tab_id) {
  CEF_REQUIRE_UI_THREAD();
  auto found = std::find_if(tabs_.begin(), tabs_.end(), [tab_id](const Tab& tab) { return tab.id == tab_id; });
  if (found == tabs_.end()) return;
  active_tab_id_ = tab_id;
  for (auto& tab : tabs_) if (tab.view) tab.view->SetVisible(tab.id == active_tab_id_);
  if (found->view && found->view->GetBrowser()) {
    CefRefPtr<CefBrowser> browser = found->view->GetBrowser();
    if (!found->internal_page) {
      found->url = browser->GetMainFrame()->GetURL().ToString();
      if (StartsWith(found->url, "http")) found->last_site_url = found->url;
    }
  }
  RefreshTabButtons();
  RefreshToolbarState();
  RefreshPrivacyStatus();
}

SimpleHandler::Tab* SimpleHandler::ActiveTab() {
  auto it = std::find_if(tabs_.begin(), tabs_.end(), [this](const Tab& tab) { return tab.id == active_tab_id_; });
  return it == tabs_.end() ? nullptr : &(*it);
}

const SimpleHandler::Tab* SimpleHandler::ActiveTab() const {
  auto it = std::find_if(tabs_.begin(), tabs_.end(), [this](const Tab& tab) { return tab.id == active_tab_id_; });
  return it == tabs_.end() ? nullptr : &(*it);
}

SimpleHandler::Tab* SimpleHandler::FindTabByBrowser(CefRefPtr<CefBrowser> browser) {
  if (!browser) return nullptr;
  for (auto& tab : tabs_) {
    if (tab.view && tab.view->GetBrowser() && tab.view->GetBrowser()->IsSame(browser)) return &tab;
  }
  return nullptr;
}

void SimpleHandler::NavigateAddress(const std::string& input) {
  CEF_REQUIRE_UI_THREAD();
  const std::string normalized = NormalizeAddress(input);
  Tab* tab = ActiveTab();
  if (!tab) return;
  if (StartsWith(normalized, "shark://")) {
    const std::string route = normalized.substr(8);
    if (tab->view && tab->view->GetBrowser()) OpenInternalPage(tab->view->GetBrowser(), route);
    else {
      // A just-created browser may not have a browser object yet. Create the
      // tab with the data URL rather than waiting on a nonexistent renderer.
      CloseTab(tab->id);
      CreateTab(normalized, tab->is_private);
    }
    return;
  }
  tab->internal_page = false;
  tab->url = normalized;
  if (tab->view && tab->view->GetBrowser()) {
    tab->view->GetBrowser()->GetMainFrame()->LoadURL(normalized);
  } else {
    const int id = tab->id;
    const bool priv = tab->is_private;
    CloseTab(id);
    CreateTab(normalized, priv);
  }
  RefreshToolbarState();
}

void SimpleHandler::OpenRoute(const std::string& route) {
  CEF_REQUIRE_UI_THREAD();
  if (ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser()) {
    OpenInternalPage(ActiveTab()->view->GetBrowser(), route);
  } else {
    CreateTab("shark://" + route, false);
  }
}

void SimpleHandler::OpenInternalPage(CefRefPtr<CefBrowser> browser, const std::string& route_input) {
  CEF_REQUIRE_UI_THREAD();
  std::string route = route_input;
  const size_t query = route.find_first_of("?#");
  if (query != std::string::npos) route.resize(query);
  std::string html;
  if (route.empty() || route == "home") html = BuildHomePage();
  else if (route == "bookmarks") html = BuildBookmarksPage();
  else if (route == "history") html = BuildHistoryPage();
  else if (route == "downloads") html = BuildDownloadsPage();
  else if (route == "find") html = BuildFindPage();
  else if (route == "privacy") html = BuildPrivacyPage();
  else html = BuildSettingsPage();

  Tab* tab = FindTabByBrowser(browser);
  if (tab) {
    tab->url = "shark://" + (route.empty() ? "home" : route);
    tab->internal_page = true;
    tab->title = route.empty() ? "New Tab" : "Shark — " + route;
    if (tab->tab_button) tab->tab_button->SetText(tab->title);
  }
  browser->GetMainFrame()->LoadURL(DataURL(html));
  if (tab && tab->id == active_tab_id_) RefreshToolbarState();
}

void SimpleHandler::HandleInternalAction(const std::string& action) {
  CEF_REQUIRE_UI_THREAD();
  if (action == "toggle-blocking") ToggleBlocking();
  else if (action == "allow-current") AddAllowedSite(GetCurrentHost());
  else if (action == "add-bookmark") HandleButton("bookmark", nullptr);
  else if (action == "clear-history") { history_.clear(); SaveHistory(); }
  else if (action == "set-home") {
    const std::string current = GetCurrentURL();
    if (StartsWith(current, "http")) home_page_ = current;
    std::ofstream out(std::filesystem::path(user_data_path_) / "settings.txt", std::ios::trunc);
    out << (blocking_enabled_ ? "1" : "0") << "\n" << home_page_ << "\n";
  } else if (StartsWith(action, "find/")) {
    const std::string encoded = action.substr(5);
    const std::string term = CefURIUnescape(encoded, true).ToString();
    if (ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser() && !term.empty())
      ActiveTab()->view->GetBrowser()->GetHost()->Find(1, term, true, false, false);
  } else if (StartsWith(action, "remove-bookmark/")) {
    const int index = std::atoi(action.substr(16).c_str());
    if (index >= 0 && index < static_cast<int>(bookmarks_.size())) {
      bookmarks_.erase(bookmarks_.begin() + index);
      SaveBookmarks();
    }
  }
  RefreshPrivacyStatus();
  const std::string route = action == "clear-history" ? "history" :
                            action == "add-bookmark" || StartsWith(action, "remove-bookmark/") ? "bookmarks" :
                            action == "set-home" ? "settings" : "privacy";
  OpenRoute(route);
}

void SimpleHandler::RefreshTabButtons() {
  CEF_REQUIRE_UI_THREAD();
  for (auto& tab : tabs_) {
    if (tab.tab_button) {
      const std::string label = (tab.id == active_tab_id_ ? "● " : "") + tab.title;
      tab.tab_button->SetText(label.substr(0, 52));
      tab.tab_button->SetTooltipText(tab.title + "\n" + tab.url);
    }
  }
}

void SimpleHandler::RefreshToolbarState() {
  CEF_REQUIRE_UI_THREAD();
  Tab* tab = ActiveTab();
  if (address_field_) address_field_->SetText(tab ? tab->url : "");
  if (window_ && tab) window_->SetTitle((tab->title.empty() ? "Shark Browser" : tab->title) + " — Shark Browser");
}

void SimpleHandler::RefreshPrivacyStatus() {
  CEF_REQUIRE_UI_THREAD();
  const std::string label = std::string("Protection ") + (blocking_enabled_ ? "ON" : "OFF") +
      "  ·  Blocked " + ReadableCount(blocked_total_.load()) +
      "  ·  Ads " + ReadableCount(blocked_ads_.load()) +
      "  ·  Trackers " + ReadableCount(blocked_trackers_.load());
  if (status_button_) status_button_->SetText(label);
  auto it = action_buttons_.find("privacy");
  if (it != action_buttons_.end()) it->second->SetText(blocking_enabled_ ? "Shield ✓" : "Shield off");
}

std::string SimpleHandler::GetCurrentURL() const {
  const Tab* tab = ActiveTab();
  if (!tab) return {};
  return !tab->last_site_url.empty() ? tab->last_site_url : tab->url;
}

std::string SimpleHandler::GetCurrentHost() const {
  return ExtractHost(GetCurrentURL());
}

void SimpleHandler::OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) {
  CEF_REQUIRE_UI_THREAD();
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  if (!title.empty()) tab->title = title.ToString();
  if (tab->tab_button) tab->tab_button->SetText((tab->id == active_tab_id_ ? "● " : "") + tab->title.substr(0, 48));
  if (tab->id == active_tab_id_ && window_) window_->SetTitle(tab->title + " — Shark Browser");
  if (!tab->is_private && !tab->internal_page && StartsWith(tab->last_site_url, "http")) {
    if (!history_.empty() && history_.front().url == tab->last_site_url) {
      history_.front().title = tab->title;
      SaveHistory();
    }
  }
}

void SimpleHandler::OnAddressChange(CefRefPtr<CefBrowser> browser,
                                    CefRefPtr<CefFrame> frame,
                                    const CefString& url) {
  CEF_REQUIRE_UI_THREAD();
  if (!frame || !frame->IsMain()) return;
  const std::string value = url.ToString();
  if (StartsWith(value, "data:") || StartsWith(value, "shark://")) return;
  Tab* tab = FindTabByBrowser(browser);
  if (!tab) return;
  tab->url = value;
  tab->internal_page = false;
  if (StartsWith(value, "http://") || StartsWith(value, "https://")) {
    tab->last_site_url = value;
    if (!tab->is_private) RecordHistory(value, tab->title);
  }
  if (tab->id == active_tab_id_) RefreshToolbarState();
  RefreshTabButtons();
}

void SimpleHandler::OnLoadingProgressChange(CefRefPtr<CefBrowser> browser, double progress) {
  CEF_REQUIRE_UI_THREAD();
  if (browser && ActiveTab() && ActiveTab()->view && ActiveTab()->view->GetBrowser() &&
      ActiveTab()->view->GetBrowser()->IsSame(browser) && status_button_ && progress < 1.0) {
    status_button_->SetText("Loading…  " + std::to_string(static_cast<int>(progress * 100)) + "%  ·  Blocked " +
                            ReadableCount(blocked_total_.load()));
  } else {
    RefreshPrivacyStatus();
  }
}

void SimpleHandler::OnAfterCreated(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  browser_list_.push_back(browser);
  Tab* tab = FindTabByBrowser(browser);
  if (tab && tab->is_private) {
    std::lock_guard<std::mutex> lock(filter_mutex_);
    private_browser_ids_.insert(browser->GetIdentifier());
  }
}

bool SimpleHandler::DoClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  return false;
}

void SimpleHandler::OnBeforeClose(CefRefPtr<CefBrowser> browser) {
  CEF_REQUIRE_UI_THREAD();
  auto it = std::find_if(browser_list_.begin(), browser_list_.end(),
                         [&browser](const CefRefPtr<CefBrowser>& b) { return b->IsSame(browser); });
  if (it != browser_list_.end()) browser_list_.erase(it);
  {
    std::lock_guard<std::mutex> lock(filter_mutex_);
    private_browser_ids_.erase(browser->GetIdentifier());
  }
  if (browser_list_.empty()) {
    if (!is_closing_ && tabs_.empty() && window_) {
      CreateTab("shark://home", false);
    }
  }
}

bool SimpleHandler::OnBeforePopup(CefRefPtr<CefBrowser> browser,
                                  CefRefPtr<CefFrame> frame,
                                  int popup_id,
                                  const CefString& target_url,
                                  const CefString& target_frame_name,
                                  WindowOpenDisposition target_disposition,
                                  bool user_gesture,
                                  const CefPopupFeatures& popup_features,
                                  CefWindowInfo& window_info,
                                  CefRefPtr<CefClient>& client,
                                  CefBrowserSettings& settings,
                                  CefRefPtr<CefDictionaryValue>& extra_info,
                                  bool* no_javascript_access) {
  CEF_REQUIRE_UI_THREAD();
  const std::string url = target_url.ToString();
  if (StartsWith(url, "http://") || StartsWith(url, "https://")) CreateTab(url, false);
  return true;
}

void SimpleHandler::OnLoadError(CefRefPtr<CefBrowser> browser,
                                CefRefPtr<CefFrame> frame,
                                ErrorCode error_code,
                                const CefString& error_text,
                                const CefString& failed_url) {
  CEF_REQUIRE_UI_THREAD();
  if (!is_alloy_style_ || error_code == ERR_ABORTED || !frame || !frame->IsMain()) return;
  std::stringstream html;
  html << "<html><body style='font:16px sans-serif;padding:40px;background:#10151d;color:#eaf2f8'>"
          "<h2>Shark couldn't load this page</h2><p>"
       << HtmlEscape(failed_url.ToString()) << "</p><p>"
       << HtmlEscape(error_text.ToString()) << "</p><a style='color:#4de0c1' href='shark://home'>Back to Shark Home</a></body></html>";
  frame->LoadURL(DataURL(html.str()));
}

CefRefPtr<CefResourceRequestHandler> SimpleHandler::GetResourceRequestHandler(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    bool is_navigation,
    bool is_download,
    const CefString& request_initiator,
    bool& disable_default_handling) {
  return this;
}

bool SimpleHandler::OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                                   CefRefPtr<CefFrame> frame,
                                   CefRefPtr<CefRequest> request,
                                   bool user_gesture,
                                   bool is_redirect) {
  CEF_REQUIRE_UI_THREAD();
  if (!frame || !frame->IsMain()) return false;
  const std::string url = request->GetURL().ToString();
  if (StartsWith(url, "shark-action://")) {
    std::string action = GetRoute(url, "shark-action://");
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::HandleInternalAction, this, action));
    return true;
  }
  if (StartsWith(url, "shark://")) {
    std::string route = GetRoute(url, "shark://");
    CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::OpenInternalPage, this, browser, route));
    return true;
  }
  return false;
}

SimpleHandler::ReturnValue SimpleHandler::OnBeforeResourceLoad(
    CefRefPtr<CefBrowser> browser,
    CefRefPtr<CefFrame> frame,
    CefRefPtr<CefRequest> request,
    CefRefPtr<CefCallback> callback) {
  const std::string request_url = request ? request->GetURL().ToString() : "";
  const std::string referrer_url = request ? request->GetReferrerURL().ToString() : "";
  std::string category;
  if (ShouldBlockRequest(request_url, referrer_url, &category)) {
    bool private_request = false;
    if (browser) {
      std::lock_guard<std::mutex> lock(filter_mutex_);
      private_request = private_browser_ids_.find(browser->GetIdentifier()) != private_browser_ids_.end();
    }
    // Do not persist or count requests from private tabs.
    if (!private_request) {
      const std::string site = ExtractHost(referrer_url);
      const std::string request_host = ExtractHost(request_url);
      const int total = ++blocked_total_;
      if (category == "tracker") ++blocked_trackers_; else ++blocked_ads_;
      {
        std::lock_guard<std::mutex> lock(filter_mutex_);
        blocked_by_site_[site.empty() ? "unknown" : site]++;
        recent_blocked_.insert(recent_blocked_.begin(), (category == "tracker" ? "Tracker: " : "Ad: ") + request_host + " (on " + site + ")");
        if (recent_blocked_.size() > 30) recent_blocked_.resize(30);
      }
      if (total == 1 || total % 5 == 0) {
        CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::RefreshPrivacyStatus, this));
      }
    }
    return RV_CANCEL;
  }
  return RV_CONTINUE;
}

bool SimpleHandler::OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                                     CefRefPtr<CefDownloadItem> download_item,
                                     const CefString& suggested_name,
                                     CefRefPtr<CefBeforeDownloadCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  downloads_.push_back("Started: " + suggested_name.ToString());
  if (downloads_.size() > 100) downloads_.erase(downloads_.begin());
  callback->Continue("", true);
  return true;
}

void SimpleHandler::OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                                      CefRefPtr<CefDownloadItem> download_item,
                                      CefRefPtr<CefDownloadItemCallback> callback) {
  CEF_REQUIRE_UI_THREAD();
  if (!download_item) return;
  const std::string name = download_item->GetSuggestedFileName().ToString();
  const std::string status = download_item->IsComplete() ? "Complete: " + name :
                             download_item->IsCanceled() ? "Canceled: " + name :
                             "Downloading: " + name + " (" + std::to_string(download_item->GetPercentComplete()) + "%)";
  const std::string match = "Started: " + name;
  auto it = std::find_if(downloads_.begin(), downloads_.end(), [&match, &name](const std::string& item) {
    return item == match || item.find(name) != std::string::npos;
  });
  if (it != downloads_.end()) *it = status;
  else downloads_.push_back(status);
  if (downloads_.size() > 100) downloads_.erase(downloads_.begin());
}

bool SimpleHandler::OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                                  const CefKeyEvent& event,
                                  CefEventHandle os_event,
                                  bool* is_keyboard_shortcut) {
  if (event.type != KEYEVENT_RAWKEYDOWN) return false;
  const bool modifier = (event.modifiers & (EVENTFLAG_CONTROL_DOWN | EVENTFLAG_COMMAND_DOWN)) != 0;
  if (!modifier) return false;
  const int key = event.windows_key_code;
  std::string action;
  if (key == 'T') action = "new-tab";
  else if (key == 'W') action = "close-active";
  else if (key == 'L') action = "focus-address";
  else if (key == 'R') action = "reload";
  else if (key == 'H') action = "history";
  else if (key == 'D') action = "bookmark";
  else if (key == 'J') action = "downloads";
  else if (key == 'F') action = "find";
  else if (key == 'P') action = "print";
  else return false;
  if (is_keyboard_shortcut) *is_keyboard_shortcut = true;
  CefPostTask(TID_UI, base::BindOnce(&SimpleHandler::HandleButton, this, action, CefRefPtr<CefButton>()));
  return true;
}

void SimpleHandler::LoadProfile() {
  CefString base_path;
  if (!CefGetPath(PK_USER_DATA, base_path)) base_path = ".";
  user_data_path_ = (std::filesystem::path(base_path.ToString()) / "SharkBrowser").string();
  std::error_code ec;
  std::filesystem::create_directories(user_data_path_, ec);

  std::ifstream settings(std::filesystem::path(user_data_path_) / "settings.txt");
  std::string enabled_line;
  if (std::getline(settings, enabled_line)) blocking_enabled_ = (Trim(enabled_line) != "0");
  std::string homepage;
  if (std::getline(settings, homepage) && !Trim(homepage).empty()) home_page_ = Trim(homepage);

  auto load_entries = [](const std::filesystem::path& path, auto* out) {
    std::ifstream file(path);
    std::string line;
    while (std::getline(file, line)) {
      const size_t split = line.find('\t');
      if (split == std::string::npos) continue;
      const std::string title = line.substr(0, split);
      const std::string url = line.substr(split + 1);
      if (StartsWith(url, "http://") || StartsWith(url, "https://")) out->push_back({title, url});
    }
  };
  load_entries(std::filesystem::path(user_data_path_) / "bookmarks.tsv", &bookmarks_);
  load_entries(std::filesystem::path(user_data_path_) / "history.tsv", &history_);
  if (bookmarks_.size() > 1000) bookmarks_.resize(1000);
  if (history_.size() > 1000) history_.resize(1000);

  std::ifstream stats_file(std::filesystem::path(user_data_path_) / "stats.txt");
  int total = 0, ads = 0, trackers = 0;
  if (stats_file >> total >> ads >> trackers) {
    blocked_total_ = std::max(0, total);
    blocked_ads_ = std::max(0, ads);
    blocked_trackers_ = std::max(0, trackers);
  }

  std::ifstream allow_file(std::filesystem::path(user_data_path_) / "allowed-sites.txt");
  std::string host;
  while (std::getline(allow_file, host)) {
    host = Lower(Trim(host));
    if (!host.empty()) allowed_site_domains_.insert(host);
  }

  blocked_ad_domains_ = {
    "doubleclick.net", "googlesyndication.com", "googleadservices.com",
    "adnxs.com", "adsrvr.org", "adform.net", "taboola.com", "outbrain.com",
    "criteo.com", "smartadserver.com", "adroll.com", "advertising.com",
    "pubmatic.com", "rubiconproject.com", "openx.net", "casalemedia.com",
    "amazon-adsystem.com", "moatads.com", "yieldmo.com"
  };
  blocked_tracker_domains_ = {
    "google-analytics.com", "googletagmanager.com", "hotjar.com",
    "mixpanel.com", "segment.com", "segment.io", "amplitude.com",
    "scorecardresearch.com", "quantserve.com", "clarity.ms",
    "bat.bing.com", "connect.facebook.net", "pixel.facebook.com",
    "branch.io", "appsflyer.com", "adjust.com", "newrelic.com",
    "fullstory.com", "mouseflow.com", "heap.io", "crazyegg.com",
    "sentry.io", "intercom.io", "analytics.tiktok.com"
  };
  LoadFilterLists();
}

void SimpleHandler::LoadFilterLists() {
  CefString executable_dir;
  if (!CefGetPath(PK_DIR_EXE, executable_dir)) return;
  const std::filesystem::path filters_dir = std::filesystem::path(executable_dir.ToString()) / "filters";
  auto parse_file = [this](const std::filesystem::path& path, bool tracker_list) {
    std::ifstream file(path);
    if (!file) return;
    std::string line;
    while (std::getline(file, line)) {
      line = Trim(line);
      if (line.empty() || line[0] == '!' || line[0] == '[' || line.find("##") != std::string::npos ||
          line.find("#@#") != std::string::npos) continue;
      const bool exception = StartsWith(line, "@@");
      const std::string domain = ExtractDomainRule(line);
      if (domain.empty()) continue;
      std::lock_guard<std::mutex> lock(filter_mutex_);
      if (exception) allowed_request_domains_.insert(domain);
      else if (tracker_list) blocked_tracker_domains_.insert(domain);
      else blocked_ad_domains_.insert(domain);
    }
  };
  parse_file(filters_dir / "easylist.txt", false);
  parse_file(filters_dir / "easyprivacy.txt", true);
  parse_file(filters_dir / "fallback.txt", false);
}

void SimpleHandler::SaveBookmarks() {
  if (user_data_path_.empty()) return;
  std::ofstream file(std::filesystem::path(user_data_path_) / "bookmarks.tsv", std::ios::trunc);
  for (const auto& entry : bookmarks_) {
    std::string title = entry.first, url = entry.second;
    std::replace(title.begin(), title.end(), '\t', ' ');
    std::replace(title.begin(), title.end(), '\n', ' ');
    std::replace(title.begin(), title.end(), '\r', ' ');
    if (StartsWith(url, "http://") || StartsWith(url, "https://")) file << title << '\t' << url << '\n';
  }
}

void SimpleHandler::SaveHistory() {
  if (user_data_path_.empty()) return;
  std::ofstream file(std::filesystem::path(user_data_path_) / "history.tsv", std::ios::trunc);
  size_t count = 0;
  for (const auto& entry : history_) {
    std::string title = entry.title;
    std::replace(title.begin(), title.end(), '\t', ' ');
    std::replace(title.begin(), title.end(), '\n', ' ');
    std::replace(title.begin(), title.end(), '\r', ' ');
    if (StartsWith(entry.url, "http://") || StartsWith(entry.url, "https://")) {
      file << title << '\t' << entry.url << '\n';
      if (++count >= 1000) break;
    }
  }
}

void SimpleHandler::SaveStats() {
  if (user_data_path_.empty()) return;
  std::ofstream file(std::filesystem::path(user_data_path_) / "stats.txt", std::ios::trunc);
  file << blocked_total_.load() << '\n' << blocked_ads_.load() << '\n' << blocked_trackers_.load() << '\n';
}

void SimpleHandler::RecordHistory(const std::string& url, const std::string& title) {
  if (url.empty() || !StartsWith(url, "http")) return;
  if (!history_.empty() && history_.front().url == url) {
    history_.front().title = title.empty() ? url : title;
    return;
  }
  history_.insert(history_.begin(), {title.empty() ? url : title, url});
  if (history_.size() > 1000) history_.resize(1000);
  SaveHistory();
}

bool SimpleHandler::ShouldBlockRequest(const std::string& request_url,
                                       const std::string& referrer_url,
                                       std::string* category) {
  if (!blocking_enabled_) return false;
  if (!StartsWith(request_url, "http://") && !StartsWith(request_url, "https://")) return false;
  const std::string request_host = ExtractHost(request_url);
  const std::string referrer_host = ExtractHost(referrer_url);
  if (request_host.empty() || referrer_host.empty()) return false;
  if (HostMatches(referrer_host, request_host) || HostMatches(request_host, referrer_host)) return false;
  std::lock_guard<std::mutex> lock(filter_mutex_);
  for (const auto& allowed : allowed_site_domains_) if (HostMatches(referrer_host, allowed)) return false;
  for (const auto& allowed : allowed_request_domains_) if (HostMatches(request_host, allowed)) return false;
  for (const auto& domain : blocked_tracker_domains_) {
    if (HostMatches(request_host, domain)) { if (category) *category = "tracker"; return true; }
  }
  for (const auto& domain : blocked_ad_domains_) {
    if (HostMatches(request_host, domain)) { if (category) *category = "ad"; return true; }
  }
  const std::string path = Lower(StripQuery(request_url));
  static const char* const ad_paths[] = {
    "/ads/", "/ad/", "/adserver/", "/adservice/", "/advertising/",
    "/banners/", "/banner/", "/pagead/", "/adsystem/", "/sponsored/"
  };
  for (const char* token : ad_paths) {
    if (path.find(token) != std::string::npos) { if (category) *category = "ad"; return true; }
  }
  static const char* const tracker_paths[] = {
    "/collect?", "/analytics/", "/tracking/", "/track/", "/pixel/",
    "/beacon/", "/telemetry/", "/g/collect", "/j/collect"
  };
  for (const char* token : tracker_paths) {
    if (Lower(request_url).find(token) != std::string::npos) { if (category) *category = "tracker"; return true; }
  }
  return false;
}

void SimpleHandler::AddAllowedSite(const std::string& host_value) {
  const std::string host = Lower(Trim(host_value));
  if (host.empty()) return;
  {
    std::lock_guard<std::mutex> lock(filter_mutex_);
    allowed_site_domains_.insert(host);
  }
  if (!user_data_path_.empty()) {
    std::ofstream file(std::filesystem::path(user_data_path_) / "allowed-sites.txt", std::ios::trunc);
    std::lock_guard<std::mutex> lock(filter_mutex_);
    for (const auto& value : allowed_site_domains_) file << value << '\n';
  }
}

void SimpleHandler::ToggleBlocking() {
  blocking_enabled_ = !blocking_enabled_;
  if (!user_data_path_.empty()) {
    std::ofstream file(std::filesystem::path(user_data_path_) / "settings.txt", std::ios::trunc);
    file << (blocking_enabled_ ? "1" : "0") << '\n' << home_page_ << '\n';
  }
}

std::string SimpleHandler::BuildHomePage() const {
  return R"HTML(<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Shark Browser</title><style>
  :root{color-scheme:dark;--bg:#10151d;--panel:#17222e;--line:#2c3b4c;--text:#eef4fa;--muted:#9aaabd;--teal:#4de0c1}
  *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 50% 35%,#1b3441,#10151d 56%);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:30px}
  main{width:min(700px,100%);text-align:center}.mark{color:var(--teal);font-size:47px;transform:rotate(-20deg)}h1{font-size:43px;letter-spacing:-1.7px;margin:10px 0 2px}p{color:var(--muted)}form{display:flex;gap:9px;margin:25px 0}input{flex:1;min-width:0;border:1px solid #35485a;border-radius:12px;background:#121c26;padding:15px;color:var(--text);font:inherit}button{border:0;border-radius:10px;padding:0 18px;background:var(--teal);color:#06231d;font-weight:700;font:inherit;cursor:pointer}.links{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}.links a{color:#d9e7f4;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:10px 14px;text-decoration:none}.links a:hover{border-color:var(--teal)}.sub{font-size:12px;margin-top:34px}
  </style></head><body><main><div class="mark">◆</div><h1>Make waves.</h1><p>A real Chromium browser. Less tracking. More control.</p><form action="https://duckduckgo.com/" method="get"><input name="q" placeholder="Search the web or enter a URL" autofocus><button>Search</button></form><div class="links"><a href="https://www.wikipedia.org">Wikipedia</a><a href="https://www.youtube.com">YouTube</a><a href="https://github.com">GitHub</a><a href="shark://bookmarks">Bookmarks</a><a href="shark://history">History</a><a href="shark://privacy">Privacy dashboard</a></div><p class="sub">Shark Browser · Powered by Chromium Embedded Framework</p></main></body></html>)HTML";
}

std::string SimpleHandler::BuildBookmarksPage() const {
  std::ostringstream html;
  html << "<!doctype html><html><head><meta charset='utf-8'><title>Bookmarks</title>" << InternalStyle()
       << "</head><body><main><a href='shark://home'>◆ Shark</a><h1>Bookmarks</h1>"
       << "<p>Saved bookmarks are stored on this device.</p><div class='actions'><a href='shark-action://add-bookmark'>Bookmark current page</a></div><section>";
  if (bookmarks_.empty()) html << "<p>No bookmarks yet. Use ☆ in the toolbar while browsing a page.</p>";
  for (size_t i = 0; i < bookmarks_.size(); ++i) {
    html << "<article><div><a href='" << HtmlEscape(bookmarks_[i].second) << "'>" << HtmlEscape(bookmarks_[i].first)
         << "</a><small>" << HtmlEscape(bookmarks_[i].second) << "</small></div><a class='remove' href='shark-action://remove-bookmark/" << i << "'>Remove</a></article>";
  }
  html << "</section></main></body></html>";
  return html.str();
}

std::string SimpleHandler::BuildHistoryPage() const {
  std::ostringstream html;
  html << "<!doctype html><html><head><meta charset='utf-8'><title>History</title>" << InternalStyle()
       << "</head><body><main><a href='shark://home'>◆ Shark</a><h1>Browsing history</h1>"
       << "<div class='actions'><a href='shark-action://clear-history'>Clear history</a></div><section>";
  if (history_.empty()) html << "<p>No browsing history yet.</p>";
  for (const auto& entry : history_) {
    html << "<article><div><a href='" << HtmlEscape(entry.url) << "'>" << HtmlEscape(entry.title)
         << "</a><small>" << HtmlEscape(entry.url) << "</small></div></article>";
  }
  html << "</section></main></body></html>";
  return html.str();
}

std::string SimpleHandler::BuildDownloadsPage() const {
  std::ostringstream html;
  html << "<!doctype html><html><head><meta charset='utf-8'><title>Downloads</title>" << InternalStyle()
       << "</head><body><main><a href='shark://home'>◆ Shark</a><h1>Downloads</h1>"
       << "<p>CEF uses the system Save File dialog. Completed downloads are saved in the location you selected.</p><section>";
  if (downloads_.empty()) html << "<p>No downloads in this session.</p>";
  for (const auto& download : downloads_) html << "<article><div>" << HtmlEscape(download) << "</div></article>";
  html << "</section></main></body></html>";
  return html.str();
}

std::string SimpleHandler::BuildPrivacyPage() const {
  std::ostringstream html;
  html << "<!doctype html><html><head><meta charset='utf-8'><title>Privacy Dashboard</title>" << InternalStyle()
       << "</head><body><main><a href='shark://home'>◆ Shark</a><h1>Privacy dashboard</h1><p>Network requests blocked before they reach their destination.</p>"
       << "<div class='stats'><article><b>" << blocked_total_.load() << "</b><small>Total blocked</small></article>"
       << "<article><b>" << blocked_ads_.load() << "</b><small>Ads blocked</small></article>"
       << "<article><b>" << blocked_trackers_.load() << "</b><small>Trackers blocked</small></article></div>"
       << "<div class='actions'><a href='shark-action://toggle-blocking'>Turn protection " << (blocking_enabled_ ? "off" : "on") << "</a>"
       << "<a href='shark-action://allow-current'>Allow current website</a><a href='shark://settings'>Settings</a></div>"
       << "<h2>Blocked by website</h2><section>";
  std::vector<std::pair<std::string, int>> sites;
  std::vector<std::string> recent;
  {
    std::lock_guard<std::mutex> lock(filter_mutex_);
    for (const auto& item : blocked_by_site_) sites.push_back(item);
    recent = recent_blocked_;
  }
  std::sort(sites.begin(), sites.end(), [](const auto& a, const auto& b) { return a.second > b.second; });
  if (sites.empty()) html << "<p>No requests blocked yet. Visit a site with third-party ads or trackers.</p>";
  for (size_t i = 0; i < sites.size() && i < 12; ++i) html << "<article><div>" << HtmlEscape(sites[i].first) << "</div><b>" << sites[i].second << "</b></article>";
  html << "</section><h2>Recent blocked requests</h2><section>";
  if (recent.empty()) html << "<p>No blocked requests yet.</p>";
  for (size_t i = 0; i < recent.size() && i < 20; ++i) html << "<article><div>" << HtmlEscape(recent[i]) << "</div></article>";
  html << "</section><p class='muted'>Lists are EasyList/EasyPrivacy-compatible domain rules plus built-in fallbacks. This is not yet a complete uBlock Origin replacement.</p></main></body></html>";
  return html.str();
}


std::string SimpleHandler::BuildFindPage() const {
  return R"HTML(<!doctype html><html><head><meta charset="utf-8"><title>Find in page</title>)HTML" +
      InternalStyle() +
      R"HTML(</head><body><main><a href="shark://home">◆ Shark</a><h1>Find in page</h1>
      <p>Search text on the current page. Use Enter to move to the next match.</p>
      <form action="shark-action://find-submit" onsubmit="location.href='shark-action://find/'+encodeURIComponent(document.getElementById('term').value);return false;">
      <input id="term" autofocus placeholder="Find on this page"><button>Find</button></form>
      <div class="actions"><a href="shark://home">Home</a></div></main></body></html>)HTML";
}

std::string SimpleHandler::BuildSettingsPage() const {
  std::ostringstream html;
  html << "<!doctype html><html><head><meta charset='utf-8'><title>Settings</title>" << InternalStyle()
       << "</head><body><main><a href='shark://home'>◆ Shark</a><h1>Settings</h1>"
       << "<h2>Privacy</h2><p>Ad and tracker blocking is <b>" << (blocking_enabled_ ? "enabled" : "disabled")
       << "</b>.</p><div class='actions'><a href='shark-action://toggle-blocking'>Turn protection "
       << (blocking_enabled_ ? "off" : "on") << "</a><a href='shark-action://allow-current'>Allow current website</a></div>"
       << "<h2>Startup</h2><p>Home page: " << HtmlEscape(home_page_) << "</p>"
       << "<div class='actions'><a href='shark-action://set-home'>Use current website as home</a><a href='shark://home'>Restore Shark home page</a></div>"
       << "<h2>Page tools</h2><div class='actions'><a href='shark://find'>Find in page</a><a href='shark://bookmarks'>Bookmarks</a><a href='shark://history'>History</a><a href='shark://downloads'>Downloads</a><a href='shark://privacy'>Privacy dashboard</a></div>"
       << "<p class='muted'>Shark is experimental. CEF provides Chromium rendering, cookies, site permissions and the browser context menu. Password management, browser sync and Chrome Web Store extension installation are not part of this native CEF build yet.</p></main></body></html>";
  return html.str();
}

std::string InternalStyle() {
  return R"CSS(<style>
  :root{color-scheme:dark;--bg:#10151d;--panel:#17222e;--line:#2c3b4c;--text:#eef4fa;--muted:#9aaabd;--teal:#4de0c1}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:30px}
  main{max-width:900px;margin:auto}a{color:var(--teal);text-decoration:none}h1{font-size:32px;letter-spacing:-.7px;margin-top:22px}h2{font-size:17px;margin-top:25px}p,.muted{color:var(--muted)}section{margin-top:18px}article{display:flex;justify-content:space-between;gap:18px;align-items:center;background:var(--panel);border:1px solid var(--line);padding:13px 15px;border-radius:9px;margin:7px 0;overflow-wrap:anywhere}article small{display:block;color:var(--muted);font-size:11px;margin-top:4px}article b{font-size:18px}.remove{color:#ffb1b1}.actions,.stats{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.actions a{background:#1b2b37;border:1px solid var(--line);border-radius:8px;padding:10px 13px}.stats article{flex:1;min-width:130px;display:flex;flex-direction:column;align-items:flex-start}.stats b{font-size:28px;color:var(--teal)}.stats small{margin-top:0}
  </style>)CSS";
}

std::string SimpleHandler::DataURL(const std::string& html) const {
  return "data:text/html;charset=utf-8," +
         CefURIEncode(CefBase64Encode(html.data(), html.size()), false).ToString();
}

std::string SimpleHandler::HtmlEscape(const std::string& input) const {
  std::string output;
  output.reserve(input.size());
  for (char c : input) {
    switch (c) {
      case '&': output += "&amp;"; break;
      case '<': output += "&lt;"; break;
      case '>': output += "&gt;"; break;
      case '"': output += "&quot;"; break;
      case '\'': output += "&#39;"; break;
      default: output.push_back(c); break;
    }
  }
  return output;
}

std::string SimpleHandler::ExtractHost(const std::string& url) {
  const size_t scheme = url.find("://");
  if (scheme == std::string::npos) return {};
  const size_t start = scheme + 3;
  const size_t end = url.find_first_of("/:?#", start);
  return Lower(url.substr(start, end == std::string::npos ? std::string::npos : end - start));
}

bool SimpleHandler::HostMatches(const std::string& host, const std::string& domain) {
  if (host.empty() || domain.empty()) return false;
  return host == domain || (host.size() > domain.size() &&
      host.compare(host.size() - domain.size(), domain.size(), domain) == 0 &&
      host[host.size() - domain.size() - 1] == '.');
}

std::string SimpleHandler::NormalizeAddress(const std::string& input) {
  std::string value = Trim(input);
  if (value.empty()) return "shark://home";
  if (StartsWith(value, "shark://") || StartsWith(value, "http://") ||
      StartsWith(value, "https://") || StartsWith(value, "file://")) return value;
  if (value.find(' ') == std::string::npos &&
      (value.find('.') != std::string::npos || StartsWith(value, "localhost") ||
       StartsWith(value, "127.0.0.1"))) return "https://" + value;
  return "https://duckduckgo.com/?q=" + CefURIEncode(value, false).ToString();
}

