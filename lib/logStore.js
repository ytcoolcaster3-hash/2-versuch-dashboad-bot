const fs = require('fs');
const path = require('path');

function getLogPath(customDir = process.cwd()) {
  const dir = path.join(customDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'logs.json');
}

function readLogs(customDir = process.cwd()) {
  const filePath = getLogPath(customDir);
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function saveLogs(logs, customDir = process.cwd()) {
  const filePath = getLogPath(customDir);
  fs.writeFileSync(filePath, JSON.stringify(logs, null, 2));
  return filePath;
}

function addLog(entry, customDir = process.cwd()) {
  const logs = readLogs(customDir);
  const timestamp = new Date().toISOString();
  const next = [
    {
      id: `${Date.now()}-${Math.random().toString(16).slice(2,8)}`,
      timestamp,
      ...entry
    },
    ...logs
  ].slice(0, 200);

  saveLogs(next, customDir);
  return next;
}

module.exports = {
  getLogPath,
  readLogs,
  saveLogs,
  addLog
};
