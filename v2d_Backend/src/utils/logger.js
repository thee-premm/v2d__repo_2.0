/**
 * Structured console logger for V2D Backend
 */
export const logger = {
  info: (msg, meta = {}) => {
    console.log(`[INFO] [${new Date().toISOString()}] ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
  },
  warn: (msg, meta = {}) => {
    console.warn(`[WARN] [${new Date().toISOString()}] ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
  },
  error: (msg, error = {}) => {
    console.error(`[ERROR] [${new Date().toISOString()}] ${msg}`, error?.stack || error?.message || error);
  },
  debug: (msg, meta = {}) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DEBUG] [${new Date().toISOString()}] ${msg}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
    }
  }
};
