const fs = require('fs');
const path = require('path');

function getAuthorizedPath(customDir = process.cwd()) {
  const dir = path.join(customDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'authorized.json');
}

function readAuthorized(customDir = process.cwd()) {
  const filePath = getAuthorizedPath(customDir);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveAuthorized(list, customDir = process.cwd()) {
  const filePath = getAuthorizedPath(customDir);
  fs.writeFileSync(filePath, JSON.stringify(list, null, 2));
  return filePath;
}

function addAuthorized(discordUserId, customDir = process.cwd()) {
  const list = readAuthorized(customDir);
  const normalized = String(discordUserId).trim();
  if (!normalized) return list;
  if (!list.includes(normalized)) {
    list.push(normalized);
    saveAuthorized(list, customDir);
  }
  return list;
}

module.exports = {
  getAuthorizedPath,
  readAuthorized,
  saveAuthorized,
  addAuthorized
};
