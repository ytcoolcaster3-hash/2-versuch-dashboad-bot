const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_PERMISSIONS = [
  'overview',
  'messages',
  'commands',
  'server',
  'roles',
  'settings',
  'users',
  'voice'
];

function ensureUsersFile(customDir = process.cwd()) {
  const dir = path.join(customDir, 'data');
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, 'users.json');
  if (!fs.existsSync(filePath)) {
    const defaultUsers = [{
      username: 'admin',
      password: hashPassword('admin123'),
      permissions: [...DEFAULT_PERMISSIONS]
    }];
    fs.writeFileSync(filePath, JSON.stringify(defaultUsers, null, 2));
  }

  return filePath;
}

function loadUsers(customDir = process.cwd()) {
  const filePath = ensureUsersFile(customDir);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Failed to load users:', error.message);
    return [];
  }
}

function saveUsers(users, customDir = process.cwd()) {
  const filePath = ensureUsersFile(customDir);
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2));
  return filePath;
}

function sanitizePermissions(value) {
  const permissions = Array.isArray(value) ? value : [value].filter(Boolean);
  const cleaned = permissions
    .filter((permission) => DEFAULT_PERMISSIONS.includes(permission))
    .filter((permission, index, all) => all.indexOf(permission) === index);
  return cleaned.length ? cleaned : ['overview'];
}

function hashPassword(password) {
  return 'sha256:' + crypto.createHash('sha256').update(String(password)).digest('hex');
}

function verifyPassword(password, hashedPassword) {
  if (!hashedPassword) return false;
  return hashPassword(password) === hashedPassword;
}

function getUserByName(username, customDir = process.cwd()) {
  const users = loadUsers(customDir);
  return users.find((user) => user.username === username);
}

function createUser({ username, password, permissions }, customDir = process.cwd()) {
  const trimmedUsername = String(username || '').trim();
  const trimmedPassword = String(password || '').trim();

  if (!trimmedUsername || !trimmedPassword) {
    throw new Error('Benutzername und Passwort sind erforderlich.');
  }

  const users = loadUsers(customDir);
  if (users.some((user) => user.username === trimmedUsername)) {
    throw new Error('Dieser Benutzer existiert bereits.');
  }

  users.push({
    username: trimmedUsername,
    password: hashPassword(trimmedPassword),
    permissions: sanitizePermissions(permissions)
  });

  saveUsers(users, customDir);
  return users[users.length - 1];
}

function deleteUser(username, customDir = process.cwd()) {
  const users = loadUsers(customDir);
  const next = users.filter((user) => user.username !== username);
  if (next.length === users.length) {
    return false;
  }

  saveUsers(next, customDir);
  return true;
}

module.exports = {
  DEFAULT_PERMISSIONS,
  ensureUsersFile,
  loadUsers,
  saveUsers,
  sanitizePermissions,
  hashPassword,
  verifyPassword,
  getUserByName,
  createUser,
  deleteUser
};
