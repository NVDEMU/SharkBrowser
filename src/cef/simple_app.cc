// Copyright (c) 2013 The Chromium Embedded Framework Authors.
// Licensed under the BSD license; see https://opensource.org/licenses/BSD-3-Clause

#include "tests/cefsimple/simple_app.h"

#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "tests/cefsimple/simple_handler.h"
#include "include/wrapper/cef_helpers.h"

namespace {
class SharkWindowDelegate final : public CefWindowDelegate {
 public:
  explicit SharkWindowDelegate(CefRefPtr<SimpleHandler> handler) : handler_(handler) {}
  void OnWindowCreated(CefRefPtr<CefWindow> window) override {
    handler_->BuildWindow(window);
  }
  void OnWindowDestroyed(CefRefPtr<CefWindow> window) override {
    handler_->WindowDestroyed();
  }
  bool CanClose(CefRefPtr<CefWindow> window) override {
    return handler_->CanCloseWindow(window);
  }
  CefSize GetPreferredSize(CefRefPtr<CefView> view) override {
    return handler_->PreferredWindowSize();
  }
  cef_runtime_style_t GetWindowRuntimeStyle() override {
    return handler_->GetBrowserRuntimeStyle();
  }
 private:
  CefRefPtr<SimpleHandler> handler_;
  IMPLEMENT_REFCOUNTING(SharkWindowDelegate);
};

}  // namespace

void SimpleHandler::CreateInitialWindow(const std::string& url) {
  CEF_REQUIRE_UI_THREAD();
  initial_url_ = url.empty() ? "shark://home" : url;
  CefWindow::CreateTopLevelWindow(new SharkWindowDelegate(CefRefPtr<SimpleHandler>(this)));
}

void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<CefCommandLine> command_line = CefCommandLine::GetGlobalCommandLine();
  std::string url = command_line->GetSwitchValue("url");
  if (url.empty()) url = "shark://home";
  CefRefPtr<SimpleHandler> handler(new SimpleHandler(false));
  handler->SetSmokeTestMode(command_line->HasSwitch("smoke-test"));
  handler->CreateInitialWindow(url);
}

CefRefPtr<CefClient> SimpleApp::GetDefaultClient() {
  return SimpleHandler::GetInstance();
}
