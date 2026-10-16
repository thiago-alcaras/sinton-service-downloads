const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('sintonDesktop', Object.freeze({ app: true }));
try { localStorage.setItem('sinton.interface-mode.v1', 'standard'); } catch {}

window.addEventListener('sinton:interface-mode', event => {
  if (event.detail === 'tv') {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

function hideTVControls() {
  const modeClasses = ['standard-mode-button', 'standard-player-mode'];
  for (const element of document.querySelectorAll('button, a, [role="button"]')) {
    const label = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    if (modeClasses.some(name => element.classList.contains(name)) || /^(?:modo tv|trocar para modo tv)$/i.test(label)) {
      element.remove();
    }
  }
}

const observer = new MutationObserver(hideTVControls);
document.addEventListener('DOMContentLoaded', () => {
  hideTVControls();
  observer.observe(document.documentElement, { childList: true, subtree: true });
});
