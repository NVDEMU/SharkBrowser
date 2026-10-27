const { ipcRenderer } = require('electron');

// This preload runs in the isolated guest page. It does not expose Node APIs
// to the website. Credentials are only offered to the browser after a user
// submits a form; the browser never saves them without a separate click.
if (window === window.top) {
  window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('submit', event => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      const passwordField = form.querySelector('input[type="password"]');
      if (!passwordField || !passwordField.value) return;
      const usernameField = form.querySelector(
        'input[autocomplete="username"],input[type="email"],input[name*="user" i],input[id*="user" i],input[name*="email" i],input[id*="email" i]'
      );
      ipcRenderer.sendToHost('shark:password-offer', {
        origin: location.origin,
        url: location.href,
        username: usernameField ? String(usernameField.value || '').slice(0, 512) : '',
        password: String(passwordField.value).slice(0, 8192)
      });
    }, true);
  });
}
