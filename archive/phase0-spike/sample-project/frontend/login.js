// frontend/login.js
// A simple login form handler that calls the backend auth API.

async function handleLoginSubmit(event) {
  event.preventDefault();

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    showError('Login failed. Please check your credentials.');
    return;
  }

  const data = await response.json();
  redirectToDashboard(data.token);
}

function showError(message) {
  const el = document.getElementById('error-banner');
  el.textContent = message;
  el.style.display = 'block';
}

function redirectToDashboard(token) {
  localStorage.setItem('authToken', token);
  window.location.href = '/dashboard';
}

module.exports = { handleLoginSubmit };
