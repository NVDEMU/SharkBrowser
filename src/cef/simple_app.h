// Copyright (c) 2013 The Chromium Embedded Framework Authors.
// Licensed under the BSD license; see https://opensource.org/licenses/BSD-3-Clause
#ifndef SHARK_SIMPLE_APP_H_
#define SHARK_SIMPLE_APP_H_
#include "include/cef_app.h"

class SimpleApp : public CefApp, public CefBrowserProcessHandler {
 public:
  SimpleApp() = default;
  CefRefPtr<CefBrowserProcessHandler> GetBrowserProcessHandler() override { return this; }
  void OnContextInitialized() override;
  CefRefPtr<CefClient> GetDefaultClient() override;
 private:
  IMPLEMENT_REFCOUNTING(SimpleApp);
};
#endif
