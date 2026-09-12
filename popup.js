const statusEl = document.getElementById('status');

document.getElementById('activate-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'toggle-blur-mode-active-tab' }, (response) => {
    if (response && response.ok) {
      statusEl.textContent = 'Blur mode activated on this tab.';
      setTimeout(() => window.close(), 500);
    } else {
      statusEl.textContent = "Can't run on this page.";
      statusEl.style.color = '#f28b82';
    }
  });
});

document.getElementById('customize-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

chrome.commands.getAll((commands) => {
  const cmd = commands.find((c) => c.name === 'activate-blur-mode');
  if (cmd && cmd.shortcut) {
    document.getElementById('shortcut-text').textContent = cmd.shortcut;
  } else if (cmd) {
    document.getElementById('shortcut-text').textContent = 'Not set';
  }
});
