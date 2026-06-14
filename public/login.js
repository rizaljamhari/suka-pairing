const form = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const log = document.getElementById('login-log');

function setBusy(isBusy) {
  form.querySelectorAll('button, input').forEach((node) => {
    node.disabled = isBusy;
  });
}

function setLog(message) {
  log.textContent = message;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    setLog('Enter both username and password.');
    return;
  }

  setBusy(true);
  setLog('Signing in...');

  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ username, password }),
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setLog(payload?.details || payload?.error || 'Login failed.');
      setBusy(false);
      passwordInput.select();
      return;
    }

    window.location.assign('/');
  } catch (error) {
    setLog(`Login failed: ${error.message}`);
    setBusy(false);
  }
});
