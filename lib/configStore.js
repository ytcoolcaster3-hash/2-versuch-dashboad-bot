const fs = require('fs');
const path = require('path');

function ensureConfigDir(customDir = process.cwd()) {
  const dir = path.join(customDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConfigPath(customDir = process.cwd()) {
  return path.join(ensureConfigDir(customDir), 'config.json');
}

function saveToken(token, customDir = process.cwd()) {
  const configPath = getConfigPath(customDir);
  const data = { token: String(token).trim() };
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
  return configPath;
}

function loadToken(customDir = process.cwd()) {
  const configPath = getConfigPath(customDir);
  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.token || null;
  } catch (error) {
    console.error('Failed to load token:', error.message);
    return null;
  }
}

module.exports = {
  ensureConfigDir,
  getConfigPath,
  saveToken,
  loadToken
};
