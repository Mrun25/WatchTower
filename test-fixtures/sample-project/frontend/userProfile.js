// frontend/userProfile.js
// Calls the backend to fetch and update a user's profile.

async function fetchUserProfile(userId) {
  const response = await fetch(`/api/users/${userId}`, { method: 'GET' });
  return response.json();
}

async function updateUserProfile(userId, name, email) {
  const response = await fetch(`/api/users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email })
  });
  return response.json();
}

function renderProfile(profile) {
  console.log(`Rendering profile for ${profile.name}`);
}

module.exports = { fetchUserProfile, updateUserProfile, renderProfile };
