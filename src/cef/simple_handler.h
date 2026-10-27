// Shark Browser CEF client. SPDX-License-Identifier: BSD-3-Clause
#ifndef SHARK_SIMPLE_HANDLER_H_
#define SHARK_SIMPLE_HANDLER_H_

#include <atomic>
#include <map>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "include/cef_client.h"
#include "include/cef_keyboard_handler.h"
#include "include/cef_download_handler.h"
#include "include/cef_request_handler.h"
#include "include/cef_request_context.h"
#include "include/cef_resource_request_handler.h"
#include "include/cef_urlrequest.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_box_layout.h"
#include "include/views/cef_label_button.h"
#include "include/views/cef_panel.h"
#include "include/views/cef_textfield.h"
#include "include/views/cef_window.h"

class SimpleHandler : public CefClient,
                      public CefDisplayHandler,
                      public CefLifeSpanHandler,
                      public CefLoadHandler,
                      public CefRequestHandler,
                      public CefResourceRequestHandler,
                      public CefDownloadHandler,
                      public CefKeyboardHandler {
 public:
  explicit SimpleHandler(bool is_alloy_style);
  ~SimpleHandler() override;

  static SimpleHandler* GetInstance();

  // CefClient.
  CefRefPtr<CefDisplayHandler> GetDisplayHandler() override { return this; }
  CefRefPtr<CefLifeSpanHandler> GetLifeSpanHandler() override { return this; }
  CefRefPtr<CefLoadHandler> GetLoadHandler() override { return this; }
  CefRefPtr<CefRequestHandler> GetRequestHandler() override { return this; }
  CefRefPtr<CefDownloadHandler> GetDownloadHandler() override { return this; }
  CefRefPtr<CefKeyboardHandler> GetKeyboardHandler() override { return this; }

  // Window/View delegate entry points called by the small delegates in simple_app.cc.
  void BuildWindow(CefRefPtr<CefWindow> window);
  bool CanCloseWindow(CefRefPtr<CefWindow> window);
  void WindowDestroyed();
  CefSize PreferredWindowSize();
  void HandleButton(const std::string& action, CefRefPtr<CefButton> button);
  bool HandleAddressKey(CefRefPtr<CefTextfield> textfield, const CefKeyEvent& event);
  bool AdoptPopupView(CefRefPtr<CefBrowserView> popup_view);
  cef_runtime_style_t GetBrowserRuntimeStyle();
  void CreateInitialWindow(const std::string& url);
  void ShowMainWindow();
  void CloseAllBrowsers(bool force_close);
  bool IsClosing() const { return is_closing_; }

  // CefDisplayHandler.
  void OnTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title) override;
  void OnAddressChange(CefRefPtr<CefBrowser> browser,
                       CefRefPtr<CefFrame> frame,
                       const CefString& url) override;
  void OnLoadingProgressChange(CefRefPtr<CefBrowser> browser, double progress) override;

  // CefLifeSpanHandler.
  void OnAfterCreated(CefRefPtr<CefBrowser> browser) override;
  bool DoClose(CefRefPtr<CefBrowser> browser) override;
  void OnBeforeClose(CefRefPtr<CefBrowser> browser) override;
  bool OnBeforePopup(CefRefPtr<CefBrowser> browser,
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
                     bool* no_javascript_access) override;

  // CefLoadHandler.
  void OnLoadError(CefRefPtr<CefBrowser> browser,
                   CefRefPtr<CefFrame> frame,
                   ErrorCode error_code,
                   const CefString& error_text,
                   const CefString& failed_url) override;

  // CefRequestHandler and CefResourceRequestHandler.
  CefRefPtr<CefResourceRequestHandler> GetResourceRequestHandler(
      CefRefPtr<CefBrowser> browser,
      CefRefPtr<CefFrame> frame,
      CefRefPtr<CefRequest> request,
      bool is_navigation,
      bool is_download,
      const CefString& request_initiator,
      bool& disable_default_handling) override;
  bool OnBeforeBrowse(CefRefPtr<CefBrowser> browser,
                      CefRefPtr<CefFrame> frame,
                      CefRefPtr<CefRequest> request,
                      bool user_gesture,
                      bool is_redirect) override;
  ReturnValue OnBeforeResourceLoad(CefRefPtr<CefBrowser> browser,
                                   CefRefPtr<CefFrame> frame,
                                   CefRefPtr<CefRequest> request,
                                   CefRefPtr<CefCallback> callback) override;

  // CefDownloadHandler.
  bool OnBeforeDownload(CefRefPtr<CefBrowser> browser,
                        CefRefPtr<CefDownloadItem> download_item,
                        const CefString& suggested_name,
                        CefRefPtr<CefBeforeDownloadCallback> callback) override;
  void OnDownloadUpdated(CefRefPtr<CefBrowser> browser,
                         CefRefPtr<CefDownloadItem> download_item,
                         CefRefPtr<CefDownloadItemCallback> callback) override;

  // CefKeyboardHandler.
  bool OnPreKeyEvent(CefRefPtr<CefBrowser> browser,
                     const CefKeyEvent& event,
                     CefEventHandle os_event,
                     bool* is_keyboard_shortcut) override;

  // Legacy platform-specific title handling used by the sample entry points.
  void PlatformTitleChange(CefRefPtr<CefBrowser> browser, const CefString& title);
  void PlatformShowWindow(CefRefPtr<CefBrowser> browser);

 private:
  struct Tab {
    int id = 0;
    std::string title;
    std::string url;
    std::string last_site_url;
    bool is_private = false;
    bool internal_page = false;
    double zoom_level = 0.0;
    CefRefPtr<CefBrowserView> view;
    CefRefPtr<CefRequestContext> request_context;
    CefRefPtr<CefLabelButton> tab_button;
    CefRefPtr<CefLabelButton> close_button;
  };
  struct HistoryEntry { std::string title; std::string url; };

  void LoadProfile();
  void SaveBookmarks();
  void SaveHistory();
  void SaveStats();
  void SaveSession();
  void LoadFilterLists();
  void CreateTab(const std::string& url, bool is_private);
  void CreateTabForView(const std::string& url, bool is_private, CefRefPtr<CefBrowserView> view, CefRefPtr<CefRequestContext> request_context = nullptr);
  void CloseTab(int tab_id);
  void SelectTab(int tab_id);
  void NavigateAddress(const std::string& input);
  void OpenInternalPage(CefRefPtr<CefBrowser> browser, const std::string& route);
  void OpenRoute(const std::string& route);
  void HandleInternalAction(const std::string& action);
  std::string GetCurrentURL() const;
  std::string GetCurrentHost() const;
  std::string BuildHomePage() const;
  std::string BuildBookmarksPage() const;
  std::string BuildHistoryPage() const;
  std::string BuildDownloadsPage() const;
  std::string BuildPrivacyPage() const;
  std::string BuildSettingsPage() const;
  std::string BuildFindPage() const;
  void RefreshTabButtons();
  void RefreshToolbarState();
  void RefreshPrivacyStatus();
  void RecordHistory(const std::string& url, const std::string& title);
  bool ShouldBlockRequest(const std::string& request_url,
                          const std::string& referrer_url,
                          std::string* category);
  void AddAllowedSite(const std::string& host);
  void ToggleBlocking();
  void CycleTab(int direction);
  Tab* FindTabByBrowser(CefRefPtr<CefBrowser> browser);
  Tab* ActiveTab();
  const Tab* ActiveTab() const;
  std::string DataURL(const std::string& html) const;
  std::string HtmlEscape(const std::string& input) const;
  static std::string ExtractHost(const std::string& url);
  static bool HostMatches(const std::string& host, const std::string& domain);
  static std::string NormalizeAddress(const std::string& input);

  const bool is_alloy_style_;
  bool is_closing_ = false;
  int next_tab_id_ = 1;
  int active_tab_id_ = 0;
  std::atomic<bool> blocking_enabled_{true};
  std::string user_data_path_;
  std::vector<Tab> tabs_;
  std::vector<CefRefPtr<CefBrowser>> browser_list_;
  std::vector<HistoryEntry> history_;
  std::vector<std::pair<std::string, std::string>> bookmarks_;
  std::vector<std::string> downloads_;
  std::vector<std::string> saved_session_tabs_;
  std::vector<std::string> closed_tab_urls_;
  std::string last_find_text_;
  std::string home_page_ = "shark://home";
  std::string initial_url_ = "shark://home";

  CefRefPtr<CefWindow> window_;
  CefRefPtr<CefPanel> root_panel_;
  CefRefPtr<CefPanel> tab_panel_;
  CefRefPtr<CefPanel> toolbar_panel_;
  CefRefPtr<CefPanel> content_panel_;
  CefRefPtr<CefPanel> status_panel_;
  CefRefPtr<CefBoxLayout> root_layout_;
  CefRefPtr<CefBoxLayout> tab_layout_;
  CefRefPtr<CefBoxLayout> toolbar_layout_;
  CefRefPtr<CefTextfield> address_field_;
  CefRefPtr<CefTextfield> find_field_;
  CefRefPtr<CefLabelButton> status_button_;
  std::map<std::string, CefRefPtr<CefLabelButton>> action_buttons_;

  mutable std::mutex filter_mutex_;
  std::unordered_set<std::string> blocked_ad_domains_;
  std::unordered_set<std::string> blocked_tracker_domains_;
  std::unordered_set<std::string> allowed_request_domains_;
  std::unordered_set<std::string> allowed_site_domains_;
  std::unordered_set<int> private_browser_ids_;
  std::unordered_map<std::string, int> blocked_by_site_;
  std::vector<std::string> recent_blocked_;
  std::atomic<int> blocked_total_{0};
  std::atomic<int> blocked_ads_{0};
  std::atomic<int> blocked_trackers_{0};

  IMPLEMENT_REFCOUNTING(SimpleHandler);
};

#endif  // SHARK_SIMPLE_HANDLER_H_
