const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');
const file = join(homedir(), '.dsh', 'dsh-think-summary.json');
const prev = { mtime: 0, size: 0 };
const timer = setInterval(() => {
  try {
    const st = require('node:fs').statSync(file);
    if (st.mtimeMs !== prev.mtime || st.size !== prev.size) {
      prev.mtime = st.mtimeMs;
      prev.size = st.size;
      const json = JSON.parse(readFileSync(file, 'utf8'));
      const n = (json.sessions || []).length;
      const segs = (json.sessions || []).reduce((a, s) => a + (s.thinks || []).reduce((x, t) => x + (t.segments || []).length, 0), 0);
      console.log(`[watch] 文件更新 mtime=${new Date(st.mtimeMs).toLocaleTimeString()} sessions=${n} segments=${segs}`);
    }
  } catch (e) { /* 文件暂不可读 */ }
}, 2000);
// 60s 后自动退出
setTimeout(() => { clearInterval(timer); console.log('[watch] done'); process.exit(0); }, 90000);