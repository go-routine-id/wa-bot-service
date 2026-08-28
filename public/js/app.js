'use strict';

const App = (() => {
  function showTab(name) {
    document.querySelectorAll('.tab-section').forEach((s) => {
      s.classList.toggle('active', s.id === `tab-${name}`);
    });
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });

    // refresh konten sesuai tab yang dibuka
    if (name === 'templates') Templates.load();
    if (name === 'history') History.load();
    if (name === 'create') Broadcast.loadTemplates();
  }

  function init() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    Connection.start(); // poll status setiap 2.5 detik (render hanya saat tab aktif)
  }

  return { showTab, init };
})();

document.addEventListener('DOMContentLoaded', App.init);
window.App = App;
