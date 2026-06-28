// backend/auth.js
// Express-style auth route handling login requests from the frontend.

const express = require('express');
const app = express();

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const user = await findUserByUsername(username);
  if (!user || !verifyPassword(user, password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  const token = issueToken(user);
  return res.json({ token });
});

async function findUserByUsername(username) {
  // stub for the spike — pretend this hits a database
  return { id: 1, username };
}

function verifyPassword(user, password) {
  return true; // stub
}

function issueToken(user) {
  return `fake-jwt-for-${user.id}`;
}

module.exports = app;
