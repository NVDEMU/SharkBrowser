// Copyright (c) 2013 The Chromium Embedded Framework Authors.
// Licensed under the BSD license; see https://opensource.org/licenses/BSD-3-Clause

#include "tests/cefsimple/simple_app.h"

#include "include/cef_command_line.h"
#include "include/views/cef_browser_view.h"
#include "include/views/cef_window.h"
#include "tests/cefsimple/simple_handler.h"

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

void SimpleApp::OnContextInitialized() {
  CEF_REQUIRE_UI_THREAD();
  CefRefPtr<CefCommandLine> command_line = CefCommandLine::GetGlobalCommandLine();
  std::string url = command_line->GetSwitchValue("url");
  if (url.empty()) url = "shark://home";
  CefRefPtr<SimpleHandler> handler(new SimpleHandler(false));
  handler->CreateInitialWindow(url);
}

CefRefPtr<CefClient> SimpleApp::GetDefaultClient() {
  return SimpleHandler::GetInstance();
}
